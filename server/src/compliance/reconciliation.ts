import { Cron } from 'croner';
import { z } from 'zod';
import {
  ACCESS_CHECK_SOURCES,
  isGitPlatformKind,
  type AccessChange,
  type AccessChangeKind,
  type AccessCheck,
  type AccessFinding,
  type AccessFindingStatus,
  type AccessSnapshot,
  type AccessSnapshotSummary,
  type AccessSubject,
  type ImportedHistoryRef,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows, importedSourceAmong } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentActor, currentUser, runAs, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { sameIdentity } from '../auth/aliases.js';
import { findUserByName, listTeams, listUsers, toAuthUser } from '../auth/users.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { permissionsFor } from '../processes/service.js';
import { getSettings } from '../settings.js';
import { buildUrl, platformRequest } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { canonicalJson, HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import {
  canCreateChecks,
  canDismissFinding,
  canDocumentFinding,
  canEditCheck,
  canReadCheck,
  forbid,
  isSubjectOf,
  me,
  platformAcl,
  platformPerms,
  readsEverything,
  visiblePlatformName,
} from './access.js';
import { createAccessChange, documentedEntries, minus, recordCounts, uniqueRights } from './access-changes.js';

/**
 * Access reconciliation: a check takes a snapshot of who has which access on a platform (Insights
 * Hub identity management, or a dataset in the access snapshot shape published by a process),
 * compares it with the previous snapshot and with the access change entries documented for that
 * period, and reports every right granted or removed without a matching entry as a finding.
 *
 * Snapshots are never updated (database trigger), hash-chained per check and each one is written
 * to the HMAC-chained audit log with its hashes – so the history of who had access when is provable.
 * The data of a snapshot is stored once per change (unchanged snapshots point to the stored copy).
 */

export const LIMITS = {
  subjects: 50000,
  rightsPerSubject: 1000,
  /** Rights of all subjects together */
  assignments: 500_000,
  text: 300,
  checksPerOwner: 50,
  /** IH identity management: users per page and pages */
  pageSize: 500,
  maxPages: 200,
  /** Largest answer of one page of the identity management API */
  pageBytes: 16 * 1024 * 1024,
  minIntervalMs: 15 * 60000,
};
/** Changes documented with a time up to this much before the previous snapshot (or after the current one) still count. */
export const GRACE_MS = 60 * 60000;

// ---------- rows ----------

interface CheckRow {
  id: string;
  name: string;
  description: string;
  platform_id: string;
  source: AccessCheck['source'];
  dataset_key: string | null;
  cron: string;
  timezone: string;
  enabled: number;
  owner: string;
  notify: string;
  ignore_rights: string;
  last_run_at: string | null;
  last_status: AccessCheck['lastStatus'];
  last_error: string | null;
  last_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface SnapshotRow {
  id: string;
  check_id: string;
  platform_id: string;
  seq: number;
  taken_at: string;
  taken_by: string;
  trigger: string;
  subject_count: number;
  assignment_count: number;
  hash: string;
  prev_chain_hash: string | null;
  chain_hash: string;
  data: string | null;
  same_as: string | null;
  source_run_id: string | null;
}

interface FindingRow {
  id: string;
  check_id: string;
  platform_id: string;
  snapshot_id: string;
  prev_snapshot_id: string;
  detected_at: string;
  window_from: string;
  window_to: string;
  subject_id: string;
  subject_name: string;
  kind: AccessChangeKind;
  granted: string;
  revoked: string;
  rights_before: string;
  rights_after: string;
  status: AccessFindingStatus;
  record_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  comment: string;
  dismiss_requested_by: string | null;
  dismiss_requested_at: string | null;
}

const checkRow = (id: string) => db().get<CheckRow>('SELECT * FROM access_checks WHERE id = ?', id);
function requireCheckRow(id: string): CheckRow {
  const r = checkRow(id);
  if (!r) throw new HttpError(404, `Access check ${id} not found`, 'ACCESS_CHECK_NOT_FOUND', { id });
  return r;
}
/** A check the current user may read (404 otherwise, so ids cannot be probed). */
function readableCheck(id: string): CheckRow {
  const u = me();
  const r = checkRow(id);
  if (!r || !canReadCheck(u, r)) throw new HttpError(404, `Access check ${id} not found`, 'ACCESS_CHECK_NOT_FOUND', { id });
  return r;
}

function toCheck(r: CheckRow, u: AuthUser | null): AccessCheck {
  const p = platformAcl(r.platform_id);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    platformId: r.platform_id,
    platformName: visiblePlatformName(u, r.platform_id),
    platformKind: p.exists ? p.kind : null,
    source: r.source,
    datasetKey: r.source === 'dataset' ? r.dataset_key : null,
    scope: r.source === 'git' ? r.dataset_key : null,
    cron: r.cron,
    timezone: r.timezone,
    enabled: !!r.enabled,
    owner: r.owner,
    notify: parseJson<string[]>(r.notify, []),
    ignoreRights: parseJson<string[]>(r.ignore_rights, []),
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastSnapshotId: r.last_snapshot_id,
    snapshotCount: Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_snapshots WHERE check_id = ?', r.id)!.n),
    openFindings: findingRowsOf({ checkId: r.id }).filter((f) => effectiveStatus(f) === 'open').length,
    canEdit: canEditCheck(u, r),
    canRun: canEditCheck(u, r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- checks ----------

const subjectRef = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):.{1,128}$/, 'Use user:<name> or team:<name>');

export const checkInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).default(''),
    platformId: z.string().min(1).max(100),
    source: z.enum(ACCESS_CHECK_SOURCES),
    datasetKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'Dataset key: letters, digits, . _ - (e.g. ih.access-snapshot)')
      .nullish(),
    /** Source "git": organisation / group, or owner/repo (kept where the dataset key is kept) */
    scope: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,10}$/, 'Scope: an organisation or group (acme) or a repository (acme/shop-web)')
      .nullish(),
    cron: z.string().trim().min(1).max(100).default('0 6 * * *'),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    enabled: z.boolean().default(true),
    notify: z.array(subjectRef).max(20).default([]),
    ignoreRights: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.source === 'dataset' && !c.datasetKey) ctx.addIssue({ code: 'custom', path: ['datasetKey'], message: 'A dataset check needs the dataset key' });
    if (c.source === 'git' && !c.scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'A Git check needs the organisation, group or repository' });
  });
export type CheckInput = z.infer<typeof checkInput>;

/** What the dataset_key column keeps: the dataset key, or the scope of a Git check. */
const keyOf = (input: CheckInput): string | null =>
  input.source === 'dataset' ? (input.datasetKey ?? null) : input.source === 'git' ? (input.scope ?? null) : null;

