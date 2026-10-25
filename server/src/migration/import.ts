import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  BRAND,
  LOCALE_CODES,
  ROLES,
  boundedRecord,
  MIGRATION_FINGERPRINT_MIN_CHARS,
  normalizeFingerprint,
  type AuditEntry,
  type ImportResult,
  type MigrationMapping,
  type MigrationMappingRow,
  type MigrationPlan,
  type MigrationPlanTeam,
  type MigrationPlanUser,
  type Role,
  type TeamDecision,
  type UserDecision,
} from '@sm/shared';
import { config } from '../config.js';
import { Db, db, namedMigrations, coreMigrations } from '../db.js';
import { audit } from '../audit.js';
import { decryptWith, publicKeyFingerprint, vault, verifySignature } from '../vault.js';
import { ENCRYPTED_COLUMNS } from '../vault-rotation.js';
import { ZipReader, safeEntryName, type ZipEntry } from '../compliance/zip.js';
import { sealPlatform } from '../platforms/integrity.js';
import { columns, fkOrder, tables } from '../cli/db-copy.js';
import { quoteIdent } from '../database/sql.js';
import { verifyExport } from '../cli/audit-verify-export.js';
import { canonicalJson, HttpError, newId, nowIso, parseJson, pathInside, rasterImageType, sha256 } from '../util.js';
import { passwordLoginMode } from '../settings.js';
import { publicProviders } from '../auth/sso.js';
import { checkedLogo, checkedThemeSettings } from '../theme/service.js';
import { checkedBranding } from '../reports/branding.js';
import { sniff } from '../records/attachments.js';
import { hashPassword, temporaryPassword } from '../auth/passwords.js';
import { NO_PASSWORD } from '../auth/users.js';
import { invalidateAliases } from '../auth/aliases.js';
import { invalidateVerifiedImports } from './history.js';
import {
  manifestSigningInput,
  openPackage,
  sha256File,
  workDir,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  type Manifest,
  type PackageTeam,
  type PackageUser,
} from './format.js';
import { NOT_MOVED, PAUSED_ON_IMPORT, SETTINGS_MOVED, USER_ID_TABLES, USER_REFS, type RefKind } from './tables.js';
import { DATA_PREFIX } from './export.js';

/**
 * Import of a migration package (see format.ts and export.ts) into this instance:
 *
 *   1. readPackage   – decrypt, check the manifest signature and every entry's SHA-256, verify the imported
 *                      audit history against the source's signed checkpoint
 *   2. buildPlan     – dry run: counts, schema, conflicts, and suggestions for the identity mapping
 *   3. applyImport   – with a complete mapping: load the rows into a staging database at the source's schema,
 *                      run the remaining migrations there, re-encrypt credentials with this vault, map the
 *                      columns that say who owns something (tables.ts), then copy everything into this
 *                      database in one transaction; files go to the data folder.
 *
 * The imported audit log is kept unchanged in imported_audit_log (verifiable with the source's key); this
 * instance's own chain gets one `instance.imported` entry with the package hash and the full mapping table.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const ident = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/)
  .max(64);

const manifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.number().int(),
  packageId: z.string().regex(/^[0-9a-f-]{36}$/),
  product: z.string().max(100),
  productVersion: z.string().max(50),
  createdAt: z.string().max(40),
  createdBy: z.string().max(200),
  source: z.object({ fingerprint: z.string().max(100), publicKey: z.string().min(40).max(200), database: z.enum(['sqlite', 'postgres']) }),
  schema: z.object({ core: z.number().int().min(0).max(1000), named: z.array(z.string().max(200)).max(5000) }),
  tables: z.array(z.object({ name: ident, rows: z.number().int().min(0), sha256: hex64, columns: z.array(ident).max(300) })).max(500),
  files: z.array(z.object({ path: z.string().max(1000), size: z.number().int().min(0), sha256: hex64 })).max(65000),
  audit: z.object({
    entries: z.number().int().min(0),
    sha256: hex64,
    checkpoint: z.object({
      v: z.literal(1),
      seq: z.number().int().min(1),
      hash: z.string().max(100),
      digest: z.string().max(100),
      count: z.number().int(),
      ts: z.string().max(40),
      keyFingerprint: z.string().max(100),
      signature: z.string().max(200),
    }),
  }),
  users: z
    .array(
      z.object({
        id: z.string().max(100),
        username: z.string().min(1).max(100),
        displayName: z.string().max(200),
        email: z.string().max(254).nullable(),
        roles: z.array(z.string().max(30)).max(20),
        active: z.boolean(),
        kind: z.enum(['local', 'sso']),
        provider: z.string().max(200).nullable(),
        teams: z.array(z.string().max(100)).max(1000),
        lastLoginAt: z.string().max(40).nullable(),
      }),
    )
    .max(100000),
  teams: z
    .array(
      z.object({
        id: z.string().max(100),
        name: z.string().min(1).max(100),
        description: z.string().max(5000),
        members: z.array(z.string().max(100)).max(100000),
      }),
    )
    .max(10000),
  settings: z.object({ sha256: hex64, keys: z.array(z.string().max(200)).max(10000) }),
  platformIntegrity: boundedRecord(z.enum(['ok', 'mismatch', 'unsealed']), 10000),
});

export interface OpenedPackage {
  dir: string;
  file: string;
  reader: ZipReader;
  manifest: Manifest;
  secrets: Buffer;
  sha256: string;
  size: number;
  history: { ok: boolean; message: string; entries: number };
  close(): void;
}

const MAX_SMALL = 64 * 1024 * 1024;

async function readEntry(r: ZipReader, name: string, max = MAX_SMALL): Promise<Buffer> {
  const e = r.find(name);
  if (!e) throw new HttpError(400, `The package has no ${name}`, 'MIGRATION_PACKAGE_INVALID');
  return r.read(e, max);
}

/** One JSON row per line; a line may not exceed MAX_LINE (a crafted package cannot exhaust memory with one line). */
const MAX_LINE = 64 * 1024 * 1024;
async function* lines(r: ZipReader, e: ZipEntry): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of (await r.stream(e)) as AsyncIterable<Buffer>) {
    rest += chunk.toString('utf8');
    let nl = rest.indexOf('\n');
    while (nl >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line) yield line;
      nl = rest.indexOf('\n');
    }
    if (rest.length > MAX_LINE) throw new HttpError(400, `${e.name} has a line longer than ${MAX_LINE / 1024 / 1024} MB`, 'MIGRATION_PACKAGE_INVALID');
  }
  if (rest) yield rest;
}

/**
 * Opens and checks a package: the transfer passphrase (AES-GCM), the manifest signature, that the ZIP holds
 * exactly the entries the manifest lists, every entry's SHA-256 and size, and the imported audit history.
 */
