import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ACCESS_TYPE_ID,
  BRAND,
  EVIDENCE_PACK_FORMAT,
  REPORT_LANGS,
  type AccessChange,
  type AuditCheckpoint as AuditCheckpointLike,
  type AuditEntry,
  type EvidenceItem,
  type EvidencePack,
  type EvidencePackScope,
  type EvidencePacksMeta,
  type ReportLang,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { DIGEST_SEED, audit, digestStep, prunedBase, publicResult, toEntry, verifyAuditAsync, type AuditRow } from '../audit.js';
import { createCheckpoint, failedFullVerification, incrementalStart, validCheckpoint } from '../audit-anchor.js';
import { archivesCovering } from '../audit-archive.js';
import { logger } from '../log.js';
import { publicKeyFingerprint, publicKeyPem, vault } from '../vault.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { generateRunReport, getReport, listRunReports } from '../reports/service.js';
import { canViewScheduledReport } from '../reports/schedules.js';
import { getRecord } from '../records/service.js';
import { renderRecordPdf } from '../records/pdf.js';
import { editionAsRecord } from '../records/documents.js';
import { attachmentFile, attachmentRows, type RecordRow } from '../records/model.js';
import { canReadRecordRow, canViewCatalogue } from '../records/access.js';
import { getService } from '../catalogue/service.js';
import { platformCatalogue, serviceCatalogue } from '../catalogue/evidence.js';
import { csvTable } from '../csv.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { canExportEvidence, canReadCheck, forbid, me, readsEverything, same, visiblePlatformName } from './access.js';
import { toAccessChange } from './access-changes.js';
import { evidenceForControls, evidenceOf, getControl, type PackCoverageStatus } from './controls.js';
import { getReview, verifySeal } from './person-reviews.js';
import { findingsOfControls } from './corrective.js';
import { cataloguesWithApprovedSoa, latestApprovedFiles } from './soa.js';
import { getCheck, getSnapshot, listFindings, listSnapshots, verifyChain } from './reconciliation.js';
import type { PackPdfModel } from './pack-pdf.js';
import { drawPdf } from '../reports/pdf/pool.js';
import { getBranding, logo } from '../reports/branding.js';
import { assuranceReportJson, collectAssuranceReport, renderAssurancePdf } from './assurance-report.js';
import { AUDIT_EXCERPT_FILE, MANIFEST_SIGNATURE_DOMAIN, type AuditExcerpt, type PackManifest } from './evidence-verify.js';
import { ZipLimitError, ZipWriter, type WrittenEntry } from './zip.js';
import { env } from '../config.js';
import { PVAULT_KIND, pvList } from '@sm/shared';

/** The summary PDF of an evidence pack: the instance branding collected here, drawn in the PDF worker (#13, pack-pdf.ts). */
const renderPackPdf = (m: PackPdfModel, o: { compress?: boolean } = {}): Promise<Buffer> =>
  drawPdf('pack', m, { branding: getBranding(), logo: logo().data }, o);

/**
 * Audit evidence packs: a ZIP for some controls (or a platform or service) and a period with an index
 * (PDF/A + index.json), the run protocols, record PDFs and their files, access change entries,
 * reconciliation snapshots and findings, scheduled report PDFs, an audit log excerpt with a fresh
 * signed checkpoint, and manifest.json (SHA-256 of every file) signed with the installation's
 * Ed25519 key. Built in the background with the requester's permissions, streamed to disk, kept
 * for a limited time.
 */

export const PACK_LIMITS = {
  maxBytes: env.SM_EVIDENCE_MAX_MB * 1024 * 1024,
  maxFiles: 5000,
  retentionDays: env.SM_EVIDENCE_RETENTION_DAYS,
  maxPeriodDays: 3 * 366,
  /** Run protocols generated for runs that have none yet */
  generateReports: 100,
  records: 1000,
  auditEntries: 200_000,
  buildingPerUser: 1,
  building: 2,
  storedPerUser: 20,
};

export const packsDir = (): string => path.join(config.dataDir, 'evidence-packs');

interface PackRow {
  id: string;
  title: string;
  scope: string;
  period_from: string;
  period_to: string;
  status: EvidencePack['status'];
  created_by: string;
  created_at: string;
  finished_at: string | null;
  expires_at: string;
  path: string | null;
  size: number | null;
  sha256: string | null;
  file_count: number | null;
  error: string | null;
}

const canSeePack = (u: AuthUser | null, r: Pick<PackRow, 'created_by'>) => !!u && (same(r.created_by, u.username) || readsEverything(u));

function scopeLabel(scope: EvidencePackScope, u: AuthUser | null): string {
  if (scope.platformId) return `Platform: ${visiblePlatformName(u, scope.platformId) ?? scope.platformId}`;
  if (scope.serviceId) {
    const s = db().get<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM services WHERE id = ?', scope.serviceId);
    const visible = s && (!u || canViewCatalogue(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) }));
    return `Service: ${visible ? s.name : scope.serviceId}`;
  }
  const refs = (scope.controlIds ?? []).map((id) => {
    const c = db().get<{ ref: string; key: string }>(
      'SELECT c.ref, k.key FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE c.id = ?',
      id,
    );
    return c ? `${c.key} ${c.ref}` : id;
  });
  return `Controls: ${refs.join(', ')}`;
}

function toPack(r: PackRow, u: AuthUser | null = currentUser()): EvidencePack {
  const scope = parseJson<EvidencePackScope>(r.scope, {});
  const expired = r.status === 'ready' && Date.parse(r.expires_at) < Date.now();
  return {
    id: r.id,
    title: r.title,
    scope,
    scopeLabel: scopeLabel(scope, u),
    from: r.period_from,
    to: r.period_to,
    status: expired ? 'expired' : r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at,
    size: r.size === null ? null : Number(r.size),
    sha256: r.sha256,
    fileCount: r.file_count === null ? null : Number(r.file_count),
    error: r.error,
    canDownload: !expired && r.status === 'ready' && canSeePack(u, r),
    canDelete: !!u && (same(r.created_by, u.username) || isAdmin(u)),
  };
}