/** A check may run at most every 15 minutes (five cron fields, time zone known). */
function checkCron(cron: string, tz: string): void {
  let job: Cron;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new HttpError(400, `Unknown time zone "${tz}"`, 'TIME_ZONE_UNKNOWN', { tz });
  }
  try {
    job = new Cron(cron, { paused: true, timezone: tz });
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`, 'CRON_INVALID', { detail: (e as Error).message });
  }
  try {
    if (!/^@\w+$/.test(cron) && cron.split(/\s+/).length !== 5)
      throw new HttpError(400, 'Use a cron expression with five fields (minute hour day month weekday)', 'CRON_FIVE_FIELDS', { context: 'accessCheck' });
    const runs = job.nextRuns(20).map((d) => d.getTime());
    if (runs.some((x, i) => i > 0 && x - runs[i - 1]! < LIMITS.minIntervalMs))
      throw new HttpError(400, 'An access check may run at most every 15 minutes', 'ACCESS_CHECK_TOO_OFTEN');
  } finally {
    job.stop();
  }
}

/**
 * A dataset check reads data a process published: its owner must be allowed to view that process
 * (the snapshot shows who has which access; GOV-4). A key without data yet is checked on every run.
 */
function datasetReadable(owner: AuthUser, key: string | null | undefined): boolean {
  const d = key ? db().get<{ process_id: string }>('SELECT process_id FROM datasets WHERE key = ?', key) : undefined;
  return !d || runAs(owner, () => permissionsFor(d.process_id).includes('view'));
}

function datasetForbidden(key: string | null | undefined, owner: string): never {
  throw new HttpError(403, `${owner} may not view the process that publishes the dataset "${key ?? ''}"`, 'ACCESS_CHECK_DATASET_FORBIDDEN', {
    key: key ?? '',
    owner,
  });
}

/** Ignored rights hide grants of those rights from every snapshot: only administrators set or change them (GOV-5). */
function checkIgnoreRights(u: AuthUser, next: string[], cur: string[]): void {
  const norm = (l: string[]) => JSON.stringify(uniqueRights(l).map((x) => x.toLowerCase()));
  if (!isAdmin(u) && norm(next) !== norm(cur)) forbid('change the rights a check ignores', 'ignoreRights');
}

const changed = (from: string[], to: string[]) => (JSON.stringify(from) === JSON.stringify(to) ? {} : { from, to });

function validatePlatform(u: AuthUser, input: CheckInput): void {
  const p = platformAcl(input.platformId);
  if (!p.exists) throw new HttpError(400, `Platform ${input.platformId} not found`, 'PLATFORM_NOT_FOUND', { id: input.platformId });
  if (!isAdmin(u) && !platformPerms(u, input.platformId).includes('use')) forbid('use this platform for an access check', 'usePlatform');
  if (input.source === 'insights-hub' && p.kind !== 'insights-hub')
    throw new HttpError(400, 'The Insights Hub source needs an Insights Hub platform – use a dataset for other platforms', 'ACCESS_CHECK_SOURCE');
  if (input.source === 'git' && !isGitPlatformKind(p.kind))
    throw new HttpError(400, 'The Git source needs a GitHub, GitLab or Forgejo/Gitea platform', 'ACCESS_CHECK_GIT_SOURCE');
}

export function listChecks(): AccessCheck[] {
  const u = me();
  return db()
    .all<CheckRow>('SELECT * FROM access_checks ORDER BY name, id')
    .filter((r) => canReadCheck(u, r))
    .map((r) => toCheck(r, u));
}

export const getCheck = (id: string): AccessCheck => toCheck(readableCheck(id), currentUser());

export function createCheck(input: CheckInput): AccessCheck {
  const u = me();
  if (!canCreateChecks(u)) forbid('set up access reconciliation checks', 'createAccessChecks');
  validatePlatform(u, input);
  checkIgnoreRights(u, input.ignoreRights, []);
  if (input.source === 'dataset' && !datasetReadable(u, input.datasetKey)) datasetForbidden(input.datasetKey, u.username);
  checkCron(input.cron, input.timezone);
  const owned = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_checks WHERE lower(owner) = lower(?)', u.username)!.n);
  if (owned >= LIMITS.checksPerOwner)
    throw new HttpError(400, `At most ${LIMITS.checksPerOwner} access checks per owner`, 'ACCESS_CHECK_TOO_MANY', { max: LIMITS.checksPerOwner });
  const id = newId('acc_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO access_checks (id, name, description, platform_id, source, dataset_key, cron, timezone, enabled, owner, notify, ignore_rights, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description,
      input.platformId,
      input.source,
      keyOf(input),
      input.cron,
      input.timezone,
      input.enabled ? 1 : 0,
      u.username,
      JSON.stringify(input.notify),
      JSON.stringify(input.ignoreRights),
      now,
      now,
      u.username,
    );
    audit({
      action: 'access_check.created',
      entityType: 'access_check',
      entityId: id,
      summary: `Access reconciliation "${input.name}" created (${input.source}${keyOf(input) ? ` ${keyOf(input)}` : ''}, ${input.cron})`,
      details: {
        platformId: input.platformId,
        source: input.source,
        datasetKey: input.datasetKey ?? null,
        ...(input.source === 'git' ? { scope: input.scope ?? null } : {}),
        cron: input.cron,
        timezone: input.timezone,
        notify: input.notify,
        ignoreRights: input.ignoreRights,
      },
    });
  });
  arm(id);
  return getCheck(id);
}

export function updateCheck(id: string, input: CheckInput): AccessCheck {
  const u = me();
  const cur = readableCheck(id);
  if (!canEditCheck(u, cur)) forbid('change this access check', 'changeAccessCheck');
  validatePlatform(u, input);
  const curIgnore = parseJson<string[]>(cur.ignore_rights, []);
  const curNotify = parseJson<string[]>(cur.notify, []);
  checkIgnoreRights(u, input.ignoreRights, curIgnore);
  checkCron(input.cron, input.timezone);
  const hasSnapshots = !!db().get('SELECT 1 FROM access_snapshots WHERE check_id = ?', id);
  const datasetKey = keyOf(input);
  if (hasSnapshots && (input.platformId !== cur.platform_id || input.source !== cur.source || datasetKey !== cur.dataset_key))
    throw new HttpError(
      409,
      'The platform, source and dataset or scope of a check with snapshots cannot change (its history would mix sources) – create a new check',
      'ACCESS_CHECK_LOCKED',
    );
  if (input.source === 'dataset' && datasetKey !== cur.dataset_key && !datasetReadable(ownerUser(cur), datasetKey)) datasetForbidden(datasetKey, cur.owner);
  db().tx(() => {
    db().run(
      'UPDATE access_checks SET name = ?, description = ?, platform_id = ?, source = ?, dataset_key = ?, cron = ?, timezone = ?, enabled = ?, notify = ?, ignore_rights = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.name,
      input.description,
      input.platformId,
      input.source,
      keyOf(input),
      input.cron,
      input.timezone,
      input.enabled ? 1 : 0,
      JSON.stringify(input.notify),
      JSON.stringify(input.ignoreRights),
      nowIso(),
      u.username,
      id,
    );
    audit({
      action: 'access_check.updated',
      entityType: 'access_check',
      entityId: id,
      summary: `Access reconciliation "${input.name}" changed${input.enabled ? '' : ' (disabled)'}`,
      details: {
        source: input.source,
        datasetKey: input.datasetKey ?? null,
        ...(input.source === 'git' ? { scope: input.scope ?? null } : {}),
        cron: input.cron,
        timezone: input.timezone,
        enabled: input.enabled,
        ...(Object.keys(changed(curNotify, input.notify)).length ? { notify: changed(curNotify, input.notify) } : {}),
        ...(Object.keys(changed(curIgnore, input.ignoreRights)).length ? { ignoreRights: changed(curIgnore, input.ignoreRights) } : {}),
      },
    });
  });
  arm(id);
  return getCheck(id);
}

/** Checks with snapshots are kept (their history is evidence) – disable them instead. */
export function deleteCheck(id: string): void {
  const u = me();
  const cur = readableCheck(id);
  if (!canEditCheck(u, cur)) forbid('delete this access check', 'changeAccessCheck');
  if (db().get('SELECT 1 FROM access_snapshots WHERE check_id = ?', id))
    throw new HttpError(409, 'This check has snapshots: they are evidence of who had access when. Disable the check instead.', 'CHECK_HAS_SNAPSHOTS');
  db().tx(() => {
    db().run('DELETE FROM access_checks WHERE id = ?', id);
    db().run("DELETE FROM control_tags WHERE kind = 'accessCheck' AND target_id = ?", id);
    audit({ action: 'access_check.deleted', entityType: 'access_check', entityId: id, summary: `Access reconciliation "${cur.name}" deleted` });
  });
  disarm(id);
}

// ---------- snapshots: collect and normalise ----------

const clip = (s: unknown) =>
  String(s ?? '')
    .trim()
    .slice(0, LIMITS.text);

/** Sorted subjects with sorted unique rights; duplicates of a subject id (case-insensitive) are merged. */
export function normalizeSubjects(list: { id: string; name?: string; type?: string; rights: unknown[] }[]): AccessSubject[] {
  const byId = new Map<string, AccessSubject>();
  for (const s of list) {
    const id = clip(s.id);
    if (!id) continue;
    const key = id.toLowerCase();
    const cur = byId.get(key) ?? { id, name: clip(s.name), ...(s.type ? { type: clip(s.type) } : {}), rights: [] };
    cur.rights = uniqueRights([...cur.rights, ...s.rights.map(clip)]);
    if (cur.rights.length > LIMITS.rightsPerSubject)
      throw new HttpError(400, `${id} has more than ${LIMITS.rightsPerSubject} rights`, 'SNAPSHOT_TOO_MANY_RIGHTS', { id, max: LIMITS.rightsPerSubject });
    if (!cur.name && s.name) cur.name = clip(s.name);
    byId.set(key, cur);
    if (byId.size > LIMITS.subjects)
      throw new HttpError(400, `The snapshot has more than ${LIMITS.subjects} subjects`, 'SNAPSHOT_TOO_LARGE', { max: LIMITS.subjects });
  }
  return [...byId.values()].sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0));
}

export const snapshotHash = (subjects: AccessSubject[]): string => sha256(canonicalJson(subjects));
export const chainHash = (prevChain: string | null, checkId: string, seq: number, takenAt: string, hash: string): string =>
  sha256(`${prevChain ?? 'GENESIS'}|${checkId}|${seq}|${takenAt}|${hash}`);

/** Rows of a dataset in the access snapshot shape (see ACCESS_SNAPSHOT_COLUMNS). */
export function subjectsFromRows(rows: Record<string, unknown>[]): { id: string; name?: string; type?: string; rights: unknown[] }[] {
  const pick = (r: Record<string, unknown>, k: string) => r[k] ?? r[k.toLowerCase()] ?? r[k[0]!.toUpperCase() + k.slice(1)];
  return rows.map((r) => {
    const right = pick(r, 'right');
    const rights = pick(r, 'rights');
    const list = right !== undefined && right !== null ? [right] : Array.isArray(rights) ? rights : typeof rights === 'string' ? rights.split(',') : [];
    return {
      id: String(pick(r, 'subjectId') ?? ''),
      name: pick(r, 'subjectName') === undefined ? undefined : String(pick(r, 'subjectName')),
      type: pick(r, 'subjectType') === undefined ? undefined : String(pick(r, 'subjectType')),
      rights: list,
    };
  });
}

function ownerUser(c: CheckRow): AuthUser {
  const u = findUserByName(c.owner);
  if (!u || !u.active) throw new HttpError(409, `The owner ${c.owner} of the check is missing or deactivated`, 'ACCESS_CHECK_OWNER', { owner: c.owner });
  return toAuthUser(u);
}

/** Insights Hub: every user of the tenant with the display names of its groups and roles (identity management API, SCIM). */
async function collectInsightsHub(c: CheckRow): Promise<{ subjects: AccessSubject[]; sourceRunId: null }> {
  const owner = ownerUser(c);
  const platform = runAs(owner, () => getPlatform(c.platform_id));
  if (!platform.permissions.includes('use'))
    throw new HttpError(403, `The owner ${c.owner} may not use the platform "${platform.name}"`, 'ACCESS_CHECK_OWNER', {
      owner: c.owner,
      context: 'platform',
      name: platform.name,
    });
  const secrets = getSecrets(c.platform_id);
  const idm = String(platform.config.variables?.idmPath || '/api/identitymanagement/v3').replace(/\/$/, '');
  const raw: { id: string; name?: string; type?: string; rights: unknown[] }[] = [];
  let assignments = 0;
  let start = 1;
  for (let page = 0; page < LIMITS.maxPages; page++) {
    const path = `${idm}/Users`;
    const query = { startIndex: start, count: LIMITS.pageSize };
    await assertOutboundAllowed(await buildUrl(platform, secrets, path, query), outboundContext());
    const res = await platformRequest(platform, secrets, { method: 'GET', url: path, query, maxResponseBytes: LIMITS.pageBytes }, AbortSignal.timeout(60000));
    if (!res.ok) throw new HttpError(502, `The identity management API answered HTTP ${res.status}`, 'IDM_HTTP', { status: res.status });
    const body = res.body as { resources?: unknown[]; Resources?: unknown[]; totalResults?: number } | null;
    const list = (body?.resources ?? body?.Resources ?? []) as {
      id?: string;
      userName?: string;
      name?: { givenName?: string; familyName?: string };
      groups?: { display?: string; value?: string }[];
    }[];
    // the limits apply while collecting, so a hostile or broken API cannot make Steward hold all pages first
    for (const u of list) {
      if (!u?.id) continue;
      const groups = Array.isArray(u.groups) ? u.groups : [];
      if (groups.length > LIMITS.rightsPerSubject)
        throw new HttpError(400, `${clip(u.id)} has more than ${LIMITS.rightsPerSubject} rights`, 'SNAPSHOT_TOO_MANY_RIGHTS', {
          id: clip(u.id),
          max: LIMITS.rightsPerSubject,
        });
      assignments += groups.length;
      if (assignments > LIMITS.assignments)
        throw new HttpError(400, `The snapshot has more than ${LIMITS.assignments} assignments`, 'SNAPSHOT_TOO_MANY_ASSIGNMENTS', {
          max: LIMITS.assignments,
        });
      raw.push({ id: clip(u.id), name: clip(u.userName), type: 'user', rights: groups.map((g) => clip(g?.display ?? g?.value ?? '')) });
      if (raw.length > LIMITS.subjects)
        throw new HttpError(400, `The tenant has more than ${LIMITS.subjects} users`, 'SNAPSHOT_TOO_LARGE', { max: LIMITS.subjects });
    }
    start += list.length;
    if (!list.length || (typeof body?.totalResults === 'number' && start > body.totalResults)) break;
  }
  return { subjects: normalizeSubjects(raw), sourceRunId: null };
}

/**
 * Git platforms (#107): members of an organisation or group with their role, or the collaborators of a repository with
 * their role (outside collaborators and access through a team marked), read with the platform's token as the owner.
 */
async function collectGit(c: CheckRow): Promise<{ subjects: AccessSubject[]; sourceRunId: null }> {
  const owner = ownerUser(c);
  const platform = runAs(owner, () => getPlatform(c.platform_id));
  if (!platform.permissions.includes('use'))
    throw new HttpError(403, `The owner ${c.owner} may not use the platform "${platform.name}"`, 'ACCESS_CHECK_OWNER', {
      owner: c.owner,
      context: 'platform',
      name: platform.name,
    });
  if (!isGitPlatformKind(platform.kind)) throw new HttpError(400, 'The Git source needs a GitHub, GitLab or Forgejo/Gitea platform', 'ACCESS_CHECK_GIT_SOURCE');
  await assertOutboundAllowed(await buildUrl(platform, getSecrets(c.platform_id), '/', {}), outboundContext());
  const { gitHost } = await import('../catalogue/repositories.js');
  let subjects: AccessSubject[];
  try {
    subjects = await gitHost(platform, getSecrets(c.platform_id)).access(String(c.dataset_key ?? ''));
  } catch (e) {
    throw new HttpError(502, `The Git platform could not be read: ${(e as Error).message}`.slice(0, 500), 'ACCESS_CHECK_GIT_READ', {
      detail: (e as Error).message.slice(0, 300),
    });
  }
  if (subjects.length > LIMITS.subjects)
    throw new HttpError(400, `The scope has more than ${LIMITS.subjects} members`, 'SNAPSHOT_TOO_LARGE', { max: LIMITS.subjects });
  return {
    subjects: normalizeSubjects(subjects.map((x) => ({ id: clip(x.id), name: clip(x.name), type: x.type, rights: x.rights.map(clip) }))),
    sourceRunId: null,
  };
}

/** A dataset in the access snapshot shape, published by a process (never a dry run). */
function collectDataset(c: CheckRow): { subjects: AccessSubject[]; sourceRunId: string } {
  const d = db().get<{ rows: string; run_id: string; dry_run: number; process_id: string }>(
    'SELECT rows, run_id, dry_run, process_id FROM datasets WHERE key = ?',
    c.dataset_key,
  );
  if (!d)
    throw new HttpError(409, `Dataset "${c.dataset_key}" has no data yet – run the process that publishes it`, 'DATASET_EMPTY', { key: c.dataset_key ?? '' });
  // the check runs as its owner: only data of a process the owner may view (GOV-4)
  const owner = ownerUser(c);
  if (!runAs(owner, () => permissionsFor(d.process_id).includes('view'))) datasetForbidden(c.dataset_key, c.owner);
  if (d.dry_run)
    throw new HttpError(409, `Dataset "${c.dataset_key}" comes from a dry run – it is not used as an access snapshot`, 'DATASET_DRY_RUN', {
      key: c.dataset_key ?? '',
    });
  const rows = parseJson<Record<string, unknown>[]>(d.rows, []);
  return { subjects: normalizeSubjects(subjectsFromRows(rows)), sourceRunId: d.run_id };
}

// ---------- diff and matching ----------

export interface SubjectDiff {
  subjectId: string;
  subjectName: string;
  /** null: the subject is new */
  before: string[] | null;
  /** null: the subject is gone */
  after: string[] | null;
  granted: string[];
  revoked: string[];
}

export function diffSnapshots(prev: AccessSubject[], cur: AccessSubject[]): SubjectDiff[] {
  const p = new Map(prev.map((s) => [s.id.toLowerCase(), s]));
  const c = new Map(cur.map((s) => [s.id.toLowerCase(), s]));
  const out: SubjectDiff[] = [];
  for (const [k, s] of c) {
    const old = p.get(k);
    if (!old) out.push({ subjectId: s.id, subjectName: s.name, before: null, after: s.rights, granted: s.rights, revoked: [] });
    else {
      const granted = minus(s.rights, old.rights);
      const revoked = minus(old.rights, s.rights);
      if (granted.length || revoked.length)
        out.push({ subjectId: s.id, subjectName: s.name || old.name, before: old.rights, after: s.rights, granted, revoked });
    }
  }
  for (const [k, s] of p) if (!c.has(k)) out.push({ subjectId: s.id, subjectName: s.name, before: s.rights, after: null, granted: [], revoked: s.rights });
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();
export function entryMatchesSubject(e: Pick<AccessChange, 'subjectId' | 'subjectName'>, d: Pick<SubjectDiff, 'subjectId' | 'subjectName'>): boolean {
  const mine = new Set([norm(d.subjectId), norm(d.subjectName)].filter(Boolean));
  return [norm(e.subjectId), norm(e.subjectName)].some((x) => x && mine.has(x));
}

/**
 * The part of a difference that no documented entry explains: a granted right needs an entry that
 * grants it, a removed right one that removes it; an offboarding entry explains a subject that is
 * gone, an onboarding entry a new subject (with the rights it lists).
 */
export function undocumentedPart(
  d: SubjectDiff,
  entries: Pick<AccessChange, 'subjectId' | 'subjectName' | 'kind' | 'granted' | 'revoked' | 'rightsBefore' | 'rightsAfter'>[],
): SubjectDiff | null {
  const mine = entries.filter((e) => entryMatchesSubject(e, d));
  const granted = d.granted.filter((r) => !mine.some((e) => e.granted.some((x) => norm(x) === norm(r))));
  const revoked = d.revoked.filter(
    (r) => !mine.some((e) => e.revoked.some((x) => norm(x) === norm(r)) || (d.after === null && e.kind === 'offboarding' && e.rightsAfter.length === 0)),
  );
  const existenceExplained =
    (d.before !== null || mine.some((e) => e.kind === 'onboarding' || e.granted.length > 0)) &&
    (d.after !== null || mine.some((e) => e.kind === 'offboarding'));
  if (!granted.length && !revoked.length && existenceExplained) return null;
  return { ...d, granted, revoked };
}

const kindOf = (d: SubjectDiff): AccessChangeKind =>
  d.before === null ? 'onboarding' : d.after === null ? 'offboarding' : d.granted.length && d.revoked.length ? 'modify' : d.granted.length ? 'grant' : 'revoke';

// ---------- running a check ----------

const running = new Set<string>();

function snapshotData(s: SnapshotRow): AccessSubject[] {
  if (s.data !== null) return parseJson<AccessSubject[]>(s.data, []);
  const src = s.same_as ? db().get<SnapshotRow>('SELECT * FROM access_snapshots WHERE id = ?', s.same_as) : undefined;
  return src?.data ? parseJson<AccessSubject[]>(src.data, []) : [];
}

export interface CheckRunResult {
  snapshot: AccessSnapshotSummary;
  findings: AccessFinding[];
  baseline: boolean;
}

/**
 * Takes a snapshot now, compares it with the previous one and the documented access changes and
 * stores the findings. `actor`: who started it ("system" for the schedule).
 */
export async function runCheck(id: string, o: { actor: string; trigger: 'schedule' | 'manual' | 'demo' }): Promise<CheckRunResult> {
  const c = requireCheckRow(id);
  if (running.has(id)) throw new HttpError(409, 'This check is running already', 'ACCESS_CHECK_RUNNING');
  running.add(id);
  try {
    let collected: { subjects: AccessSubject[]; sourceRunId: string | null };
    try {
      collected = c.source === 'insights-hub' ? await collectInsightsHub(c) : c.source === 'git' ? await collectGit(c) : collectDataset(c);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      db().tx(() => {
        db().run("UPDATE access_checks SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", nowIso(), msg, id);
        audit({
          actor: o.actor,
          action: 'access_check.failed',
          entityType: 'access_check',
          entityId: id,
          summary: `Access reconciliation "${c.name}" failed: ${msg}`,
        });
      });
      throw e;
    }
    // rights the check leaves out (e.g. a review marker group); the subjects stay
    const ignored = new Set(parseJson<string[]>(c.ignore_rights, []).map((x) => x.toLowerCase()));
    const subjects = ignored.size
      ? collected.subjects.map((x) => ({ ...x, rights: x.rights.filter((r) => !ignored.has(r.toLowerCase())) }))
      : collected.subjects;
    const hash = snapshotHash(subjects);
    const prev = db().get<SnapshotRow>('SELECT * FROM access_snapshots WHERE check_id = ? ORDER BY seq DESC LIMIT 1', id);
    let takenAt = nowIso();
    if (prev && takenAt <= prev.taken_at) takenAt = new Date(Date.parse(prev.taken_at) + 1).toISOString();
    const seq = (prev ? Number(prev.seq) : 0) + 1;
    const sameAs = prev && prev.hash === hash ? (prev.same_as ?? prev.id) : null;
    const chain = chainHash(prev?.chain_hash ?? null, id, seq, takenAt, hash);
    const snapId = newId('asn_');
    const assignments = subjects.reduce((n, s) => n + s.rights.length, 0);
    let findings: FindingRow[] = [];
    if (prev && !sameAs) {
      const prevSubjects = snapshotData(prev);
      const windowFrom = new Date(Date.parse(prev.taken_at) - GRACE_MS).toISOString();
      const windowTo = new Date(Date.parse(takenAt) + GRACE_MS).toISOString();
      const entries = documentedEntries(c.platform_id, Date.parse(windowFrom), Date.parse(windowTo));
      findings = diffSnapshots(prevSubjects, subjects)
        .map((d) => undocumentedPart(d, entries))
        .filter((d): d is SubjectDiff => !!d)
        .map((d) => ({
          id: newId('afd_'),
          check_id: id,
          platform_id: c.platform_id,
          snapshot_id: snapId,
          prev_snapshot_id: prev.id,
          detected_at: takenAt,
          window_from: prev.taken_at,
          window_to: takenAt,
          subject_id: d.subjectId,
          subject_name: d.subjectName,
          kind: kindOf(d),
          granted: JSON.stringify(d.granted),
          revoked: JSON.stringify(d.revoked),
          rights_before: JSON.stringify(d.before ?? []),
          rights_after: JSON.stringify(d.after ?? []),
          status: 'open',
          record_id: null,
          resolved_by: null,
          resolved_at: null,
          comment: '',
          dismiss_requested_by: null,
          dismiss_requested_at: null,
        }));
    }
    db().tx(() => {
      db().run(
        `INSERT INTO access_snapshots (id, check_id, platform_id, seq, taken_at, taken_by, trigger, subject_count, assignment_count, hash, prev_chain_hash, chain_hash, data, same_as, source_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        snapId,
        id,
        c.platform_id,
        seq,
        takenAt,
        o.actor,
        o.trigger,
        subjects.length,
        assignments,
        hash,
        prev?.chain_hash ?? null,
        chain,
        sameAs ? null : JSON.stringify(subjects),
        sameAs,
        collected.sourceRunId,
      );
      for (const f of findings) {
        db().run(
          `INSERT INTO access_findings (id, check_id, platform_id, snapshot_id, prev_snapshot_id, detected_at, window_from, window_to, subject_id, subject_name, kind,
             granted, revoked, rights_before, rights_after, status, record_id, resolved_by, resolved_at, comment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '')`,
          f.id,
          f.check_id,
          f.platform_id,
          f.snapshot_id,
          f.prev_snapshot_id,
          f.detected_at,
          f.window_from,
          f.window_to,
          f.subject_id,
          f.subject_name,
          f.kind,
          f.granted,
          f.revoked,
          f.rights_before,
          f.rights_after,
          f.status,
        );
      }
      db().run(
        'UPDATE access_checks SET last_run_at = ?, last_status = ?, last_error = NULL, last_snapshot_id = ? WHERE id = ?',
        takenAt,
        findings.length ? 'findings' : 'ok',
        snapId,
        id,
      );
      audit({
        actor: o.actor,
        action: 'access_check.snapshot',
        entityType: 'access_check',
        entityId: id,
        summary: `Access snapshot #${seq} of "${c.name}": ${subjects.length} subject(s), ${assignments} assignment(s)${
          !prev ? ' (baseline)' : sameAs ? ' (unchanged)' : `, ${findings.length} undocumented change(s)`
        }`,
        details: {
          snapshotId: snapId,
          seq,
          platformId: c.platform_id,
          takenAt,
          hash,
          prevChainHash: prev?.chain_hash ?? null,
          chainHash: chain,
          subjects: subjects.length,
          assignments,
          sameAs,
          sourceRunId: collected.sourceRunId,
          findings: findings.map((f) => f.id),
        },
      });
      for (const f of findings) {
        audit({
          actor: o.actor,
          action: 'access_finding.created',
          entityType: 'access_finding',
          entityId: f.id,
          summary: `Undocumented access change on "${c.name}": ${f.subject_name || f.subject_id} (${f.kind}) ${describeRights(f)}`.slice(0, 1000),
          details: { checkId: id, snapshotId: snapId, subjectId: f.subject_id, kind: f.kind, granted: JSON.parse(f.granted), revoked: JSON.parse(f.revoked) },
        });
      }
    });
    if (findings.length) notifyFindings(c, findings);
    const u = currentUser();
    return {
      snapshot: toSnapshotSummary(db().get<SnapshotRow>('SELECT * FROM access_snapshots WHERE id = ?', snapId)!),
      findings: findings.map((f) => toFinding(f, u, c)),
      baseline: !prev,
    };
  } finally {
    running.delete(id);
  }
}

