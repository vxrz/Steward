import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ImportedHistoryEntry, InstanceImport, MigrationPlan } from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { type AuthUser } from '../auth/context.js';
import { unlockThrottle } from '../auth/unlock-throttle.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { HttpError, parseJson } from '../util.js';
import { MAGIC, workDir } from './format.js';
import { exportPackage } from './export.js';
import { applyImport, buildPlan, mappingSchema, readPackage, type OpenedPackage } from './import.js';
import { verifyImportedHistory } from './history.js';
import { requireAdmin } from '../auth/access.js';

/**
 * Settings → Migration (administrators, signed-in sessions only – see SESSION_ONLY_ROUTES in app.ts):
 *
 *   POST   /api/migration/export                  build a package (master passphrase as a re-check + transfer passphrase)
 *   GET    /api/migration/exports/:id/download    the package, once, within 30 minutes
 *   POST   /api/migration/imports/upload          multipart: transferPassphrase, then the file → the dry run (plan)
 *   GET    /api/migration/imports/staged/:id      the dry run again
 *   POST   /api/migration/imports/staged/:id/apply  { mapping, confirmFingerprint } → import
 *   DELETE /api/migration/imports/staged/:id      discard an uploaded package
 *   GET    /api/migration/imports                 imports into this instance, with their mapping tables
 *   GET    /api/migration/imports/:id             one import, its imported history verified again
 *   GET    /api/migration/imports/:id/history     the imported audit history, with who each actor is here
 */

export const MIGRATION_MAX_BYTES = Math.max(1, Number(process.env.SM_MIGRATION_MAX_MB) || 2048) * 1024 * 1024;
const TTL_MS = 30 * 60_000;
const MAX_STAGED = 2;

interface Staged {
  pkg: OpenedPackage;
  userId: string;
  at: number;
  /** the uploaded file (in its own working folder) */
  upload: string;
}
const staged = new Map<string, Staged>();
const exportsReady = new Map<string, { file: string; dir: string; userId: string; at: number; name: string }>();

function sweep(): void {
  const now = Date.now();
  for (const [id, s] of staged) {
    if (now - s.at > TTL_MS) dropStaged(id);
  }
  for (const [id, e] of exportsReady) {
    if (now - e.at > TTL_MS) {
      fs.rmSync(e.dir, { recursive: true, force: true });
      exportsReady.delete(id);
    }
  }
}
function dropStaged(id: string): void {
  const s = staged.get(id);
  if (!s) return;
  s.pkg.close();
  fs.rmSync(path.dirname(s.upload), { recursive: true, force: true });
  staged.delete(id);
}

/** Administrators in a normal session move instances. */
const mover = (): AuthUser => {
  const u = requireAdmin('move instances');
  if (u.emergency) throw new HttpError(403, 'Not in an emergency access session', 'EMERGENCY_NOT_ALLOWED');
  return u;
};
const params = (req: FastifyRequest) => req.params as Record<string, string>;

function stagedFor(id: string, u: AuthUser): Staged {
  sweep();
  const s = staged.get(id);
  if (!s || s.userId !== u.id) throw new HttpError(404, 'The uploaded package is gone – upload it again', 'MIGRATION_STAGED_GONE');
  return s;
}

function importRow(r: Record<string, unknown>): InstanceImport {
  return {
    id: String(r.id),
    packageId: String(r.package_id),
    packageSha256: String(r.package_sha256),
    importedAt: String(r.imported_at),
    importedBy: String(r.imported_by),
    source: {
      fingerprint: String(r.source_fingerprint),
      version: String(r.source_version),
      exportedAt: String(r.source_exported_at),
      exportedBy: String(r.source_exported_by),
    },
    mapping: parseJson(String(r.mapping), []),
    mappingSha256: String(r.mapping_sha256),
    counts: parseJson(String(r.counts), {}),
    historyEntries: Number(r.history_entries),
  };
}