export function packsMeta(): EvidencePacksMeta {
  return {
    canCreate: canExportEvidence(me()),
    maxBytes: PACK_LIMITS.maxBytes,
    maxFiles: PACK_LIMITS.maxFiles,
    retentionDays: PACK_LIMITS.retentionDays,
    maxPeriodDays: PACK_LIMITS.maxPeriodDays,
  };
}

export function listPacks(): EvidencePack[] {
  const u = me();
  cleanupExpired();
  return db()
    .all<PackRow>('SELECT * FROM evidence_packs ORDER BY created_at DESC, id DESC LIMIT 500')
    .filter((r) => canSeePack(u, r))
    .map((r) => toPack(r, u));
}

function readablePack(id: string): PackRow {
  const u = me();
  const r = db().get<PackRow>('SELECT * FROM evidence_packs WHERE id = ?', id);
  if (!r || !canSeePack(u, r)) throw new HttpError(404, `Evidence pack ${id} not found`, 'PACK_NOT_FOUND', { id });
  return r;
}

export const getPack = (id: string): EvidencePack => toPack(readablePack(id));

export const packInput = z
  .object({
    title: z.string().trim().max(200).optional(),
    scope: z
      .object({
        controlIds: z.array(z.string().min(1).max(100)).min(1).max(200).optional(),
        platformId: z.string().min(1).max(100).optional(),
        serviceId: z.string().min(1).max(100).optional(),
      })
      .strict()
      .refine((s) => [s.controlIds, s.platformId, s.serviceId].filter((x) => x !== undefined).length === 1, {
        error: 'Choose controls, a platform or a service',
      }),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    lang: z.enum(REPORT_LANGS).default('en'),
    /** Add the assurance report of the period (#210): the policy, its changes and how each event met it (auditors and administrators) */
    assurance: z.boolean().default(false),
  })
  .strict()
  .refine((p) => Date.parse(p.from) < Date.parse(p.to), { error: 'from must be before to', path: ['to'] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= PACK_LIMITS.maxPeriodDays * 86400000, {
    error: `The period may be at most ${PACK_LIMITS.maxPeriodDays} days`,
    path: ['to'],
  });

/** Requests a pack; it is built in the background (poll its status). */
export function createPack(input: z.infer<typeof packInput>): EvidencePack {
  const u = me();
  if (!canExportEvidence(u)) forbid('export evidence packs', 'exportEvidence');
  const scope = input.scope;
  if (scope.controlIds) for (const id of scope.controlIds) getControl(id);
  if (scope.platformId && !visiblePlatformName(u, scope.platformId))
    throw new HttpError(404, `Platform ${scope.platformId} not found`, 'PLATFORM_NOT_FOUND', { id: scope.platformId });
  if (scope.serviceId) getService(scope.serviceId);
  cleanupExpired();
  const mine = db().all<PackRow>('SELECT * FROM evidence_packs WHERE lower(created_by) = lower(?)', u.username);
  if (mine.filter((r) => r.status === 'building').length >= PACK_LIMITS.buildingPerUser)
    throw new HttpError(429, 'One of your evidence packs is still being built – wait until it is ready', 'PACK_BUILDING', { context: 'own' });
  if (Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence_packs WHERE status = 'building'")!.n) >= PACK_LIMITS.building)
    throw new HttpError(429, 'Other evidence packs are being built – try again in a minute', 'PACK_BUILDING');
  if (mine.filter((r) => r.status === 'ready' || r.status === 'building').length >= PACK_LIMITS.storedPerUser)
    throw new HttpError(429, `At most ${PACK_LIMITS.storedPerUser} stored evidence packs per user – delete older ones first`, 'PACK_TOO_MANY', {
      max: PACK_LIMITS.storedPerUser,
    });
  const id = newId('evp_');
  const now = nowIso();
  const from = new Date(input.from).toISOString();
  const to = new Date(input.to).toISOString();
  const title = input.title || `Evidence pack ${from.slice(0, 10)} – ${to.slice(0, 10)}`;
  const expires = new Date(Date.now() + PACK_LIMITS.retentionDays * 86400000).toISOString();
  db().tx(() => {
    db().run(
      `INSERT INTO evidence_packs (id, title, scope, period_from, period_to, status, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'building', ?, ?, ?)`,
      id,
      title,
      JSON.stringify(scope),
      from,
      to,
      u.username,
      now,
      expires,
    );
    audit({
      action: 'evidence_pack.requested',
      entityType: 'evidence_pack',
      entityId: id,
      summary: `Evidence pack "${title}" requested (${scopeLabel(scope, u)}, ${from} – ${to})`,
      details: { scope, from, to, lang: input.lang, ...(input.assurance ? { assurance: true } : {}) },
    });
  });
  const build = runAs(u, () => buildPack(id, input.lang, { assurance: input.assurance }));
  pending.set(id, build);
  void build.finally(() => pending.delete(id));
  return getPack(id);
}

const pending = new Map<string, Promise<void>>();
/** Tests: wait until a pack is built. */
export const packBuilt = (id: string): Promise<void> => pending.get(id) ?? Promise.resolve();

export function deletePack(id: string): void {
  const u = me();
  const r = readablePack(id);
  if (!(same(r.created_by, u.username) || isAdmin(u))) forbid('delete this evidence pack', 'ownerOnly');
  if (r.status === 'building') throw new HttpError(409, 'The pack is still being built', 'PACK_BUILDING', { context: 'delete' });
  removeFile(r);
  db().tx(() => {
    db().run('DELETE FROM evidence_packs WHERE id = ?', id);
    audit({ action: 'evidence_pack.deleted', entityType: 'evidence_pack', entityId: id, summary: `Evidence pack "${r.title}" deleted` });
  });
}

/** The file of a ready pack for download (audited). */
export function packForDownload(id: string): { file: string; filename: string; size: number } {
  const r = readablePack(id);
  const p = toPack(r);
  if (!p.canDownload || !r.path)
    throw new HttpError(409, p.status === 'expired' ? 'The pack has expired – create it again' : `The pack is ${p.status}`, 'PACK_NOT_READY', {
      context: p.status,
    });
  const file = path.join(packsDir(), path.basename(r.path));
  if (!fs.existsSync(file)) throw new HttpError(404, 'The file of this pack is missing', 'PACK_FILE_MISSING');
  audit({
    action: 'evidence_pack.downloaded',
    entityType: 'evidence_pack',
    entityId: id,
    summary: `Evidence pack "${r.title}" downloaded`,
    details: { sha256: r.sha256, size: r.size },
  });
  return { file, filename: `${BRAND.slug}-evidence-${r.created_at.slice(0, 10)}-${id.slice(4, 12)}.zip`, size: Number(r.size) };
}

function removeFile(r: Pick<PackRow, 'path'>): void {
  if (!r.path) return;
  fs.rmSync(path.join(packsDir(), path.basename(r.path)), { force: true });
}

let lastCleanup = 0;
/** Expired packs lose their file (the row and its audit entries stay); runs at most once a minute. */
export function cleanupExpired(force = false): number {
  if (!force && Date.now() - lastCleanup < 60000) return 0;
  lastCleanup = Date.now();
  const rows = db().all<PackRow>("SELECT * FROM evidence_packs WHERE status = 'ready' AND expires_at < ?", nowIso());
  for (const r of rows) {
    removeFile(r);
    db().run("UPDATE evidence_packs SET status = 'expired', path = NULL WHERE id = ?", r.id);
  }
  // a pack whose build was interrupted by a restart stays "building" forever otherwise
  const stale = db().all<PackRow>(
    "SELECT * FROM evidence_packs WHERE status = 'building' AND created_at < ?",
    new Date(Date.now() - 6 * 3600000).toISOString(),
  );
  for (const r of stale) {
    if (pending.has(r.id)) continue;
    removeFile(r);
    db().run("UPDATE evidence_packs SET status = 'failed', error = ?, path = NULL WHERE id = ?", 'The build was interrupted (restart)', r.id);
  }
  return rows.length;
}

// ---------- collecting ----------

interface PackItem extends EvidenceItem {
  controls: string[];
  files: string[];
}

function addItems(into: Map<string, PackItem>, items: EvidenceItem[], control?: string): void {
  for (const e of items) {
    const k = `${e.kind}|${e.id}`;
    const cur = into.get(k);
    if (cur) {
      if (control && !cur.controls.includes(control)) cur.controls.push(control);
    } else into.set(k, { ...e, controls: control ? [control] : [], files: [] });
  }
}

const inPeriod = (iso: string, from: string, to: string) => iso >= from && iso <= to;

/** Evidence of a platform: access change entries, its reconciliation checks, runs that used it, records linked to it. */
function platformItems(platformId: string, from: string, to: string, u: AuthUser): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const pname = visiblePlatformName(u, platformId) ?? platformId;
  const via = { kind: 'accessCheck' as const, id: platformId, label: pname };
  for (const r of db().all<RecordRow>(
    "SELECT * FROM records WHERE type_id = ? AND lower(fields) LIKE lower(?) ESCAPE '\\'",
    ACCESS_TYPE_ID,
    `%${likeEscape(JSON.stringify(platformId))}%`,
  )) {
    if (!canReadRecordRow(u, r)) continue;
    const a = toAccessChange(r, u);
    if (a.platformId !== platformId || !inPeriod(a.performedAt || r.created_at, from, to)) continue;
    out.push({
      kind: 'accessChange',
      id: r.id,
      label: `${r.number} ${r.title}`,
      at: a.performedAt,
      path: `/records/${r.id}`,
      status: r.status,
      detail: a.origin,
      via,
    });
  }
  for (const c of db().all<{ id: string; owner: string; platform_id: string }>(
    'SELECT id, owner, platform_id FROM access_checks WHERE platform_id = ?',
    platformId,
  ))
    if (canReadCheck(u, c)) out.push(...evidenceOf({ kind: 'accessCheck', target_id: c.id }, { from, to }, u));
  for (const r of db().all<{
    id: string;
    process_id: string;
    process_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    bindings: string;
  }>(
    "SELECT id, process_id, process_name, status, started_at, finished_at, bindings FROM runs WHERE dry_run = 0 AND debug IS NULL AND lower(bindings) LIKE lower(?) ESCAPE '\\' AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT 2000",
    `%${likeEscape(JSON.stringify(platformId))}%`,
    from,
    to,
  )) {
    if (!Object.values(parseJson<Record<string, string>>(r.bindings, {})).includes(platformId) || !permissionsFor(r.process_id).includes('view')) continue;
    out.push({
      kind: 'run',
      id: r.id,
      label: `${r.process_name} · ${r.id}`,
      at: r.finished_at ?? r.started_at,
      path: `/runs/${r.id}`,
      status: r.status,
      detail: '',
      via,
    });
  }
  for (const l of db().all<{ from_id: string }>("SELECT from_id FROM item_links WHERE from_kind = 'record' AND to_kind = 'platform' AND to_id = ?", platformId))
    out.push(...evidenceOf({ kind: 'record', target_id: l.from_id }, { from, to }, u));
  return out;
}

function serviceItems(serviceId: string, from: string, to: string, u: AuthUser): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const l of db().all<{ to_kind: string | null; to_id: string | null }>(
    "SELECT to_kind, to_id FROM item_links WHERE from_kind = 'service' AND from_id = ?",
    serviceId,
  )) {
    if (!l.to_kind || !l.to_id) continue;
    if (l.to_kind === 'platform') out.push(...platformItems(l.to_id, from, to, u));
    else if (l.to_kind === 'process' || l.to_kind === 'record' || l.to_kind === 'monitor')
      out.push(...evidenceOf({ kind: l.to_kind, target_id: l.to_id }, { from, to }, u));
  }
  return out;
}