function describeRights(f: Pick<FindingRow, 'granted' | 'revoked'>): string {
  const g = parseJson<string[]>(f.granted, []);
  const r = parseJson<string[]>(f.revoked, []);
  return [g.length ? `+ ${g.join(', ')}` : '', r.length ? `− ${r.join(', ')}` : ''].filter(Boolean).join(' ');
}

/** The owner, the users and teams to notify, and the administrators. */
function recipients(c: CheckRow): UserInfo[] {
  const subjects = parseJson<string[]>(c.notify, []);
  const names = new Set([c.owner.toLowerCase(), ...subjects.filter((s) => s.startsWith('user:')).map((s) => s.slice(5).toLowerCase())]);
  const teams = subjects.filter((s) => s.startsWith('team:')).map((s) => s.slice(5).toLowerCase());
  for (const tm of listTeams()) if (teams.includes(tm.name.toLowerCase())) tm.members.forEach((m) => names.add(m.toLowerCase()));
  return listUsers().filter((u) => u.active && (names.has(u.username.toLowerCase()) || u.roles.includes('admin')));
}

function notifyFindings(c: CheckRow, findings: FindingRow[]): void {
  const users = recipients(c).filter((u) => runAs(toAuthUser(u), () => canReadCheck(toAuthUser(u), c)));
  if (!users.length) return;
  const platform = platformAcl(c.platform_id).name || c.platform_id;
  const list = findings
    .slice(0, 10)
    .map((f) => `- ${f.subject_name || f.subject_id}: ${describeRights(f) || f.kind}`)
    .join('\n');
  notify({
    event: 'access.undocumented',
    text: (l) => ({
      title: t(l, 'accessUndocumented.title', { name: titleName(c.name) }),
      body: t(l, 'accessUndocumented.body', { name: c.name, n: String(findings.length), platform, list: findings.length > 10 ? `${list}\n…` : list }),
    }),
    link: `/compliance/reconciliation?check=${encodeURIComponent(c.id)}`,
    recipients: users,
    inAppKey: `access-check:${c.id}:${findings[0]!.snapshot_id}`,
    externalKey: `access-check:${c.id}`,
    data: { checkId: c.id, snapshotId: findings[0]!.snapshot_id, findings: findings.length },
  });
}

