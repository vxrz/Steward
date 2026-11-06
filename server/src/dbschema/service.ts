import {
  DATABASE_KIND,
  DB_SCHEMA_LIMITS,
  dbSchemaImportInput,
  dbSchemaSettingsInput,
  type DbSchemaChange,
  type DbSchemaCheck,
  type DbSchemaDiff,
  type DbSchemaDoc,
  type DbSchemaExportFormat,
  type DbSchemaImportInput,
  type DbSchemaImportPreview,
  type DbSchemaOverview,
  type DbSchemaSettings,
  type DbSchemaSnapshot,
  type DbSchemaSnapshotSummary,
  type DbSchemaSource,
  type DbSchemaSubjectKind,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { currentUser } from '../auth/context.js';
import { forbid } from '../auth/access.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { canEditSystem } from '../catalogue/systems.js';
import { canViewCatalogue } from '../records/access.js';
import { redactSecrets } from '../platforms/testConnection.js';
import { columnCount, contentHash } from './model.js';
import { diffSchemas } from './diff.js';
import { parseTbls, parseTblsLint } from './tbls.js';
import { exportSchema, type ExportFile } from './export.js';

/**
 * Database schemas (0.8.0, #222, docs/DATABASES.md#database-schemas): snapshots of a database platform's schema
 * (Steward's read) or of a tbls schema.json (an import, for a database platform or a system without one), the changes
 * between consecutive snapshots, retention, scheduled reads and the exports.
 *
 * Rights follow the subject: whoever sees the platform (any right) or the system sees its schema – a platform or
 * system the caller may not see reads like one that does not exist; reading the database now needs the platform's
 * "use" right; importing and the settings need its "manage" right, or the right to change the system.
 */

const L = DB_SCHEMA_LIMITS;

export interface SnapshotRow {
  id: string;
  subject_kind: DbSchemaSubjectKind;
  subject_id: string;
  source: DbSchemaSource;
  taken_at: string;
  checked_at: string;
  actor: string;
  via: string;
  dialect: DbSchemaDoc['dialect'];
  product: string | null;
  server_version: string | null;
  database_name: string | null;
  table_count: number;
  column_count: number;
  truncated: number;
  sha256: string | null;
  file_name: string | null;
  content_hash: string;
  schema_doc: string;
  checks: string;
  check_count: number;
  previous_id: string | null;
  changes: string | null;
  change_count: number;
  breaking_count: number;
}

interface SettingsRow {
  subject_kind: string;
  subject_id: string;
  retention: number;
  read_interval_hours: number;
  last_read_at: string | null;
  last_read_error: string | null;
}

// ---------- subjects and rights ----------

export interface Subject {
  kind: DbSchemaSubjectKind;
  id: string;
  name: string;
  /** The database platform (kind platform) */
  platform: Platform | null;
  canRead: boolean;
  canImport: boolean;
  importBlocked: DbSchemaOverview['importBlocked'];
}

interface SystemRow {
  id: string;
  name: string;
  owners: string;
  platform_id: string | null;
}

const notFound = (kind: DbSchemaSubjectKind, id: string) =>
  kind === 'platform'
    ? new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id })
    : new HttpError(404, `System ${id} not found`, 'SYSTEM_NOT_FOUND', { id });

/**
 * The platform or system a schema belongs to, as the caller may see it: 404 when it does not exist or the caller may
 * not see it (the same answer). Jobs (no caller) see everything.
 */