export async function readPackage(file: string, passphrase: string): Promise<OpenedPackage> {
  const dir = workDir(config.dataDir);
  const close = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const zipFile = path.join(dir, 'package.zip');
    const { secrets } = await openPackage(file, passphrase, zipFile);
    let reader: ZipReader;
    try {
      reader = await ZipReader.open(zipFile);
    } catch (e) {
      throw new HttpError(400, `The package content is damaged: ${(e as Error).message}`, 'MIGRATION_PACKAGE_INVALID');
    }
    const manifestBytes = await readEntry(reader, 'manifest.json');
    const sig = parseJson<{ alg?: string; publicKey?: string; signature?: string }>((await readEntry(reader, 'signature.json', 4096)).toString('utf8'), {});
    let raw: unknown;
    try {
      raw = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new HttpError(400, 'The package manifest is damaged', 'MIGRATION_PACKAGE_INVALID');
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, `The package manifest is not valid: ${parsed.error.issues[0]?.message ?? ''}`, 'MIGRATION_PACKAGE_INVALID');
    const manifest = parsed.data as Manifest;
    if (manifest.formatVersion > PACKAGE_VERSION)
      throw new HttpError(
        400,
        `The package was made by a newer ${BRAND.name} (format ${manifest.formatVersion}) – update this instance first`,
        'MIGRATION_PACKAGE_NEWER',
      );
    // the manifest is signed by the source's key, which the package names: the importer confirms its fingerprint
    if (
      sig.alg !== 'ed25519' ||
      sig.publicKey !== manifest.source.publicKey ||
      !verifySignature(manifest.source.publicKey, manifestSigningInput(manifestBytes), String(sig.signature ?? ''))
    ) {
      throw new HttpError(400, 'The package signature is invalid – it was changed after the export', 'MIGRATION_SIGNATURE_INVALID');
    }
    if (publicKeyFingerprint(manifest.source.publicKey) !== manifest.source.fingerprint)
      throw new HttpError(400, 'The package names a fingerprint that does not belong to its key', 'MIGRATION_SIGNATURE_INVALID');
    // exactly the entries the manifest lists: nothing hidden, nothing missing
    const expected = new Map<string, { sha256: string; size?: number }>();
    for (const t of manifest.tables) expected.set(`tables/${t.name}.jsonl`, { sha256: t.sha256 });
    for (const f of manifest.files) {
      const name = `files/${safeEntryName(f.path)}`;
      if (expected.has(name)) throw new HttpError(400, `Duplicate file ${f.path} in the package`, 'MIGRATION_PACKAGE_INVALID');
      expected.set(name, { sha256: f.sha256, size: f.size });
    }
    expected.set('audit.jsonl', { sha256: manifest.audit.sha256 });
    expected.set('settings.json', { sha256: manifest.settings.sha256 });
    // a package cannot inflate to more than a bounded multiple of what was uploaded
    const declared = reader.entries.reduce((s, e) => s + e.usize, 0);
    if (declared > Math.max(4 * 1024 ** 3, 64 * fs.statSync(file).size))
      throw new HttpError(400, 'The package content is larger than its file allows', 'MIGRATION_PACKAGE_INVALID');
    const names = new Set(reader.entries.map((e) => e.name));
    for (const e of reader.entries) {
      if (e.name === 'manifest.json' || e.name === 'signature.json') continue;
      if (!expected.has(e.name)) throw new HttpError(400, `The package contains ${e.name}, which its manifest does not list`, 'MIGRATION_PACKAGE_INVALID');
    }
    if (names.size !== reader.entries.length) throw new HttpError(400, 'The package contains an entry twice', 'MIGRATION_PACKAGE_INVALID');
    for (const [name, want] of expected) {
      const e = reader.find(name);
      if (!e) throw new HttpError(400, `The package lacks ${name}`, 'MIGRATION_PACKAGE_INVALID');
      const d = await reader.digest(e);
      if (!d.crcOk || d.sha256 !== want.sha256 || (want.size !== undefined && d.size !== want.size)) {
        throw new HttpError(400, `${name} does not match the signed manifest`, 'MIGRATION_PACKAGE_INVALID');
      }
    }
    // the source's audit log: an unbroken chain up to the signed checkpoint of the export
    const entries: AuditEntry[] = [];
    for await (const l of lines(reader, reader.find('audit.jsonl')!)) entries.push(JSON.parse(l) as AuditEntry);
    const v = verifyExport({
      entries,
      checkpoints: [{ source: 'checkpoint of the export', cp: manifest.audit.checkpoint }],
      publicKey: manifest.source.publicKey,
      keySource: 'export',
    });
    const historyOk = v.ok && v.uncovered === 0 && entries.length === manifest.audit.entries && entries.length === manifest.audit.checkpoint.seq;
    return {
      dir,
      file,
      reader,
      manifest,
      secrets,
      sha256: await sha256File(file),
      size: fs.statSync(file).size,
      history: {
        ok: historyOk,
        entries: entries.length,
        message: historyOk
          ? `All ${entries.length} entries match the signed checkpoint of ${manifest.audit.checkpoint.ts}`
          : (v.problems[0] ?? 'The history is incomplete'),
      },
      close,
    };
  } catch (e) {
    close();
    throw e;
  }
}

// ---------- the dry run ----------

/** Tables of this database that may hold rows before an import: identities, sign-in and instance settings. */
const TARGET_ALLOWED = new Set([...Object.keys(NOT_MOVED), 'daily_summary_prefs']);

