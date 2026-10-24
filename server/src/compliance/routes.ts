import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { z } from 'zod';
import {
  ACCESS_CHECK_SOURCES,
  ACCESS_FINDING_STATUSES,
  CONTROL_TAG_KINDS,
  type AccessReconciliationMeta,
  type ControlTagKind,
  type ControlsMeta,
} from '@sm/shared';
import { config, loopbackUrl } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { on } from '../events.js';
import { onRunReported } from '../reports/auto.js';
import { isAdmin } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { permissionsOfRow } from '../monitors/model.js';
import { HttpError, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { contentDisposition } from '../records/attachments.js';
import { canReadRecordRow } from '../records/access.js';
import { canCreateChecks, canManageCatalogues, canReadCheck, canTagControls, me, readsEverything, same } from './access.js';
import { accessChangeInput, createAccessChange, getAccessChange, listAccessChanges } from './access-changes.js';
import { createRunEntries } from './run-entries.js';
import * as rec from './reconciliation.js';
import * as ctl from './controls.js';
import * as packs from './evidence-pack.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { ensureDefaultTypes } from '../records/types.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const iso = z.string().datetime({ offset: true });
const csv = (v: string | undefined) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

let initialised = false;
/** Automatic entries after runs, re-matching findings when entries are documented. */
export function initCompliance(): void {
  if (initialised) return;
  initialised = true;
  onRunReported((runId, reportId) => createRunEntries(runId, reportId));
  on('record.transitioned', (e) => {
    if (e.action !== 'document' && e.action !== 'verify') return;
    const r = db().get<{ fields: string; type_id: string }>('SELECT fields, type_id FROM records WHERE id = ?', e.recordId);
    if (!r || !db().get("SELECT 1 FROM record_types WHERE id = ? AND workflow = 'access'", r.type_id)) return;
    const platform = parseJson<Record<string, string>>(r.fields, {}).platform;
    if (platform) rec.rematchFindings(platform, e.recordId);
  });
}

/** Compliance (web UI API): access changes, access reconciliation, controls and evidence packs. Permissions are checked in the services. */
export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  initCompliance();

  // ---------- access change entries ----------
  app.get('/compliance/access-changes', async (req) => {
    const q = z
      .object({
        platformId: z.string().max(100).optional(),
        subject: z.string().max(200).optional(),
        status: z.string().max(200).optional(),
        kind: z.string().max(20).optional(),
        from: iso.optional(),
        to: iso.optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
      })
      .parse(req.query);
    return listAccessChanges({ ...q, status: csv(q.status) });
  });
  app.get('/compliance/access-changes/:accessChangeId', async (req) => getAccessChange(params(req).accessChangeId!));
  app.post('/compliance/access-changes', async (req) => {
    const b = accessChangeInput
      .extend({ document: z.boolean().default(false), requestUrl: z.string().url().max(2000).optional() })
      .strict()
      .parse(req.body);
    const { document, requestUrl, ...input } = b;
    const links: NonNullable<NonNullable<Parameters<typeof createAccessChange>[1]>['links']> = [{ kind: 'platform', id: input.platformId, note: 'platform' }];
    if (requestUrl && /^https?:\/\//i.test(requestUrl)) links.push({ url: requestUrl, label: input.requestRef || 'Request', note: 'request' });
    return createAccessChange({ ...input, origin: 'manual' }, { document, links });
  });

  // ---------- access reconciliation ----------
  app.get('/compliance/reconciliation/meta', async (): Promise<AccessReconciliationMeta> => ({
    canCreate: canCreateChecks(me()),
    demo: config.demo,
    sources: [...ACCESS_CHECK_SOURCES],
  }));
  app.get('/compliance/access-checks', async () => rec.listChecks());
  app.post('/compliance/access-checks', async (req) => rec.createCheck(rec.checkInput.parse(req.body)));
  app.get('/compliance/access-checks/:accessCheckId', async (req) => rec.getCheck(params(req).accessCheckId!));
  app.put('/compliance/access-checks/:accessCheckId', async (req) => rec.updateCheck(params(req).accessCheckId!, rec.checkInput.parse(req.body)));
  app.delete('/compliance/access-checks/:accessCheckId', async (req, reply) => {
    rec.deleteCheck(params(req).accessCheckId!);
    return reply.code(204).send();
  });
  app.post('/compliance/access-checks/:accessCheckId/run', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const u = me();
    const c = rec.getCheck(params(req).accessCheckId!);
    if (!c.canRun) throw new HttpError(403, 'You are not allowed to run this access check', 'FORBIDDEN', { context: 'changeAccessCheck' });
    return rec.runCheck(c.id, { actor: u.username, trigger: 'manual' });
  });
  app.get('/compliance/access-checks/:accessCheckId/snapshots', async (req) => {
    const q = z.object({ from: iso.optional(), to: iso.optional(), limit: z.coerce.number().int().min(1).max(5000).optional() }).parse(req.query);
    return rec.listSnapshots(params(req).accessCheckId!, q);
  });
  app.get('/compliance/access-checks/:accessCheckId/snapshots/:snapshotId', async (req) =>
    rec.getSnapshot(params(req).accessCheckId!, params(req).snapshotId!),
  );
  app.get('/compliance/access-checks/:accessCheckId/verify', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) =>
    rec.verifyCheck(params(req).accessCheckId!),
  );
  app.get('/compliance/findings', async (req) => {
    const q = z
      .object({ checkId: z.string().max(100).optional(), platformId: z.string().max(100).optional(), status: z.enum(ACCESS_FINDING_STATUSES).optional() })
      .parse(req.query);
    return rec.listFindings(q);
  });
  app.post('/compliance/findings/:findingId/document', async (req) => rec.documentFinding(params(req).findingId!, rec.documentInput.parse(req.body)));
  app.post('/compliance/findings/:findingId/dismiss', async (req) => {
    const b = z
      .object({ comment: z.string().max(2000) })
      .strict()
      .parse(req.body);
    return rec.dismissFinding(params(req).findingId!, b.comment);
  });
  /** Demo mode: someone grants the tenant administrator role in the simulated Insights Hub, outside Steward; the demo check runs right after. */
  app.post('/compliance/demo/simulate-change', async (req) => {
    if (!config.demo) throw new HttpError(404, 'Demo mode is not enabled', 'DEMO_DISABLED');
    const u = me();
    if (!isAdmin(u) && !u.roles.includes('designer'))
      throw new HttpError(403, 'Only designers and administrators can simulate changes', 'FORBIDDEN', { context: 'createAccessChecks' });
    const b = z
      .object({ accessCheckId: z.string().max(100) })
      .strict()
      .parse(req.body);
    const c = rec.getCheck(b.accessCheckId);
    if (c.source !== 'insights-hub') throw new HttpError(400, 'The simulation works with Insights Hub checks of the demo platform', 'DEMO_CHECK_ONLY');
    const p = db().get<{ base_url: string }>('SELECT base_url FROM platforms WHERE id = ?', c.platformId);
    if (!p || !p.base_url.startsWith(`${loopbackUrl()}/mock/ih`))
      throw new HttpError(400, 'The check does not use the simulated Insights Hub', 'DEMO_CHECK_ONLY');
    const res = await fetch(`${loopbackUrl()}/mock/ih/demo/grant-admin`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new HttpError(409, 'Every demo user is a tenant administrator already – reset the demo (restart) to try again', 'DEMO_ALL_ADMINS');
    const granted = (await res.json()) as { userName: string; role: string };
    audit({
      action: 'demo.access_changed',
      entityType: 'platform',
      entityId: c.platformId,
      summary: `Demo: ${granted.role} granted to ${granted.userName} in the simulated Insights Hub (outside Steward)`,
    });
    return { granted, result: c.canRun ? await rec.runCheck(c.id, { actor: u.username, trigger: 'demo' }) : null };
  });

  // ---------- controls ----------
  app.get('/compliance/meta', async (): Promise<ControlsMeta> => {
    const u = me();
    return { canManageCatalogues: canManageCatalogues(u), canTag: canTagControls(u), tagKinds: CONTROL_TAG_KINDS };
  });
  app.get('/compliance/catalogues', async () => ctl.listCatalogues());
  app.post('/compliance/catalogues', async (req) => ctl.createCatalogue(ctl.catalogueInput.parse(req.body)));
  app.put('/compliance/catalogues/:catalogueId', async (req) =>
    ctl.updateCatalogue(params(req).catalogueId!, ctl.catalogueInput.omit({ key: true }).parse(req.body)),
  );
  app.delete('/compliance/catalogues/:catalogueId', async (req, reply) => {
    ctl.deleteCatalogue(params(req).catalogueId!);
    return reply.code(204).send();
  });
  app.post('/compliance/catalogues/import', { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: ctl.LIMITS.importBytes * 2 + 16 * 1024 }, async (req) => {
    const b = z
      .object({
        catalogueId: z.string().max(100).optional(),
        key: z.string().max(40).optional(),
        name: z.string().max(120).optional(),
        filename: z.string().min(1).max(255),
        content: z.string().max(ctl.LIMITS.importBytes),
      })
      .strict()
      .parse(req.body);
    return ctl.importCatalogue(b);
  });
  app.post('/compliance/catalogues/:catalogueId/controls', async (req) =>
    ctl.addControl(
      params(req).catalogueId!,
      z
        .object({ ref: z.string(), title: z.string(), description: z.string().default('') })
        .strict()
        .parse(req.body),
    ),
  );
  app.get('/compliance/controls', async (req) => ctl.listControls(z.object({ catalogue: z.string().max(60).optional() }).parse(req.query).catalogue));
  app.get('/compliance/controls/:controlId', async (req) => ctl.getControl(params(req).controlId!));
  app.put('/compliance/controls/:controlId', async (req) =>
    ctl.updateControl(
      params(req).controlId!,
      z
        .object({ title: z.string(), description: z.string().default('') })
        .strict()
        .parse(req.body),
    ),
  );
  app.post('/compliance/controls/:controlId/tags', async (req) => ctl.addTag(params(req).controlId!, ctl.tagInput.parse(req.body)));
  app.post('/compliance/controls/:controlId/tags/remove', async (req) => {
    const b = ctl.tagInput.parse(req.body);
    return ctl.removeTag(params(req).controlId!, b.kind, b.targetId);
  });
  app.get('/compliance/coverage', async (req) => {
    const q = ctl.periodQuery.and(z.object({ catalogue: z.string().max(60).optional() })).parse(req.query);
    return ctl.coverage({ from: q.from, to: q.to }, { catalogue: q.catalogue });
  });
  app.get('/compliance/tagged', async (req) => {
    const q = z.object({ kind: z.enum(CONTROL_TAG_KINDS), targetId: z.string().min(1).max(200) }).parse(req.query);
    return ctl.controlsOf(q.kind, q.targetId);
  });
  /** Items that can be mapped to controls (only what the user can see). */
  app.get('/compliance/tag-targets', async (req) => {
    const q = z.object({ kind: z.enum(CONTROL_TAG_KINDS), q: z.string().max(100).default('') }).parse(req.query);
    return tagTargets(q.kind, q.q);
  });

  // ---------- evidence packs ----------
  app.get('/compliance/evidence-packs/meta', async () => packs.packsMeta());
  app.get('/compliance/evidence-packs', async () => packs.listPacks());
  app.post('/compliance/evidence-packs', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => packs.createPack(packs.packInput.parse(req.body)));
  app.get('/compliance/evidence-packs/:packId', async (req) => packs.getPack(params(req).packId!));
  app.delete('/compliance/evidence-packs/:packId', async (req, reply) => {
    packs.deletePack(params(req).packId!);
    return reply.code(204).send();
  });
  app.get('/compliance/evidence-packs/:packId/download', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
    const f = packs.packForDownload(params(req).packId!);
    reply.header('content-disposition', contentDisposition(f.filename));
    reply.header('content-length', String(f.size));
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.type('application/zip').send(fs.createReadStream(f.file));
  });
}