// ---------- snapshots (read) ----------

const toSnapshotSummary = (s: SnapshotRow): AccessSnapshotSummary => ({
  id: s.id,
  checkId: s.check_id,
  takenAt: s.taken_at,
  subjects: Number(s.subject_count),
  assignments: Number(s.assignment_count),
  hash: s.hash,
  chainHash: s.chain_hash,
  prevChainHash: s.prev_chain_hash,
  sameAs: s.same_as,
  sourceRunId: s.source_run_id,
  trigger: s.trigger,
  takenBy: s.taken_by,
  findings: Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_findings WHERE snapshot_id = ?', s.id)!.n),
});

export function listSnapshots(checkId: string, o: { from?: string; to?: string; limit?: number } = {}): AccessSnapshotSummary[] {
  readableCheck(checkId);
  return snapshotRows(checkId, o).map(toSnapshotSummary);
}

export function snapshotRows(checkId: string, o: { from?: string; to?: string; limit?: number } = {}): SnapshotRow[] {
  const where = ['check_id = ?'];
  const params: unknown[] = [checkId];
  if (o.from) (where.push('taken_at >= ?'), params.push(o.from));
  if (o.to) (where.push('taken_at <= ?'), params.push(o.to));
  return db().all<SnapshotRow>(
    `SELECT * FROM access_snapshots WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
    ...params,
    Math.min(o.limit ?? 500, 5000),
  );
}

export function getSnapshot(checkId: string, snapshotId: string): AccessSnapshot {
  readableCheck(checkId);
  const s = db().get<SnapshotRow>('SELECT * FROM access_snapshots WHERE id = ? AND check_id = ?', snapshotId, checkId);
  if (!s) throw new HttpError(404, `Snapshot ${snapshotId} not found`, 'SNAPSHOT_NOT_FOUND', { id: snapshotId });
  return { ...toSnapshotSummary(s), data: snapshotData(s) };
}

/** Recomputes every snapshot hash and the chain of a check, and compares them with the authentic audit entries. */
export function verifyCheck(checkId: string): ReturnType<typeof verifyChain> {
  readableCheck(checkId);
  return verifyChain(checkId);
}

/**
 * Recomputes every snapshot hash and the chain of a check and compares the snapshots and findings with
 * the authentic (HMAC-chained) audit entries (GOV-6): every audited snapshot and finding must still be
 * in the database, and the status of every finding must be the one its audit entries say – so rows
 * deleted or changed by someone with database access (but without the vault) are found.
 */
export function verifyChain(checkId: string): {
  ok: boolean;
  checked: number;
  findingsChecked: number;
  problems: string[];
  /** snapshot entries in history imported from another instance: verified against that history and the source's key */
  importedHistory?: ImportedHistoryRef;
} {
  const rows = db().all<SnapshotRow>('SELECT * FROM access_snapshots WHERE check_id = ? ORDER BY seq ASC', checkId);
  const problems: string[] = [];
  const audited = new Map<string, { chainHash: string; seq: number }>();
  const auditedFindings = new Set<string>();
  const { rows: entries } = authenticRows("entity_type = 'access_check' AND entity_id = ? AND action = 'access_check.snapshot'", [checkId], {
    ascending: true,
    limit: 1_000_000,
  });
  for (const e of entries) {
    const d = parseJson<{ snapshotId?: string; chainHash?: string; seq?: number; findings?: string[] }>(e.details, {});
    if (d.snapshotId && d.chainHash) audited.set(d.snapshotId, { chainHash: d.chainHash, seq: Number(d.seq) });
    for (const id of Array.isArray(d.findings) ? d.findings : []) if (typeof id === 'string') auditedFindings.add(id);
  }
  let prev: SnapshotRow | undefined;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const s of rows) {
    if (prev && Number(s.seq) !== Number(prev.seq) + 1) problems.push(`Snapshot #${Number(prev.seq) + 1} is missing`);
    if ((s.prev_chain_hash ?? null) !== (prev?.chain_hash ?? null)) problems.push(`Snapshot #${s.seq} does not link to the previous snapshot`);
    if (chainHash(s.prev_chain_hash, checkId, Number(s.seq), s.taken_at, s.hash) !== s.chain_hash)
      problems.push(`Snapshot #${s.seq}: the chain hash does not match`);
    if (s.data !== null && snapshotHash(parseJson<AccessSubject[]>(s.data, [])) !== s.hash)
      problems.push(`Snapshot #${s.seq}: the data does not match its hash`);
    if (s.data === null && (!s.same_as || byId.get(s.same_as)?.hash !== s.hash))
      problems.push(`Snapshot #${s.seq}: the referenced data does not match its hash`);
    if (audited.get(s.id)?.chainHash !== s.chain_hash) problems.push(`Snapshot #${s.seq}: no matching authentic audit entry`);
    prev = s;
  }
  // snapshots in the audit log that are gone (also the newest ones, which leave no gap in the sequence)
  for (const [id, a] of audited) if (!byId.has(id)) problems.push(`Snapshot #${a.seq} is in the audit log but missing from the database`);
  const findingsChecked = verifyFindings(checkId, auditedFindings, problems);
  const imported = importedSourceAmong(entries);
  return { ok: problems.length === 0, checked: rows.length, findingsChecked, problems, ...(imported ? { importedHistory: imported } : {}) };
}

