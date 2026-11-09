import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PLANT_CHANGESET_LIMITS,
  PLANT_CHANGESET_OPEN,
  PLANT_CHANGESET_SOURCES,
  PLANT_CHANGESET_STATES,
  PLANT_ENTRY_KINDS,
  PLANT_ENTRY_SCOPE,
  plantChangeApplyInput,
  plantChangeCommentInput,
  plantChangeOperationInput,
  plantChangeResolveInput,
  plantChangeSetCreateInput,
  plantChangeSetPatchInput,
  type PlantChangeSetConfig,
  type PlantChangeSetDetail,
  type PlantChangeSetList,
  type PlantOpenChanges,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { me } from '../../auth/access.js';
import { ROUTE_LIMITS } from '../../rateLimits.js';
import { HttpError, nowIso, parseJson } from '../../util.js';
import { canManageCatalogue, plantProposesSome, siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { currentParams } from '../ids.js';
import {
  applyStored,
  canSee,
  catalogueReview,
  changeSetLevel,
  detailOf,
  expireChangeSets,
  insertChangeSet,
  insertOp,
  isAuthor,
  opsOf,
  previewOf,
  rememberWhere,
  reviewNeeded,
  rightsProblem,
  rowOf,
  setCatalogueReview,
  stepUpPointsOf,
  summaryOf,
  touch,
  visibleRow,
  whereOfOps,
  type CsRow,
} from './core.js';
import { addOperation, checkOpenLimits, currentDraftRow, documentOperation, editableDraft, ensureDraft, operationOf } from './drafts.js';
import { entryHistory, revert } from './history.js';
import { notifyDecided, notifyProposed, registerChangeSetHeldCheck } from './notify.js';

/**
 * The change sets' API (0.13.0, internal, docs/PLANT.md "Change sets"), under /api/plant:
 *
 *   GET    change-sets?box=drafts|review|applied|closed|mine&site=&source=     the inbox (Plant → Changes)
 *   POST   change-sets                                    a new draft (the person's current one)
 *   GET    change-sets/open?kind=&scope=&id= | ?site=     open changes of an entry or a site (the chips)
 *   GET    change-sets/settings, PUT …                    plant.changeSet and the catalogue's switch
 *   GET    change-sets/:id, PATCH …                       one change set; its title, "current draft"
 *   POST   change-sets/:id/operations (:id may be "current"), PUT|DELETE …/operations/:seq
 *   POST   change-sets/:id/preview | propose | withdraw | return | resolve | apply | reject | revert | copy
 *   GET    history?kind=&scope=&id=, POST history/:id/revert
 */

const box = z.enum(['drafts', 'review', 'applied', 'closed', 'mine']);
const listQuery = z.object({
  box: box.default('review'),
  site: z.string().max(100).optional(),
  source: z.enum(PLANT_CHANGESET_SOURCES).optional(),
  state: z.enum(PLANT_CHANGESET_STATES).optional(),
});

const LIST_LIMIT = 200;

export function listChangeSets(q: z.infer<typeof listQuery>, u: AuthUser = me()): PlantChangeSetList {
  requirePlant();
  expireChangeSets();
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const states =
    q.state !== undefined
      ? [q.state]
      : q.box === 'drafts'
        ? ['draft']
        : q.box === 'review'
          ? ['proposed']
          : q.box === 'applied'
            ? ['applied']
            : q.box === 'closed'
              ? ['rejected', 'withdrawn', 'expired']
              : [...PLANT_CHANGESET_STATES];
  const rows = db().all<CsRow>(
    `SELECT * FROM plant_change_sets WHERE state IN (${states.map(() => '?').join(', ')})${q.source ? ' AND source = ?' : ''} ORDER BY updated_at DESC LIMIT 2000`,
    ...states,
    ...(q.source ? [q.source] : []),
  );
  const items = rows
    .filter((r) => {
      if (q.box === 'drafts' || q.box === 'mine') return isAuthor(r, u);
      if (!canSee(r, u, rights)) return false;
      if (q.box === 'review') return !isAuthor(r, u) && !rightsProblem(r, u);
      return true;
    })
    .filter((r) => !q.site || parseJson<string[]>(r.sites, []).includes(q.site))
    .slice(0, LIST_LIMIT);
  return { items: items.map((r) => summaryOf(r, u)), toReview: toReview(u) };
}

/** How many proposed change sets `u` may decide (the count on Plant → Changes). */
export function toReview(u: AuthUser = me()): number {
  return db()
    .all<CsRow>("SELECT * FROM plant_change_sets WHERE state = 'proposed' ORDER BY updated_at DESC LIMIT 2000")
    .filter((r) => !isAuthor(r, u) && !rightsProblem(r, u)).length;
}

/** What the plant pages need to know about change sets (GET /api/plant/config). */
export function changeSetConfig(u: AuthUser = me()): PlantChangeSetConfig {
  const draft = currentDraftRow(u);
  return {
    level: changeSetLevel() as PlantChangeSetConfig['level'],
    catalogueReview: catalogueReview(),
    canPropose: plantProposesSome(u),
    draft: draft ? summaryOf(draft, u) : null,
  };
}

/** Open change sets that touch an entry (its operations), or a site. */
export function openChanges(q: { kind?: string; scope?: string; id?: string; site?: string }, u: AuthUser = me()): PlantOpenChanges {
  requirePlant();
  expireChangeSets();
  let rows: CsRow[];
  if (q.site) {
    rows = db()
      .all<CsRow>("SELECT * FROM plant_change_sets WHERE state IN ('draft', 'proposed') ORDER BY updated_at DESC LIMIT 2000")
      .filter((r) => parseJson<string[]>(r.sites, []).includes(q.site!) || whereOfOps(opsOf(r.id)).sites.includes(q.site!));
  } else {
    const kind = PLANT_ENTRY_KINDS.find((k) => k === q.kind);
    if (!kind || !q.id) throw new HttpError(400, 'Give kind and id, or site', 'INVALID_INPUT', { details: 'kind, id' });
    const scope = PLANT_ENTRY_SCOPE[kind] === 'none' ? '' : (q.scope ?? '');
    rows = db().all<CsRow>(
      `SELECT DISTINCT c.* FROM plant_change_sets c JOIN plant_change_ops o ON o.change_set_id = c.id
       WHERE c.state IN ('draft', 'proposed') AND o.kind = ? AND o.scope = ? AND o.entry_id = ? ORDER BY c.updated_at DESC LIMIT 200`,
      kind,
      scope,
      q.id,
    );
  }
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const seen = rows.filter((r) => canSee(r, u, rights));
  const own = (r: CsRow) => isAuthor(r, u) && r.state === 'draft';
  return {
    count: seen.length,
    mine: seen.filter(own).length,
    items: seen.slice(0, 20).map((r) => ({ id: r.id, title: r.title, state: r.state, createdBy: r.created_by, own: own(r) })),
  };
}

const auditCs = (r: Pick<CsRow, 'id' | 'title' | 'source' | 'created_by'>, action: string, summary: string, details: Record<string, unknown> = {}) =>
  audit({
    action: `plant.change_set_${action}`,
    entityType: 'plant_change_set',
    entityId: r.id,
    summary,
    details: { source: r.source, createdBy: r.created_by, ...details },
  });

const detail = (id: string, u: AuthUser = me()): PlantChangeSetDetail => detailOf(rowOf(id)!, u);

/** The step-up points of applying a stored change set (route config, read once per request). */
const pointsCache = new WeakMap<FastifyRequest, string[]>();
function applyPoints(req: FastifyRequest): string[] {
  let x = pointsCache.get(req);
  if (!x) {
    const r = rowOf((req.params as { changeSetId?: string }).changeSetId ?? '');
    x = r ? stepUpPointsOf(opsOf(r.id), r.source) : [];
    pointsCache.set(req, x);
  }
  return x;
}

/** The person's draft, or the change set the path names (only their own drafts). */
function draftOf(id: string, u: AuthUser): CsRow {
  requirePlant();
  if (id === 'current') {
    if (!plantProposesSome(u)) throw new HttpError(403, 'You may not propose changes to the plant registry', 'FORBIDDEN', { context: 'proposePlant' });
    return ensureDraft(u);
  }
  return editableDraft(id, u);
}

/** The assistant's proposal is decided through its AI request (both inboxes show it). */
async function viaRequest(r: CsRow, approve: boolean, comment: string, fingerprint?: string): Promise<void> {
  const { decide } = await import('../../mcp/requests.js');
  const { proposalFingerprintNow } = await import('../proposals.js');
  if (approve) {
    // what the reviewer saw here: the change set's preview – its fingerprint is checked again inside the apply
    const pre = previewOf(r);
    if (pre.fingerprint !== fingerprint)
      throw new HttpError(409, 'What the change set writes is no longer what the preview showed – look at the preview again', 'PLANT_CHANGESET_CHANGED', {
        id: r.id,
      });
    await decide(r.mcp_request_id!, { approve: true, comment, selection: { plant: { fingerprint: proposalFingerprintNow(r.mcp_request_id!) } } });
  } else await decide(r.mcp_request_id!, { approve: false, comment });
}

export async function changeSetRoutes(app: FastifyInstance): Promise<void> {
  const writeLimit = { config: { rateLimit: ROUTE_LIMITS.action } };
  // held messages about change sets (quiet hours, digests) are checked again when they are released
  await registerChangeSetHeldCheck();

  app.get('/plant/change-sets', async (req) => listChangeSets(listQuery.parse(req.query ?? {})));
  app.post('/plant/change-sets', writeLimit, async (req) => {
    requirePlant();
    const u = me();
    if (!plantProposesSome(u)) throw new HttpError(403, 'You may not propose changes to the plant registry', 'FORBIDDEN', { context: 'proposePlant' });
    const b = plantChangeSetCreateInput.parse(req.body);
    checkOpenLimits(u);
    const id = insertChangeSet({ state: 'draft', source: 'draft', title: b.title, by: u.username, current: b.current });
    auditCs(rowOf(id)!, 'created', `Plant change set "${b.title}" started (draft)`);
    return detail(id);
  });
  app.get('/plant/change-sets/open', async (req) => {
    const q = z
      .object({
        kind: z.string().max(40).optional(),
        scope: z.string().max(120).optional(),
        id: z.string().max(120).optional(),
        site: z.string().max(100).optional(),
      })
      .parse(req.query ?? {});
    // old ids lead to their entries
    const c = currentParams({ siteId: q.site, assetId: q.kind === 'asset' ? q.id : undefined });
    return openChanges({ ...q, site: c.siteId, id: q.kind === 'asset' ? c.assetId : q.id });
  });
  app.get('/plant/change-sets/settings', async () => {
    requirePlant();
    return { level: changeSetLevel(), catalogueReview: catalogueReview() };
  });
  // the catalogue's switch: who manages device profiles and KPI definitions, confirmed as an access grant
  app.put('/plant/change-sets/settings', { config: { stepUp: { action: 'grantAccess' } } }, async (req) => {
    requirePlant();
    if (!canManageCatalogue(me())) throw new HttpError(403, 'You may not change the catalogue’s settings', 'FORBIDDEN', { context: 'managePlantCatalogue' });
    setCatalogueReview(z.object({ catalogueReview: z.boolean() }).strict().parse(req.body).catalogueReview);
    return { level: changeSetLevel(), catalogueReview: catalogueReview() };
  });
  app.get('/plant/change-sets/:changeSetId', async (req) => {
    const u = me();
    return detailOf(visibleRow((req.params as { changeSetId: string }).changeSetId, u), u);
  });
  app.patch('/plant/change-sets/:changeSetId', writeLimit, async (req) => {
    const u = me();
    const r = editableDraft((req.params as { changeSetId: string }).changeSetId, u);
    const b = plantChangeSetPatchInput.parse(req.body);
    db().tx(() => {
      if (b.title !== undefined) db().run('UPDATE plant_change_sets SET title = ? WHERE id = ?', b.title, r.id);
      if (b.current === true) {
        db().run('UPDATE plant_change_sets SET current_of = NULL WHERE current_of = ?', u.username);
        db().run('UPDATE plant_change_sets SET current_of = ? WHERE id = ?', u.username, r.id);
      } else if (b.current === false) db().run('UPDATE plant_change_sets SET current_of = NULL WHERE id = ?', r.id);
      touch(r.id, u.username);
    });
    return detail(r.id, u);
  });

  // ---------- operations of a draft ----------
  app.post('/plant/change-sets/:changeSetId/operations', writeLimit, async (req) => {
    const u = me();
    const raw = (req.body ?? {}) as { op?: unknown; value?: unknown };
    const id = (req.params as { changeSetId: string }).changeSetId;
    return db().tx(() => {
      const r = draftOf(id, u);
      const op = raw.op === 'import' || raw.op === 'bulk' ? documentOperation(raw.op, raw.value, u) : operationOf(plantChangeOperationInput.parse(req.body), u);
      const seq = addOperation(r, op, u);
      return { ...detail(r.id, u), seq };
    });
  });
  app.put('/plant/change-sets/:changeSetId/operations/:seq', writeLimit, async (req) => {
    const u = me();
    const { changeSetId: id, seq } = req.params as { changeSetId: string; seq: string };
    const r = draftOf(id, u);
    const o = opsOf(r.id).find((x) => String(x.seq) === seq);
    if (!o || !o.kind || (o.op !== 'set' && o.op !== 'add')) throw new HttpError(404, `Change ${seq} not found`, 'PLANT_CHANGESET_NOT_FOUND', { id: seq });
    const value = z.object({ value: z.unknown() }).strict().parse(req.body).value;
    const next = operationOf({ op: o.op, kind: o.kind, scope: o.scope, id: o.entry_id, value }, u);
    db().tx(() => {
      db().run(
        'UPDATE plant_change_ops SET value = ?, author = ?, updated_at = ? WHERE change_set_id = ? AND seq = ?',
        JSON.stringify(next.value),
        u.username,
        nowIso(),
        r.id,
        o.seq,
      );
      touch(r.id, u.username);
    });
    return detail(r.id, u);
  });
  app.delete('/plant/change-sets/:changeSetId/operations/:seq', writeLimit, async (req) => {
    const u = me();
    const { changeSetId: id, seq } = req.params as { changeSetId: string; seq: string };
    const r = draftOf(id, u);
    db().tx(() => {
      if (db().run('DELETE FROM plant_change_ops WHERE change_set_id = ? AND seq = ?', r.id, Number(seq) || 0).changes !== 1)
        throw new HttpError(404, `Change ${seq} not found`, 'PLANT_CHANGESET_NOT_FOUND', { id: seq });
      db().run('DELETE FROM plant_change_sources WHERE change_set_id = ? AND seq = ?', r.id, Number(seq) || 0);
      touch(r.id, u.username);
    });
    return detail(r.id, u);
  });

  // ---------- review ----------
  app.post('/plant/change-sets/:changeSetId/preview', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    const p = previewOf(r, u);
    if (PLANT_CHANGESET_OPEN.includes(r.state)) rememberWhere(r, p);
    const { sites: _s, catalogue: _c, ...preview } = p;
    return preview;
  });
  app.post('/plant/change-sets/:changeSetId/propose', writeLimit, async (req) => {
    const u = me();
    const r = editableDraft((req.params as { changeSetId: string }).changeSetId, u);
    const p = previewOf(r, u);
    if (!opsOf(r.id).length) throw new HttpError(409, 'The draft has no changes yet', 'PLANT_CHANGESET_EMPTY', { id: r.id });
    const at = nowIso();
    db().tx(() => {
      db().run(
        `UPDATE plant_change_sets SET state = 'proposed', current_of = NULL, proposed_at = ?, proposed_by = ?, updated_at = ?, sites = ?, catalogue = ?, review = ?, expires_at = ? WHERE id = ? AND state = 'draft'`,
        at,
        u.username,
        at,
        JSON.stringify(p.sites),
        p.catalogue ? 1 : 0,
        reviewNeeded(p.sites, p.catalogue) ? 1 : 0,
        new Date(Date.now() + PLANT_CHANGESET_LIMITS.proposedDays * 86_400_000).toISOString(),
        r.id,
      );
      auditCs(
        r,
        'proposed',
        `Plant change set "${r.title}" proposed by ${u.username}: ${p.counts.add} added, ${p.counts.change} changed, ${p.counts.rename} renamed, ${p.counts.remove} removed`,
        {
          counts: p.counts,
          sites: p.sites.slice(0, 50),
          fingerprint: p.fingerprint,
        },
      );
    });
    notifyProposed(r.id);
    return detail(r.id, u);
  });
  app.post('/plant/change-sets/:changeSetId/withdraw', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    if (!PLANT_CHANGESET_OPEN.includes(r.state) || !isAuthor(r, u))
      throw new HttpError(409, 'Only its author withdraws an open change set', 'PLANT_CHANGESET_DECIDE', { id: r.id });
    if (r.source === 'assistant' && r.mcp_request_id) await viaRequest(r, false, '');
    else
      db().tx(() => {
        db().run(
          "UPDATE plant_change_sets SET state = 'withdrawn', current_of = NULL, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?",
          nowIso(),
          u.username,
          nowIso(),
          r.id,
        );
        auditCs(r, 'withdrawn', `Plant change set "${r.title}" withdrawn by ${u.username}`);
      });
    return detail(r.id, u);
  });
  app.post('/plant/change-sets/:changeSetId/return', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    const { comment } = plantChangeCommentInput.parse(req.body ?? {});
    if (r.state !== 'proposed' || isAuthor(r, u) || rightsProblem(r, u) || r.source === 'assistant')
      throw new HttpError(409, 'Only a reviewer returns a proposed change set to its author', 'PLANT_CHANGESET_DECIDE', { id: r.id });
    db().tx(() => {
      db().run(
        "UPDATE plant_change_sets SET state = 'draft', comment = ?, updated_at = ?, expires_at = ? WHERE id = ? AND state = 'proposed'",
        comment,
        nowIso(),
        new Date(Date.now() + PLANT_CHANGESET_LIMITS.draftDays * 86_400_000).toISOString(),
        r.id,
      );
      auditCs(r, 'returned', `Plant change set "${r.title}" returned to its author by ${u.username}${comment ? ` – ${comment.slice(0, 200)}` : ''}`, {
        comment,
      });
    });
    notifyDecided(r.id, 'returned', u.username, comment);
    return detail(r.id, u);
  });
  app.post('/plant/change-sets/:changeSetId/resolve', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    const b = plantChangeResolveInput.parse(req.body);
    // the author in their draft, or a reviewer of a proposed one
    const mayResolve = (r.state === 'draft' && isAuthor(r, u)) || (r.state === 'proposed' && !isAuthor(r, u) && !rightsProblem(r, u));
    if (!mayResolve) throw new HttpError(409, 'You may not resolve conflicts of this change set', 'PLANT_CHANGESET_DECIDE', { id: r.id });
    const before = parseJson<{ seq: number; path: string; choice: string }[]>(r.resolutions, []);
    const next = [...before.filter((x) => !b.choices.some((c) => c.seq === x.seq && c.path === x.path)), ...b.choices];
    db().tx(() => {
      db().run('UPDATE plant_change_sets SET resolutions = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), r.id);
      auditCs(r, 'resolved', `Conflicts of plant change set "${r.title}" resolved by ${u.username} (${b.choices.length})`, {
        choices: b.choices.slice(0, 100),
      });
    });
    return detail(r.id, u);
  });
  app.post(
    '/plant/change-sets/:changeSetId/apply',
    {
      config: {
        rateLimit: ROUTE_LIMITS.heavy,
        // 0.11's rules per source: more than one removal or rename, many edits, one rename (stored operations)
        stepUp: {
          action: 'changePlantInBulk',
          when: (req: FastifyRequest) => plantChangeApplyInput.safeParse(req.body).success && applyPoints(req).length > 0,
          points: applyPoints,
        },
      },
    },
    async (req) => {
      const u = me();
      const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
      const { fingerprint } = plantChangeApplyInput.parse(req.body);
      if (r.source === 'assistant' && r.mcp_request_id) await viaRequest(r, true, '', fingerprint);
      else {
        applyStored(r.id, fingerprint, u);
        // its other authors learn that it was applied (who applied it is not told)
        notifyDecided(r.id, 'applied', u.username);
      }
      return detail(r.id, u);
    },
  );
  app.post('/plant/change-sets/:changeSetId/reject', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    const { comment } = plantChangeCommentInput.parse(req.body ?? {});
    if (r.state !== 'proposed' || isAuthor(r, u) || rightsProblem(r, u))
      throw new HttpError(409, 'Only a reviewer rejects a proposed change set', 'PLANT_CHANGESET_DECIDE', { id: r.id });
    if (r.source === 'assistant' && r.mcp_request_id) await viaRequest(r, false, comment);
    else
      db().tx(() => {
        if (
          db().run(
            "UPDATE plant_change_sets SET state = 'rejected', decided_at = ?, decided_by = ?, comment = ?, updated_at = ? WHERE id = ? AND state = 'proposed'",
            nowIso(),
            u.username,
            comment,
            nowIso(),
            r.id,
          ).changes !== 1
        )
          throw new HttpError(409, 'The change set is no longer open', 'PLANT_CHANGESET_DECIDE', { id: r.id });
        auditCs(r, 'rejected', `Plant change set "${r.title}" rejected by ${u.username}${comment ? ` – ${comment.slice(0, 200)}` : ''}`, { comment });
      });
    if (r.source !== 'assistant') notifyDecided(r.id, 'rejected', u.username, comment);
    return detail(r.id, u);
  });
  app.post('/plant/change-sets/:changeSetId/revert', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    const out = revert({ changeSetId: r.id }, u);
    return { ...detail(out.id, u), skipped: out.skipped };
  });
  app.post('/plant/change-sets/:changeSetId/copy', writeLimit, async (req) => {
    const u = me();
    const r = visibleRow((req.params as { changeSetId: string }).changeSetId, u);
    if (!['rejected', 'withdrawn', 'expired'].includes(r.state) || r.source === 'assistant' || !plantProposesSome(u))
      throw new HttpError(409, 'Only a rejected, withdrawn or expired change set is copied into a new draft', 'PLANT_CHANGESET_DECIDE', { id: r.id });
    checkOpenLimits(u);
    const id = db().tx(() => {
      const id = insertChangeSet({ state: 'draft', source: 'draft', title: r.title, by: u.username, current: true, copiedFrom: r.id });
      for (const o of opsOf(r.id)) {
        const source = db().get<{ content: string }>('SELECT content FROM plant_change_sources WHERE change_set_id = ? AND seq = ?', r.id, o.seq)?.content;
        insertOp(
          id,
          {
            op: o.op,
            kind: o.kind,
            scope: o.scope,
            id: o.entry_id,
            name: o.name,
            origin: o.origin,
            baseRevision: o.base_revision === null ? null : Number(o.base_revision),
            base: parseJson(o.base, null),
            value: parseJson(o.value, null),
            ...(source !== undefined ? { source } : {}),
          },
          u.username,
        );
      }
      auditCs(rowOf(id)!, 'created', `Plant change set "${r.title}" started from ${r.id} (copy)`, { copiedFrom: r.id });
      return id;
    });
    return detail(id, u);
  });

  // ---------- history ----------
  app.get('/plant/history', async (req) => {
    const q = z
      .object({
        kind: z.enum(PLANT_ENTRY_KINDS),
        scope: z.string().max(120).default(''),
        id: z.string().min(1).max(120),
        children: z.enum(['0', '1']).default('0'),
      })
      .parse(req.query ?? {});
    // old ids lead to their entries
    const id = q.kind === 'site' ? currentParams({ siteId: q.id }).siteId! : q.kind === 'asset' ? currentParams({ assetId: q.id }).assetId! : q.id;
    return entryHistory(q.kind, q.scope, id, me(), q.children === '1');
  });
  app.post('/plant/history/:historyId/revert', writeLimit, async (req) => {
    const u = me();
    const out = revert({ historyId: (req.params as { historyId: string }).historyId }, u);
    return { ...detail(out.id, u), skipped: out.skipped };
  });
}

export { currentDraftRow, reviewNeeded };