// ---------- privileged use (#205) ----------

interface PrivilegedUseSection {
  platformId: string;
  platformName: string;
  privileged: { folders: string[]; templates: string[] };
  secrets: number;
  events: number;
  truncated: boolean;
  files: string[];
}

/** The vault platforms a pack covers: its platform, and those of the vault access checks it holds. */
function vaultPlatformsOf(scope: EvidencePackScope, checkIds: Iterable<string>): string[] {
  const ids = new Set<string>();
  const kindOf = (id: string) => db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', id)?.kind;
  if (scope.platformId && kindOf(scope.platformId) === PVAULT_KIND) ids.add(scope.platformId);
  for (const cid of checkIds) {
    const c = db().get<{ source: string; platform_id: string }>('SELECT source, platform_id FROM access_checks WHERE id = ?', cid);
    if (c?.source === 'privilege-vault' && kindOf(c.platform_id) === PVAULT_KIND) ids.add(c.platform_id);
  }
  return [...ids].sort();
}

/**
 * Who used the privileged secrets of a vault platform in the pack's period – views, checkouts, password displays,
 * edits and access requests from the vault's audit, read now with the creator's right to use the platform (never a
 * secret value). Privileged: the platform variables privilegedFolders and privilegedTemplates; neither set – every
 * secret the account may list. A read that fails is named under "omitted".
 */