/** Findings against their authentic audit entries: existence, status and documenting entry. */
function verifyFindings(checkId: string, audited: Set<string>, problems: string[]): number {
  const rows = db().all<FindingRow>('SELECT * FROM access_findings WHERE check_id = ?', checkId);
  const ids = [...new Set([...audited, ...rows.map((r) => r.id)])];
  const history = new Map<string, { created: boolean; status: AccessFindingStatus; recordId: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { rows: entries } = authenticRows(`entity_type = 'access_finding' AND entity_id IN (${chunk.map(() => '?').join(', ')})`, chunk, {
      ascending: true,
      limit: 1_000_000,
    });
    for (const e of entries) {
      const h = history.get(String(e.entity_id)) ?? { created: false, status: 'open' as AccessFindingStatus, recordId: null };
      const d = parseJson<{ checkId?: string; recordId?: string }>(e.details, {});
      if (d.checkId && d.checkId !== checkId) continue;
      if (e.action === 'access_finding.created') h.created = true;
      else if (e.action === 'access_finding.documented') ((h.status = 'documented'), (h.recordId = d.recordId ?? null));
      else if (e.action === 'access_finding.dismissed') ((h.status = 'dismissed'), (h.recordId = null));
      history.set(String(e.entity_id), h);
    }
  }
  const present = new Set(rows.map((r) => r.id));
  for (const id of audited) if (!present.has(id)) problems.push(`Finding ${id} is in the audit log but missing from the database`);
  for (const r of rows) {
    const h = history.get(r.id);
    if (!h?.created && !audited.has(r.id)) {
      problems.push(`Finding ${r.id} has no authentic audit entry`);
      continue;
    }
    const expected = h?.status ?? 'open';
    if (r.status !== expected) problems.push(`Finding ${r.id}: status ${r.status} in the database, ${expected} in the audit log`);
    else if (expected === 'documented' && h?.recordId && r.record_id !== h.recordId)
      problems.push(`Finding ${r.id}: documented by another entry than the audit log says`);
  }
  return rows.length;
}