/** Content tables of this instance that already hold rows (the import needs them empty). */
export function filledTargetTables(): string[] {
  const d = db();
  return tables(d)
    .filter((t) => !TARGET_ALLOWED.has(t))
    .filter((t) => Number(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`)!.n) > 0);
}

interface TargetUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  active: boolean;
  sso: boolean;
}

function targetUsers(): TargetUser[] {
  return db()
    .all<{ id: string; username: string; display_name: string; email: string | null; roles: string; active: number; auth_source: string | null }>(
      'SELECT id, username, display_name, email, roles, active, auth_source FROM users ORDER BY username',
    )
    .map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      roles: parseJson<Role[]>(u.roles, []),
      active: !!Number(u.active),
      sso: (u.auth_source ?? 'local') !== 'local',
    }));
}

const targetTeams = () => db().all<{ id: string; name: string }>('SELECT id, name FROM teams ORDER BY name');

const lower = (s: string) => s.trim().toLowerCase();
const localPart = (s: string) => lower(s).split('@')[0]!;

/**
 * A match by e-mail address or by the name before the "@" is a guess: the address of a single sign-on account comes
 * from the identity provider's claims. Mapping a user to such a match needs an explicit confirmation.
 */
export function guessedMatch(u: Pick<PackageUser, 'username' | 'email'>, t: Pick<TargetUser, 'username' | 'email'>): boolean {
  if (lower(t.username) === lower(u.username)) return false;
  return (
    (!!u.email && !!t.email && lower(t.email) === lower(u.email)) ||
    localPart(t.username) === localPart(u.username) ||
    (!!t.email && localPart(t.email) === localPart(u.username))
  );
}

function suggestUser(u: PackageUser, targets: TargetUser[], providers: { id: string }[]): Pick<MigrationPlanUser, 'suggestion' | 'suggestedBy'> {
  const confirm = u.roles.includes('admin') ? false : undefined;
  const pick = (t: TargetUser, by: MigrationPlanUser['suggestedBy']) => ({
    suggestion: {
      action: 'map' as const,
      to: t.username,
      ...(confirm !== undefined || t.roles.includes('admin') || guessedMatch(u, t) ? { confirm: false } : {}),
    },
    suggestedBy: by,
  });
  const active = targets.filter((t) => t.active);
  if (u.email) {
    const byMail = active.find((t) => t.email && lower(t.email) === lower(u.email!));
    if (byMail) return pick(byMail, 'email');
  }
  const same = active.find((t) => lower(t.username) === lower(u.username));
  if (same) return pick(same, 'username');
  const parts = active.filter((t) => localPart(t.username) === localPart(u.username) || (t.email && localPart(t.email) === localPart(u.username)));
  if (parts.length === 1) return pick(parts[0]!, 'localPart');
  if (!u.active) return { suggestion: { action: 'archive', ...(confirm !== undefined ? { confirm } : {}) }, suggestedBy: 'none' };
  return {
    suggestion: {
      action: 'create-sso',
      username: (u.email ?? u.username).toLowerCase(),
      ...(providers.length === 1 ? { provider: providers[0]!.id } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    },
    suggestedBy: 'none',
  };
}

function suggestTeam(t: PackageTeam, existing: { name: string }[]): TeamDecision {
  const same = existing.find((x) => lower(x.name) === lower(t.name));
  return same ? { action: 'map', to: same.name } : { action: 'create' };
}

/** Which of the source's migrations this instance would still apply (and whether it knows them all). */
function schemaGap(m: Manifest): { unknown: string[]; toApply: number; newerCore: boolean } {
  const known = new Set(namedMigrations(db().dialect).map((x) => x.name));
  const unknown = m.schema.named.filter((n) => !known.has(n));
  const core = coreMigrations(db().dialect).length;
  const toApply = Math.max(0, core - m.schema.core) + [...known].filter((n) => !m.schema.named.includes(n)).length;
  return { unknown, toApply, newerCore: m.schema.core > core };
}

function versionNewer(a: string, b: string): boolean {
  const p = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((x) => Number(x) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export function buildPlan(pkg: OpenedPackage): MigrationPlan {
  const m = pkg.manifest;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const gap = schemaGap(m);
  if (gap.newerCore || gap.unknown.length || versionNewer(m.productVersion, config.version)) {
    blocking.push(
      `The package comes from ${BRAND.name} ${m.productVersion}${gap.unknown.length ? ` (unknown migrations: ${gap.unknown.slice(0, 5).join(', ')})` : ''} – this instance runs ${config.version}. Update this instance first.`,
    );
  }
  if (!pkg.history.ok) blocking.push(`The audit history in the package does not verify: ${pkg.history.message}`);
  if (!vault().unlocked) blocking.push('The vault of this instance is locked.');
  const filled = filledTargetTables();
  if (filled.length)
    blocking.push(`This instance already holds data (${filled.slice(0, 8).join(', ')}${filled.length > 8 ? ' …' : ''}) – import into a new instance.`);
  if (db().get('SELECT 1 FROM instance_imports WHERE package_id = ?', m.packageId)) blocking.push('This package was imported already.');
  if (db().get('SELECT 1 FROM instance_imports LIMIT 1')) blocking.push('This instance already holds an imported package.');
  const targets = targetUsers();
  const tTeams = targetTeams();
  const providers = publicProviders();
  const users: MigrationPlanUser[] = m.users.map((u) => {
    const clashUser = targets.find((t) => lower(t.username) === lower(u.username));
    return {
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      roles: u.roles,
      active: u.active,
      kind: u.kind,
      provider: u.provider,
      teams: u.teams,
      lastLoginAt: u.lastLoginAt,
      ...suggestUser(u, targets, providers),
      clash: clashUser ? { username: clashUser.username, admin: clashUser.roles.includes('admin') } : null,
    };
  });
  const teams: MigrationPlanTeam[] = m.teams.map((t) => ({
    name: t.name,
    description: t.description,
    members: t.members,
    suggestion: suggestTeam(t, tTeams),
    clash: tTeams.some((x) => lower(x.name) === lower(t.name)),
  }));
  const unsealed = Object.values(m.platformIntegrity).filter((s) => s !== 'ok').length;
  if (unsealed)
    warnings.push(`${unsealed} platform(s) had settings changed outside ${BRAND.name} on the source – an administrator reviews them after the import.`);
  warnings.push('Runs that are still running or waiting for a decision on the source are imported cancelled – start them again here if they are still needed.');
  const settingsKeys = m.settings.keys;
  return {
    packageId: m.packageId,
    packageSha256: pkg.sha256,
    sizeBytes: pkg.size,
    source: { version: m.productVersion, exportedAt: m.createdAt, exportedBy: m.createdBy, database: m.source.database },
    schema: { core: m.schema.core, named: m.schema.named.length, migrationsToApply: gap.toApply },
    counts: m.tables.filter((t) => t.rows > 0).map((t) => ({ table: t.name, rows: t.rows })),
    files: { count: m.files.length, bytes: m.files.reduce((s, f) => s + f.size, 0) },
    history: { entries: pkg.history.entries, ok: pkg.history.ok, message: pkg.history.message, checkpointSeq: m.audit.checkpoint.seq },
    users,
    teams,
    targetUsers: targets.map((t) => ({ username: t.username, displayName: t.displayName, email: t.email, roles: t.roles, active: t.active, sso: t.sso })),
    targetTeams: tTeams.map((t) => t.name),
    paused: PAUSED_ON_IMPORT.map((p) => ({ label: p.label, count: m.tables.find((t) => t.name === p.table)?.rows ?? 0 })).filter((p) => p.count > 0),
    settings: {
      applied: settingsKeys.filter((k) => SETTINGS_MOVED.includes(k)),
      notApplied: settingsKeys.filter((k) => !SETTINGS_MOVED.includes(k) && !/^(system|vault|security|audit|maintenance)\./.test(k)),
    },
    notMoved: Object.entries(NOT_MOVED)
      .filter(([t]) => !['schema_version', 'schema_migrations', 'sqlite_sequence', 'engine_probe'].includes(t))
      .map(([what, why]) => ({ what, why })),
    blocking,
    warnings,
    providers: providers.map((p) => ({ id: p.id, displayName: p.displayName })),
    passwordLogin: passwordLoginMode(),
  };
}

// ---------- the mapping ----------

const USERNAME = /^[a-zA-Z0-9._@-]{2,64}$/;
const TEAM_NAME = /^[\w .@-]{2,64}$/;
const confirmField = z.boolean().optional();
const userDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('map'), to: z.string().min(1).max(100), confirm: confirmField }),
  z.object({ action: z.literal('create-sso'), username: z.string().min(1).max(100), provider: z.string().max(100).optional(), confirm: confirmField }),
  z.object({ action: z.literal('create-local'), username: z.string().max(100).optional(), confirm: confirmField }),
  z.object({ action: z.literal('archive'), username: z.string().max(100).optional(), confirm: confirmField }),
]);
const teamDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('map'), to: z.string().min(1).max(100) }),
  z.object({ action: z.literal('create'), name: z.string().max(100).optional() }),
  z.object({ action: z.literal('drop') }),
]);
export const mappingSchema = z.object({
  // as many entries as a package may carry users and teams (see manifestSchema)
  users: boundedRecord(userDecision, 100000),
  teams: boundedRecord(teamDecision, 10000),
});

interface ResolvedUser {
  source: PackageUser;
  decision: UserDecision;
  /** The account on this instance (existing or to create) */
  username: string;
  existingId: string | null;
  /** create-sso: the provider that may claim the new account */
  provider?: string;
}
interface ResolvedTeam {
  source: PackageTeam;
  decision: TeamDecision;
  name: string | null;
  existingId: string | null;
}

/** Checks a complete mapping against the package and this instance. Throws with every problem found. */
export function resolveMapping(m: Manifest, mapping: MigrationMapping, importer: { id: string } | null): { users: ResolvedUser[]; teams: ResolvedTeam[] } {
  const problems: string[] = [];
  const targets = targetUsers();
  const byName = new Map(targets.map((t) => [lower(t.username), t]));
  const tTeams = targetTeams();
  const teamByName = new Map(tTeams.map((t) => [lower(t.name), t]));
  const sourceNames = new Set(m.users.map((u) => u.username));
  for (const k of Object.keys(mapping.users)) if (!sourceNames.has(k)) problems.push(`The mapping names user "${k}", who is not in the package`);
  const teamNames = new Set(m.teams.map((t) => t.name));
  for (const k of Object.keys(mapping.teams)) if (!teamNames.has(k)) problems.push(`The mapping names team "${k}", which is not in the package`);
  const creating = new Set<string>();
  const users: ResolvedUser[] = [];
  const providers = publicProviders();
  const usedAliases = new Set(
    db()
      .all<{ alias: string }>("SELECT alias FROM identity_aliases WHERE kind = 'user'")
      .map((r) => r.alias),
  );
  for (const u of m.users) {
    const d = mapping.users[u.username];
    if (!d) {
      problems.push(`No decision for user "${u.username}"`);
      continue;
    }
    const isSourceAdmin = u.roles.includes('admin');
    if (isSourceAdmin && d.confirm !== true) problems.push(`"${u.username}" is an administrator on the source – confirm the decision for this account`);
    let username = u.username;
    let existingId: string | null = null;
    let provider: string | undefined;
    if (d.action === 'map') {
      const t = byName.get(lower(d.to));
      if (!t) problems.push(`"${u.username}" is mapped to "${d.to}", who does not exist here`);
      else {
        if (!t.active) problems.push(`"${u.username}" is mapped to "${t.username}", whose account is deactivated`);
        if (t.roles.includes('admin') && d.confirm !== true) problems.push(`"${u.username}" is mapped to the administrator "${t.username}" – confirm it`);
        else if (guessedMatch(u, t) && d.confirm !== true)
          problems.push(`"${u.username}" is mapped to "${t.username}" by e-mail address or name only – confirm that it is the same person`);
        username = t.username;
        existingId = t.id;
      }
    } else {
      username = (d.action === 'create-sso' ? d.username : (d.username ?? u.username)).trim();
      if (d.action === 'create-sso') {
        // bound to one provider: no other provider can hand the account (and its roles) to someone with that name
        if (d.provider) {
          if (!providers.some((p) => p.id === d.provider)) problems.push(`"${u.username}": "${d.provider}" is not an enabled single sign-on provider here`);
          else provider = d.provider;
        } else if (providers.length === 1) provider = providers[0]!.id;
        else if (!providers.length) problems.push(`"${u.username}": no single sign-on provider is enabled here – set one up first`);
        else problems.push(`"${u.username}": choose the single sign-on provider the new account signs in with`);
      }
      if (d.action === 'create-local' && passwordLoginMode() === 'none')
        problems.push(`"${u.username}": password sign-in is turned off here – choose a single sign-on account instead`);
      if (!USERNAME.test(username)) problems.push(`"${username}" is not a valid user name (2–64 characters, letters, digits and . _ @ -)`);
      else if (byName.has(lower(username))) problems.push(`"${username}" exists here already – map "${u.username}" to it instead`);
      else if (creating.has(lower(username))) problems.push(`"${username}" would be created twice`);
      else if (usedAliases.has(lower(username))) problems.push(`"${username}" is the former name of an imported account`);
      creating.add(lower(username));
    }
    // A source name that is an account here must be that account: otherwise the former name would become an alias of
    // another account and match "user:<name>" everywhere – the existing account's grants, now and in future content.
    // (No exception for administrators: an alias equal to an existing name is never created.)
    const clash = byName.get(lower(u.username));
    if (clash && lower(clash.username) !== lower(username)) {
      problems.push(`"${u.username}" is the name of an account here – map "${u.username}" to that account`);
    }
    if (usedAliases.has(lower(u.username))) problems.push(`"${u.username}" is the former name of an account imported earlier`);
    // mapping to the importing administrator is fine: that account is never changed (no roles, no teams)
    void importer;
    users.push({ source: u, decision: d, username, existingId, provider });
  }
  const teams: ResolvedTeam[] = [];
  const newTeams = new Set<string>();
  for (const t of m.teams) {
    const d = mapping.teams[t.name];
    if (!d) {
      problems.push(`No decision for team "${t.name}"`);
      continue;
    }
    let name: string | null = null;
    let existingId: string | null = null;
    if (d.action === 'map') {
      const x = teamByName.get(lower(d.to));
      if (!x) problems.push(`Team "${t.name}" is mapped to "${d.to}", which does not exist here`);
      else ((name = x.name), (existingId = x.id));
    } else if (d.action === 'create') {
      name = (d.name ?? t.name).trim();
      if (!TEAM_NAME.test(name)) problems.push(`"${name}" is not a valid team name`);
      else if (teamByName.has(lower(name)) || newTeams.has(lower(name))) problems.push(`Team "${name}" exists here already – map "${t.name}" to it instead`);
      newTeams.add(lower(name));
    }
    const clash = teamByName.get(lower(t.name));
    if (clash && (d.action !== 'map' || lower(d.to) !== lower(clash.name))) {
      problems.push(`Team "${t.name}" exists here – map it to that team (a team name in imported content would otherwise reach its members)`);
    }
    teams.push({ source: t, decision: d, name, existingId });
  }
  if (problems.length) throw new HttpError(400, `The identity mapping cannot be applied: ${problems.join('; ')}`, 'MIGRATION_MAPPING_INVALID', { problems });
  return { users, teams };
}

// ---------- staging: the package's rows at their schema, then migrated to this version ----------

async function buildStaging(pkg: OpenedPackage, file: string): Promise<Db> {
  const m = pkg.manifest;
  const staging = new Db({ kind: 'sqlite', file }, { upTo: { core: m.schema.core, named: m.schema.named }, appVersion: m.productVersion, quiet: true });
  try {
    const order = fkOrder(
      staging,
      m.tables.map((t) => t.name),
    );
    const have = new Set(tables(staging));
    for (const name of order) {
      const t = m.tables.find((x) => x.name === name)!;
      if (!have.has(name)) throw new HttpError(400, `The package has a table ${name} that its schema does not create`, 'MIGRATION_PACKAGE_INVALID');
      const cols = new Set(columns(staging, name));
      for (const c of t.columns)
        if (!cols.has(c)) throw new HttpError(400, `Table ${name} of the package has an unknown column ${c}`, 'MIGRATION_PACKAGE_INVALID');
      const head = `INSERT INTO ${quoteIdent(name)} (${t.columns.map(quoteIdent).join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`;
      let n = 0;
      let batch: unknown[][] = [];
      const flush = () => {
        const rows = batch;
        batch = [];
        staging.tx(() => {
          for (const r of rows) staging.run(head, ...r);
        });
      };
      for await (const l of lines(pkg.reader, pkg.reader.find(`tables/${name}.jsonl`)!)) {
        const row = JSON.parse(l) as Record<string, unknown>;
        batch.push(t.columns.map((c) => (row[c] === undefined ? null : row[c])));
        n++;
        if (batch.length >= 500) flush();
      }
      flush();
      if (n !== t.rows) throw new HttpError(400, `Table ${name}: the package lists ${t.rows} rows but holds ${n}`, 'MIGRATION_PACKAGE_INVALID');
    }
  } catch (e) {
    staging.close();
    throw e;
  }
  staging.close();
  // the remaining migrations of this version (exactly as an update of the source would run them)
  return new Db({ kind: 'sqlite', file }, { quiet: true });
}

// ---------- mapping of the "who owns / who may" columns ----------

interface NameMaps {
  /** source user name (lower case) → user name here */
  users: Map<string, string>;
  /** source team name (lower case) → team name here, or null (dropped) */
  teams: Map<string, string | null>;
}

function mapSubject(s: unknown, maps: NameMaps): string | null {
  if (typeof s !== 'string') return s as null;
  const m = /^(user|team):(.+)$/i.exec(s.trim());
  if (!m) return s;
  const name = lower(m[2]!);
  if (m[1]!.toLowerCase() === 'user') {
    const to = maps.users.get(name);
    return to ? `user:${lower(to)}` : s;
  }
  if (!maps.teams.has(name)) return s;
  const to = maps.teams.get(name);
  return to ? `team:${lower(to)}` : null;
}

function mapValue(kind: RefKind, raw: unknown, maps: NameMaps): unknown {
  if (raw === null || raw === undefined) return raw;
  if (kind === 'username') {
    const to = maps.users.get(lower(String(raw)));
    return to ?? raw;
  }
  const json = parseJson<unknown>(String(raw), undefined);
  if (json === undefined) return raw;
  let out: unknown = json;
  if (kind === 'subjects' && Array.isArray(json)) {
    out = [...new Set(json.map((s) => mapSubject(s, maps)).filter((s) => s !== null))];
  } else if (kind === 'acl' && Array.isArray(json)) {
    out = json
      .map((e) => (e && typeof e === 'object' ? { ...(e as object), subject: mapSubject((e as { subject?: unknown }).subject, maps) } : e))
      .filter((e) => !(e && typeof e === 'object' && (e as { subject: unknown }).subject === null));
  } else if (kind === 'recipients' && json && typeof json === 'object') {
    const r = json as { users?: unknown[]; teams?: unknown[] };
    out = {
      ...r,
      users: Array.isArray(r.users) ? [...new Set(r.users.map((x) => (typeof x === 'string' ? (maps.users.get(lower(x)) ?? x) : x)))] : r.users,
      teams: Array.isArray(r.teams)
        ? r.teams.map((x) => (typeof x === 'string' && maps.teams.has(lower(x)) ? maps.teams.get(lower(x)) : x)).filter((x) => x !== null && x !== undefined)
        : r.teams,
    };
  } else if (kind === 'monitorDefinition' && json && typeof json === 'object') {
    const def = json as { outputs?: { subscribers?: unknown[] }[] };
    if (Array.isArray(def.outputs)) {
      out = {
        ...def,
        outputs: def.outputs.map((o) =>
          o && Array.isArray(o.subscribers) ? { ...o, subscribers: [...new Set(o.subscribers.map((s) => mapSubject(s, maps)).filter((s) => s !== null))] } : o,
        ),
      };
    }
  }
  return JSON.stringify(out);
}

/** Credentials: from the package's key to this vault's data key. */
function reencrypt(staging: Db, secrets: Buffer): number {
  const target = vault();
  let n = 0;
  const have = new Set(tables(staging));
  for (const c of ENCRYPTED_COLUMNS) {
    if (!have.has(c.table)) continue;
    const rows = staging.all<{ id: string; blob: string | null }>(`SELECT ${c.id} AS id, ${c.column} AS blob FROM ${c.table} WHERE ${c.column} IS NOT NULL`);
    staging.tx(() => {
      for (const r of rows) {
        if (!r.blob) continue;
        let value: unknown;
        try {
          value = JSON.parse(decryptWith(secrets, r.blob));
        } catch {
          throw new HttpError(400, `A credential in ${c.table} cannot be read with the package key`, 'MIGRATION_PACKAGE_INVALID');
        }
        // only the columns registered in ENCRYPTED_COLUMNS (key rotation covers them), with this vault's data key
        staging.run(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.id} = ?`, target.encrypt(value), r.id);
        n++;
      }
    });
  }
  return n;
}