async function addPrivilegedUse(b: PackBuilder, platformId: string, from: string, to: string, u: AuthUser): Promise<PrivilegedUseSection | null> {
  const { getPlatform, getSecrets } = await import('../platforms/service.js');
  let platform;
  try {
    platform = getPlatform(platformId);
  } catch {
    b.omitted.push(`Privileged use of platform ${platformId}: the platform is gone`);
    return null;
  }
  if (!platform.permissions.includes('use')) {
    b.omitted.push(`Privileged use of "${platform.name}": ${u.username} may not use the platform – ask someone who may`);
    return null;
  }
  const vars = platform.config.variables ?? {};
  const privileged = { folders: pvList(vars.privilegedFolders), templates: pvList(vars.privilegedTemplates) };
  try {
    const secrets = getSecrets(platformId);
    const { buildUrl } = await import('../platforms/http.js');
    const { assertOutboundAllowed } = await import('../platforms/outbound.js');
    const { outboundContext } = await import('../platforms/policyContext.js');
    await assertOutboundAllowed(await buildUrl(platform, secrets, '/', {}), outboundContext());
    const { privilegedUse } = await import('../pvault/service.js');
    const r = await privilegedUse(platform, secrets, { from, to, ...privileged });
    const dir = `privileged-use/${safe(platformId)}`;
    const files = [
      await b.json(`${dir}/events.json`, {
        platformId,
        platformName: platform.name,
        from,
        to,
        readAt: nowIso(),
        privileged,
        secrets: r.secrets,
        truncated: r.truncated,
        note: 'Read from the vault audit when the pack was built; metadata only – Steward never reads secret values.',
        events: r.events,
      }),
    ];
    const head = ['at', 'secretId', 'secret', 'folder', 'user', 'action', 'notes', 'ticket'] as const;
    files.push(
      await b.buffer(
        `${dir}/events.csv`,
        csvTable(
          head,
          r.events.map((e) => head.map((h) => e[h])),
        ),
      ),
    );
    if (r.truncated) b.omitted.push(`Privileged use of "${platform.name}": more events than the limit – the newest are left out; choose a shorter period`);
    return { platformId, platformName: platform.name, privileged, secrets: r.secrets, events: r.events.length, truncated: r.truncated, files };
  } catch (e) {
    b.omitted.push(`Privileged use of "${platform.name}" could not be read from the vault: ${(e as Error).message.slice(0, 300)}`);
    return null;
  }
}

// ---------- building ----------

const isText = (p: string) => /\.(json|csv|txt|md|pem|eml)$/i.test(p);

class PackBuilder {
  files: WrittenEntry[] = [];
  omitted: string[] = [];
  constructor(
    readonly zip: ZipWriter,
    readonly maxFiles: number,
  ) {}

