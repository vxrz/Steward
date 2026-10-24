import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EDITION_KINDS, EDITION_RE, LINK_KINDS, RECORD_STATUSES, RECORD_WORKFLOW_KEYS, REVIEW_STATUSES, type RecordsMeta, type ReviewStatus } from '@sm/shared';
import { HttpError } from '../util.js';
import { canApproveRecords, canCreateRecords, canManageRecordTypes, me } from './access.js';
import * as svc from './service.js';
import * as types from './types.js';
import { addLink, linkInput, listBacklinks, removeLink, searchTargets, targetVisible } from './links.js';
import { addAttachment, ATTACHMENT_EXTENSIONS, attachmentForDownload, contentDisposition, MAX_ATTACHMENT_BYTES, removeAttachment } from './attachments.js';
import { exportMarkdown, IMPORT_LIMITS, importMarkdown } from './markdown-io.js';
import { generateRecordPdf, pdfInput } from './pdf.js';
import { uploadSignedPdf } from './signed.js';
import * as docs from './documents.js';
import * as catalogue from '../catalogue/service.js';
import { ROUTE_LIMITS } from '../rateLimits.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const csv = (v: unknown): string[] | undefined =>
  typeof v === 'string' && v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : Array.isArray(v)
      ? v.map(String)
      : undefined;

const listQuery = z.object({
  type: z.string().max(64).optional(),
  status: z.string().max(400).optional(),
  tag: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  owner: z.string().max(128).optional(),
  workflow: z.enum(RECORD_WORKFLOW_KEYS).optional(),
  /** Living documents: review statuses, comma-separated (current, dueSoon, overdue, none) */
  review: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

const updateBody = z
  .object({
    title: z.string().max(svc.LIMITS.title).optional(),
    body: z.string().max(svc.LIMITS.body).optional(),
    fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    tags: z.array(z.string()).max(svc.LIMITS.tags).optional(),
    owner: z.string().max(128).optional(),
    comment: z.string().max(svc.LIMITS.comment).optional(),
    baseVersion: z.number().int().optional(),
  })
  .strict();

/** One uploaded file (multipart), with a size limit. */
async function uploadedFile(req: FastifyRequest, maxBytes: number): Promise<{ filename: string; data: Buffer; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new HttpError(400, 'Send the file as multipart/form-data', 'MULTIPART_REQUIRED');
  const file = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!file) throw new HttpError(400, 'No file', 'NO_FILE');
  const tooLarge = () =>
    new HttpError(413, `The file is too large (at most ${maxBytes / 1024 / 1024} MB)`, 'FILE_TOO_LARGE', { maxMb: maxBytes / 1024 / 1024 });
  let data: Buffer;
  try {
    data = await file.toBuffer();
  } catch {
    throw tooLarge();
  }
  if (file.file.truncated) throw tooLarge();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.fields)) {
    const val = (v as { value?: unknown } | undefined)?.value;
    if (typeof val === 'string') fields[k] = val;
  }
  return { filename: file.filename || 'file', data, fields };
}

/**
 * Records (change requests, decision records) and the service catalogue: the
 * web UI's API. Every route checks permissions in the service layer.
 */