export async function migrationRoutes(app: FastifyInstance): Promise<void> {
  // ---------- export ----------
  // the master passphrase proves the vault, the step-up (auth/step-up.ts) the person
  app.post('/migration/export', { config: { rateLimit: ROUTE_LIMITS.credential, stepUp: { action: 'exportMigration', who: 'manageUsers' } } }, async (req) => {
    const u = mover();
    const b = z.object({ passphrase: z.string().max(1024), transferPassphrase: z.string().max(1024) }).parse(req.body);
    const wait = unlockThrottle.waitSeconds();
    if (wait > 0) throw new HttpError(429, `Too many wrong passphrases – try again in ${wait} s`, 'TOO_MANY_ATTEMPTS');
    // the package carries every credential: the master passphrase is asked again (works for single sign-on administrators too)
    if (!(await vault().verifyPassphrase(b.passphrase))) {
      const n = unlockThrottle.failed();
      audit({
        action: 'instance.export_refused',
        entityType: 'instance',
        summary: `Migration export by ${u.username} refused: wrong master passphrase (attempt ${n})`,
      });
      throw new HttpError(400, 'The master passphrase is wrong', 'WRONG_PASSPHRASE');
    }
    unlockThrottle.succeeded();
    sweep();
    const dir = workDir(config.dataDir);
    const name = `steward-${new Date().toISOString().slice(0, 10)}.smig`;
    const file = path.join(dir, name);
    try {
      const r = await exportPackage({ out: file, transferPassphrase: b.transferPassphrase });
      const id = crypto.randomUUID();
      exportsReady.set(id, { file, dir, userId: u.id, at: Date.now(), name });
      return { ...r, downloadId: id, filename: name };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });

  app.get('/migration/exports/:id/download', async (req, reply) => {
    const u = mover();
    sweep();
    const e = exportsReady.get(params(req).id!);
    if (!e || e.userId !== u.id) throw new HttpError(404, 'The package is gone – export again', 'MIGRATION_EXPORT_GONE');
    exportsReady.delete(params(req).id!); // once
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${e.name}"`);
    reply.header('cache-control', 'no-store');
    const stream = fs.createReadStream(e.file);
    stream.on('close', () => fs.rmSync(e.dir, { recursive: true, force: true }));
    return reply.send(stream);
  });

  // ---------- import ----------
  app.post('/migration/imports/upload', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req): Promise<MigrationPlan> => {
    const u = mover();
    sweep();
    if (staged.size >= MAX_STAGED) throw new HttpError(409, 'Another package is being imported – finish or discard it first', 'MIGRATION_BUSY');
    const part = await req.file({ limits: { fileSize: MIGRATION_MAX_BYTES, files: 1, fields: 2, fieldSize: 2048 } });
    if (!part) throw new HttpError(400, 'No file', 'MIGRATION_PACKAGE_INVALID');
    const field = part.fields.transferPassphrase as { value?: unknown } | undefined;
    const passphrase = typeof field?.value === 'string' ? field.value : '';
    const dir = workDir(config.dataDir);
    const upload = path.join(dir, 'upload.smig');
    try {
      await pipeline(part.file, fs.createWriteStream(upload, { flags: 'wx', mode: 0o600 }));
      if (part.file.truncated)
        throw new HttpError(413, `The package is larger than ${MIGRATION_MAX_BYTES / 1024 / 1024} MB (SM_MIGRATION_MAX_MB)`, 'MIGRATION_TOO_LARGE');
      // content sniffing: a migration package starts with its magic line
      const head = Buffer.alloc(MAGIC.length);
      const fd = fs.openSync(upload, 'r');
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.toString('utf8') !== MAGIC) throw new HttpError(400, 'This is not a Steward migration package', 'MIGRATION_PACKAGE_INVALID');
      if (!passphrase) throw new HttpError(400, 'Enter the transfer passphrase', 'TRANSFER_PASSPHRASE_REQUIRED');
      const pkg = await readPackage(upload, passphrase);
      const id = crypto.randomUUID();
      staged.set(id, { pkg, userId: u.id, at: Date.now(), upload });
      audit({
        action: 'instance.import_checked',
        entityType: 'instance',
        entityId: pkg.manifest.packageId,
        // no fingerprint here: the importer reads it on the source, not in this log
        summary: `Migration package ${pkg.manifest.packageId} uploaded and checked (dry run)`,
        details: { packageSha256: pkg.sha256, history: pkg.history.ok },
      });
      return { ...buildPlan(pkg), id };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });

  app.get('/migration/imports/staged/:id', async (req): Promise<MigrationPlan> => {
    const s = stagedFor(params(req).id!, mover());
    return { ...buildPlan(s.pkg), id: params(req).id! };
  });

  app.delete('/migration/imports/staged/:id', async (req) => {
    stagedFor(params(req).id!, mover());
    dropStaged(params(req).id!);
    return { ok: true };
  });

  app.post(
    '/migration/imports/staged/:id/apply',
    { config: { rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'applyMigration', who: 'manageUsers' } } },
    async (req) => {
      const u = mover();
      const s = stagedFor(params(req).id!, u);
      const b = z.object({ mapping: mappingSchema, confirmFingerprint: z.string().min(1).max(200) }).parse(req.body);
      try {
        const r = await applyImport(s.pkg, { mapping: b.mapping, importer: { id: u.id, username: u.username }, confirmFingerprint: b.confirmFingerprint });
        dropStaged(params(req).id!);
        return r;
      } catch (e) {
        // a refused mapping or confirmation can be corrected; anything else needs a fresh upload
        if (!((e instanceof HttpError && e.statusCode < 500) || e instanceof z.ZodError)) dropStaged(params(req).id!);
        throw e;
      }
    },
  );

  app.get('/migration/imports', async (): Promise<InstanceImport[]> => {
    mover();
    return db().all<Record<string, unknown>>('SELECT * FROM instance_imports ORDER BY imported_at DESC').map(importRow);
  });

  app.get('/migration/imports/:id', async (req) => {
    mover();
    const r = db().get<Record<string, unknown>>('SELECT * FROM instance_imports WHERE id = ?', params(req).id);
    if (!r) throw new HttpError(404, 'Import not found', 'MIGRATION_IMPORT_NOT_FOUND');
    return { ...importRow(r), verification: verifyImportedHistory(String(r.id)) };
  });

  app.get('/migration/imports/:id/history', async (req): Promise<ImportedHistoryEntry[]> => {
    mover();
    const q = z
      .object({
        beforeSeq: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        q: z.string().max(200).optional(),
      })
      .parse(req.query ?? {});
    const imp = db().get<{ mapping: string }>('SELECT mapping FROM instance_imports WHERE id = ?', params(req).id);
    if (!imp) throw new HttpError(404, 'Import not found', 'MIGRATION_IMPORT_NOT_FOUND');
    const now = new Map(
      parseJson<{ kind: string; source: string; target: string | null }[]>(imp.mapping, [])
        .filter((m) => m.kind === 'user')
        .map((m) => [m.source.toLowerCase(), m.target]),
    );
    const where = ['import_id = ?'];
    const args: unknown[] = [params(req).id];
    if (q.beforeSeq) (where.push('seq < ?'), args.push(q.beforeSeq));
    if (q.q) {
      where.push("(lower(summary) LIKE lower(?) ESCAPE '\\' OR lower(actor) LIKE lower(?) ESCAPE '\\' OR lower(action) LIKE lower(?) ESCAPE '\\')");
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like, like);
    }
    return db()
      .all<{
        seq: number;
        ts: string;
        actor: string;
        action: string;
        entity_type: string;
        entity_id: string | null;
        summary: string;
      }>(
        `SELECT seq, ts, actor, action, entity_type, entity_id, summary FROM imported_audit_log WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
        ...args,
        q.limit,
      )
      .map((r) => ({
        seq: Number(r.seq),
        ts: r.ts,
        actor: r.actor,
        actorNow: now.get(r.actor.toLowerCase()) ?? null,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        summary: r.summary,
      }));
  });
}