  private check(): void {
    if (this.files.length >= this.maxFiles)
      throw new ZipLimitError(`The pack would hold more than ${this.maxFiles} files – choose a shorter period or fewer controls`);
  }
  async buffer(p: string, data: Buffer | string): Promise<string> {
    this.check();
    const w = await this.zip.add(p, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), { compress: isText(p) });
    this.files.push(w);
    return w.path;
  }
  async json(p: string, v: unknown): Promise<string> {
    return this.buffer(p, JSON.stringify(v, null, 2) + '\n');
  }
  async file(p: string, file: string, expectSha?: string): Promise<string | null> {
    this.check();
    if (!fs.existsSync(file)) {
      this.omitted.push(`${p}: the file is missing in the data folder`);
      return null;
    }
    const w = await this.zip.addFile(p, file, { compress: isText(p) });
    if (expectSha && w.sha256 !== expectSha) {
      // the stored file no longer matches its recorded hash: keep it, but say so (the auditor must know)
      this.omitted.push(`${p}: the stored file does not match its recorded SHA-256 (${expectSha}) – it was changed outside Steward`);
    }
    this.files.push(w);
    return w.path;
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';

async function buildPack(id: string, lang: ReportLang, opts: { assurance?: boolean } = {}): Promise<void> {
  const row = db().get<PackRow>('SELECT * FROM evidence_packs WHERE id = ?', id)!;
  const u = me();
  const scope = parseJson<EvidencePackScope>(row.scope, {});
  const { period_from: from, period_to: to } = row;
  fs.mkdirSync(packsDir(), { recursive: true, mode: 0o700 });
  const rel = `${id}.zip`;
  const file = path.join(packsDir(), rel);
  let zip: ZipWriter | null = null;
  try {
    const pub = vault().signingPublicKey();
    if (!vault().unlocked || !pub) throw new HttpError(423, 'The vault is locked or has no signing key', 'VAULT_LOCKED');
    const fingerprint = publicKeyFingerprint(pub);

    // 1. what belongs into the pack (as the requester sees it)
    const items = new Map<string, PackItem>();
    const controls: { id: string; ref: string; catalogue: string; title: string; status: PackCoverageStatus; count: number; hidden: number }[] = [];
    // the pack holds what its creator may see: it says so, and how much it leaves out per control (GOV-12)
    const complete = readsEverything(u);
    if (scope.controlIds) {
      for (const c of evidenceForControls(scope.controlIds, { from, to }, u)) {
        const label = `${c.control.catalogueKey} ${c.control.ref}`;
        addItems(items, c.evidence, label);
        controls.push({
          id: c.control.id,
          ref: c.control.ref,
          catalogue: c.control.catalogueKey,
          title: c.control.title,
          status: c.status,
          count: c.evidence.length,
          hidden: c.hidden,
        });
      }
    } else if (scope.platformId) addItems(items, platformItems(scope.platformId, from, to, u));
    else if (scope.serviceId) addItems(items, serviceItems(scope.serviceId, from, to, u));
    const list = [...items.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.at.localeCompare(b.at));

    // 2. size check before writing anything big
    let planned = 0;
    for (const it of list) {
      if (it.kind === 'run')
        planned += Number(db().get<{ size: number }>('SELECT size FROM reports WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', it.id)?.size ?? 200_000);
      if (it.kind === 'record' || it.kind === 'accessChange')
        planned +=
          150_000 +
          attachmentRows(it.id)
            .filter((a) => a.kind !== 'generated')
            .reduce((n, a) => n + Number(a.size), 0);
      if (it.kind === 'report') planned += Number(db().get<{ size: number }>('SELECT size FROM reports WHERE id = ?', it.id)?.size ?? 0);
      if (it.kind === 'snapshot') planned += Number(db().get<{ n: number }>('SELECT LENGTH(data) AS n FROM access_snapshots WHERE id = ?', it.id)?.n ?? 0);
    }
    if (planned > PACK_LIMITS.maxBytes)
      throw new ZipLimitError(
        `The pack would be about ${Math.round(planned / 1024 / 1024)} MB – more than the limit of ${Math.round(PACK_LIMITS.maxBytes / 1024 / 1024)} MB. Choose a shorter period or fewer controls.`,
      );
    if (list.filter((i) => i.kind === 'record' || i.kind === 'accessChange').length > PACK_LIMITS.records)
      throw new ZipLimitError(`More than ${PACK_LIMITS.records} records – choose a shorter period or fewer controls`);

    zip = await ZipWriter.create(file, PACK_LIMITS.maxBytes);
    const b = new PackBuilder(zip, PACK_LIMITS.maxFiles);
    let generated = 0;
    const accessChanges: AccessChange[] = [];
    const checks = new Set<string>();
    const monitors: PackItem[] = [];

    // 3. evidence files
    for (const it of list) {
      if (it.kind === 'run') {
        let rec = listRunReports(it.id)[0];
        if (!rec && ['succeeded', 'failed', 'cancelled'].includes(it.status) && generated < PACK_LIMITS.generateReports) {
          generated++;
          rec = await generateRunReport(it.id, { actor: u.username, lang });
        }
        if (!rec) {
          b.omitted.push(`Run ${it.id}: no PDF protocol (${generated >= PACK_LIMITS.generateReports ? 'generation limit reached' : `run is ${it.status}`})`);
          continue;
        }
        const r = getReport(rec.id);
        const p = await b.file(`runs/${it.id}/${safe(r.filename)}`, r.file, r.sha256);
        if (p) it.files.push(p);
      } else if (it.kind === 'record' || it.kind === 'accessChange') {
        const current = getRecord(it.id);
        // a living document: the edition valid at the end of the period, as approved (its PDF cites its hash)
        const edition = it.document?.edition;
        const rec = edition ? editionAsRecord(current, edition) : current;
        const dir = `records/${safe(rec.number)}`;
        const { pdf } = await renderRecordPdf({ rec, pdfId: newId('rpdf_'), lang, signers: [], generatedBy: u.username, generatedAt: nowIso(), edition });
        it.files.push(await b.buffer(`${dir}/${safe(rec.number)}${edition ? `-edition-${safe(edition)}` : ''}.pdf`, pdf));
        const { attachments, actions: _a, permissions: _p, ...rest } = rec;
        it.files.push(await b.json(`${dir}/record.json`, { ...rest, attachments: attachments.map(({ details: _d, ...x }) => x) }));
        for (const a of attachmentRows(rec.id)) {
          if (a.kind === 'generated') continue;
          const p = await b.file(`${dir}/attachments/${safe(a.id)}-${safe(a.filename)}`, attachmentFile(a), a.sha256);
          if (p) it.files.push(p);
        }
        if (it.kind === 'accessChange') accessChanges.push(toAccessChange(db().get<RecordRow>('SELECT * FROM records WHERE id = ?', rec.id)!, u));
      } else if (it.kind === 'snapshot' || it.kind === 'finding') {
        const checkId = it.via.kind === 'accessCheck' ? it.via.id : '';
        const snapCheck =
          it.kind === 'snapshot' ? db().get<{ check_id: string }>('SELECT check_id FROM access_snapshots WHERE id = ?', it.id)?.check_id : undefined;
        const findCheck =
          it.kind === 'finding' ? db().get<{ check_id: string }>('SELECT check_id FROM access_findings WHERE id = ?', it.id)?.check_id : undefined;
        const cid = snapCheck ?? findCheck ?? checkId;
        if (cid) checks.add(cid);
        if (it.kind === 'snapshot' && it.status === 'stored' && cid) {
          const s = getSnapshot(cid, it.id);
          const seq = Number(db().get<{ seq: number }>('SELECT seq FROM access_snapshots WHERE id = ?', it.id)!.seq);
          it.files.push(await b.json(`reconciliation/${safe(cid)}/snapshot-${String(seq).padStart(5, '0')}.json`, s));
        }
      } else if (it.kind === 'personReview') {
        // the frozen rights, the decisions, who approved, and whether the seal still matches
        it.files.push(
          await b.json(`person-reviews/${safe(it.id)}.json`, { ...getReview(it.id), sealVerification: { verifiedAt: nowIso(), ...verifySeal(it.id) } }),
        );
      } else if (it.kind === 'report') {
        const r = getReport(it.id);
        if (!canViewScheduledReport(r, u)) continue;
        const p = await b.file(`reports/${safe(r.id)}-${safe(r.filename)}`, r.file, r.sha256);
        if (p) it.files.push(p);
      } else if (it.kind === 'monitor') monitors.push(it);
    }
    for (const cid of checks) {
      const dir = `reconciliation/${safe(cid)}`;
      await b.json(`${dir}/check.json`, getCheck(cid));
      await b.json(`${dir}/snapshots.json`, listSnapshots(cid, { from, to, limit: 5000 }));
      await b.json(`${dir}/findings.json`, listFindings({ checkId: cid, from, to }));
      const v = verifyChain(cid);
      await b.json(`${dir}/chain-verification.json`, { verifiedAt: nowIso(), ...v });
      if (!v.ok)
        b.omitted.push(
          `Reconciliation ${cid}: the snapshots or findings do not match the audit log (${v.problems.length} problem(s), see ${dir}/chain-verification.json)`,
        );
    }
    if (accessChanges.length) {
      await b.json('access-changes/access-changes.json', accessChanges);
      const head = [
        'number',
        'status',
        'platformId',
        'platformName',
        'subjectId',
        'subjectName',
        'kind',
        'granted',
        'revoked',
        'rightsBefore',
        'rightsAfter',
        'reason',
        'requestedBy',
        'requestRef',
        'approvedBy',
        'performedBy',
        'performedAt',
        'origin',
        'afterTheFact',
        'runId',
        'findingId',
        'frozenHash',
        'tampered',
        'documentedBy',
        'lastEditedBy',
      ] as const;
      const csv = csvTable(
        head,
        accessChanges.map((a) => head.map((h) => a[h])),
      );
      await b.buffer('access-changes/access-changes.csv', csv);
    }
    if (monitors.length)
      await b.json(
        'monitors/monitors.json',
        monitors.map(({ files: _f, ...m }) => m),
      );
    // corrective actions (ADR 0029): the findings naming the pack's controls that were open at some time in the period
    const findings = scope.controlIds?.length
      ? findingsOfControls(scope.controlIds, u).filter((f) => f.createdAt <= to && (!f.closedAt || f.closedAt >= from))
      : [];
    if (findings.length) {
      await b.json(
        'corrective-actions/findings.json',
        findings.map(({ permissions: _p, actions, ...f }) => ({ ...f, actions: actions.map(({ canEdit: _e, canMarkDone: _d, ...a }) => a) })),
      );
      const head = [
        'number',
        'title',
        'source',
        'severity',
        'status',
        'serviceName',
        'supplierName',
        'owner',
        'dueDate',
        'overdue',
        'actionsOpen',
        'actionsTotal',
        'controls',
        'effective',
        'checkedBy',
        'checkedAt',
        'createdAt',
        'closedAt',
      ] as const;
      await b.buffer(
        'corrective-actions/findings.csv',
        csvTable(
          head,
          findings.map((f) =>
            head.map((h) =>
              h === 'controls'
                ? f.controls.map((c) => `${c.catalogueKey} ${c.ref}`).join('; ')
                : h === 'effective'
                  ? (f.effectiveness?.result ?? '')
                  : h === 'checkedBy'
                    ? (f.effectiveness?.checkedBy ?? '')
                    : h === 'checkedAt'
                      ? (f.effectiveness?.checkedAt ?? '')
                      : f[h],
            ),
          ),
        ),
      );
    }

    // the statement of applicability (ADR 0029 part 4): of each catalogue whose controls are in the pack, the version
    // valid at the end of the period – approved latest on or before it (0.18.0; a pack of a past period does not get a
    // statement approved after it) – the archived PDF (checked against its recorded SHA-256), its CSV and the frozen JSON
    const catalogueIds = [...new Set(controls.map((c) => c.catalogue))]
      .map((key) => db().get<{ id: string }>('SELECT id FROM control_catalogues WHERE key = ?', key)?.id)
      .filter((x): x is string => !!x);
    const soas: { catalogue: string; number: number; approvedAt: string; approvedBy: string; contentSha256: string; files: string[] }[] = [];
    const valid = catalogueIds.length ? latestApprovedFiles(catalogueIds, u, to) : [];
    for (const c of cataloguesWithApprovedSoa(catalogueIds))
      if (!valid.some((v) => v.catalogueId === c.catalogueId))
        b.omitted.push(
          `soa/${safe(c.catalogueKey)}: no version of the statement of applicability was approved by the end of the period (${to}); the first was approved on ${c.firstApprovedAt}.`,
        );
    for (const v of valid) {
      const dir = `soa/${safe(v.catalogueKey)}`;
      // the signed bytes cannot be filtered: a version naming suppliers or services the creator may not see stays out
      if (v.hidden) {
        b.omitted.push(
          `${dir}: version ${v.number} of the statement of applicability names suppliers or services ${row.created_by} may not see. Ask an auditor or administrator for a complete pack.`,
        );
        continue;
      }
      const files: string[] = [];
      if (v.pdf) {
        const p = await b.file(`${dir}/${v.base}.pdf`, v.pdf.file, v.pdf.sha256);
        if (p) files.push(p);
      } else b.omitted.push(`${dir}/${v.base}.pdf: no archived PDF is recorded for version ${v.number}`);
      files.push(await b.buffer(`${dir}/${v.base}.csv`, Buffer.from(v.csv, 'utf8')));
      files.push(await b.buffer(`${dir}/${v.base}.json`, Buffer.from(v.json, 'utf8')));
      soas.push({ catalogue: v.catalogueKey, number: v.number, approvedAt: v.approvedAt, approvedBy: v.approvedBy, contentSha256: v.contentSha256, files });
    }

    // privileged use of the vault platforms in scope (#205)
    const privilegedUse: PrivilegedUseSection[] = [];
    for (const pid of vaultPlatformsOf(scope, checks)) {
      const sec = await addPrivilegedUse(b, pid, from, to, u);
      if (sec) privilegedUse.push(sec);
    }

    // 4. audit log excerpt with a fresh signed checkpoint (auditors and administrators only)
    let auditInfo: Record<string, unknown> = { included: false };
    if (capabilities(u).viewAudit) auditInfo = await addAuditExcerpt(b, from, to);
    else b.omitted.push('Audit log excerpt: only auditors and administrators may export the audit log');

    // 4b. the assurance report of the period (#210): PDF/A and JSON, listed in the signed manifest like every file
    let assuranceInfo: Record<string, unknown> = { included: false };
    if (opts.assurance && capabilities(u).viewAudit) {
      const report = collectAssuranceReport({ from, to, lang }, u);
      await b.buffer('assurance/assurance-report.pdf', await renderAssurancePdf(report.model));
      await b.json('assurance/assurance-report.json', assuranceReportJson(report));
      assuranceInfo = {
        included: true,
        files: ['assurance/assurance-report.pdf', 'assurance/assurance-report.json'],
        policyVersion: report.model.endVersion,
        events: report.events.length,
        exceptions: report.model.exceptions.length,
      };
    } else if (opts.assurance) b.omitted.push('Assurance report: only auditors and administrators may read it');

    // 5. index (JSON and PDF/A)
    const meta = {
      id,
      title: row.title,
      scope,
      scopeLabel: scopeLabel(scope, u),
      from,
      to,
      createdAt: row.created_at,
      createdBy: row.created_by,
      lang,
      /** true: only what the creator may see (not an administrator or auditor) */
      filtered: !complete,
    };
    const hidden = controls.reduce((n, c) => n + c.hidden, 0);
    // the protection need (CIA) of the service or of the platform's application, as rated when the pack is built
    const catalogue = scope.serviceId ? serviceCatalogue(scope.serviceId) : scope.platformId ? platformCatalogue(scope.platformId) : null;
    if (!complete)
      b.omitted.push(
        `This pack holds only what ${row.created_by} may see${hidden ? ` – ${hidden} evidence item(s) of the chosen controls are not visible to them` : ''}. Ask an auditor or administrator for a complete pack.`,
      );
    const index = {
      format: 'steward-evidence-index',
      version: 1,
      pack: meta,
      filtered: { complete, permissionsOf: row.created_by, hidden },
      product: BRAND.name,
      productVersion: config.version,
      generatedAt: nowIso(),
      disclaimer: 'Evidence recorded by Steward. It does not certify compliance with any standard.',
      controls,
      ...(catalogue ? { catalogue } : {}),
      items: list.map(({ via, ...i }) => ({ ...i, via })),
      ...(privilegedUse.length ? { privilegedUse } : {}),
      ...(findings.length
        ? { correctiveActions: { findings: findings.length, files: ['corrective-actions/findings.json', 'corrective-actions/findings.csv'] } }
        : {}),
      ...(soas.length ? { statementsOfApplicability: soas } : {}),
      audit: auditInfo,
      assurance: assuranceInfo,
      omitted: b.omitted,
      files: b.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    };
    await b.json('index.json', index);
    const pdf = await renderPackPdf({
      id,
      title: row.title,
      scopeLabel: meta.scopeLabel,
      from,
      to,
      createdAt: row.created_at,
      createdBy: row.created_by,
      keyFingerprint: fingerprint,
      lang,
      filtered: !complete,
      controls,
      catalogue,
      items: [
        ...list.map((i) => ({ kind: i.kind, label: i.document ? `${i.label} · ${i.document.edition}` : i.label, at: i.at, files: i.files.length })),
        ...privilegedUse.map((p) => ({
          kind: 'privilegedUse',
          label: `${p.platformName}: ${p.events} event(s) on ${p.secrets} secret(s)${p.truncated ? ' (truncated)' : ''}`,
          at: to,
          files: p.files.length,
        })),
        ...findings.map((f) => ({ kind: 'correctiveAction', label: `${f.number} ${f.title} (${f.status})`, at: f.updatedAt, files: 2 })),
        ...soas.map((v) => ({
          kind: 'soa',
          label: `${v.catalogue}, version ${v.number} (approved by ${v.approvedBy})`,
          at: v.approvedAt,
          files: v.files.length,
        })),
      ],
      omitted: b.omitted,
      assurance: assuranceInfo.included === true,
    });
    await b.buffer('index.pdf', pdf);

    // 6. signed manifest
    const manifest: PackManifest = {
      format: EVIDENCE_PACK_FORMAT,
      version: 2,
      pack: { ...meta, product: BRAND.name, productVersion: config.version },
      keyFingerprint: fingerprint,
      files: b.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await zip.add('manifest.json', manifestBytes, { compress: true });
    // domain separation: the key also signs audit checkpoints, so a manifest signature covers a prefix of its own
    await zip.add('manifest.sig', Buffer.from(vault().sign(Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_DOMAIN, 'utf8'), manifestBytes])) + '\n'), {
      compress: false,
    });
    await zip.add('public-key.pem', Buffer.from(publicKeyPem(pub)), { compress: false });
    const { size } = await zip.finish();
    zip = null;
    const zipSha = await fileSha256(file);
    db().tx(() => {
      db().run(
        "UPDATE evidence_packs SET status = 'ready', finished_at = ?, path = ?, size = ?, sha256 = ?, file_count = ? WHERE id = ?",
        nowIso(),
        rel,
        size,
        zipSha,
        b.files.length + 3,
        id,
      );
      audit({
        action: 'evidence_pack.created',
        entityType: 'evidence_pack',
        entityId: id,
        summary: `Evidence pack "${row.title}" built: ${b.files.length + 3} files, ${size} bytes, sha256 ${zipSha.slice(0, 16)}…`,
        details: {
          sha256: zipSha,
          size,
          files: b.files.length + 3,
          manifestSha256: sha256(manifestBytes),
          keyFingerprint: fingerprint,
          items: list.length,
          omitted: b.omitted.length,
        },
      });
    });
  } catch (e) {
    await zip?.abort();
    fs.rmSync(file, { force: true });
    const msg = (e instanceof HttpError || e instanceof ZipLimitError ? e.message : `Building the pack failed: ${(e as Error).message}`).slice(0, 1000);
    if (!(e instanceof HttpError || e instanceof ZipLimitError)) logger.warn({ err: e, packId: id }, 'evidence pack failed');
    db().tx(() => {
      db().run("UPDATE evidence_packs SET status = 'failed', finished_at = ?, error = ?, path = NULL WHERE id = ?", nowIso(), msg, id);
      audit({ action: 'evidence_pack.failed', entityType: 'evidence_pack', entityId: id, summary: `Evidence pack "${row.title}" failed: ${msg}` });
    });
  }
}