/**
 * Stored files: paths relative to the data folder ("@data/artifacts/…") become paths in this data folder. A path that
 * would lead anywhere else (absolute, "..", odd characters) is refused – downloads read these paths.
 */
export function fixStoredPaths(staging: Db, dataDir: string): void {
  const have = new Set(tables(staging));
  const inside = (dir: string, rel: string | null, what: string) => {
    try {
      return pathInside(path.join(dataDir, dir), ...String(rel).split('/'));
    } catch {
      throw new HttpError(400, `The package has an unsafe file path in ${what}`, 'MIGRATION_PACKAGE_INVALID');
    }
  };
  for (const r of staging.all<{ id: string; path: string }>('SELECT id, path FROM run_artifacts')) {
    const prefix = `${DATA_PREFIX}artifacts/`;
    if (typeof r.path !== 'string' || !r.path.startsWith(prefix))
      throw new HttpError(400, 'The package has an unsafe file path in run_artifacts', 'MIGRATION_PACKAGE_INVALID');
    staging.run('UPDATE run_artifacts SET path = ? WHERE id = ?', inside('artifacts', r.path.slice(prefix.length), 'run_artifacts'), r.id);
  }
  if (have.has('record_attachments'))
    for (const r of staging.all<{ path: string | null }>('SELECT path FROM record_attachments WHERE path IS NOT NULL'))
      inside('records', r.path, 'record_attachments');
  if (have.has('reports'))
    for (const r of staging.all<{ path: string | null }>('SELECT path FROM reports WHERE path IS NOT NULL')) inside('reports', r.path, 'reports');
}