function tagTargets(kind: ControlTagKind, text: string): { id: string; label: string }[] {
  const u = me();
  const like = `%${likeEscape(text.trim().toLowerCase())}%`;
  const LIMIT = 50;
  switch (kind) {
    case 'process':
      return db()
        .all<{ id: string; name: string }>("SELECT id, name FROM processes WHERE archived = 0 AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 500", like)
        .filter((p) => permissionsFor(p.id).includes('view'))
        .slice(0, LIMIT)
        .map((p) => ({ id: p.id, label: p.name }));
    case 'recordType':
      ensureDefaultTypes(); // the built-in types exist before anyone opened the records pages
      return db()
        .all<{ id: string; key: string; name: string }>(
          "SELECT id, key, name FROM record_types WHERE lower(key) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
          like,
          like,
          LIMIT,
        )
        .map((t) => ({ id: t.id, label: `${t.key} – ${t.name}` }));
    case 'record':
      return db()
        .all<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string }>(
          "SELECT id, number, title, type_id, fields, owner FROM records WHERE lower(number) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 500",
          like,
          like,
        )
        .filter((r) => canReadRecordRow(u, r))
        .slice(0, LIMIT)
        .map((r) => ({ id: r.id, label: `${r.number} ${r.title}` }));
    case 'monitor':
      return db()
        .all<{ id: string; name: string; owner: string; acl: string }>(
          "SELECT id, name, owner, acl FROM monitors WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 500",
          like,
        )
        .filter((m) => permissionsOfRow(m, u).includes('view'))
        .slice(0, LIMIT)
        .map((m) => ({ id: m.id, label: m.name }));
    case 'reportSchedule':
      return db()
        .all<{ id: string; name: string; owner: string }>(
          "SELECT id, name, owner FROM report_schedules WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 500",
          like,
        )
        .filter((s) => readsEverything(u) || same(s.owner, u.username))
        .slice(0, LIMIT)
        .map((s) => ({ id: s.id, label: s.name }));
    case 'accessCheck':
      return db()
        .all<{ id: string; name: string; owner: string; platform_id: string }>(
          "SELECT id, name, owner, platform_id FROM access_checks WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 500",
          like,
        )
        .filter((c) => canReadCheck(u, c))
        .slice(0, LIMIT)
        .map((c) => ({ id: c.id, label: c.name }));
  }
}
