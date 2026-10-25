import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND, type Role } from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit, toEntry, type AuditRow } from '../audit.js';
import { createCheckpoint } from '../audit-anchor.js';
import { publicKeyFingerprint, vault, encryptWith } from '../vault.js';
import { ENCRYPTED_COLUMNS } from '../vault-rotation.js';
import { ZipWriter } from '../compliance/zip.js';
import { platformIntegrity, type SealedPlatformRow } from '../platforms/integrity.js';
import { columns, readBatches, tables } from '../cli/db-copy.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { listProviders } from '../auth/sso.js';
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  newPackageKeys,
  sealPackage,
  sha256File,
  workDir,
  type Manifest,
  type PackageTeam,
  type PackageUser,
} from './format.js';
import { FILE_DIRS, NOT_MOVED, SETTINGS_MOVED, USER_ID_TABLES } from './tables.js';

/** Paths to stored files (run artifacts) are written relative to the data folder: "@data/artifacts/…". */
export const DATA_PREFIX = '@data/';

export interface ExportResult {
  packageId: string;
  sha256: string;
  size: number;
  tables: number;
  rows: number;
  files: number;
  auditEntries: number;
  fingerprint: string;
  /** Credentials that could not be decrypted on the source (moved empty) */
  undecryptable: number;
}

/** The schema of the open database: core version and the named migrations applied. */
export function currentSchema(): { core: number; named: string[] } {
  const core = Number(db().get<{ version: number }>('SELECT version FROM schema_version')?.version ?? 0);
  const named = db()
    .all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
    .map((r) => r.name);
  return { core, named };
}

/** Every file below the data folder's file directories (no links, no special files). */
function listFiles(dataDir: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ rel: r, abs });
    }
  };
  for (const d of FILE_DIRS) walk(path.join(dataDir, d), d);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * Writes a migration package of this instance to `out` (it must not exist). Needs the unlocked vault.
 * Order: the `instance.exported` audit entry, a signed checkpoint that covers it, then one consistent
 * read of the database (a transaction), then the files and the encrypted package.
 */