export function subjectOf(kind: DbSchemaSubjectKind, id: string): Subject {
  const u = currentUser();
  if (kind === 'platform') {
    let p: Platform;
    try {
      p = getPlatform(id);
    } catch {
      throw notFound(kind, id);
    }
    if (u && !p.permissions.length) throw notFound(kind, id);
    if (p.kind !== DATABASE_KIND)
      throw new HttpError(400, `"${p.name}" is not a database platform (kind ${p.kind})`, 'DB_NOT_A_DATABASE', { name: p.name, kind: p.kind });
    return {
      kind,
      id: p.id,
      name: p.name,
      platform: p,
      canRead: !u || p.permissions.includes('use'),
      canImport: !u || p.permissions.includes('manage'),
      importBlocked: null,
    };
  }
  const r = db().get<SystemRow>('SELECT id, name, owners, platform_id FROM systems WHERE id = ?', id);
  if (!r) throw notFound(kind, id);
  const owners = parseJson<string[]>(r.owners, []);
  if (u && !canViewCatalogue(u, { kind: 'system', id: r.id, owners })) throw notFound(kind, id);
  // a system that is a database platform keeps its schema on the platform – said only to who sees that platform: for
  // everyone else it is a system like any other (nothing tells that a platform they may not see exists, or its kind)
  let platformKind: string | undefined;
  if (r.platform_id) {
    try {
      const p = getPlatform(r.platform_id);
      if (!u || p.permissions.length) platformKind = p.kind;
    } catch {
      platformKind = undefined; // the platform is gone: a system like any other
    }
  }
  return {
    kind,
    id: r.id,
    name: r.name,
    platform: null,
    canRead: false,
    canImport: !u || canEditSystem(u, r),
    importBlocked: platformKind === DATABASE_KIND ? 'systemIsPlatform' : null,
  };
}

function requireImport(s: Subject): void {
  if (!s.canImport)
    forbid(
      s.kind === 'platform' ? 'import a schema for this platform' : 'import a schema for this system',
      s.kind === 'platform' ? 'right_manage' : 'changeSystem',
    );
  if (s.importBlocked)
    throw new HttpError(409, `The system "${s.name}" is a database platform of Steward – import its schema on the platform`, 'DB_SCHEMA_ON_PLATFORM', {
      name: s.name,
    });
}

// ---------- settings ----------

function settingsRow(kind: DbSchemaSubjectKind, id: string): SettingsRow | undefined {
  return db().get<SettingsRow>('SELECT * FROM db_schema_settings WHERE subject_kind = ? AND subject_id = ?', kind, id);
}

export function settingsOf(kind: DbSchemaSubjectKind, id: string): DbSchemaSettings {
  const r = settingsRow(kind, id);
  return { retention: r?.retention ?? L.retention.default, readIntervalHours: r?.read_interval_hours ?? 0 };
}

function ensureSettings(kind: DbSchemaSubjectKind, id: string, actor: string): void {
  db().run(
    `INSERT INTO db_schema_settings (subject_kind, subject_id, retention, read_interval_hours, updated_at, updated_by) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(subject_kind, subject_id) DO NOTHING`,
    kind,
    id,
    L.retention.default,
    nowIso(),
    actor,
  );
}

const actorName = () => currentUser()?.username ?? 'system';

/** Changes retention and the scheduled read; `body` is read once the caller may (dbSchemaSettingsInput). */
export function setSettings(kind: DbSchemaSubjectKind, id: string, body: unknown): DbSchemaSettings {
  const s = subjectOf(kind, id);
  if (!s.canImport) forbid('change the schema settings', s.kind === 'platform' ? 'right_manage' : 'changeSystem');
  const input = dbSchemaSettingsInput.parse(body);
  if (kind === 'system' && input.readIntervalHours > 0)
    throw new HttpError(400, 'A system has no connection to read – push its tbls schema instead', 'DB_SCHEMA_NO_READ');
  const before = settingsOf(kind, id);
  const actor = actorName();
  db().tx(() => {
    ensureSettings(kind, id, actor);
    db().run(
      'UPDATE db_schema_settings SET retention = ?, read_interval_hours = ?, updated_at = ?, updated_by = ? WHERE subject_kind = ? AND subject_id = ?',
      input.retention,
      input.readIntervalHours,
      nowIso(),
      actor,
      kind,
      id,
    );
    const pruned = prune(kind, id, input.retention);
    audit({
      action: 'dbschema.settings_changed',
      entityType: kind,
      entityId: id,
      summary: `Schema settings of "${s.name}": keep ${input.retention} snapshots, ${input.readIntervalHours ? `read every ${input.readIntervalHours} h` : 'no scheduled read'}${pruned ? ` (${pruned} older snapshots removed)` : ''}`,
      details: { settings: input, previous: before, pruned },
    });
  });
  return settingsOf(kind, id);
}