/** Shown with the paused automation: unfinished runs arrive cancelled. */
export const UNFINISHED_RUNS_LABEL = 'unfinished runs (cancelled – start them again here)';
const UNFINISHED_NOTE = 'Imported from another instance before it finished – it is not resumed here; start it again if it is still needed.';

/**
 * Runs that were running, queued or waiting for a decision on the source are cancelled (with a note): they would
 * otherwise be resumed at the next start (engine/runner.ts recoverRuns) and carry on with the moved credentials,
 * without anyone here having decided to run them. Their open decisions are cancelled too. Returns their number.
 */
export function cancelUnfinishedRuns(staging: Db): number {
  const ids = staging.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('running', 'queued', 'waiting')").map((r) => r.id);
  const ts = nowIso();
  for (const id of ids) {
    staging.run("UPDATE run_tasks SET status = 'cancelled', decided_by = 'system', decided_at = ? WHERE run_id = ? AND status = 'open'", ts, id);
    staging.run("UPDATE runs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?", ts, UNFINISHED_NOTE, id);
  }
  return ids.length;
}

function transformStaging(staging: Db, pkg: OpenedPackage, maps: NameMaps, dataDir: string): number {
  const have = new Set(tables(staging));
  let unfinished = 0;
  staging.tx(() => {
    // who owns something / who may do something now
    for (const ref of USER_REFS) {
      if (!have.has(ref.table)) continue;
      const pk = staging.all<{ name: string }>('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', ref.table).map((r) => r.name);
      const key = pk.length ? pk : ['rowid'];
      const rows = staging.all<Record<string, unknown>>(
        `SELECT ${key.map(quoteIdent).join(', ')}, ${quoteIdent(ref.column)} AS v FROM ${quoteIdent(ref.table)} WHERE ${quoteIdent(ref.column)} IS NOT NULL`,
      );
      for (const r of rows) {
        const next = mapValue(ref.kind, r.v, maps);
        if (next !== r.v)
          staging.run(
            `UPDATE ${quoteIdent(ref.table)} SET ${quoteIdent(ref.column)} = ? WHERE ${key.map((k) => `${quoteIdent(k)} = ?`).join(' AND ')}`,
            next,
            ...key.map((k) => r[k]),
          );
      }
    }
    // automation starts paused: an administrator reviews it on this instance first
    for (const p of PAUSED_ON_IMPORT) if (have.has(p.table)) staging.run(`UPDATE ${quoteIdent(p.table)} SET ${quoteIdent(p.column)} = 0`);
    unfinished = cancelUnfinishedRuns(staging);
    fixStoredPaths(staging, dataDir);
  });
  reencrypt(staging, pkg.secrets);
  return unfinished;
}

