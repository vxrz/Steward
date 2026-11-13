import { z } from 'zod';
import {
  boundedRecord,
  MCP_REQUEST_LIMITS,
  type DataProductImportChange,
  type DataProductImportPreview,
  type McpDataProductsProposal,
  type McpProposalSelection,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { moduleEnabled } from '../modules/registry.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { ToolError, defineTool, type ToolDef } from '../mcp/tooling.js';
import { registerReviewKind, saveProposal, type Row } from '../mcp/requests.js';
import { canCreate, canManageModule, domainAccess, objectAccess, productAccess, usesModule } from './access.js';
import { DATA_PRODUCT_FORMAT_VERSION, SCHEMA_ID, dataProductsFileSchema, dataProductsJsonSchema, issueMessages } from './format.js';
import { applyImport, credentialPlaces, previewImport } from './import.js';
import type { DomainRow, ObjectRow, ProductRow } from './store.js';

/**
 * Data products proposed by AI assistants (ADR 0036 part 14, phase 2; the pattern of the plant registry's proposals).
 * An assistant connected through MCP sends a document of the module's file format – new products, elements, ports,
 * steps, data objects, domains and changes to them, read from a Snowflake schema (search_data_elements) or a dbt
 * manifest it has locally. Steward checks it with the import's preview as the token owner – nothing is written – and
 * keeps it as a proposal in the AI requests inbox. **A person applies it**: whoever uses the module accepts it there, the
 * preview runs again with their rights (a preview that changed since the proposal needs their confirmation) and the
 * import applies it in one transaction, as them, audited as every import. An assistant never applies anything.
 *
 * Only additions and changes: the import's mode is always _add and update_ – nothing is removed, no list item dropped,
 * no product retired; credential-looking values refuse the document (their places are named, never their values).
 * Large proposals come in parts, each a document of the format; together they are one import (several files).
 */

export const DATA_PRODUCT_PROPOSAL_LIMITS = {
  /** One part as sent (an MCP request is at most 64 KB) */
  partBytes: 48 * 1024,
  parts: 20,
  title: 120,
} as const;

interface Payload {
  type: 'dataProducts';
  title: string;
  incomplete: boolean;
  /** The parts as sent (JSON), each a file of the import */
  documents: string[];
  added: number;
  changed: number;
  /** The preview when it was proposed (the token owner's rights) */
  proposed: { counts: { add: number; change: number }; changes: DataProductImportChange[]; warnings: string[]; fingerprint: string } | null;
  result?: { add: number; change: number } | null;
}

const payloadOf = (r: Pick<Row, 'payload'>): Payload =>
  parseJson<Payload>(r.payload, { type: 'dataProducts', title: '', incomplete: false, documents: [], added: 0, changed: 0, proposed: null });
const filesOf = (p: Payload) => p.documents.map((content, i) => ({ name: `proposal-${i + 1}.json`, content }));
const importBody = (p: Payload, fingerprint?: string) => ({ files: filesOf(p), mode: 'update' as const, ...(fingerprint ? { fingerprint } : {}) });
const documentSha = (p: Payload) => sha256(p.documents.join('\n'));
const documentBytes = (p: Payload) => p.documents.reduce((n, d) => n + Buffer.byteLength(d), 0);

const mayUse = (u: AuthUser | null): boolean => moduleEnabled('dataProducts') && usesModule(u);

/**
 * Whether the reader may see what a change of the proposal names: a new entry is the assistant's text; a change names an
 * existing product, data object or domain – by key, shown only where the reader may see it; an element's change names
 * it by its qualified name – shown only to who may see it now (the reader's preview lists it).
 */
function seen(c: DataProductImportChange, u: AuthUser, nowKeys: Set<string> | null): boolean {
  if (c.action === 'add') return true;
  if (nowKeys) return nowKeys.has(`${c.kind}\u0000${c.key}`);
  if (c.kind === 'dataProduct') {
    const p = db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', c.key);
    return !p || productAccess(u, p).permissions.length > 0;
  }
  if (c.kind === 'dataObject') {
    const o = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE key = ?', c.key);
    return !o || objectAccess(u, o).permissions.length > 0;
  }
  if (c.kind === 'domain') {
    const d = db().get<DomainRow>('SELECT * FROM dp_domains WHERE key = ?', c.key);
    return !d || domainAccess(u, d).permissions.length > 0;
  }
  return false;
}

/** The import's preview now, as the current person – null when it cannot run (a parse problem is a problem of it). */
function previewNow(p: Payload): DataProductImportPreview {
  return previewImport(importBody(p));
}

const isOpen = (r: Row) => r.status === 'pending';

function view(r: Row, u: AuthUser): McpDataProductsProposal {
  const p = payloadOf(r);
  const mayApply = isOpen(r) && !p.incomplete && mayUse(u);
  let now: McpDataProductsProposal['now'] = null;
  if (mayApply) {
    const n = previewNow(p);
    now = {
      counts: { add: n.counts.add, change: n.counts.change },
      changes: n.changes.filter((c) => c.action === 'add' || c.action === 'change'),
      warnings: n.warnings,
      problems: n.problems,
      ok: !n.problems.length,
      fingerprint: n.fingerprint,
    };
  }
  const nowKeys = now ? new Set(now.changes.map((c) => `${c.kind}\u0000${c.key}`)) : null;
  const proposedChanges = p.proposed?.changes ?? [];
  const shown = proposedChanges.filter((c) => seen(c, u, nowKeys));
  return {
    type: 'dataProducts',
    title: p.title,
    incomplete: p.incomplete,
    document: { bytes: documentBytes(p), sha256: documentSha(p) },
    parts: p.documents.length,
    proposed: {
      counts: p.proposed?.counts ?? { add: 0, change: 0 },
      changes: shown,
      warnings: shown.length === proposedChanges.length ? (p.proposed?.warnings ?? []) : [],
    },
    now,
    changedSince: !!now && !!p.proposed && now.fingerprint !== p.proposed.fingerprint,
    hidden: proposedChanges.length - shown.length,
    result: p.result ?? null,
  };
}

const selectionOf = (s: McpProposalSelection | undefined) =>
  z
    .object({ fingerprint: z.string().trim().max(80) })
    .strict()
    .optional()
    .parse(s?.dataProducts);

/** As the reviewer, before the request is claimed: the preview now must be clean, and confirmed when it changed. */
function precheck(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): void {
  if (!mayUse(u)) throw new HttpError(403, 'You may not apply data products proposals', 'MCP_REQUEST_APPROVE');
  const p = payloadOf(r);
  const n = previewNow(p);
  if (n.problems.length) {
    const first = n.problems[0]!;
    throw new HttpError(
      409,
      `The proposal cannot be applied (${n.problems.length} problem(s)): ${first.path}: ${first.message}`,
      'DATA_PRODUCT_IMPORT_INVALID',
      {
        count: n.problems.length,
        file: first.file,
        path: first.path,
        message: first.message,
      },
    );
  }
  const sel = selectionOf(selection);
  if (p.proposed && n.fingerprint !== p.proposed.fingerprint && sel?.fingerprint !== n.fingerprint)
    throw new HttpError(
      409,
      'The proposal’s preview changed since it was proposed – check the preview of now and accept it again',
      'DATA_PRODUCT_IMPORT_CHANGED',
    );
}

/** Applies the proposal as the reviewer (their rights): the import, mode add and update, in one transaction. */
function apply(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): { body: unknown } {
  const p = payloadOf(r);
  const n = previewNow(p);
  const sel = selectionOf(selection);
  // the preview the reviewer confirmed (changed since), else the proposed one – what else came in between is refused
  const fingerprint = p.proposed && n.fingerprint !== p.proposed.fingerprint ? sel?.fingerprint : n.fingerprint;
  const result = applyImport(importBody(p, fingerprint ?? 'unconfirmed'));
  const counts = { add: result.counts.add, change: result.counts.change };
  db().run('UPDATE mcp_requests SET payload = ? WHERE id = ?', JSON.stringify({ ...p, result: counts }), r.id);
  audit({
    action: 'dataproduct.proposal_applied',
    entityType: 'mcp_request',
    entityId: r.id,
    summary: `Data products proposal "${p.title}" of ${r.requested_by}'s AI assistant applied by ${u.username}: ${counts.add} added, ${counts.change} changed`,
    details: { requestId: r.id, requestedBy: r.requested_by, tokenName: r.token_name, counts, sha256: documentSha(p) },
  });
  return { body: counts };
}

registerReviewKind('dataProducts', {
  // who may create in the module (contributors and managers) or asked for it applies it – the import checks their
  // rights entry by entry; never while incomplete. A viewer, who could change nothing, neither sees nor decides it.
  mayAccept: (u, r) => !payloadOf(r).incomplete && mayUse(u) && (canCreate(u) || r.requested_by.toLowerCase() === u.username.toLowerCase()),
  deciders: (r) => {
    const all = listUsers().filter((x) => {
      if (!x.active) return false;
      const a = toAuthUser(x);
      return x.username.toLowerCase() === r.requested_by.toLowerCase() ? usesModule(a) : canManageModule(a);
    });
    return all.filter((x, i) => all.findIndex((y) => y.id === x.id) === i);
  },
  describe: (r) => {
    const p = payloadOf(r);
    return p.incomplete
      ? `data products proposal "${p.title}" (${p.documents.length} part(s) so far)`
      : `data products proposal "${p.title}" (${p.added} added, ${p.changed} changed)`;
  },
  summary: (r) => {
    const p = payloadOf(r);
    return { type: 'dataProducts', title: p.title, added: p.added, changed: p.changed };
  },
  view,
  precheck,
  apply,
  onRejected: (r, u, o) => {
    audit({
      action: 'dataproduct.proposal_rejected',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Data products proposal "${payloadOf(r).title}" of ${r.requested_by}'s AI assistant ${o.withdrawn ? 'withdrawn' : `rejected by ${u.username}`}${o.comment ? ` – ${o.comment.slice(0, 200)}` : ''}`,
      details: { requestId: r.id, requestedBy: r.requested_by, withdrawn: o.withdrawn, comment: o.comment },
    });
  },
});

// ---------- the tools ----------

const L = DATA_PRODUCT_PROPOSAL_LIMITS;
const visible = () => mayUse(currentUser());

/** Products retired by a proposal: retiring is a person's decision in Steward (it tells consumers). */
function retiring(doc: Record<string, unknown>): string[] {
  const list = [...(Array.isArray(doc.data_products) ? doc.data_products : []), ...(doc.data_product ? [doc.data_product] : [])];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (p as Record<string, unknown>).lifecycle === 'retired')
    .map((p) => String(p.key ?? '?'));
}