// ---------- findings ----------

/**
 * A finding documented by an entry that went back to draft (new revision) or was cancelled counts as
 * open again – as does one whose entry no longer counts (changed in the database, or documented by
 * the subject of the change: see entryCounts).
 */
function effectiveStatus(f: FindingRow): AccessFindingStatus {
  if (f.status !== 'documented') return f.status;
  return f.record_id && recordCounts(f.record_id) ? 'documented' : 'open';
}

const fourEyesDismissals = (): boolean => getSettings().findingDismissFourEyes === true;
const subjectOfFinding = (u: AuthUser | null, f: FindingRow) => !!u && isSubjectOf(u.username, { subjectId: f.subject_id, subjectName: f.subject_name });

/** Dismiss (or, with four-eyes dismissals, ask to dismiss or confirm the dismissal of) a finding: the owner of the check or an administrator – never its subject, and not twice the same person. */
function mayDismiss(u: AuthUser | null, f: FindingRow, c: CheckRow): boolean {
  if (!u || !canDismissFinding(u, c) || subjectOfFinding(u, f)) return false;
  return !(fourEyesDismissals() && f.dismiss_requested_by && sameIdentity(f.dismiss_requested_by, u));
}

function findingRowsOf(f: { checkId?: string; platformId?: string; snapshotId?: string; from?: string; to?: string }): FindingRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.checkId) (where.push('check_id = ?'), params.push(f.checkId));
  if (f.platformId) (where.push('platform_id = ?'), params.push(f.platformId));
  if (f.snapshotId) (where.push('snapshot_id = ?'), params.push(f.snapshotId));
  if (f.from) (where.push('detected_at >= ?'), params.push(f.from));
  if (f.to) (where.push('detected_at <= ?'), params.push(f.to));
  return db().all<FindingRow>(
    `SELECT * FROM access_findings${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY detected_at DESC, id DESC LIMIT 10000`,
    ...params,
  );
}