export async function recordRoutes(app: FastifyInstance): Promise<void> {
  // ---------- meta, types ----------
  app.get('/records/meta', async (): Promise<RecordsMeta> => {
    const u = me();
    return {
      canCreate: canCreateRecords(u),
      canManageTypes: canManageRecordTypes(u),
      canApprove: canApproveRecords(u),
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      maxImportFiles: IMPORT_LIMITS.files,
      maxImportBytes: IMPORT_LIMITS.fileBytes,
      attachmentExtensions: ATTACHMENT_EXTENSIONS,
    };
  });
  app.get('/record-types', async (req) => {
    me();
    return types.listTypes({ archived: (req.query as { archived?: string }).archived === '1' });
  });
  app.post('/record-types', async (req) => types.createType(types.typeInput.parse(req.body)));
  app.put('/record-types/:id', async (req) => types.updateType(params(req).id!, types.typeInput.parse(req.body)));

  // ---------- records ----------
  app.get('/records', async (req) => {
    const q = listQuery.parse(req.query);
    const status = csv(q.status);
    if (status?.some((s) => !RECORD_STATUSES.includes(s)))
      throw new HttpError(400, `Unknown status – use ${RECORD_STATUSES.join(', ')}`, 'RECORD_STATUS_UNKNOWN', { allowed: RECORD_STATUSES.join(', ') });
    const review = csv(q.review);
    if (review?.some((s) => !(REVIEW_STATUSES as readonly string[]).includes(s)))
      throw new HttpError(400, `Unknown review status – use ${REVIEW_STATUSES.join(', ')}`, 'REVIEW_STATUS_UNKNOWN', { allowed: REVIEW_STATUSES.join(', ') });
    return svc.listRecords({
      type: q.type,
      status,
      tag: q.tag,
      q: q.q,
      owner: q.owner,
      workflow: q.workflow,
      review: review as ReviewStatus[] | undefined,
      limit: q.limit,
    });
  });
  app.post('/records', async (req) => {
    const b = z
      .object({
        type: z.string().min(1).max(64),
        title: z.string().max(svc.LIMITS.title),
        body: z.string().max(svc.LIMITS.body).optional(),
        fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        tags: z.array(z.string()).max(svc.LIMITS.tags).optional(),
        // e.g. the service a new document is written for ("New document" on the service page)
        links: z.array(linkInput).max(20).optional(),
      })
      .strict()
      .parse(req.body);
    return svc.createRecord(b);
  });
  app.post('/records/import', { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: IMPORT_LIMITS.totalBytes * 2 + 64 * 1024 }, async (req) => {
    const b = z
      .object({
        type: z.string().max(64).optional(),
        dryRun: z.boolean().default(false),
        files: z
          .array(z.object({ filename: z.string().max(255), content: z.string().max(IMPORT_LIMITS.fileBytes * 2) }))
          .min(1)
          .max(IMPORT_LIMITS.files),
      })
      .strict()
      .parse(req.body);
    return importMarkdown(b.files, { type: b.type, dryRun: b.dryRun });
  });
  app.get('/records/:id', async (req) => svc.getRecord(params(req).id!));
  app.put('/records/:id', async (req) => svc.updateRecord(params(req).id!, updateBody.parse(req.body)));
  app.get('/records/:id/versions', async (req) => svc.listVersions(params(req).id!));
  app.get('/records/:id/versions/:version', async (req) => svc.getVersion(params(req).id!, z.coerce.number().int().min(1).parse(params(req).version)));
  app.post('/records/:id/transition', async (req) => {
    const b = z
      .object({
        action: z.string().min(1).max(40),
        comment: z.string().max(svc.LIMITS.comment).optional(),
        supersededBy: z.string().max(64).optional(),
        // living documents (submit): minor or major edition, and what changed
        editionKind: z.enum(EDITION_KINDS).optional(),
        changeSummary: z.string().max(4000).optional(),
        // optional: the content hash the decision is based on (the web app sends the one it showed when approving)
        contentHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/, 'a SHA-256 hash (64 hex digits)')
          .optional(),
      })
      .strict()
      .parse(req.body);
    return svc.transition(params(req).id!, b);
  });
  app.post('/records/:id/revise', async (req) =>
    svc.revise(
      params(req).id!,
      z
        .object({ comment: z.string().max(svc.LIMITS.comment) })
        .strict()
        .parse(req.body).comment,
    ),
  );
  app.post('/records/:id/comments', async (req) =>
    svc.addComment(
      params(req).id!,
      z
        .object({ text: z.string().max(svc.LIMITS.comment) })
        .strict()
        .parse(req.body).text,
    ),
  );
  // living documents: editions, changelog, reviews
  const edition = (req: FastifyRequest) => z.string().regex(EDITION_RE, 'an edition such as 1.0 or 2.1').parse(params(req).edition);
  app.get('/records/:id/editions', async (req) => docs.listEditions(params(req).id!));
  app.get('/records/:id/editions/:edition', async (req) => docs.getEdition(params(req).id!, edition(req)));
  app.post('/records/:id/editions/:edition/pdf', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const { texts: _t, ...att } = await generateRecordPdf(params(req).id!, { ...pdfInput.parse(req.body ?? {}), edition: edition(req) });
    return att;
  });
  app.get('/records/:id/changelog', async (req) => docs.changelog(params(req).id!));
  app.get('/records/:id/reviews', async (req) => docs.listReviews(params(req).id!));
  app.post('/records/:id/review', async (req) => docs.reviewDocument(params(req).id!, docs.reviewInput.parse(req.body)));
  app.put('/records/:id/review-settings', async (req) => docs.updateReviewSettings(params(req).id!, docs.reviewSettingsInput.parse(req.body)));
  app.get('/records/:id/export', async (req, reply) => {
    const { filename, text } = exportMarkdown(params(req).id!);
    reply.header('content-disposition', contentDisposition(filename));
    return reply.type('text/markdown; charset=utf-8').send(text);
  });

  // links
  app.post('/records/:id/links', async (req) => {
    const { r } = svc.requireEditable(params(req).id!, 'change the links of this record', { notTerminal: true });
    const link = addLink('record', r.id, linkInput.parse(req.body), r.number);
    svc.touch(r.id);
    return link;
  });
  app.delete('/records/:id/links/:linkId', async (req) => {
    const { r } = svc.requireEditable(params(req).id!, 'change the links of this record', { notTerminal: true });
    removeLink('record', r.id, params(req).linkId!, r.number);
    svc.touch(r.id);
    return { ok: true };
  });

  // attachments
  app.post('/records/:id/attachments', async (req) => {
    const f = await uploadedFile(req, MAX_ATTACHMENT_BYTES);
    return addAttachment(params(req).id!, f.filename, f.data);
  });
  app.delete('/records/:id/attachments/:attId', async (req) => {
    removeAttachment(params(req).id!, params(req).attId!);
    return { ok: true };
  });
  app.get('/records/:id/attachments/:attId/download', async (req, reply) => {
    const { row, data } = attachmentForDownload(params(req).id!, params(req).attId!);
    // Untrusted files: always a download, never rendered by the browser.
    reply.header('content-disposition', contentDisposition(row.filename));
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(row.mime || 'application/octet-stream').send(data);
  });

  // PDF and signed copies
  app.post('/records/:id/pdf', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const { texts: _t, ...att } = await generateRecordPdf(params(req).id!, pdfInput.parse(req.body ?? {}));
    return att;
  });
  app.post('/records/:id/signed', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const f = await uploadedFile(req, MAX_ATTACHMENT_BYTES);
    const plain = (req.query as { plain?: string }).plain === '1' || f.fields.plain === '1';
    return uploadSignedPdf(params(req).id!, f.filename, f.data, { plain });
  });

  // ---------- links (shared) ----------
  app.get('/link-targets', async (req) => {
    me();
    const q = z
      .object({ kind: z.enum(LINK_KINDS), q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) })
      .parse(req.query);
    return searchTargets(q.kind, q.q, q.limit);
  });
  app.get('/backlinks', async (req) => {
    me();
    const q = z.object({ kind: z.enum(LINK_KINDS), id: z.string().min(1).max(200) }).parse(req.query);
    // not for items the user cannot see (no probing which hidden items exist or are linked)
    if (!targetVisible(q.kind, q.id)) throw new HttpError(404, `${q.kind} ${q.id} not found`, 'LINK_TARGET_NOT_FOUND', { kind: q.kind, id: q.id });
    return listBacklinks(q.kind, q.id);
  });

  // ---------- service catalogue ----------
  app.get('/services', async (req) => catalogue.listServices({ archived: (req.query as { archived?: string }).archived === '1' }));
  app.post('/services', async (req) => catalogue.createService(catalogue.serviceInput.parse(req.body)));
  app.get('/services/:id', async (req) => catalogue.getService(params(req).id!));
  app.put('/services/:id', async (req) => catalogue.updateService(params(req).id!, catalogue.serviceInput.parse(req.body)));
  app.post('/services/:id/archive', async (req) =>
    catalogue.setArchived(params(req).id!, z.object({ archived: z.boolean() }).strict().parse(req.body).archived),
  );
  app.post('/services/:id/links', async (req) => catalogue.addServiceLink(params(req).id!, linkInput.parse(req.body)));
  app.delete('/services/:id/links/:linkId', async (req) => {
    catalogue.removeServiceLink(params(req).id!, params(req).linkId!);
    return { ok: true };
  });
}