// ---------- snapshots ----------

const summary = (r: SnapshotRow): DbSchemaSnapshotSummary => ({
  id: r.id,
  source: r.source,
  takenAt: r.taken_at,
  checkedAt: r.checked_at,
  actor: r.actor,
  via: r.via,
  dialect: r.dialect,
  product: r.product,
  serverVersion: r.server_version,
  database: r.database_name,
  tables: r.table_count,
  columns: r.column_count,
  truncated: !!r.truncated,
  sha256: r.sha256,
  fileName: r.file_name,
  checks: r.check_count,
  changes: r.change_count,
  breaking: r.breaking_count,
  previousId: r.previous_id,
});

const full = (r: SnapshotRow): DbSchemaSnapshot => ({
  ...summary(r),
  schema: parseJson<DbSchemaDoc>(r.schema_doc, {
    format: 'steward-db-schema',
    version: 1,
    dialect: r.dialect,
    product: null,
    serverVersion: null,
    database: null,
    tables: [],
    truncated: false,
  }),
  lint: parseJson<DbSchemaCheck[]>(r.checks, []),
  diff: r.changes ? parseJson<DbSchemaDiff | null>(r.changes, null) : null,
});

const SELECT_SUMMARY = `SELECT id, subject_kind, subject_id, source, taken_at, checked_at, actor, via, dialect, product, server_version, database_name, table_count,
  column_count, truncated, sha256, file_name, content_hash, check_count, previous_id, change_count, breaking_count FROM db_schema_snapshots`;

function latestRow(kind: DbSchemaSubjectKind, id: string): SnapshotRow | undefined {
  return db().get<SnapshotRow>('SELECT * FROM db_schema_snapshots WHERE subject_kind = ? AND subject_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1', kind, id);
}

/** Removes the oldest snapshots beyond `keep`; returns how many. */
function prune(kind: DbSchemaSubjectKind, id: string, keep: number): number {
  const old = db()
    .all<{ id: string }>('SELECT id FROM db_schema_snapshots WHERE subject_kind = ? AND subject_id = ? ORDER BY taken_at DESC, id DESC', kind, id)
    .slice(keep);
  for (const r of old) db().run('DELETE FROM db_schema_snapshots WHERE id = ?', r.id);
  return old.length;
}

interface StoreInput {
  source: DbSchemaSource;
  doc: DbSchemaDoc;
  checks: DbSchemaCheck[];
  sha256: string | null;
  fileName: string | null;
  actor: string;
  via: string;
}

export interface StoreResult {
  snapshot: DbSchemaSnapshotSummary;
  /** false: the same schema as the latest snapshot – its "checked" time moved on instead */
  created: boolean;
  diff: DbSchemaDiff | null;
  pruned: number;
}