function toFinding(f: FindingRow, u: AuthUser | null, c?: CheckRow): AccessFinding {
  const check = c ?? checkRow(f.check_id);
  const status = effectiveStatus(f);
  const rec = f.record_id ? db().get<{ number: string }>('SELECT number FROM records WHERE id = ?', f.record_id) : undefined;
  return {
    id: f.id,
    checkId: f.check_id,
    checkName: check?.name ?? '',
    platformId: f.platform_id,
    platformName: visiblePlatformName(u, f.platform_id),
    snapshotId: f.snapshot_id,
    previousSnapshotId: f.prev_snapshot_id,
    detectedAt: f.detected_at,
    windowFrom: f.window_from,
    windowTo: f.window_to,
    subjectId: f.subject_id,
    subjectName: f.subject_name,
    kind: f.kind,
    granted: parseJson(f.granted, []),
    revoked: parseJson(f.revoked, []),
    rightsBefore: parseJson(f.rights_before, []),
    rightsAfter: parseJson(f.rights_after, []),
    status,
    recordId: status === 'documented' ? f.record_id : null,
    recordNumber: status === 'documented' ? (rec?.number ?? null) : null,
    resolvedBy: status === 'open' ? null : f.resolved_by,
    resolvedAt: status === 'open' ? null : f.resolved_at,
    comment: f.comment,
    dismissRequestedBy: status === 'open' ? f.dismiss_requested_by : null,
    dismissRequestedAt: status === 'open' ? f.dismiss_requested_at : null,
    canDocument: status === 'open' && !!check && canDocumentFinding(u, check) && !subjectOfFinding(u, f),
    canDismiss: status === 'open' && !!check && mayDismiss(u, f, check),
  };
}

export function listFindings(
  f: { checkId?: string; platformId?: string; status?: AccessFindingStatus; from?: string; to?: string; limit?: number } = {},
): AccessFinding[] {
  const u = me();
  const checks = new Map<string, CheckRow | undefined>();
  const out: AccessFinding[] = [];
  for (const row of findingRowsOf(f)) {
    if (!checks.has(row.check_id)) checks.set(row.check_id, checkRow(row.check_id));
    const c = checks.get(row.check_id);
    if (!c || !canReadCheck(u, c)) continue;
    const x = toFinding(row, u, c);
    if (f.status && x.status !== f.status) continue;
    out.push(x);
    if (out.length >= (f.limit ?? 5000)) break;
  }
  return out;
}

/**
 * The start page's "Undocumented access changes" tile: open findings of the checks the current user may
 * read. null for a user who may read no check (and is no administrator or auditor) – no tile, not a 0.
 */
export function findingAttention(): { open: number } | null {
  const u = me();
  const readable = db()
    .all<CheckRow>('SELECT * FROM access_checks')
    .filter((c) => canReadCheck(u, c));
  if (!readable.length && !readsEverything(u)) return null;
  let open = 0;
  for (const c of readable) {
    // documented findings count again when their entry no longer counts (effectiveStatus); dismissed ones never
    const rows = db().all<FindingRow>("SELECT * FROM access_findings WHERE check_id = ? AND status IN ('open', 'documented')", c.id);
    open += rows.filter((f) => effectiveStatus(f) === 'open').length;
  }
  return { open };
}

function readableFinding(id: string): { f: FindingRow; c: CheckRow } {
  const u = me();
  const f = db().get<FindingRow>('SELECT * FROM access_findings WHERE id = ?', id);
  const c = f ? checkRow(f.check_id) : undefined;
  if (!f || !c || !canReadCheck(u, c)) throw new HttpError(404, `Finding ${id} not found`, 'FINDING_NOT_FOUND', { id });
  return { f, c };
}

export const getFinding = (id: string): AccessFinding => {
  const { f, c } = readableFinding(id);
  return toFinding(f, currentUser(), c);
};

export const documentInput = z
  .object({
    reason: z.string().trim().min(1).max(4000),
    kind: z.enum(['grant', 'revoke', 'modify', 'onboarding', 'offboarding']).optional(),
    requestedBy: z.string().trim().max(200).optional(),
    requestRef: z.string().trim().max(500).optional(),
    approvedBy: z.string().trim().max(200).optional(),
    performedBy: z.string().trim().min(1).max(200).optional(),
    performedAt: z.string().datetime({ offset: true }).optional(),
    /** false: create the entry as a draft (it resolves the finding once documented) */
    document: z.boolean().default(true),
  })
  .strict();

/**
 * "Document this change": a pre-filled access change entry marked as documented after the fact,
 * linked to the platform, documented (frozen) right away unless asked otherwise.
 */