// ---------- files ----------

async function writeFiles(pkg: OpenedPackage, dataDir: string): Promise<{ written: string[] }> {
  const written: string[] = [];
  try {
    for (const f of pkg.manifest.files) {
      const rel = safeEntryName(f.path).split('/');
      if (!['artifacts', 'docs', 'reports', 'records', 'evidence-packs', 'branding'].includes(rel[0]!) || rel.length < 2) {
        throw new HttpError(400, `The package has a file outside the stored-file folders: ${f.path}`, 'MIGRATION_PACKAGE_INVALID');
      }
      const target = pathInside(dataDir, ...rel);
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      // no link may lead out of the data folder
      const real = fs.realpathSync(parent);
      if (!(real + path.sep).startsWith(fs.realpathSync(dataDir) + path.sep)) throw new HttpError(400, `Unsafe path ${f.path}`, 'MIGRATION_PACKAGE_INVALID');
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      written.push(target);
      await pipeline(await pkg.reader.stream(pkg.reader.find(`files/${f.path}`)!, f.size), fs.createWriteStream('', { fd }));
    }
  } catch (e) {
    for (const w of written) fs.rmSync(w, { force: true });
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new HttpError(409, 'A file of the package exists in the data folder already', 'MIGRATION_TARGET_NOT_EMPTY');
    throw e;
  }
  return { written };
}

// ---------- the import ----------

export interface ApplyOptions {
  mapping: MigrationMapping;
  /** Audit actor ("cli:…" or the signed-in administrator) */
  actor?: string;
  /** The signed-in administrator who imports (their account is never changed) */
  importer?: { id: string; username: string } | null;
  /**
   * The fingerprint of the source's key as the person read it on the source: at least MIGRATION_FINGERPRINT_MIN_CHARS
   * hex digits from its start (separators and case do not matter), matching the key that signed the package
   */
  confirmFingerprint: string;
}

