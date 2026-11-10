import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PlantChangeSetSummary, PlantEntryKind } from '@sm/shared';
import { me } from '../../auth/access.js';
import { asProposer } from '../access.js';
import { CATALOGUE_KINDS, PER_ASSET, bodyOf, readEntry } from './entries.js';
import { applyDirect, quietDryRun, regionOf, reviewNeeded, rowOf, summaryOf, type NewOp } from './core.js';
import type { EntryChange } from './track.js';
import { addOperation, ensureDraft, entryChanged, mayPropose, operationOf, siteOfTarget } from './drafts.js';

/**
 * The edit forms' routes through change sets (0.13.0, ADR 0020). They keep their paths, bodies, answers and audit
 * actions; a save becomes a change set of one operation:
 *
 * - **Without review** it is created and applied in the request (source edit) – exactly as before, plus history and
 *   the entry's new revision. A body with `revision` (what the form loaded) that is no longer the entry's is refused
 *   with 409 PLANT_ENTRY_CHANGED and what the form needs for its choice per field; a body without it (scripts, 0.12
 *   clients) writes as before.
 * - **Where review is required** (plant.changeSet), or the request asks for it (header `X-SM-Draft: 1`: who may propose
 *   but not manage), the save goes into the person's current draft and the route answers
 *   202: its usual answer as it would be with the change (computed in a transaction that is rolled back) plus
 *   `changeSet` – the draft. Also for API tokens: a sync into a reviewed site becomes a proposal, not a failure.
 */

export interface WriteTarget {
  kind: PlantEntryKind;
  op: 'set' | 'add' | 'remove';
  scope: string;
  id: string;
}

/** The body without `revision` (the routes' schemas are strict) and the revision the form sent. */
export function splitRevision(body: unknown): { body: unknown; revision: number | undefined } {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('revision' in body)) return { body, revision: undefined };
  const { revision, ...rest } = body as Record<string, unknown>;
  return { body: rest, revision: typeof revision === 'number' && Number.isInteger(revision) && revision > 0 ? revision : undefined };
}

/**
 * Runs a write route: `run` is the route's service call (rights, rules, audit), `reread` its answer after the write
 * (with the entry's new revision). `parsed` is the route's body after its schema.
 */
export function entryWrite<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  target: WriteTarget,
  parsed: unknown,
  revision: number | undefined,
  run: () => T,
  reread: (result: T, changes: EntryChange[]) => T,
): T | (T & { changeSet: PlantChangeSetSummary }) {
  let t = target;
  const u = me();
  const now = t.op === 'add' ? null : readEntry(t.kind, t.scope, t.id);
  // an asset's assignment or list of checks that does not exist yet is added by its PUT
  if (!now && t.op === 'set' && PER_ASSET.includes(t.kind)) t = { ...t, op: 'add' };
  const catalogue = CATALOGUE_KINDS.includes(t.kind);
  const site = now ? now.siteId : siteOfTarget(t.kind, t.scope, t.id, parsed);
  const sites = [site, (parsed as { siteId?: unknown } | null)?.siteId].filter((s): s is string => typeof s === 'string' && !!s);
  const value = t.op === 'remove' ? { cascade: (parsed as { cascade?: boolean } | null)?.cascade === true } : parsed;
  // into the draft: where review is required, or when asked for (X-SM-Draft: 1 – who may propose but not manage, "Add to draft")
  const wantsDraft = req.headers['x-sm-draft'] === '1';
  if ((reviewNeeded(sites, catalogue) || wantsDraft) && (now || t.op === 'add') && mayPropose(u, catalogue ? '' : site)) {
    // what the form expects back, as it would be with the change: computed and rolled back
    let answer: T | undefined;
    quietDryRun(() => asProposer(() => void (answer = run())));
    const op = operationOf({ op: t.op, kind: t.kind, scope: t.scope, id: t.id, value, revision }, u);
    const draft = ensureDraft(u);
    addOperation(draft, op, u);
    reply.code(202);
    const changeSet = summaryOf(rowOf(draft.id)!, u);
    return answer && typeof answer === 'object' && !Array.isArray(answer)
      ? { ...answer, changeSet }
      : ({ ok: true, changeSet } as unknown as T & { changeSet: PlantChangeSetSummary });
  }
  // the form loaded an older revision: someone else changed the entry since. What the save could never write (its
  // rules, rights) is refused as such first – a choice per field would not help
  if (now && revision !== undefined && revision !== now.revision && (t.op === 'set' || t.op === 'remove')) {
    quietDryRun(() => void run());
    throw entryChanged(now, revision, t.op === 'set' ? (parsed as Record<string, unknown>) : bodyOf(t.kind, now.values));
  }
  const op: NewOp = {
    op: t.op,
    kind: t.kind,
    scope: t.scope,
    id: t.id,
    name: now?.name ?? String((parsed as { name?: unknown } | null)?.name ?? t.id),
    origin: 'authored',
    baseRevision: now?.revision ?? null,
    base: now ? bodyOf(t.kind, now.values) : null,
    value,
  };
  const region = regionOf([{ op: t.op, kind: t.kind, scope: t.scope, entry_id: t.id, value: JSON.stringify(value ?? null) }]);
  const done = applyDirect({ source: 'edit', title: `${t.kind} "${op.name}"`, region, ops: [op], fn: run });
  return done.changeSetId ? reread(done.result, done.changes) : done.result;
}

const LISTS: Partial<Record<PlantEntryKind, string>> = { vlan: 'vlans', zone: 'zones', conduit: 'conduits', device: 'devices', data_path: 'dataPaths' };

/**
 * The answer of a network route (a site's or an asset's OT network, computed by the service after its write) with the
 * revisions the change reached, instead of computing it again: the entries it changed carry their new revision, the
 * others are as they were. Null when the answer holds something it cannot place – the route reads it again.
 */
export function revisedNetwork<T>(answer: T, changes: EntryChange[]): T | null {
  if (!answer || typeof answer !== 'object') return null;
  const out = { ...(answer as Record<string, unknown>) };
  for (const c of changes) {
    const list = LISTS[c.kind];
    const items = list ? out[list] : undefined;
    if (!list || !Array.isArray(items)) return null;
    // a removed entry is no longer listed; an added one has its first revision already
    if (c.op === 'remove' || c.op === 'add') continue;
    const at = (items as { id?: unknown; assetId?: unknown }[]).findIndex((x) => x.id === c.id && (x.assetId === undefined || x.assetId === c.scope));
    if (at < 0 || c.op !== 'set') return null;
    out[list] = (items as Record<string, unknown>[]).map((x, i) => (i === at ? { ...x, revision: c.revision } : x));
  }
  return out as T;
}