export function documentFinding(id: string, input: z.infer<typeof documentInput>): AccessFinding {
  const u = me();
  const { f, c } = readableFinding(id);
  if (!canDocumentFinding(u, c)) forbid('document access changes of this check', 'documentFinding');
  if (effectiveStatus(f) !== 'open') throw new HttpError(409, 'This finding is not open any more', 'FINDING_CLOSED');
  if (subjectOfFinding(u, f)) subjectSelf();
  const subject = f.subject_name || f.subject_id;
  const entry = createAccessChange(
    {
      platformId: f.platform_id,
      subjectId: f.subject_id,
      subjectName: f.subject_name || undefined,
      kind: input.kind ?? f.kind,
      rightsBefore: parseJson(f.rights_before, []),
      rightsAfter: parseJson(f.rights_after, []),
      reason: input.reason,
      requestedBy: input.requestedBy,
      requestRef: input.requestRef,
      approvedBy: input.approvedBy,
      performedBy: input.performedBy ?? 'unknown (changed outside Steward)',
      performedAt: input.performedAt ?? f.window_to,
      origin: 'reconciliation',
      findingId: f.id,
      body:
        `Documented after the fact: the access reconciliation “${c.name}” found this change of ${subject} between ` +
        `${f.window_from} and ${f.window_to} (snapshot ${f.snapshot_id}) without an access change entry.\n`,
    },
    {
      document: input.document,
      comment: 'Documented after the fact (access reconciliation)',
      links: [{ kind: 'platform', id: f.platform_id, note: 'platform' }],
    },
  );
  db().tx(() => {
    db().run(
      "UPDATE access_findings SET status = 'documented', record_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
      entry.recordId,
      u.username,
      nowIso(),
      f.id,
    );
    audit({
      action: 'access_finding.documented',
      entityType: 'access_finding',
      entityId: f.id,
      summary: `Undocumented access change of ${subject} documented after the fact as ${entry.number}${input.document ? '' : ' (draft)'}`,
      details: { checkId: c.id, recordId: entry.recordId, number: entry.number, afterTheFact: true },
    });
  });
  return getFinding(f.id);
}

function subjectSelf(): never {
  throw new HttpError(403, 'Four-eyes principle: nobody documents or dismisses a change of their own access', 'ACCESS_SUBJECT_SELF');
}

/**
 * Dismisses a finding that needs no entry, with a reason. With four-eyes dismissals (setting), the
 * first call asks for the dismissal and a second person who may dismiss confirms it.
 */
export function dismissFinding(id: string, comment: string): AccessFinding {
  const u = me();
  const { f, c } = readableFinding(id);
  if (!canDismissFinding(u, c)) forbid('dismiss findings of this check', 'changeAccessCheck');
  if (effectiveStatus(f) !== 'open') throw new HttpError(409, 'This finding is not open any more', 'FINDING_CLOSED');
  if (subjectOfFinding(u, f)) subjectSelf();
  const requested = fourEyesDismissals() ? f.dismiss_requested_by : null;
  if (requested && sameIdentity(requested, u))
    throw new HttpError(403, 'Four-eyes principle: another person confirms the dismissal you asked for', 'FOUR_EYES_DISMISS');
  const why = (requested ? f.comment : comment).trim();
  if (!why) throw new HttpError(400, 'Please say why this change needs no access change entry', 'FINDING_REASON_REQUIRED');
  if (fourEyesDismissals() && !requested) {
    db().tx(() => {
      db().run(
        'UPDATE access_findings SET dismiss_requested_by = ?, dismiss_requested_at = ?, comment = ? WHERE id = ?',
        u.username,
        nowIso(),
        why.slice(0, 2000),
        f.id,
      );
      audit({
        action: 'access_finding.dismiss_requested',
        entityType: 'access_finding',
        entityId: f.id,
        summary: `Dismissal of the undocumented access change of ${f.subject_name || f.subject_id} requested: ${why.slice(0, 300)}`,
        details: { checkId: c.id, comment: why.slice(0, 2000) },
      });
    });
    return getFinding(f.id);
  }
  db().tx(() => {
    db().run(
      "UPDATE access_findings SET status = 'dismissed', resolved_by = ?, resolved_at = ?, comment = ? WHERE id = ?",
      u.username,
      nowIso(),
      why.slice(0, 2000),
      f.id,
    );
    audit({
      action: 'access_finding.dismissed',
      entityType: 'access_finding',
      entityId: f.id,
      summary: `Undocumented access change of ${f.subject_name || f.subject_id} dismissed: ${why.slice(0, 300)}${requested ? ` (asked by ${requested})` : ''}`,
      details: {
        checkId: c.id,
        comment: why.slice(0, 2000),
        ...(requested ? { requestedBy: requested, confirmComment: comment.trim().slice(0, 2000) } : {}),
      },
    });
  });
  return getFinding(f.id);
}

/**
 * After an access change entry was documented (by the current user): open findings of the platform
 * that it (with the other documented entries that count) now fully explains are marked as documented
 * – only findings of checks whose findings the user may document (GOV-1).
 */
export function rematchFindings(platformId: string, recordId: string): number {
  const u = currentUser();
  const open = db().all<FindingRow>("SELECT * FROM access_findings WHERE platform_id = ? AND status = 'open'", platformId);
  const checks = new Map<string, CheckRow | undefined>();
  let n = 0;
  for (const f of open) {
    if (!checks.has(f.check_id)) checks.set(f.check_id, checkRow(f.check_id));
    const c = checks.get(f.check_id);
    if (!c || !canDocumentFinding(u, c)) continue;
    const entries = documentedEntries(platformId, Date.parse(f.window_from) - GRACE_MS, Date.parse(f.window_to) + GRACE_MS);
    if (!entries.some((e) => e.recordId === recordId)) continue;
    const before = parseJson<string[]>(f.rights_before, []);
    const d: SubjectDiff = {
      subjectId: f.subject_id,
      subjectName: f.subject_name,
      before: f.kind === 'onboarding' ? null : before,
      after: f.kind === 'offboarding' ? null : parseJson<string[]>(f.rights_after, []),
      granted: parseJson(f.granted, []),
      revoked: parseJson(f.revoked, []),
    };
    if (undocumentedPart(d, entries)) continue;
    db().tx(() => {
      db().run(
        "UPDATE access_findings SET status = 'documented', record_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
        recordId,
        currentActor(),
        nowIso(),
        f.id,
      );
      audit({
        action: 'access_finding.documented',
        entityType: 'access_finding',
        entityId: f.id,
        summary: `Undocumented access change of ${f.subject_name || f.subject_id} matched by a later access change entry`,
        details: { checkId: f.check_id, recordId },
      });
    });
    n++;
  }
  return n;
}

// ---------- schedule ----------

const jobs = new Map<string, Cron>();
let started = false;

function disarm(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

function arm(id: string): void {
  disarm(id);
  const r = checkRow(id);
  if (!r || !r.enabled || !started) return;
  try {
    const job = new Cron(r.cron, { timezone: r.timezone, protect: true }, () => {
      if (!vault().unlocked) return;
      runCheck(id, { actor: 'system', trigger: 'schedule' }).catch((e) =>
        logger.warn({ err: { message: (e as Error).message }, accessCheckId: id }, 'access reconciliation failed'),
      );
    });
    jobs.set(id, job);
  } catch (err) {
    logger.warn({ err, accessCheckId: id }, 'access reconciliation could not be scheduled');
  }
}

export function startAccessChecks(): void {
  started = true;
  for (const r of db().all<{ id: string }>('SELECT id FROM access_checks WHERE enabled = 1')) arm(r.id);
}

export function stopAccessChecks(): void {
  started = false;
  for (const id of [...jobs.keys()]) disarm(id);
}