export const dataProductProposalTools: ToolDef[] = [
  defineTool({
    name: 'get_data_products_format',
    title: 'Get the data products file format',
    description: `The JSON Schema (${SCHEMA_ID}) of Steward's data products file format, version ${DATA_PRODUCT_FORMAT_VERSION}: domains, data_objects, elements and data_products (with members, ports, bindings, consumers and steps). propose_data_product_changes takes a document of this format.`,
    input: z.object({}).strict(),
    visible,
    handler: () => ({
      schemaId: SCHEMA_ID,
      version: DATA_PRODUCT_FORMAT_VERSION,
      identity:
        'Domains, data objects and products by key; elements by platform (name), kind, qualified_name and environment; ports by direction, name and version; steps by name within their product. Platforms, applications and processes by name, data contracts by their ODCS id.',
      schema: dataProductsJsonSchema(),
    }),
  }),
  defineTool({
    name: 'propose_data_product_changes',
    title: 'Propose data products, elements, ports and steps',
    description: [
      `Proposes additions and changes to the data products module as a document of its file format (get_data_products_format; { "version": ${DATA_PRODUCT_FORMAT_VERSION}, "data_products": [...], "elements": [...], "data_objects": [...], "domains": [...] }). Steward checks it with the import's preview – nothing is written – and a person who uses the module reviews it in Steward (AI requests) and applies or rejects it. You never apply it.`,
      'Only adding and changing: an existing entry takes the keys the document gives (keys left out keep their values); list items (members, ports, consumers, steps) are matched and added or changed, never removed. Retiring a product is refused – a person does that. Never send credentials: a password, token, key or a password in a URL refuses the document.',
      'To document a product from a Snowflake schema, read its discovered elements with search_data_elements and name them (platform, kind, qualified_name, environment) as members, port bindings and step inputs and outputs; elements Steward does not know yet go under "elements". From a dbt manifest: models and sources become elements and steps (inputs → outputs), exposures registered consumers.',
      `Large documents come in parts of at most ${L.partBytes / 1024} KB: the first with more: true (with title and rationale), the next ones with the returned proposalId, the last with more: false – at most ${L.parts} parts. Each part is a document of the format by itself; together they are one import.`,
    ].join('\n\n'),
    input: z
      .object({
        title: z.string().trim().min(3).max(L.title).optional().describe('What the proposal is, in a few words (the first or only part)'),
        rationale: z
          .string()
          .trim()
          .min(5)
          .max(MCP_REQUEST_LIMITS.reason)
          .optional()
          .describe('Why, and where it comes from (a schema, a dbt manifest) – the reviewer sees it (the first or only part)'),
        document: boundedRecord(z.unknown(), 16).describe(`A document of the data products file format, version ${DATA_PRODUCT_FORMAT_VERSION}`),
        proposalId: z.string().min(1).max(100).optional().describe('A further part: the `requestId` of your unfinished proposal'),
        more: z.boolean().default(false).describe('true when further parts follow; the last (or only) part leaves it out'),
      })
      .strict(),
    visible,
    asks: true,
    handler: (a, ctx) => {
      if (!mayUse(currentUser())) throw new ToolError('The data products module is off, or you do not use it');
      const doc = a.document as Record<string, unknown>;
      const what = a.proposalId || a.more ? 'This part' : 'The document';
      const secrets = credentialPlaces(doc);
      if (secrets.length)
        throw new ToolError(
          `${what} holds what looks like a credential – nothing was proposed. Leave out passwords, tokens, keys and passwords in URLs:\n${secrets.map((x) => `- ${x}`).join('\n')}`,
        );
      const retired = retiring(doc);
      if (retired.length) throw new ToolError(`A proposal does not retire products (${retired.join(', ')}) – a person does that in Steward`);
      const text = JSON.stringify(doc);
      if (Buffer.byteLength(text) > L.partBytes)
        throw new ToolError(
          `${what} is too large (at most ${L.partBytes / 1024} KB) – split it into parts: the first with more: true, the next ones with the returned proposalId`,
        );
      if (!a.proposalId && (!a.title || !a.rationale)) throw new ToolError('Give `title` and `rationale` (with the first part of a proposal in parts)');
      const more = a.more === true;
      // each part is a document of the format by itself: its format problems are told now (names it refers to may be in
      // another part – they are checked with the last one)
      const own = dataProductsFileSchema.safeParse(doc);
      const formatProblems = own.success ? [] : issueMessages(own.error.issues);
      if (formatProblems.length && (more || a.proposalId))
        throw new ToolError(
          `${what} is no document of the format – it was not kept. Fix it and send it again:\n${formatProblems
            .slice(0, 20)
            .map((x) => `- ${x.path}: ${x.message}`)
            .join('\n')}`,
        );
      let preview: DataProductImportPreview | null = null;
      const r = saveProposal(ctx, 'dataProducts', {
        proposalId: a.proposalId,
        reason: a.rationale,
        payload: (prev) => {
          const before = prev ? (prev as Payload) : null;
          if (before && before.documents.length >= L.parts) throw new ToolError(`A proposal has at most ${L.parts} parts`);
          const documents = [...(before?.documents ?? []), text];
          const base: Payload = {
            type: 'dataProducts',
            title: before?.title ?? a.title!,
            incomplete: more,
            documents,
            added: 0,
            changed: 0,
            proposed: null,
          };
          if (more) return { ...base };
          // the last part: the preview of all parts together, as the token owner – problems refuse it
          preview = previewImport(importBody(base));
          if (preview.problems.length)
            throw new ToolError(
              `The proposal cannot be applied as it is (${preview.problems.length} problem(s)) – nothing was kept of this part. Fix and send it again:\n${preview.problems
                .slice(0, 30)
                .map((x) => `- ${x.file} ${x.path}: ${x.message}`)
                .join('\n')}`,
            );
          if (!preview.counts.add && !preview.counts.change) throw new ToolError('The proposal changes nothing – Steward has all of it already');
          return {
            ...base,
            added: preview.counts.add,
            changed: preview.counts.change,
            proposed: {
              counts: { add: preview.counts.add, change: preview.counts.change },
              changes: preview.changes.filter((c) => c.action === 'add' || c.action === 'change'),
              warnings: preview.warnings,
              fingerprint: preview.fingerprint,
            },
          };
        },
      });
      const p = preview as DataProductImportPreview | null;
      if (!more && p)
        audit({
          action: 'dataproduct.proposal_created',
          entityType: 'mcp_request',
          entityId: r.requestId,
          summary: `Data products proposal "${a.title ?? ''}" of ${ctx.principal.user.username}'s AI assistant: ${p.counts.add} to add, ${p.counts.change} to change`,
          details: { counts: p.counts, requestedBy: ctx.principal.user.username },
        });
      return {
        ...r,
        ...(p ? { preview: { counts: p.counts, warnings: p.warnings.slice(0, 20) } } : {}),
        note: more
          ? 'Part kept. Send the next part with this proposalId; the last one with more: false.'
          : 'Nothing has been changed yet. A person reviews the proposal in Steward (AI requests) and applies or rejects it.',
      };
    },
  }),
];