export async function applyImport(pkg: OpenedPackage, opts: ApplyOptions): Promise<ImportResult> {
  const m = pkg.manifest;
  const plan = buildPlan(pkg);
  if (plan.blocking.length) throw new HttpError(409, plan.blocking.join(' '), 'MIGRATION_BLOCKED', { problems: plan.blocking });
  const typed = normalizeFingerprint(opts.confirmFingerprint ?? '');
  if (typed.length < MIGRATION_FINGERPRINT_MIN_CHARS || !/^[0-9a-f]+$/.test(typed))
    throw new HttpError(
      400,
      `Enter the fingerprint of the source's signing key as the source shows it – at least its first ${MIGRATION_FINGERPRINT_MIN_CHARS} characters`,
      'MIGRATION_FINGERPRINT_SHORT',
      { min: MIGRATION_FINGERPRINT_MIN_CHARS },
    );
  if (!normalizeFingerprint(m.source.fingerprint).startsWith(typed))
    throw new HttpError(400, 'The confirmed fingerprint does not match the package', 'MIGRATION_FINGERPRINT_MISMATCH');
  const mapping = mappingSchema.parse(opts.mapping) as MigrationMapping;
  const resolved = resolveMapping(m, mapping, opts.importer ?? null);
  const dataDir = config.dataDir;
  const maps: NameMaps = {
    users: new Map(resolved.users.map((u) => [lower(u.source.username), u.username])),
    teams: new Map(resolved.teams.map((t) => [lower(t.source.name), t.name])),
  };
  const stagingFile = path.join(pkg.dir, 'staging.db');
  const staging = await buildStaging(pkg, stagingFile);
  let files: string[] = [];
  try {
    const unfinished = transformStaging(staging, pkg, maps, dataDir);
    files = (await writeFiles(pkg, dataDir)).written;
    checkStoredContent(staging, dataDir);
    const settings = checkedSettings(parseJson<Record<string, unknown>>((await readEntry(pkg.reader, 'settings.json')).toString('utf8'), {}), dataDir);
    const entries: AuditEntry[] = [];
    for await (const l of lines(pkg.reader, pkg.reader.find('audit.jsonl')!)) entries.push(JSON.parse(l) as AuditEntry);
    const result = copyIntoTarget(staging, pkg, resolved, settings, entries, opts, unfinished);
    invalidateAliases();
    invalidateVerifiedImports();
    return { ...result, files: files.length };
  } catch (e) {
    for (const f of files) fs.rmSync(f, { force: true });
    throw e;
  } finally {
    staging.close();
  }
}

/**
 * Files that are served back must be what their rows say: run artifacts are images (taken from the content), record
 * attachments get the type their content and name give, exactly as at upload. A row of another type would be served
 * with a type the package chose (a page or a script on Steward's origin).
 */
export function checkStoredContent(staging: Db, dataDir: string): void {
  const have = new Set(tables(staging));
  const read = (file: string): Buffer | null => {
    try {
      return fs.readFileSync(file);
    } catch {
      return null; // the file was removed on the source (retention): nothing is served
    }
  };
  staging.tx(() => {
    if (have.has('run_artifacts'))
      for (const r of staging.all<{ id: string; path: string; mime: string }>('SELECT id, path, mime FROM run_artifacts')) {
        const data = read(r.path);
        if (!data) continue;
        const type = rasterImageType(data);
        if (!type || type !== r.mime) throw new HttpError(400, `Run artifact ${r.id} is not the image it claims to be`, 'MIGRATION_PACKAGE_INVALID');
      }
    if (have.has('record_attachments'))
      for (const r of staging.all<{ id: string; path: string | null; filename: string }>(
        'SELECT id, path, filename FROM record_attachments WHERE path IS NOT NULL',
      )) {
        const data = read(pathInside(path.join(dataDir, 'records'), ...String(r.path).split('/')));
        if (!data) continue;
        let mime: string;
        try {
          mime = sniff(r.filename, data).mime;
        } catch {
          throw new HttpError(400, `Attachment ${r.id} (${r.filename}) is not a file type Steward accepts`, 'MIGRATION_PACKAGE_INVALID');
        }
        staging.run('UPDATE record_attachments SET mime = ? WHERE id = ?', mime, r.id);
      }
  });
}

/** The settings that move, each checked like its own form would (invalid values are left out, not applied). */
export function checkedSettings(settings: Record<string, unknown>, dataDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  const object = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const [k, v] of Object.entries(settings)) {
    if (!SETTINGS_MOVED.includes(k) || v === null || v === undefined) continue;
    let ok: unknown;
    if (k === 'browserHeadless' || k === 'findingDismissFourEyes') ok = typeof v === 'boolean' ? v : undefined;
    else if (k === 'browserTimeoutMs') ok = int(v, 1000, 3_600_000) ? v : undefined;
    else if (k === 'retentionRunDays') ok = int(v, 0, 3650) ? v : undefined;
    else if (k === 'retentionNotificationDays' || k === 'retentionMonitorDays') ok = int(v, 1, 3650) ? v : undefined;
    else if (k === 'defaultLocale') ok = typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v) ? v : undefined;
    else if (k === 'theme.settings') ok = checkedThemeSettings(v) ?? undefined;
    else if (k === 'theme.logo') ok = checkedLogo(v) ?? undefined;
    else if (k === 'reports.branding') {
      const mime = object(v) ? (v as { logoMime?: unknown }).logoMime : null;
      const file = mime === 'image/jpeg' ? 'logo.jpg' : 'logo.png';
      let data: Buffer | null;
      try {
        data = fs.readFileSync(path.join(dataDir, 'branding', file));
      } catch {
        data = null;
      }
      ok = checkedBranding(v, data) ?? undefined;
    } else ok = object(v) ? v : undefined;
    if (ok !== undefined) out[k] = ok;
  }
  return out;
}

/** The mapping as lines for the audit entry, or only its size when it would make the entry too large. */
function mappingSummary(rows: MigrationMappingRow[]): string[] | { rows: number } {
  const lines = rows.map((r) => `${r.kind} ${r.source} → ${r.action}${r.target ? ` ${r.target}` : ''}`);
  return JSON.stringify(lines).length > 10_000 ? { rows: rows.length } : lines;
}