/** Stores a snapshot (or moves the latest one's "checked" time when nothing changed), with its changes and retention. */
function store(s: Subject, x: StoreInput): StoreResult {
  const hash = contentHash(x.doc, x.checks);
  const now = nowIso();
  return db().tx(() => {
    ensureSettings(s.kind, s.id, x.actor);
    const latest = latestRow(s.kind, s.id);
    if (latest && latest.content_hash === hash && latest.source === x.source) {
      db().run('UPDATE db_schema_snapshots SET checked_at = ?, server_version = ? WHERE id = ?', now, x.doc.serverVersion, latest.id);
      return { snapshot: summary({ ...latest, checked_at: now, server_version: x.doc.serverVersion }), created: false, diff: null, pruned: 0 };
    }
    const diff = latest ? diffSchemas(full(latest).schema, x.doc) : null;
    const id = newId('dbs_');
    // taken_at orders the snapshots: never before the latest one, even within the same millisecond
    const takenAt = latest && latest.taken_at >= now ? new Date(new Date(latest.taken_at).getTime() + 1).toISOString() : now;
    db().run(
      `INSERT INTO db_schema_snapshots (id, subject_kind, subject_id, source, taken_at, checked_at, actor, via, dialect, product, server_version, database_name,
        table_count, column_count, truncated, sha256, file_name, content_hash, schema_doc, checks, check_count, previous_id, changes, change_count, breaking_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.kind,
      s.id,
      x.source,
      takenAt,
      takenAt,
      x.actor,
      x.via,
      x.doc.dialect,
      x.doc.product,
      x.doc.serverVersion,
      x.doc.database,
      x.doc.tables.length,
      columnCount(x.doc),
      x.doc.truncated ? 1 : 0,
      x.sha256,
      x.fileName,
      hash,
      JSON.stringify(x.doc),
      JSON.stringify(x.checks),
      x.checks.length,
      latest?.id ?? null,
      diff ? JSON.stringify(diff) : null,
      diff?.total ?? 0,
      diff?.breaking ?? 0,
    );
    const pruned = prune(s.kind, s.id, settingsOf(s.kind, s.id).retention);
    const row = db().get<SnapshotRow>(`${SELECT_SUMMARY} WHERE id = ?`, id)!;
    return { snapshot: summary(row), created: true, diff, pruned };
  });
}

const changeLine = (r: StoreResult) =>
  !r.created ? 'unchanged' : r.diff ? `${r.diff.total} change(s), ${r.diff.breaking} breaking${r.diff.incomplete ? ', incomplete' : ''}` : 'first snapshot';

// ---------- reading a database platform ----------

const inFlight = new Map<string, Promise<StoreResult>>();

/**
 * Reads the schema of a database platform and stores the snapshot. One read per platform at a time (a second caller
 * gets the running one). Errors are recorded with the settings (masked) and thrown.
 */
async function readPlatform(s: Subject, via: string): Promise<StoreResult> {
  const key = `${s.id}`;
  const running = inFlight.get(key);
  if (running) return running;
  const actor = actorName();
  const work = (async () => {
    const p = s.platform!;
    const secrets = getSecrets(p.id);
    const { readDatabaseSchema } = await import('../dbms/service.js');
    try {
      const { doc } = await readDatabaseSchema(p, secrets, AbortSignal.timeout((L.readSeconds + 10) * 1000));
      const r = store(s, { source: 'read', doc, checks: [], sha256: null, fileName: null, actor, via });
      db().run('UPDATE db_schema_settings SET last_read_at = ?, last_read_error = NULL WHERE subject_kind = ? AND subject_id = ?', nowIso(), s.kind, s.id);
      // a person's read is always recorded; a scheduled or monitor read when it found a change
      if (via === 'ui' || r.created)
        audit({
          actor,
          action: 'dbschema.read',
          entityType: 'platform',
          entityId: p.id,
          summary: `Schema of "${p.name}" read: ${doc.tables.length} tables, ${columnCount(doc)} columns – ${changeLine(r)}`,
          details: {
            snapshotId: r.snapshot.id,
            created: r.created,
            via,
            tables: doc.tables.length,
            truncated: doc.truncated,
            changes: r.diff?.total ?? 0,
            breaking: r.diff?.breaking ?? 0,
            pruned: r.pruned,
          },
        });
      return r;
    } catch (e) {
      const message = redactSecrets(String((e as Error).message ?? e), secrets).slice(0, 500);
      ensureSettings(s.kind, s.id, actor);
      db().run(
        'UPDATE db_schema_settings SET last_read_at = ?, last_read_error = ? WHERE subject_kind = ? AND subject_id = ?',
        nowIso(),
        message,
        s.kind,
        s.id,
      );
      throw e;
    }
  })();
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/** "Read now" (the platform's "use" right). */
export async function readNow(kind: DbSchemaSubjectKind, id: string, via: 'ui' = 'ui'): Promise<StoreResult> {
  const s = subjectOf(kind, id);
  if (kind !== 'platform') throw new HttpError(400, 'A system has no connection to read – import its tbls schema instead', 'DB_SCHEMA_NO_READ');
  if (!s.canRead) forbid('read the schema of this platform', 'right_use');
  return readPlatform(s, via);
}

// ---------- tbls import ----------

function parseImport(input: DbSchemaImportInput) {
  const { doc, warnings } = parseTbls(input.schema);
  const checks = parseTblsLint(input.lint);
  return { doc, warnings, checks, sha256: sha256(Buffer.from(input.schema, 'utf8')) };
}

/** What an import would add: the changes against the latest snapshot. Nothing is stored. */
export function previewImport(kind: DbSchemaSubjectKind, id: string, body: unknown): DbSchemaImportPreview {
  const s = subjectOf(kind, id);
  requireImport(s);
  const x = parseImport(dbSchemaImportInput.parse(body));
  const latest = latestRow(kind, id);
  const unchanged = !!latest && latest.content_hash === contentHash(x.doc, x.checks) && latest.source === 'tbls';
  return {
    sha256: x.sha256,
    tables: x.doc.tables.length,
    columns: columnCount(x.doc),
    checks: x.checks.length,
    unchanged,
    diff: latest && !unchanged ? diffSchemas(full(latest).schema, x.doc) : null,
    warnings: x.warnings,
  };
}

/** Imports a tbls schema.json (and optionally the output of tbls lint): a snapshot, audited with the file's SHA-256. */
export function importTbls(kind: DbSchemaSubjectKind, id: string, body: unknown, via: 'ui'): StoreResult & { warnings: string[] } {
  const s = subjectOf(kind, id);
  requireImport(s);
  return importInto(s, dbSchemaImportInput.parse(body), via, actorName(), {});
}

/**
 * A push from CI (push.ts): the token was checked there and names this target; no user is signed in. Audited with the
 * token's id and name.
 */
export function importFromPush(
  kind: DbSchemaSubjectKind,
  id: string,
  input: DbSchemaImportInput,
  token: { id: string; name: string; ip: string },
): StoreResult & { warnings: string[] } {
  const s = subjectOf(kind, id);
  requireImport(s);
  return importInto(s, dbSchemaImportInput.parse(input), 'push', `push token "${token.name}"`.slice(0, 120), {
    tokenId: token.id,
    tokenName: token.name,
    sourceIp: token.ip,
  });
}

function importInto(s: Subject, input: DbSchemaImportInput, via: string, actor: string, extra: Record<string, unknown>): StoreResult & { warnings: string[] } {
  const x = parseImport(input);
  const fileName = input.fileName?.replace(/[\\/]/g, '_').slice(0, 255) || null;
  const r = db().tx(() => {
    const out = store(s, { source: 'tbls', doc: x.doc, checks: x.checks, sha256: x.sha256, fileName, actor, via });
    audit({
      ...(via === 'push' ? { actor } : {}),
      action: 'dbschema.imported',
      entityType: s.kind,
      entityId: s.id,
      summary: `tbls schema${fileName ? ` ${fileName}` : ''} imported for "${s.name}"${via === 'push' ? ` with ${actor}` : ''}: ${x.doc.tables.length} tables, ${x.checks.length} lint finding(s) – ${changeLine(out)}`,
      details: {
        sha256: x.sha256,
        fileName,
        bytes: Buffer.byteLength(input.schema, 'utf8'),
        via,
        ...extra,
        snapshotId: out.snapshot.id,
        created: out.created,
        tables: x.doc.tables.length,
        checks: x.checks.length,
        changes: out.diff?.total ?? 0,
        breaking: out.diff?.breaking ?? 0,
        pruned: out.pruned,
      },
    });
    return out;
  });
  return { ...r, warnings: x.warnings };
}

// ---------- reading what is stored ----------

export function overview(kind: DbSchemaSubjectKind, id: string): DbSchemaOverview {
  const s = subjectOf(kind, id);
  const st = settingsRow(kind, id);
  const rows = db().all<SnapshotRow>(`${SELECT_SUMMARY} WHERE subject_kind = ? AND subject_id = ? ORDER BY taken_at DESC, id DESC`, kind, id);
  return {
    subject: { kind, id: s.id, name: s.name },
    settings: settingsOf(kind, id),
    canRead: kind === 'platform' && s.canRead,
    canImport: s.canImport,
    importBlocked: s.importBlocked,
    lastRead: st?.last_read_at ? { at: st.last_read_at, error: st.last_read_error } : null,
    snapshots: rows.map(summary),
  };
}

/** The snapshots, newest first (the public API pages them). */
export function listSnapshots(kind: DbSchemaSubjectKind, id: string): DbSchemaSnapshotSummary[] {
  subjectOf(kind, id);
  return db().all<SnapshotRow>(`${SELECT_SUMMARY} WHERE subject_kind = ? AND subject_id = ? ORDER BY taken_at DESC, id DESC`, kind, id).map(summary);
}

function snapshotRow(kind: DbSchemaSubjectKind, id: string, snapshotId: string): SnapshotRow {
  subjectOf(kind, id);
  const r = db().get<SnapshotRow>('SELECT * FROM db_schema_snapshots WHERE id = ? AND subject_kind = ? AND subject_id = ?', snapshotId, kind, id);
  if (!r) throw new HttpError(404, `Snapshot ${snapshotId} not found`, 'DB_SCHEMA_SNAPSHOT_NOT_FOUND', { id: snapshotId });
  return r;
}

export function getSnapshot(kind: DbSchemaSubjectKind, id: string, snapshotId: string | 'latest'): DbSchemaSnapshot {
  if (snapshotId === 'latest') {
    subjectOf(kind, id);
    const r = latestRow(kind, id);
    if (!r) throw new HttpError(404, 'No snapshot yet', 'DB_SCHEMA_SNAPSHOT_NOT_FOUND', { id: 'latest' });
    return full(r);
  }
  return full(snapshotRow(kind, id, snapshotId));
}

/** The changes from one snapshot to another of the same database (any two, in either order of time). */
export function compareSnapshots(kind: DbSchemaSubjectKind, id: string, fromId: string, toId: string): DbSchemaDiff & { from: string; to: string } {
  const a = full(snapshotRow(kind, id, fromId));
  const b = full(snapshotRow(kind, id, toId));
  return { ...diffSchemas(a.schema, b.schema), from: a.id, to: b.id };
}

export function exportSnapshot(kind: DbSchemaSubjectKind, id: string, snapshotId: string | 'latest', format: DbSchemaExportFormat): ExportFile {
  const snap = getSnapshot(kind, id, snapshotId);
  const s = subjectOf(kind, id);
  return exportSchema(snap.schema, format, snap.schema.database || s.name, snap.takenAt);
}

/** The changes of the snapshots taken since `since` (for the monitor check and the public API). */
export function changesSince(
  kind: DbSchemaSubjectKind,
  id: string,
  since: string,
): { snapshots: DbSchemaSnapshotSummary[]; changes: number; breaking: number } {
  const rows = db().all<SnapshotRow>(
    `${SELECT_SUMMARY} WHERE subject_kind = ? AND subject_id = ? AND taken_at >= ? AND previous_id IS NOT NULL ORDER BY taken_at DESC, id DESC`,
    kind,
    id,
    since,
  );
  return { snapshots: rows.map(summary), changes: rows.reduce((n, r) => n + r.change_count, 0), breaking: rows.reduce((n, r) => n + r.breaking_count, 0) };
}

/** Each snapshot with its changes against the one before, newest first. */
export function listChangeSets(
  kind: DbSchemaSubjectKind,
  id: string,
  f: { since?: string; breaking?: boolean } = {},
): { snapshot: DbSchemaSnapshotSummary; diff: DbSchemaDiff }[] {
  subjectOf(kind, id);
  const rows = db().all<SnapshotRow & { changes: string | null }>(
    `SELECT id, subject_kind, subject_id, source, taken_at, checked_at, actor, via, dialect, product, server_version, database_name, table_count, column_count,
      truncated, sha256, file_name, content_hash, check_count, previous_id, change_count, breaking_count, changes
     FROM db_schema_snapshots WHERE subject_kind = ? AND subject_id = ? AND previous_id IS NOT NULL AND taken_at >= ? AND breaking_count >= ?
     ORDER BY taken_at DESC, id DESC`,
    kind,
    id,
    f.since ? new Date(f.since).toISOString() : '',
    f.breaking ? 1 : 0,
  );
  return rows.map((r) => ({ snapshot: summary(r), diff: parseJson<DbSchemaDiff>(r.changes, { changes: [], total: 0, breaking: 0, incomplete: false }) }));
}

/** The first (breaking) change of the newest snapshot since `since` that has one – for the check's message. */
export function newestChange(kind: DbSchemaSubjectKind, id: string, since: string, breakingOnly: boolean): DbSchemaChange | null {
  const r = db().get<{ changes: string | null }>(
    'SELECT changes FROM db_schema_snapshots WHERE subject_kind = ? AND subject_id = ? AND taken_at >= ? AND breaking_count >= ? AND change_count > 0 ORDER BY taken_at DESC, id DESC LIMIT 1',
    kind,
    id,
    since,
    breakingOnly ? 1 : 0,
  );
  const d = parseJson<DbSchemaDiff | null>(r?.changes, null);
  return d?.changes.find((c) => !breakingOnly || c.breaking) ?? null;
}

export function hasSnapshot(kind: DbSchemaSubjectKind, id: string): boolean {
  return !!db().get('SELECT 1 AS x FROM db_schema_snapshots WHERE subject_kind = ? AND subject_id = ? LIMIT 1', kind, id);
}

// ---------- scheduled reads (jobs/builtin.ts) ----------

/** At most this many platforms are read per run of the job; the rest follow at the next run. */
const READS_PER_RUN = 10;

/**
 * Reads the database platforms whose interval has passed, one after the other, and removes the snapshots and settings
 * of platforms and systems that no longer exist.
 */
export async function runSchemaJob(): Promise<{ read: number; failed: number; removed: number }> {
  // the platform or system is gone: so are its snapshots
  const removed =
    db().run(
      "DELETE FROM db_schema_snapshots WHERE subject_kind = 'platform' AND NOT EXISTS (SELECT 1 FROM platforms x WHERE x.id = db_schema_snapshots.subject_id)",
    ).changes +
    db().run(
      "DELETE FROM db_schema_snapshots WHERE subject_kind = 'system' AND NOT EXISTS (SELECT 1 FROM systems x WHERE x.id = db_schema_snapshots.subject_id)",
    ).changes;
  db().run(
    "DELETE FROM db_schema_settings WHERE subject_kind = 'platform' AND NOT EXISTS (SELECT 1 FROM platforms x WHERE x.id = db_schema_settings.subject_id)",
  );
  db().run("DELETE FROM db_schema_settings WHERE subject_kind = 'system' AND NOT EXISTS (SELECT 1 FROM systems x WHERE x.id = db_schema_settings.subject_id)");
  db().run(
    "DELETE FROM db_schema_push_tokens WHERE subject_kind = 'platform' AND NOT EXISTS (SELECT 1 FROM platforms x WHERE x.id = db_schema_push_tokens.subject_id)",
  );
  db().run(
    "DELETE FROM db_schema_push_tokens WHERE subject_kind = 'system' AND NOT EXISTS (SELECT 1 FROM systems x WHERE x.id = db_schema_push_tokens.subject_id)",
  );
  const due = db()
    .all<SettingsRow>("SELECT * FROM db_schema_settings WHERE subject_kind = 'platform' AND read_interval_hours > 0 ORDER BY last_read_at")
    .filter((r) => !r.last_read_at || Date.parse(r.last_read_at) + r.read_interval_hours * 3_600_000 <= Date.now())
    .slice(0, READS_PER_RUN);
  let read = 0;
  let failed = 0;
  for (const r of due) {
    try {
      const s = subjectOf('platform', r.subject_id);
      await readPlatform(s, 'job');
      read++;
    } catch (e) {
      failed++;
      logger.warn({ platformId: r.subject_id, err: (e as Error).message }, 'scheduled schema read failed');
    }
  }
  return { read, failed, removed };
}

/** For the monitor check: read first (database platforms), as the monitor's owner was checked by the caller. */
export async function readForCheck(platformId: string): Promise<StoreResult> {
  return readPlatform(subjectOf('platform', platformId), 'monitor');
}
