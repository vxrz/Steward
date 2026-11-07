import YAML from 'yaml';
import {
  compareSemver,
  isMutating,
  type ConnectorPackage,
  type LibraryConnectorView,
  type LibraryInstallRequest,
  type LibraryInstallSummary,
  type LibraryItemKind,
  type LibraryItemOrigin,
  type LibraryItemStatus,
  type LibraryOrigin,
  type LibraryProcessAbilities,
  type LibraryReferenceChoice,
  type LibraryReleaseSource,
  type LibraryReleaseSummary,
  type LibraryReview,
  type LibraryReviewItem,
  type ProcessDefinition,
  type SyncKind,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { currentActor, currentUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { checkFourEyes, fourEyesRequired } from '../auth/assurance.js';
import { HttpError, canonicalJson, nowIso, parseJson, sha256 } from '../util.js';
import * as processes from '../processes/service.js';
import * as dashboards from '../dashboards/service.js';
import * as monitors from '../monitors/service.js';
import * as engine from '../monitors/engine.js';
import { validateTemplate } from '../monitors/validation.js';
import { monitorRow, permissionsOfRow } from '../monitors/model.js';
import * as recordTypes from '../records/types.js';
import { listPlatforms } from '../platforms/service.js';
import { rearmSchedule } from '../scheduler.js';
import { canDecide, canView, findLocal, incomingText, localById, localHash, localText } from '../sync/items.js';
import { keyStateOf, publisherName } from './trust.js';
import {
  RELEASE_ID_RE,
  installedVersion,
  refusal,
  releaseRow,
  requireRelease,
  toReleaseSummary,
  verifyStored,
  type LibraryItem,
  type ReleaseRow,
  type VerifiedRelease,
} from './releases.js';

/**
 * Review and install of a staged release, rollback, uninstall and hold (ADR 0014).
 *
 * The review shows the whole release: per item new / changed (with the diff) / unchanged / no longer in the library /
 * a conflict (changed locally, exists but not from this library), what each process can do – computed from its steps,
 * not from the publisher's words – and the references to map. Accepting installs everything in ONE transaction
 * through the normal services with the reviewer's rights for each item: processes get a new version with the comment
 * "From library …" and an origin, monitors start disabled, connector types need an administrator. A failed item rolls
 * back the whole install. An item id that exists locally and did not come from this library is never overwritten
 * without an explicit decision (keep the local item, or take the library's).
 */

export const sourceOf = (library: string) => `lib:${library}`;

interface LinkRow {
  kind: LibraryItemKind;
  entity_id: string;
  source_id: string;
  path: string;
  commit_sha: string;
  blob_sha: string;
  source_hash: string;
  local_hash: string;
  release_id: string | null;
}

export interface InstallRow {
  library: string;
  publisher_id: string;
  release_id: string;
  previous_release_id: string | null;
  reference_map: string;
  skipped: string;
  held: number;
  hold_state: string | null;
  held_by: string | null;
  held_at: string | null;
  installed_at: string;
  installed_by: string;
}

interface ReferenceMap {
  platforms: Record<string, string>;
  processes: Record<string, string>;
}

interface HoldState {
  schedules: string[];
  triggers: string[];
  monitors: string[];
}

export function requireReviewer(): void {
  if (!capabilities(currentUser()).createProcesses)
    throw new HttpError(403, 'Only designers and administrators review and install libraries', 'FORBIDDEN', { context: 'reviewLibraries' });
}

export function installRow(library: string): InstallRow | undefined {
  return db().get<InstallRow>('SELECT * FROM library_installs WHERE library = ?', library);
}

function requireInstall(library: string): InstallRow {
  const r = /^[a-z0-9-]{1,64}$/.test(library) ? installRow(library) : undefined;
  if (!r) throw new HttpError(404, 'Library not installed', 'LIBRARY_NOT_INSTALLED');
  return r;
}

// ---------- what a process can do ----------

/** Computed from the steps (graph nodes) of a process definition. */
export function abilitiesOf(def: ProcessDefinition): LibraryProcessAbilities {
  const a: LibraryProcessAbilities = {
    slots: def.connections.map((c) => ({ slot: c.slot, kind: c.kind || null })),
    writes: 0,
    accessChanges: 0,
    browser: 0,
    ai: 0,
    databaseQueries: 0,
    subprocesses: [],
    notifications: 0,
    userTasks: 0,
    datasets: [],
  };
  for (const n of def.nodes as unknown as Record<string, unknown>[]) {
    switch (n.type) {
      case 'http':
        if (isMutating(n as { method: 'GET'; mutating?: boolean })) a.writes++;
        break;
      case 'accessChange':
        a.accessChanges++;
        break;
      case 'browser':
        a.browser++;
        break;
      case 'ai':
        a.ai++;
        break;
      case 'query':
        a.databaseQueries++;
        break;
      case 'subprocess':
        if (typeof n.process === 'string' && !a.subprocesses.includes(n.process)) a.subprocesses.push(n.process);
        break;
      case 'check':
        if (n.notify !== false) a.notifications++;
        break;
      case 'userTask':
        a.userTasks++;
        break;
      case 'publish':
        if (typeof n.dataset === 'string' && !a.datasets.includes(n.dataset)) a.datasets.push(n.dataset);
        break;
    }
  }
  return a;
}

/** The abilities as comparable tokens (what is new since the installed release). */
export function abilityTokens(a: LibraryProcessAbilities): string[] {
  const out: string[] = [];
  for (const s of a.slots) out.push(`slot:${s.slot}:${s.kind ?? '*'}`);
  for (const k of ['writes', 'accessChanges', 'browser', 'ai', 'databaseQueries', 'notifications', 'userTasks'] as const) if (a[k]) out.push(k);
  for (const p of a.subprocesses) out.push(`subprocess:${p}`);
  for (const d of a.datasets) out.push(`dataset:${d}`);
  return out;
}

// ---------- local state of the items ----------

const isSyncKind = (k: LibraryItemKind): k is SyncKind => k !== 'connector';

function connectorLocal(kind: string): { id: string; name: string } | null {
  const r = db().get<{ package: string }>('SELECT package FROM platform_types WHERE kind = ?', kind);
  return r ? { id: kind, name: parseJson<ConnectorPackage>(r.package, {} as ConnectorPackage).label ?? kind } : null;
}

function hashOfLocal(kind: LibraryItemKind, id: string): string | null {
  if (kind === 'connector') {
    const r = db().get<{ package: string }>('SELECT package FROM platform_types WHERE kind = ?', id);
    return r ? sha256(canonicalJson(parseJson(r.package, {}))) : null;
  }
  return localHash(kind, id);
}

const yaml = (v: unknown) => YAML.stringify(JSON.parse(JSON.stringify(v)), { lineWidth: 0 });

interface Planned {
  item: LibraryItem;
  local: { id: string; name: string } | null;
  link: LinkRow | undefined;
  status: LibraryItemStatus;
  conflictReason: LibraryReviewItem['conflictReason'];
  visible: boolean;
}

function linkFor(library: string, it: LibraryItem): LinkRow | undefined {
  const src = sourceOf(library);
  const byPath = db().get<LinkRow>('SELECT * FROM sync_items WHERE source_id = ? AND kind = ? AND path = ?', src, it.kind, it.path);
  if (byPath) return byPath;
  const local = isSyncKind(it.kind) ? findLocal(it.kind, it.identity) : connectorLocal(it.identity);
  return local ? db().get<LinkRow>('SELECT * FROM sync_items WHERE source_id = ? AND kind = ? AND entity_id = ?', src, it.kind, local.id) : undefined;
}

function plan(library: string, items: LibraryItem[]): Planned[] {
  return items.map((it) => {
    let link = linkFor(library, it);
    let local = link ? (isSyncKind(it.kind) ? localById(it.kind, link.entity_id) : connectorLocal(link.entity_id)) : null;
    if (link && !local) link = undefined; // the item is gone (deleted, archived): it counts as new
    if (!link) local = isSyncKind(it.kind) ? findLocal(it.kind, it.identity) : connectorLocal(it.identity);
    const visible = !local || it.kind === 'connector' || canView(it.kind, local.id);
    let status: LibraryItemStatus;
    let conflictReason: LibraryReviewItem['conflictReason'] = null;
    if (!local) status = 'new';
    else if (!link) {
      const other = db().get<{ source_id: string }>('SELECT source_id FROM sync_items WHERE kind = ? AND entity_id = ?', it.kind, local.id);
      if (other) {
        status = 'conflict';
        conflictReason = 'otherLibrary';
      } else if (hashOfLocal(it.kind, local.id) === it.hash) status = 'unchanged';
      else {
        status = 'conflict';
        conflictReason = 'notFromLibrary';
      }
    } else if (link.source_hash === it.hash) status = 'unchanged';
    else if (hashOfLocal(it.kind, local.id) !== link.local_hash) {
      status = 'conflict';
      conflictReason = 'changedLocally';
    } else status = 'changed';
    return { item: it, local, link, status, conflictReason, visible };
  });
}

/** Items of the installed release that the new one no longer has. */
function removedLinks(library: string, items: LibraryItem[]): LinkRow[] {
  const keep = new Set(items.map((i) => `${i.kind}\u0000${i.path}`));
  return db()
    .all<LinkRow>('SELECT * FROM sync_items WHERE source_id = ? ORDER BY kind, path', sourceOf(library))
    .filter((l) => !keep.has(`${l.kind}\u0000${l.path}`));
}

function mayDecide(p: Planned): boolean {
  if (p.item.kind === 'connector') return isAdmin(currentUser());
  if (!p.visible) return false;
  return canDecide(p.item.kind, p.local?.id ?? null);
}

function connectorView(pkg: ConnectorPackage): LibraryConnectorView {
  const cfg = (pkg.config ?? {}) as { auth?: { type?: string; tokenUrl?: string }; http?: { trustedOrigins?: string[] } };
  return {
    kind: pkg.kind,
    label: pkg.label,
    baseUrl: pkg.baseUrl,
    tokenUrl: cfg.auth?.tokenUrl ?? null,
    trustedOrigins: cfg.http?.trustedOrigins ?? [],
    authType: cfg.auth?.type ?? 'none',
    secretFields: pkg.secretFields.map((s) => s.key),
    specs: pkg.specs.length,
  };
}

// ---------- references ----------

interface RefNeeds {
  platforms: Map<
    string,
    { kind: string | null; description: string; required: boolean; candidates: { id: string; name: string; kind?: string }[]; resolved: string | null }
  >;
  processes: Map<string, { description: string; required: boolean }>;
}

const monitorDefinition = (content: unknown) => {
  const { kind: _k, key: _key, enabled: _e, ...definition } = content as Record<string, unknown>;
  return definition;
};

function referenceNeeds(v: VerifiedRelease): RefNeeds {
  const usable = listPlatforms().filter((p) => p.permissions.includes('use'));
  const platforms: RefNeeds['platforms'] = new Map();
  for (const r of v.manifest.references.platforms)
    platforms.set(r.ref, {
      kind: r.kind ?? null,
      description: r.description ?? '',
      required: false,
      candidates: usable.filter((p) => !r.kind || p.kind === r.kind).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      resolved: null,
    });
  for (const it of v.items) {
    if (it.kind !== 'monitor') continue;
    for (const ref of monitors.platformReferences(monitorDefinition(it.content))) {
      const known = platforms.get(ref.ref);
      const kind = known?.kind ?? ref.kind;
      platforms.set(ref.ref, {
        kind,
        description: known?.description ?? '',
        required: !ref.resolved,
        candidates: ref.candidates.filter((c) => !known?.kind || c.kind === known.kind),
        resolved: ref.resolved?.id ?? null,
      });
    }
  }
  const processes: RefNeeds['processes'] = new Map(v.manifest.references.processes.map((r) => [r.ref, { description: r.description ?? '', required: false }]));
  const ids = new Set(v.items.filter((i) => i.kind === 'process').map((i) => i.identity));
  for (const it of v.items) {
    if (it.kind !== 'process') continue;
    for (const p of abilitiesOf(it.content as ProcessDefinition).subprocesses) if (!ids.has(p) && processes.has(p)) processes.get(p)!.required = true;
  }
  return { platforms, processes };
}

/** Sub-process steps that name neither an item of the library nor a declared process reference. */
function subprocessProblems(v: VerifiedRelease, it: LibraryItem): string[] {
  if (it.kind !== 'process') return [];
  const ids = new Set(v.items.filter((i) => i.kind === 'process').map((i) => i.identity));
  const refs = new Set(v.manifest.references.processes.map((r) => r.ref));
  return abilitiesOf(it.content as ProcessDefinition)
    .subprocesses.filter((p) => !ids.has(p) && !refs.has(p))
    .map((p) => `A sub-process step names "${p}", which is neither in the library nor a process reference of its manifest`);
}

// ---------- review ----------

async function previousItems(inst: InstallRow | undefined, r: ReleaseRow): Promise<Map<string, LibraryItem> | null> {
  if (!inst || inst.release_id === r.id) return null;
  const prev = releaseRow(inst.release_id);
  if (!prev) return null;
  try {
    const v = await verifyStored(prev);
    return new Map(v.items.map((i) => [`${i.kind}\u0000${i.identity}`, i]));
  } catch (e) {
    logger.warn({ release: prev.id, err: (e as Error).message }, 'library: the installed release does not verify any more – abilities are not compared');
    return null;
  }
}

export async function reviewRelease(id: string): Promise<LibraryReview> {
  requireReviewer();
  const r = requireRelease(id);
  const v = await verifyStored(r);
  const inst = installRow(r.library);
  const before = await previousItems(inst, r);
  const planned = plan(r.library, v.items);
  const refMap = parseJson<ReferenceMap>(inst?.reference_map ?? '{}', { platforms: {}, processes: {} });
  const prevManifestRefs =
    inst && inst.release_id !== r.id ? parseJson<VerifiedRelease['manifest']>(releaseRow(inst.release_id)?.manifest ?? '{}', {} as never) : null;
  const items: LibraryReviewItem[] = planned.map((p) => {
    const it = p.item;
    const local = p.local && p.visible && isSyncKind(it.kind) ? localText(it.kind, p.local.id) : null;
    const connectorLocalText =
      it.kind === 'connector' && p.local
        ? yaml(parseJson(db().get<{ package: string }>('SELECT package FROM platform_types WHERE kind = ?', p.local.id)?.package ?? '{}', {}))
        : null;
    const out: LibraryReviewItem = {
      path: it.path,
      kind: it.kind,
      identity: it.identity,
      name: it.name,
      status: p.status,
      conflictReason: p.conflictReason,
      entityId: p.visible ? (p.local?.id ?? null) : null,
      canDecide: mayDecide(p),
      incomingText: isSyncKind(it.kind) ? incomingText(it.kind, it.content) : yaml(it.content),
      currentText: it.kind === 'connector' ? connectorLocalText : (local?.text ?? null),
      problems: subprocessProblems(v, it),
    };
    if (it.kind === 'process') {
      out.abilities = abilitiesOf(it.content as ProcessDefinition);
      const prev = before?.get(`process\u0000${it.identity}`);
      const had = new Set(prev ? abilityTokens(abilitiesOf(prev.content as ProcessDefinition)) : []);
      out.newAbilities = before ? abilityTokens(out.abilities).filter((t) => !had.has(t)) : [];
    }
    if (it.kind === 'monitor') out.platformRefs = monitors.platformReferences(monitorDefinition(it.content)).map((x) => x.ref);
    if (it.kind === 'connector') out.connector = connectorView(it.content as ConnectorPackage);
    return out;
  });
  for (const l of removedLinks(r.library, v.items)) {
    const local = isSyncKind(l.kind) ? localById(l.kind, l.entity_id) : connectorLocal(l.entity_id);
    if (!local) continue;
    const visible = l.kind === 'connector' || canView(l.kind, local.id);
    items.push({
      path: l.path,
      kind: l.kind,
      identity: l.entity_id,
      name: visible ? local.name : l.path,
      status: 'removed',
      conflictReason: null,
      entityId: visible ? local.id : null,
      canDecide: true,
      incomingText: '',
      currentText: null,
      problems: [],
    });
  }
  const needs = referenceNeeds(v);
  const prevPlatformRefs = new Set(prevManifestRefs?.references?.platforms?.map((x) => x.ref) ?? Object.keys(refMap.platforms ?? {}));
  const prevProcessRefs = new Set(prevManifestRefs?.references?.processes?.map((x) => x.ref) ?? Object.keys(refMap.processes ?? {}));
  const visibleProcesses = processes.listProcesses().map((p) => ({ id: p.id, name: p.name }));
  const references = {
    platforms: [...needs.platforms].map(([ref, n]): LibraryReferenceChoice => ({
      ref,
      kind: n.kind,
      description: n.description,
      mapped: refMap.platforms?.[ref] && n.candidates.some((c) => c.id === refMap.platforms[ref]) ? refMap.platforms[ref]! : n.resolved,
      isNew: !!inst && !prevPlatformRefs.has(ref),
      candidates: n.candidates,
    })),
    processes: [...needs.processes].map(([ref, n]): LibraryReferenceChoice => ({
      ref,
      kind: null,
      description: n.description,
      mapped: refMap.processes?.[ref] && visibleProcesses.some((c) => c.id === refMap.processes[ref]) ? refMap.processes[ref]! : null,
      isNew: !!inst && !prevProcessRefs.has(ref),
      candidates: visibleProcesses,
    })),
  };
  const summary = toReleaseSummary(r);
  const blockers = blockersOf(r, summary, inst, items);
  return {
    release: summary,
    installed: inst ? { id: inst.release_id, release: releaseRow(inst.release_id)?.release_version ?? '' } : null,
    description: v.manifest.description,
    licence: v.manifest.licence ?? '',
    changelog: v.manifest.changelog,
    items,
    references,
    blockers,
    canInstall: !blockers.length,
    needsAdmin: v.items.some((i) => i.kind === 'connector'),
  };
}

/** Why the reviewer cannot install now, as codes the web app translates (blockers.<code>). */
function blockersOf(r: ReleaseRow, s: LibraryReleaseSummary, inst: InstallRow | undefined, items: LibraryReviewItem[]): string[] {
  const out: string[] = [];
  if (s.needsVersion) out.push('needsVersion');
  if (s.keyState === 'revoked') out.push('revokedKey');
  if (r.state === 'installed') out.push('installed');
  else if (r.state === 'previous') {
    if (!inst || inst.previous_release_id !== r.id) out.push('notPrevious');
  } else if (r.state !== 'staged') out.push('downgrade');
  if (items.some((i) => i.status !== 'removed' && i.status !== 'unchanged' && !i.canDecide)) out.push('rights');
  if (items.some((i) => i.problems.length)) out.push('undeclaredProcess');
  return out;
}

// ---------- install ----------

export const installInput = z.object({
  platforms: z.record(z.string().max(100), z.string().max(64)).optional(),
  processes: z.record(z.string().max(100), z.string().max(64)).optional(),
  skip: z.array(z.string().max(300)).max(200).optional(),
  keepLocal: z.array(z.string().max(300)).max(200).optional(),
  takeLibrary: z.array(z.string().max(300)).max(200).optional(),
  comment: z.string().max(2000).optional(),
});

/** Own keys only: reference names never become object keys of something else ("__proto__" is refused). */
const cleanMap = (m: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(m ?? {}).filter(([k, val]) => !['__proto__', 'constructor', 'prototype'].includes(k) && typeof val === 'string' && val));

function originOf(v: VerifiedRelease, releaseId: string): LibraryOrigin {
  return {
    library: v.release.library,
    release: v.release.release,
    publisher: v.release.publisher,
    keyFingerprint: v.key.fingerprint,
    releaseSha256: v.sha256,
    releaseId,
  };
}

function applyConnector(pkg: ConnectorPackage, exists: boolean, note: string): void {
  if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators install connector types', 'FORBIDDEN', { context: 'installConnector' });
  if (exists) db().run('UPDATE platform_types SET package = ? WHERE kind = ?', JSON.stringify(pkg), pkg.kind);
  else db().run('INSERT INTO platform_types (kind, package, created_at) VALUES (?, ?, ?)', pkg.kind, JSON.stringify(pkg), nowIso());
  const v = connectorView(pkg);
  audit({
    action: exists ? 'connector.updated' : 'connector.imported',
    entityType: 'connector',
    entityId: pkg.kind,
    summary: `Connector type "${pkg.label}" (${pkg.kind}) ${exists ? 'updated' : 'installed'} – ${note}; platforms made from it before are not changed`,
    details: { baseUrl: v.baseUrl, tokenUrl: v.tokenUrl, trustedOrigins: v.trustedOrigins, specs: v.specs },
  });
}

/** Rewrites the sub-process steps of a library process: its own children by their installed id and version, references by the mapped process. */
function mapSubprocesses(def: ProcessDefinition, installed: Map<string, { id: string; version: number }>, mapped: Record<string, string>): ProcessDefinition {
  const out = structuredClone(def);
  for (const n of out.nodes as unknown as Record<string, unknown>[]) {
    if (n.type !== 'subprocess' || typeof n.process !== 'string') continue;
    const own = installed.get(n.process);
    if (own) {
      n.process = own.id;
      n.version = own.version;
    } else if (Object.hasOwn(mapped, n.process)) n.process = mapped[n.process];
  }
  return out;
}

/** Library processes in an order where children come before the parents that call them. */
function childFirst(items: Planned[]): Planned[] {
  const procs = items.filter((p) => p.item.kind === 'process');
  const byId = new Map(procs.map((p) => [p.item.identity, p]));
  const out: Planned[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (p: Planned) => {
    const id = p.item.identity;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw refusal('LIBRARY_INVALID', `The sub-processes of "${id}" call each other in a circle`);
    state.set(id, 'visiting');
    for (const c of abilitiesOf(p.item.content as ProcessDefinition).subprocesses) {
      const child = byId.get(c);
      if (child) visit(child);
    }
    state.set(id, 'done');
    out.push(p);
  };
  for (const p of procs) visit(p);
  return [...items.filter((p) => p.item.kind !== 'process'), ...out];
}

/**
 * Installs a staged release (or rolls back to the previous one) in one transaction. `rollback` is set by
 * rollbackLibrary; a release older than the previous one is a downgrade and refused.
 */
export async function installRelease(
  id: string,
  raw: LibraryInstallRequest,
  opts: { rollback?: boolean; approving?: boolean } = {},
): Promise<LibraryInstallResult> {
  requireReviewer();
  const req = installInput.parse(raw ?? {});
  const r = requireRelease(id);
  if (r.install_request && !opts.approving)
    throw new HttpError(409, 'An install of this release waits for a second person – approve or withdraw it first', 'LIBRARY_INSTALL_REQUESTED');
  const inst = installRow(r.library);
  const isRollback = r.state === 'previous' && !!inst && inst.previous_release_id === r.id;
  if (opts.rollback && !isRollback) throw refusal('LIBRARY_DOWNGRADE', 'Only the release installed before the current one can be rolled back to');
  if (r.state === 'installed') throw new HttpError(409, 'This release is installed', 'LIBRARY_RELEASE_INSTALLED');
  if (r.state !== 'staged' && !isRollback)
    throw refusal('LIBRARY_DOWNGRADE', `Release ${r.release_version} is older than the installed one – downgrades are refused`);
  const installed = installedVersion(r.library);
  if (!isRollback && installed && (compareSemver(r.release_version, installed) ?? 0) <= 0)
    throw refusal('LIBRARY_DOWNGRADE', `Release ${r.release_version} is not newer than the installed release ${installed}`);
  const summary = toReleaseSummary(r);
  if (summary.needsVersion)
    throw new HttpError(409, `Release ${r.release_version} needs Steward ${summary.needsVersion} or newer`, 'LIBRARY_NEEDS_VERSION', {
      version: summary.needsVersion,
    });
  // the stored copy, verified again: a revoked key, a changed file or a broken seal stops here
  const v = await verifyStored(r);
  const planned = plan(r.library, v.items);
  const skip = new Set(req.skip ?? []);
  const keep = new Set(req.keepLocal ?? []);
  const take = new Set(req.takeLibrary ?? []);
  const platformsMap = cleanMap(req.platforms);
  const processMap = cleanMap(req.processes);
  // ---- everything is checked before anything is written ----
  const problems = v.items.flatMap((it) => subprocessProblems(v, it));
  if (problems.length) throw refusal('LIBRARY_INVALID', problems.slice(0, 5).join('; '));
  const needs = referenceNeeds(v);
  const openPlatforms = [...needs.platforms].filter(([ref, n]) => n.required && !platformsMap[ref]).map(([ref]) => ref);
  const openProcesses = [...needs.processes].filter(([ref, n]) => n.required && !processMap[ref]).map(([ref]) => ref);
  if (openPlatforms.length || openProcesses.length)
    throw new HttpError(400, `Map the references ${[...openPlatforms, ...openProcesses].map((x) => `"${x}"`).join(', ')}`, 'LIBRARY_REFERENCE_NEEDED', {
      refs: [...openPlatforms, ...openProcesses].join(', '),
    });
  for (const [ref, pid] of Object.entries(processMap)) {
    if (!needs.processes.has(ref)) continue;
    if (!processes.permissionsFor(pid).includes('view'))
      throw new HttpError(400, `Process ${pid} chosen for "${ref}" does not exist`, 'LIBRARY_REFERENCE_NOT_FOUND', { ref });
  }
  for (const p of planned) {
    const path = p.item.path;
    if (p.status === 'conflict') {
      if (keep.has(path) === take.has(path))
        throw new HttpError(409, `${path}: decide whether to keep the local item or take the library's`, 'LIBRARY_CONFLICT_UNDECIDED', { path });
      if (p.conflictReason === 'otherLibrary' && take.has(path))
        throw new HttpError(
          409,
          `${path}: the item comes from another library or Git source – keep it, or uninstall the other one first`,
          'LIBRARY_CONFLICT_OTHER',
          {
            path,
          },
        );
    }
    const writes = (p.status === 'new' && !skip.has(path)) || p.status === 'changed' || (p.status === 'conflict' && take.has(path));
    if (writes && !mayDecide(p))
      throw new HttpError(403, `You are not allowed to ${p.local ? 'change' : 'create'} ${p.item.kind} "${p.item.name}"`, 'FORBIDDEN', {
        context: 'installLibraryItem',
      });
  }
  // monitor templates are validated asynchronously before the transaction (createMonitorNow takes the result)
  const templates = new Map<string, Record<string, unknown>>();
  for (const p of planned) {
    const c = p.item.content as Record<string, unknown>;
    if (p.item.kind === 'monitor' && c.kind === 'monitorTemplate')
      templates.set(p.item.path, (await validateTemplate(monitors.applyPlatformMap(monitorDefinition(c), platformsMap))).def);
  }
  // four-eyes (control point library.install, off by default): the first person's checked request waits for a second
  if (!opts.approving && fourEyesRequired('library.install')) {
    const request = { by: currentActor(), at: nowIso(), rollback: isRollback, request: req };
    db().tx(() => {
      db().run('UPDATE library_releases SET install_request = ? WHERE id = ?', JSON.stringify(request), r.id);
      audit({
        action: 'library.install_requested',
        entityType: 'library',
        entityId: r.library,
        summary: `${isRollback ? 'Rollback to' : 'Install of'} library ${r.library} ${r.release_version} requested – waits for a second person (four-eyes)`,
        details: { releaseId: r.id, releaseSha256: v.sha256, keyFingerprint: v.key.fingerprint, request: req },
      });
    });
    return { status: 'requested', release: toReleaseSummary(requireRelease(r.id)) };
  }
  const prevId = inst?.release_id ?? null;
  const verb = isRollback ? 'rolled back' : inst ? 'updated' : 'installed';
  const note =
    `From library ${v.release.library} ${v.release.release} (${v.release.publisher}, ${v.key.fingerprint})${req.comment?.trim() ? ` – ${req.comment.trim()}` : ''}`.slice(
      0,
      2000,
    );
  const origin = originOf(v, r.id);
  const reloadMonitors: string[] = [];
  const counts = { created: 0, updated: 0, unchanged: 0, kept: 0, skipped: 0, detached: 0 };
  const changes: { path: string; kind: string; id: string | null; action: string; version?: number }[] = [];
  db().tx(() => {
    const ownProcesses = new Map<string, { id: string; version: number }>();
    for (const p of childFirst(planned)) {
      const it = p.item;
      const path = it.path;
      const link = (entityId: string, keepLocalHash = false) =>
        db().run(
          `INSERT INTO sync_items (kind, entity_id, source_id, path, commit_sha, blob_sha, source_hash, local_hash, applied_at, applied_by, release_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, entity_id) DO UPDATE SET source_id = excluded.source_id, path = excluded.path, commit_sha = excluded.commit_sha,
             blob_sha = excluded.blob_sha, source_hash = excluded.source_hash, local_hash = excluded.local_hash, applied_at = excluded.applied_at,
             applied_by = excluded.applied_by, release_id = excluded.release_id`,
          it.kind,
          entityId,
          sourceOf(r.library),
          path,
          v.sha256,
          sha256(v.files.get(path)!),
          it.hash,
          keepLocalHash && p.link ? p.link.local_hash : (hashOfLocal(it.kind, entityId) ?? ''),
          nowIso(),
          currentActor(),
          r.id,
        );
      const remember = (pid: string) => {
        const cur = db().get<{ current_version: number }>('SELECT current_version FROM processes WHERE id = ?', pid);
        if (cur) ownProcesses.set(it.identity, { id: pid, version: cur.current_version });
      };
      if (p.status === 'unchanged') {
        link(p.local!.id, true);
        if (it.kind === 'process') remember(p.local!.id);
        counts.unchanged++;
        continue;
      }
      if (p.status === 'new' && skip.has(path)) {
        counts.skipped++;
        changes.push({ path, kind: it.kind, id: null, action: 'skipped' });
        continue;
      }
      if (p.status === 'conflict' && keep.has(path)) {
        // the local item stays; an item of this library that was changed locally stays linked (and shows the conflict again next time)
        if (p.conflictReason === 'changedLocally') link(p.local!.id, true);
        if (it.kind === 'process' && p.local) remember(p.local.id);
        counts.kept++;
        changes.push({ path, kind: it.kind, id: p.local?.id ?? null, action: 'keptLocal' });
        continue;
      }
      const target = p.local?.id ?? null;
      let entityId: string;
      let version: number | undefined;
      switch (it.kind) {
        case 'process': {
          const def = mapSubprocesses(it.content as ProcessDefinition, ownProcesses, processMap);
          const d = target ? processes.saveProcess(target, def, note) : processes.createProcess(def, { id: it.identity, comment: note });
          entityId = d.id;
          version = d.currentVersion;
          db().run('UPDATE process_versions SET origin = ? WHERE process_id = ? AND version = ?', JSON.stringify(origin), d.id, d.currentVersion);
          ownProcesses.set(it.identity, { id: d.id, version: d.currentVersion });
          break;
        }
        case 'dashboard': {
          const d = target ? dashboards.saveDashboard(target, it.content) : dashboards.createDashboard(it.content, { id: it.identity });
          entityId = d.id;
          break;
        }
        case 'monitor': {
          const c = it.content as Record<string, unknown>;
          const key = c.key as string;
          const isTemplate = c.kind === 'monitorTemplate';
          const definition = monitors.applyPlatformMap(monitorDefinition(c), platformsMap);
          const res = target
            ? monitors.updateMonitorNow(target, { key, isTemplate, definition }, templates.get(path))
            : monitors.createMonitorNow({ key, enabled: false, isTemplate, definition }, {}, templates.get(path));
          entityId = res.monitor.id;
          version = res.monitor.version;
          reloadMonitors.push(entityId);
          break;
        }
        case 'recordType': {
          const input = recordTypes.typeInput.parse(it.content);
          entityId = (target ? recordTypes.updateType(target, input) : recordTypes.createType(input)).id;
          break;
        }
        case 'connector':
          applyConnector(it.content as ConnectorPackage, !!target, note);
          entityId = (it.content as ConnectorPackage).kind;
          break;
      }
      link(entityId);
      if (target) counts.updated++;
      else counts.created++;
      changes.push({ path, kind: it.kind, id: entityId, action: target ? 'updated' : 'created', ...(version !== undefined ? { version } : {}) });
    }
    // items the new release no longer has stay as local items, detached from the library
    for (const l of removedLinks(r.library, v.items)) {
      db().run('DELETE FROM sync_items WHERE kind = ? AND entity_id = ?', l.kind, l.entity_id);
      counts.detached++;
      changes.push({ path: l.path, kind: l.kind, id: l.entity_id, action: 'detached' });
    }
    const map: ReferenceMap = { platforms: platformsMap, processes: processMap };
    const skipped = planned.filter((p) => p.status === 'new' && skip.has(p.item.path)).map((p) => p.item.path);
    const ts = nowIso();
    if (inst)
      db().run(
        'UPDATE library_installs SET release_id = ?, previous_release_id = ?, reference_map = ?, skipped = ?, installed_at = ?, installed_by = ? WHERE library = ?',
        r.id,
        isRollback ? null : prevId,
        JSON.stringify(map),
        JSON.stringify(skipped),
        ts,
        currentActor(),
        r.library,
      );
    else
      db().run(
        'INSERT INTO library_installs (library, publisher_id, release_id, previous_release_id, reference_map, skipped, installed_at, installed_by) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
        r.library,
        v.release.publisher,
        r.id,
        JSON.stringify(map),
        JSON.stringify(skipped),
        ts,
        currentActor(),
      );
    // the release rolled back from waits again as staged; the one replaced by an update is the rollback target
    if (prevId) {
      db().run("UPDATE library_releases SET state = 'older' WHERE library = ? AND state = 'previous' AND id <> ?", r.library, r.id);
      // after a rollback the release rolled back from waits again – unless a newer one is staged already
      const newerStaged = !!db().get("SELECT 1 FROM library_releases WHERE library = ? AND state = 'staged' AND id <> ?", r.library, r.id);
      db().run('UPDATE library_releases SET state = ? WHERE id = ?', isRollback ? (newerStaged ? 'superseded' : 'staged') : 'previous', prevId);
    }
    db().run("UPDATE library_releases SET state = 'installed', installed_at = ?, installed_by = ? WHERE id = ?", ts, currentActor(), r.id);
    audit({
      action: isRollback ? 'library.rolled_back' : inst ? 'library.updated' : 'library.installed',
      entityType: 'library',
      entityId: r.library,
      summary:
        `Library ${r.library} ${v.release.release} (${v.release.publisher}) ${verb}${prevId && !isRollback ? ` from ${releaseRow(prevId)?.release_version ?? '?'}` : ''}${isRollback ? ` from ${releaseRow(prevId!)?.release_version ?? '?'}` : ''}: ` +
        `${counts.created} new, ${counts.updated} changed, ${counts.unchanged} unchanged, ${counts.kept} kept local, ${counts.skipped} skipped, ${counts.detached} detached`,
      details: {
        releaseId: r.id,
        release: v.release.release,
        publisher: v.release.publisher,
        releaseSha256: v.sha256,
        keyFingerprint: v.key.fingerprint,
        previousReleaseId: prevId,
        references: map,
        items: changes.slice(0, 200),
        comment: req.comment ?? null,
      },
    });
    for (const s of skipped)
      audit({
        action: 'library.skipped_item',
        entityType: 'library',
        entityId: r.library,
        summary: `Library ${r.library} ${v.release.release}: ${s} skipped`,
        details: { releaseId: r.id, path: s, releaseSha256: v.sha256, keyFingerprint: v.key.fingerprint },
      });
  });
  for (const m of reloadMonitors) engine.reloadMonitor(m);
  return { status: 'installed', library: librarySummary(requireInstall(r.library)) };
}

export type LibraryInstallResult = { status: 'installed'; library: LibraryInstallSummary } | { status: 'requested'; release: LibraryReleaseSummary };

interface StoredRequest {
  by: string;
  at: string;
  rollback: boolean;
  request: LibraryInstallRequest;
}

/** The second person: never the one who asked (by identity, auth/assurance.ts); installs with the approver's rights. */
export async function approveInstall(id: string): Promise<LibraryInstallResult> {
  requireReviewer();
  const r = requireRelease(id);
  const pending = r.install_request ? parseJson<StoredRequest | null>(r.install_request, null) : null;
  if (!pending) throw new HttpError(409, 'No install of this release waits for approval', 'LIBRARY_NO_REQUEST');
  const u = currentUser()!;
  const fe = checkFourEyes('library.install', [pending.by], u);
  if (!fe.ok) throw new HttpError(403, 'You asked for this install – a second person approves it', 'FOUR_EYES_REQUIRED', { context: 'libraryInstall' });
  const res = await installRelease(id, pending.request, { rollback: pending.rollback, approving: true });
  db().run('UPDATE library_releases SET install_request = NULL WHERE id = ?', id);
  return res;
}

/** The person who asked (or an administrator) takes the request back. */
export function withdrawInstall(id: string): LibraryReleaseSummary {
  requireReviewer();
  const r = requireRelease(id);
  const pending = r.install_request ? parseJson<StoredRequest | null>(r.install_request, null) : null;
  if (!pending) throw new HttpError(409, 'No install of this release waits for approval', 'LIBRARY_NO_REQUEST');
  if (pending.by !== currentActor() && !isAdmin(currentUser()))
    throw new HttpError(403, 'Only the person who asked or an administrator withdraws the request', 'FORBIDDEN', { context: 'withdrawLibraryInstall' });
  db().tx(() => {
    db().run('UPDATE library_releases SET install_request = NULL WHERE id = ?', id);
    audit({
      action: 'library.install_withdrawn',
      entityType: 'library',
      entityId: r.library,
      summary: `Request to install library ${r.library} ${r.release_version} (by ${pending.by}) withdrawn`,
      details: { releaseId: id, requestedBy: pending.by },
    });
  });
  return toReleaseSummary(requireRelease(id));
}

/** Rollback to the release installed before, from Steward's stored copy (verified again); conflicts are decided as on install. */
export async function rollbackLibrary(library: string, req: LibraryInstallRequest): Promise<LibraryInstallResult> {
  requireReviewer();
  const inst = requireInstall(library);
  if (!inst.previous_release_id) throw refusal('LIBRARY_DOWNGRADE', 'There is no release installed before this one to roll back to');
  const map = parseJson<ReferenceMap>(inst.reference_map, { platforms: {}, processes: {} });
  return installRelease(
    inst.previous_release_id,
    { ...req, platforms: { ...map.platforms, ...req.platforms }, processes: { ...map.processes, ...req.processes } },
    { rollback: true },
  );
}

/** Detaches the items: they stay as local items (their versions keep the origin in the history). */
export function uninstallLibrary(library: string): void {
  requireReviewer();
  const inst = requireInstall(library);
  const rel = releaseRow(inst.release_id);
  db().tx(() => {
    const n = db().run('DELETE FROM sync_items WHERE source_id = ?', sourceOf(library)).changes;
    db().run('DELETE FROM library_installs WHERE library = ?', library);
    db().run("UPDATE library_releases SET state = 'older' WHERE library = ? AND state IN ('installed', 'previous')", library);
    audit({
      action: 'library.uninstalled',
      entityType: 'library',
      entityId: library,
      summary: `Library ${library} ${rel?.release_version ?? ''} uninstalled: ${n} item(s) stay as local items${inst.held ? '; what the hold paused stays paused' : ''}`,
      details: {
        releaseId: inst.release_id,
        releaseSha256: rel?.release_sha256 ?? null,
        keyFingerprint: rel?.key_fingerprint ?? null,
        items: n,
        held: !!inst.held,
      },
    });
  });
}

/** A staged release that nobody wants: removed from the list (a refused or superseded release can be staged again). */
export function discardRelease(id: string): void {
  requireReviewer();
  const r = requireRelease(id);
  if (r.state !== 'staged' && r.state !== 'superseded') throw new HttpError(409, 'Only staged releases can be discarded', 'LIBRARY_RELEASE_INSTALLED');
  db().tx(() => {
    db().run('DELETE FROM library_releases WHERE id = ?', id);
    audit({
      action: 'library.release_discarded',
      entityType: 'library',
      entityId: r.library,
      summary: `Staged release ${r.library} ${r.release_version} discarded`,
      details: { releaseId: id, releaseSha256: r.release_sha256, keyFingerprint: r.key_fingerprint },
    });
  });
}

// ---------- hold ----------

function libraryEntities(library: string, kind: string): string[] {
  return db()
    .all<{ entity_id: string }>('SELECT entity_id FROM sync_items WHERE source_id = ? AND kind = ?', sourceOf(library), kind)
    .map((r) => r.entity_id);
}

/**
 * Hold (a key was revoked, or the library is suspect): pauses the schedules, webhook triggers and monitors of the
 * release's items and refuses new runs of its processes, until an administrator lifts it. Lifting turns on again
 * exactly what the hold turned off.
 */
export function setHold(library: string, held: boolean, reason?: string): LibraryInstallSummary {
  if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators put a library on hold', 'FORBIDDEN', { context: 'holdLibrary' });
  const inst = requireInstall(library);
  if (!!inst.held === held) return librarySummary(inst);
  const procs = libraryEntities(library, 'process');
  const mons = libraryEntities(library, 'monitor');
  const ph = procs.map(() => '?').join(', ');
  const rearm: string[] = [];
  const reload: string[] = [];
  db().tx(() => {
    if (held) {
      const state: HoldState = {
        schedules: procs.length
          ? db()
              .all<{ id: string }>(`SELECT id FROM schedules WHERE enabled = 1 AND process_id IN (${ph})`, ...procs)
              .map((x) => x.id)
          : [],
        triggers: procs.length
          ? db()
              .all<{ id: string }>(`SELECT id FROM webhook_triggers WHERE enabled = 1 AND process_id IN (${ph})`, ...procs)
              .map((x) => x.id)
          : [],
        monitors: mons.length
          ? db()
              .all<{ id: string }>(`SELECT id FROM monitors WHERE enabled = 1 AND id IN (${mons.map(() => '?').join(', ')})`, ...mons)
              .map((x) => x.id)
          : [],
      };
      for (const id of state.schedules) db().run('UPDATE schedules SET enabled = 0 WHERE id = ?', id);
      for (const id of state.triggers) db().run('UPDATE webhook_triggers SET enabled = 0 WHERE id = ?', id);
      for (const id of state.monitors) db().run('UPDATE monitors SET enabled = 0 WHERE id = ?', id);
      rearm.push(...state.schedules);
      db().run(
        'UPDATE library_installs SET held = 1, hold_state = ?, held_by = ?, held_at = ? WHERE library = ?',
        JSON.stringify(state),
        currentActor(),
        nowIso(),
        library,
      );
      audit({
        action: 'library.held',
        entityType: 'library',
        entityId: library,
        summary: `Library ${library} on hold${reason ? `: ${reason.slice(0, 200)}` : ''} – ${state.schedules.length} schedule(s), ${state.triggers.length} trigger(s) and ${state.monitors.length} monitor(s) paused, new runs of its ${procs.length} process(es) refused`,
        details: { ...state, processes: procs, reason: reason ?? null },
      });
      reload.push(...state.monitors);
    } else {
      const state = parseJson<HoldState>(inst.hold_state ?? '{}', { schedules: [], triggers: [], monitors: [] });
      const back = { schedules: 0, triggers: 0, monitors: 0 };
      for (const id of state.schedules ?? []) back.schedules += db().run('UPDATE schedules SET enabled = 1 WHERE id = ?', id).changes;
      for (const id of state.triggers ?? []) back.triggers += db().run('UPDATE webhook_triggers SET enabled = 1 WHERE id = ?', id).changes;
      for (const id of state.monitors ?? []) back.monitors += db().run('UPDATE monitors SET enabled = 1 WHERE id = ?', id).changes;
      rearm.push(...(state.schedules ?? []));
      db().run('UPDATE library_installs SET held = 0, hold_state = NULL, held_by = NULL, held_at = NULL WHERE library = ?', library);
      audit({
        action: 'library.hold_lifted',
        entityType: 'library',
        entityId: library,
        summary: `Hold of library ${library} lifted${reason ? `: ${reason.slice(0, 200)}` : ''} – ${back.schedules} schedule(s), ${back.triggers} trigger(s) and ${back.monitors} monitor(s) on again`,
        details: { ...back, reason: reason ?? null },
      });
      reload.push(...(state.monitors ?? []));
    }
  });
  for (const id of rearm) rearmSchedule(id);
  for (const id of reload) engine.reloadMonitor(id);
  return librarySummary(requireInstall(library));
}

// ---------- lists and origins ----------

function librarySummary(i: InstallRow): LibraryInstallSummary {
  const rel = requireRelease(i.release_id);
  const prev = i.previous_release_id ? releaseRow(i.previous_release_id) : undefined;
  const update = db().get<{ id: string; release_version: string }>(
    "SELECT id, release_version FROM library_releases WHERE library = ? AND state = 'staged' ORDER BY staged_at DESC LIMIT 1",
    i.library,
  );
  const s = toReleaseSummary(rel);
  const src =
    s.source.type === 'git'
      ? db().get<{ last_fetch_at: string | null; newest_seen: string | null }>(
          'SELECT last_fetch_at, newest_seen FROM sync_sources WHERE id = ?',
          s.source.sourceId,
        )
      : undefined;
  return {
    library: i.library,
    name: rel.name,
    publisherId: i.publisher_id,
    publisherName: publisherName(i.publisher_id),
    release: s,
    previous: prev ? { id: prev.id, release: prev.release_version } : null,
    update: update ? { id: update.id, release: update.release_version } : null,
    held: !!i.held,
    heldBy: i.held_by,
    heldAt: i.held_at,
    revoked: s.keyState === 'revoked',
    installedAt: i.installed_at,
    installedBy: i.installed_by,
    lastCheckedAt: src?.last_fetch_at ?? null,
    newestSeen: src?.newest_seen ?? null,
  };
}

export function listLibraries(): { installed: LibraryInstallSummary[]; staged: LibraryReleaseSummary[] } {
  requireReviewer();
  const installed = db().all<InstallRow>('SELECT * FROM library_installs ORDER BY library').map(librarySummary);
  const staged = db().all<ReleaseRow>("SELECT * FROM library_releases WHERE state = 'staged' ORDER BY staged_at DESC, id").map(toReleaseSummary);
  return { installed, staged };
}

export function getLibrary(library: string): LibraryInstallSummary & { releases: LibraryReleaseSummary[] } {
  requireReviewer();
  const inst = requireInstall(library);
  return {
    ...librarySummary(inst),
    releases: db().all<ReleaseRow>('SELECT * FROM library_releases WHERE library = ? ORDER BY staged_at DESC, id', library).map(toReleaseSummary),
  };
}

export function getRelease(id: string): LibraryReleaseSummary {
  requireReviewer();
  if (!RELEASE_ID_RE.test(id)) throw new HttpError(404, 'Library release not found', 'LIBRARY_RELEASE_NOT_FOUND');
  return toReleaseSummary(requireRelease(id));
}

/** Items installed from libraries – only items the current user can see (the "From library" badge). */
export function listLibraryOrigins(kind?: LibraryItemKind): LibraryItemOrigin[] {
  const rows = db().all<LinkRow & { library: string; held: number; name: string; release_version: string; publisher_id: string; key_fingerprint: string }>(
    `SELECT s.*, i.library, i.held, r.name, r.release_version, r.publisher_id, r.key_fingerprint
       FROM sync_items s JOIN library_installs i ON s.source_id = 'lib:' || i.library JOIN library_releases r ON r.id = s.release_id
      ${kind ? 'WHERE s.kind = ?' : ''} ORDER BY s.kind, s.entity_id`,
    ...(kind ? [kind] : []),
  );
  const revoked = new Map<string, boolean>();
  return rows
    .filter((r) => {
      if (r.kind === 'process') return processes.permissionsFor(r.entity_id).includes('view');
      if (r.kind === 'monitor') {
        const m = monitorRow(r.entity_id);
        return !!m && permissionsOfRow(m).includes('view');
      }
      if (r.kind === 'dashboard') return canView('dashboard', r.entity_id);
      return true;
    })
    .map((r) => {
      if (!revoked.has(r.key_fingerprint)) revoked.set(r.key_fingerprint, keyStateOf(r.key_fingerprint) === 'revoked');
      return {
        kind: r.kind,
        entityId: r.entity_id,
        name: (isSyncKind(r.kind) ? localById(r.kind, r.entity_id) : connectorLocal(r.entity_id))?.name ?? r.entity_id,
        library: r.library,
        libraryName: r.name,
        release: r.release_version,
        releaseId: r.release_id ?? '',
        publisherId: r.publisher_id,
        path: r.path,
        changedLocally: (hashOfLocal(r.kind, r.entity_id) ?? '') !== r.local_hash,
        held: !!r.held,
        revoked: revoked.get(r.key_fingerprint)!,
      };
    });
}

export { versionOrigin } from './lookup.js';

export type { LibraryReleaseSource };