async function fileSha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * The audit entries from the start of the period up to a fresh signed checkpoint, with the public
 * digest before the first entry: the offline check continues the digest over the excerpt and must
 * reach the checkpoint's signed digest – so no entry of the excerpt can be changed or left out.
 *
 * The chain is verified incrementally (from the newest signed checkpoint), and the start digest is continued from the
 * newest signed checkpoint before the excerpt rather than from entry #1. When the period reaches back into entries
 * that were archived and deleted (retention), the excerpt starts at the first entry still in the database (its start
 * digest is the one the archive's signed end checkpoint holds) and the archives of the period are put into the pack:
 * the offline check verifies each of them and that they link up with the excerpt.
 */
async function addAuditExcerpt(b: PackBuilder, from: string, to: string): Promise<Record<string, unknown>> {
  // after a failed full verification only a full one counts (audit-anchor.ts)
  const start = failedFullVerification() ? undefined : incrementalStart();
  const verified = await verifyAuditAsync({ from: start ? { seq: start.seq, hash: start.hash, digest: start.digest } : undefined });
  const checkpoint = verified.ok ? await createCheckpoint('export', verified) : null;
  const pub = vault().signingPublicKey()!;
  if (!checkpoint) {
    b.omitted.push('Audit log excerpt: the audit chain could not be verified, so no checkpoint was signed – check Audit log → Verify');
    await b.json('audit/verification.json', publicResult(verified));
    return { included: false, verification: publicResult(verified) };
  }
  const based = prunedBase();
  const base = based && !('problem' in based) ? based : null;
  const baseSeq = base?.seq ?? 0;
  const first = db().get<{ seq: number }>('SELECT MIN(seq) AS seq FROM audit_log WHERE seq > ? AND ts >= ?', baseSeq, from)?.seq;
  const startSeq = first === null || first === undefined ? checkpoint.seq : Math.min(Number(first), checkpoint.seq);
  const count = checkpoint.seq - startSeq + 1;
  if (count > PACK_LIMITS.auditEntries) {
    b.omitted.push(
      `Audit log excerpt: ${count} entries since the start of the period exceed the limit of ${PACK_LIMITS.auditEntries} – export the audit log separately`,
    );
    await b.json('audit/verification.json', publicResult(verified));
    await b.json('audit/checkpoint.json', checkpoint);
    return { included: false, verification: publicResult(verified), checkpoint };
  }
  // public digest before the excerpt: from the newest signed checkpoint before it (or the deletion base, or #1)
  let digest = base?.digest ?? DIGEST_SEED;
  let seq = baseSeq + 1;
  const before = db().all<{ details: string | null }>(
    "SELECT details FROM audit_log WHERE action = 'audit.checkpoint' AND seq <= ? ORDER BY seq DESC LIMIT 50",
    startSeq,
  );
  for (const r of before) {
    const c = parseJson<AuditCheckpointLike | null>(r.details, null);
    if (c && typeof c.seq === 'number' && c.seq < startSeq && c.seq >= baseSeq && validCheckpoint(c)) {
      digest = c.digest;
      seq = c.seq + 1;
      break;
    }
  }
  while (seq < startSeq) {
    const rows = db().all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? AND seq < ? ORDER BY seq LIMIT 5000', seq, startSeq);
    if (!rows.length) break;
    for (const r of rows) digest = digestStep(digest, toEntry(r));
    seq = Number(rows.at(-1)!.seq) + 1;
  }
  const entries: AuditEntry[] = db().all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq', startSeq, checkpoint.seq).map(toEntry);
  // archived and deleted entries of the period: their archives up to the excerpt (verified offline, linked to it)
  const archives: NonNullable<AuditExcerpt['archives']> = [];
  if (base && startSeq === base.seq + 1) {
    for (const a of archivesCovering(1, base.seq).filter((x) => x.lastSeq <= base.seq && x.lastTs >= from)) {
      const p = `audit/archives/${safe(a.file)}`;
      const added = await b.file(p, a.path, a.sha256);
      archives.push({ file: a.file, path: added, firstSeq: a.firstSeq, lastSeq: a.lastSeq, sha256: a.sha256, checkpoint: a.checkpoint });
    }
  }
  const excerpt: AuditExcerpt & Record<string, unknown> = {
    format: 'steward-audit-excerpt',
    version: 1,
    period: { from, to },
    startSeq,
    startDigest: digest,
    inPeriod: entries.filter((e) => e.ts >= from && e.ts <= to).length,
    note: 'Entries from the start of the period up to the signed checkpoint created for this pack (entries after the period end are included so the checkpoint covers the excerpt).',
    publicKeyPem: publicKeyPem(pub),
    fingerprint: publicKeyFingerprint(pub),
    checkpoint,
    ...(archives.length
      ? {
          archives,
          archivedNote: `Entries of the period up to #${base!.seq} were archived and deleted from the database; their archives are in audit/archives/ (the excerpt continues the signed checkpoint the last one ends at).`,
        }
      : {}),
    entries,
  };
  await b.json(AUDIT_EXCERPT_FILE, excerpt);
  await b.json('audit/checkpoint.json', checkpoint);
  await b.json('audit/verification.json', { verifiedAt: nowIso(), ...publicResult(verified) });
  return {
    included: true,
    startSeq,
    endSeq: checkpoint.seq,
    entries: entries.length,
    checkpointSeq: checkpoint.seq,
    archives: archives.length,
    verification: publicResult(verified),
  };
}