export async function exportPackage(opts: { out: string; transferPassphrase: string; actor?: string; log?: (line: string) => void }): Promise<ExportResult> {
  const log = opts.log ?? (() => undefined);
  if (!vault().unlocked) throw new HttpError(423, 'Vault is locked', 'VAULT_LOCKED');
  if (fs.existsSync(opts.out)) throw new HttpError(409, `${opts.out} exists already`, 'MIGRATION_OUT_EXISTS');
  if (db().get('SELECT 1 FROM instance_imports LIMIT 1')) {
    throw new HttpError(409, 'This instance holds imported history from an earlier move – moving it again is not supported yet', 'MIGRATION_SOURCE_IMPORTED');
  }
  const keys = await newPackageKeys(opts.transferPassphrase);
  const pub = vault().signingPublicKey();
  if (!pub) throw new HttpError(409, 'The vault has no signing key – unlock it once with this version', 'MIGRATION_NO_SIGNING_KEY');
  const fingerprint = publicKeyFingerprint(pub);
  const packageId = crypto.randomUUID();

  audit({
    ...(opts.actor ? { actor: opts.actor } : {}),
    action: 'instance.exported',
    entityType: 'instance',
    entityId: packageId,
    summary: `Migration package ${packageId} exported (protected with a transfer passphrase, signed with key ${fingerprint})`,
    details: { packageId, fingerprint, version: config.version },
  });
  const checkpoint = await createCheckpoint('export');
  if (!checkpoint) {
    throw new HttpError(409, 'The audit log does not verify – no package is made (see Audit log → Verify)', 'MIGRATION_AUDIT_UNVERIFIED');
  }

  const dir = workDir(config.dataDir);
  try {
    const zipFile = path.join(dir, 'package.zip');
    const zip = await ZipWriter.create(zipFile, 0xfffff000);
    const d = db();
    const enc = new Map<string, string[]>();
    for (const c of ENCRYPTED_COLUMNS) enc.set(c.table, [...(enc.get(c.table) ?? []), c.column]);
    const tableInfo: Manifest['tables'] = [];
    let undecryptable = 0;
    let rowsTotal = 0;
    const tmp: { entry: string; file: string }[] = [];
    let users: PackageUser[] = [];
    let teams: PackageTeam[] = [];
    let settingsJson = '';
    let settingsKeys: string[] = [];
    let auditEntries = 0;
    const integrity: Manifest['platformIntegrity'] = {};
    const schema = currentSchema();

    // ---- one consistent read of the database (synchronous; table contents go to temporary files) ----
    d.tx(() => {
      if (d.dialect === 'postgres') d.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const moved = tables(d).filter((t) => !(t in NOT_MOVED));
      for (const t of moved) {
        const cols = columns(d, t).filter((c) => c !== 'rowid');
        const file = path.join(dir, `${t}.jsonl`);
        const fd = fs.openSync(file, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let n = 0;
        try {
          for (const batch of readBatches(d, t, columns(d, t))) {
            let chunk = '';
            for (const row of batch) {
              const out: Record<string, unknown> = {};
              for (const c of cols) out[c] = row[c] ?? null;
              for (const c of enc.get(t) ?? []) {
                const blob = out[c];
                if (typeof blob !== 'string' || !blob) continue;
                try {
                  out[c] = encryptWith(keys.secrets, JSON.stringify(vault().decrypt(blob)));
                } catch {
                  out[c] = null;
                  undecryptable++;
                }
              }
              if (t === 'run_artifacts' && typeof out.path === 'string') {
                const rel = path.relative(config.dataDir, out.path);
                if (!rel.startsWith('..') && !path.isAbsolute(rel)) out.path = DATA_PREFIX + rel.split(path.sep).join('/');
              }
              chunk += JSON.stringify(out) + '\n';
              n++;
            }
            fs.writeSync(fd, chunk);
            hash.update(chunk);
          }
        } finally {
          fs.closeSync(fd);
        }
        tableInfo.push({ name: t, rows: n, sha256: hash.digest('hex'), columns: cols });
        tmp.push({ entry: `tables/${t}.jsonl`, file });
        rowsTotal += n;
      }
      // per-user rows: moved, and mapped to the target's user ids on import
      for (const [t] of Object.entries(USER_ID_TABLES)) if (!moved.includes(t)) throw new Error(`${t} is not moved`);

      // the audit log up to the signed checkpoint (the checkpoint entry itself and later ones are not covered)
      const auditFile = path.join(dir, 'audit.jsonl');
      const afd = fs.openSync(auditFile, 'wx', 0o600);
      try {
        for (let from = 1; from <= checkpoint.seq; from += 5000) {
          const rows = d.all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq', from, Math.min(checkpoint.seq, from + 4999));
          fs.writeSync(afd, rows.map((r) => JSON.stringify(toEntry(r)) + '\n').join(''));
          auditEntries += rows.length;
        }
      } finally {
        fs.closeSync(afd);
      }
      tmp.push({ entry: 'audit.jsonl', file: auditFile });

      // identities (no password hashes: local passwords never move)
      const providers = new Map(listProviders().map((p) => [p.id, p.displayName]));
      const teamRows = d.all<{ id: string; name: string; description: string }>('SELECT id, name, description FROM teams ORDER BY name');
      const members = d.all<{ team_id: string; username: string }>('SELECT m.team_id, u.username FROM team_members m JOIN users u ON u.id = m.user_id');
      teams = teamRows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? '',
        members: members.filter((m) => m.team_id === t.id).map((m) => m.username),
      }));
      users = d
        .all<{
          id: string;
          username: string;
          display_name: string;
          email: string | null;
          roles: string;
          active: number;
          auth_source: string | null;
          last_login_at: string | null;
        }>('SELECT id, username, display_name, email, roles, active, auth_source, last_login_at FROM users ORDER BY username')
        .map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          email: u.email,
          roles: parseJson<Role[]>(u.roles, []),
          active: !!Number(u.active),
          kind: (u.auth_source ?? 'local') === 'local' ? 'local' : 'sso',
          provider: (u.auth_source ?? 'local') === 'local' ? null : (providers.get(u.auth_source!) ?? u.auth_source),
          teams: teams.filter((t) => t.members.includes(u.username)).map((t) => t.name),
          lastLoginAt: u.last_login_at,
        }));

      // settings: the ones that move with their values, the others by name (shown as "not applied")
      const rows = d.all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
      const movedSettings: Record<string, unknown> = {};
      for (const r of rows) if (SETTINGS_MOVED.includes(r.key)) movedSettings[r.key] = parseJson<unknown>(r.value, null);
      settingsKeys = rows.map((r) => r.key);
      settingsJson = JSON.stringify(movedSettings);

      for (const p of d.all<SealedPlatformRow>('SELECT id, name, kind, base_url, environment, config, secrets, config_mac FROM platforms')) {
        const state = platformIntegrity(p);
        integrity[p.id] = state === 'ok' ? 'ok' : state === 'unsealed' ? 'unsealed' : 'mismatch';
      }
    });

    // ---- the package: tables, audit log, settings, files, signed manifest ----
    let auditSha = '';
    for (const t of tmp) {
      const w = await zip.addFile(t.entry, t.file, { compress: true });
      if (t.entry === 'audit.jsonl') auditSha = w.sha256;
      fs.rmSync(t.file, { force: true });
    }
    await zip.add('settings.json', Buffer.from(settingsJson, 'utf8'), { compress: true });
    const files: Manifest['files'] = [];
    for (const f of listFiles(config.dataDir)) {
      const w = await zip.addFile(`files/${f.rel}`, f.abs, { compress: !/\.(zip|png|jpe?g|gif|webp|pdf|gz)$/i.test(f.rel) });
      files.push({ path: f.rel, size: w.size, sha256: w.sha256 });
    }
    log(`  ${tableInfo.length} tables, ${rowsTotal} rows, ${auditEntries} audit entries, ${files.length} files`);
    const manifest: Manifest = {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_VERSION,
      packageId,
      product: BRAND.name,
      productVersion: config.version,
      createdAt: new Date().toISOString(),
      createdBy: opts.actor ?? 'system',
      source: { fingerprint, publicKey: pub, database: d.dialect },
      schema,
      tables: tableInfo,
      files,
      audit: { entries: auditEntries, sha256: auditSha, checkpoint },
      users,
      teams,
      settings: { sha256: sha256(settingsJson), keys: settingsKeys },
      platformIntegrity: integrity,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
    await zip.add('manifest.json', manifestBytes, { compress: true });
    await zip.add('signature.json', Buffer.from(JSON.stringify({ alg: 'ed25519', publicKey: pub, signature: vault().sign(manifestBytes) })), {});
    await zip.finish();
    await sealPackage(zipFile, opts.out, opts.transferPassphrase, keys);
    const size = fs.statSync(opts.out).size;
    const sum = await sha256File(opts.out);
    return {
      packageId,
      sha256: sum,
      size,
      tables: tableInfo.length,
      rows: rowsTotal,
      files: files.length,
      auditEntries,
      fingerprint,
      undecryptable,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