function copyIntoTarget(
  staging: Db,
  pkg: OpenedPackage,
  resolved: { users: ResolvedUser[]; teams: ResolvedTeam[] },
  settings: Record<string, unknown>,
  history: AuditEntry[],
  opts: ApplyOptions,
  unfinished: number,
): Omit<ImportResult, 'files'> {
  const m = pkg.manifest;
  const d = db();
  const importId = newId('imp_');
  const ts = nowIso();
  const temporaryPasswords: ImportResult['temporaryPasswords'] = [];
  const counts: Record<string, number> = {};
  const rows: MigrationMappingRow[] = [];
  const userIds = new Map<string, string>(); // source user id → id here
  d.tx(() => {
    // the import record first: identity aliases and the imported history refer to it
    d.run(
      `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
         source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      importId,
      m.packageId,
      pkg.sha256,
      ts,
      opts.actor ?? opts.importer?.username ?? 'system',
      m.source.fingerprint,
      m.source.publicKey,
      m.productVersion,
      m.createdAt,
      m.createdBy,
      JSON.stringify({ ...m, users: undefined, teams: undefined, files: m.files.length }),
      '[]',
      '',
      '{}',
      JSON.stringify(m.audit.checkpoint),
      history.length,
    );
    // ---- teams ----
    const teamIds = new Map<string, string>(); // source team name (lower) → team id here
    for (const t of resolved.teams) {
      if (t.decision.action === 'map') teamIds.set(lower(t.source.name), t.existingId!);
      else if (t.decision.action === 'create') {
        const id = newId('team_');
        d.run('INSERT INTO teams (id, name, description, created_at) VALUES (?, ?, ?, ?)', id, t.name, t.source.description ?? '', ts);
        teamIds.set(lower(t.source.name), id);
      }
      rows.push({
        kind: 'team',
        source: t.source.name,
        sourceKind: 'team',
        action: t.decision.action,
        target: t.name,
        targetId: teamIds.get(lower(t.source.name)) ?? null,
      });
      if (t.name && lower(t.name) !== lower(t.source.name) && teamIds.get(lower(t.source.name))) {
        d.run(
          "INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('team', ?, ?, ?)",
          lower(t.source.name),
          teamIds.get(lower(t.source.name)),
          importId,
        );
      }
    }
    // ---- users ----
    for (const u of resolved.users) {
      const roles = u.source.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
      let id = u.existingId;
      if (u.decision.action !== 'map') {
        id = newId('usr_');
        const archive = u.decision.action === 'archive';
        let hash = NO_PASSWORD;
        if (u.decision.action === 'create-local') {
          const pw = temporaryPassword();
          hash = hashPassword(pw);
          temporaryPasswords.push({ username: u.username, password: pw });
        }
        d.run(
          `INSERT INTO users (id, username, display_name, email, password_hash, roles, active, must_change_password, created_at, updated_at, auth_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          u.username,
          u.source.displayName || u.username,
          u.source.email,
          hash,
          JSON.stringify(archive ? [] : roles),
          archive ? 0 : 1,
          u.decision.action === 'create-local' ? 1 : 0,
          ts,
          ts,
          // a new single sign-on account belongs to the chosen provider until its first sign-in links it
          u.provider ?? 'local',
        );
      }
      userIds.set(u.source.id, id!);
      const sourceKind = u.source.kind === 'sso' ? `sso${u.source.provider ? ` (${u.source.provider})` : ''}` : 'local';
      rows.push({ kind: 'user', source: u.source.username, sourceKind, action: u.decision.action, target: u.username, targetId: id });
      if (lower(u.username) !== lower(u.source.username)) {
        d.run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', ?, ?, ?)", lower(u.source.username), id, importId);
      }
      // team memberships follow the mapping (never for the importing administrator, never for former users)
      if (u.decision.action === 'archive' || (opts.importer && id === opts.importer.id)) continue;
      for (const tn of u.source.teams) {
        const tid = teamIds.get(lower(tn));
        if (tid) d.run('INSERT INTO team_members (team_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', tid, id);
      }
    }
    // ---- content ----
    const order = fkOrder(d, tables(d)).filter((t) => !(t in NOT_MOVED));
    const stagingTables = new Set(tables(staging));
    for (const t of order) {
      if (!stagingTables.has(t)) continue;
      const cols = columns(staging, t).filter((c) => columns(d, t).includes(c));
      const userCol = USER_ID_TABLES[t];
      const sel = staging.all<Record<string, unknown>>(`SELECT ${cols.map(quoteIdent).join(', ')} FROM ${quoteIdent(t)}`);
      let n = 0;
      const insert = `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const r of sel) {
        if (userCol) {
          const to = userIds.get(String(r[userCol]));
          const archived = resolved.users.find((x) => x.source.id === r[userCol])?.decision.action === 'archive';
          if (!to || archived || d.get(`SELECT 1 FROM ${quoteIdent(t)} WHERE ${quoteIdent(userCol)} = ?`, to)) continue;
          r[userCol] = to;
        }
        d.run(insert, ...cols.map((c) => r[c] ?? null));
        n++;
      }
      if (n) counts[t] = n;
    }
    // ---- selected settings ----
    for (const [k, v] of Object.entries(settings)) {
      if (!SETTINGS_MOVED.includes(k) || v === null || v === undefined) continue;
      d.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
    }
    // ---- configuration integrity: what was intact on the source is sealed with this vault's key ----
    for (const [id, state] of Object.entries(m.platformIntegrity)) {
      if (state === 'ok') sealPlatform(id);
      else d.run('UPDATE platforms SET config_mac = NULL WHERE id = ?', id);
    }
    // ---- the imported history, unchanged ----
    for (const e of history) {
      d.run(
        `INSERT INTO imported_audit_log (import_id, seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importId,
        e.seq,
        e.ts,
        e.actor,
        e.action,
        e.entityType,
        e.entityId ?? null,
        e.runId ?? null,
        e.summary,
        e.details === null || e.details === undefined ? null : JSON.stringify(e.details),
        e.prevHash ?? '',
        e.hash,
      );
    }
    if (d.dialect === 'postgres') {
      const ids = d.all<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'",
      );
      for (const { table_name: t, column_name: c } of ids) {
        d.get(`SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${quoteIdent(c)}) FROM ${quoteIdent(t)}), 0) + 1, false)`, quoteIdent(t), c);
      }
    }
    const mappingJson = canonicalJson(rows);
    const mappingSha = sha256(mappingJson);
    d.run('UPDATE instance_imports SET mapping = ?, mapping_sha256 = ?, counts = ? WHERE id = ?', mappingJson, mappingSha, JSON.stringify(counts), importId);
    const pausedNow = [
      ...PAUSED_ON_IMPORT.map((p) => ({ label: p.label, count: counts[p.table] ?? 0 })),
      { label: UNFINISHED_RUNS_LABEL, count: unfinished },
    ].filter((p) => p.count > 0);
    audit({
      ...(opts.actor ? { actor: opts.actor } : {}),
      action: 'instance.imported',
      entityType: 'instance',
      entityId: importId,
      summary: `Migration package ${m.packageId} from ${m.source.fingerprint} (${BRAND.name} ${m.productVersion}) imported: ${Object.values(counts).reduce((s, n) => s + n, 0)} rows, ${m.files.length} files, ${history.length} audit entries of the source; ${rows.filter((r) => r.kind === 'user').length} users mapped`,
      details: {
        importId,
        packageId: m.packageId,
        packageSha256: pkg.sha256,
        source: { fingerprint: m.source.fingerprint, version: m.productVersion, exportedAt: m.createdAt, exportedBy: m.createdBy },
        history: { entries: history.length, checkpointSeq: m.audit.checkpoint.seq, checkpointHash: m.audit.checkpoint.hash, digest: m.audit.checkpoint.digest },
        mappingSha256: mappingSha,
        counts,
        paused: pausedNow.map((p) => `${p.label}: ${p.count}`),
        // the full table is in the import record (bound by mappingSha256); here as long as the entry stays small
        mapping: mappingSummary(rows),
      },
    });
  });
  const paused = [
    ...PAUSED_ON_IMPORT.map((p) => ({ label: p.label, count: counts[p.table] ?? 0 })),
    { label: UNFINISHED_RUNS_LABEL, count: unfinished },
  ].filter((p) => p.count > 0);
  return { importId, counts, historyEntries: history.length, temporaryPasswords, paused };
}
