import fs from 'node:fs';
import path from 'node:path';
import { BRAND, type AuditAnchoring, type AuditCheckpoint, type AuditVerifyResult } from '@sm/shared';
import { config } from './config.js';
import { audit, checkpointPayload, latestCheckpoint, publicResult, verifyAuditAsync, type Anchor, type VerifyOutcome } from './audit.js';
import { publicKeyFingerprint, publicKeyPem, vault, verifySignature } from './vault.js';
import { logger } from './log.js';
import { readSetting, writeSetting } from './settings.js';
import { HttpError, nowIso } from './util.js';

/**
 * Anchoring of the audit log outside the database.
 *
 * A checkpoint {seq, hash, digest, count, ts} is signed with the installation's Ed25519
 * key (vault) every hour (when there are new entries), after each verification and
 * before each export. Each checkpoint is
 *   - written to the audit log itself (action "audit.checkpoint"),
 *   - written to <data dir>/audit-anchor.json (a database administrator cannot change it),
 *   - logged as a pino info line "audit checkpoint" (ship it to your SIEM: append-only for Steward),
 *   - optionally e-mailed to auditors (at most every `emailIntervalHours`).
 * verify() compares the chain with these anchors and with an anchor kept elsewhere
 * (pasted in the UI, SM_AUDIT_ANCHOR, SM_AUDIT_ANCHOR_FILE): removing entries at the end,
 * or rewriting the log, no longer goes unnoticed once a checkpoint has left the system.
 */

export const CHECKPOINT_INTERVAL_MINUTES = Math.max(5, Number(process.env.SM_AUDIT_CHECKPOINT_MINUTES) || 60);
const EMAIL_KEY = 'audit.checkpointEmail';
const EMAIL_LAST_KEY = 'audit.checkpointEmailLast';

export const anchorFile = (): string => path.join(config.dataDir, 'audit-anchor.json');

function ownKey(): { pub: string; fingerprint: string } | null {
  const pub = vault().signingPublicKey();
  return pub ? { pub, fingerprint: publicKeyFingerprint(pub) } : null;
}

export function validCheckpoint(c: Partial<AuditCheckpoint>, publicKey?: string): c is AuditCheckpoint {
  const key = publicKey ?? ownKey()?.pub;
  if (!key || !c || typeof c.signature !== 'string' || typeof c.seq !== 'number') return false;
  const { signature, ...rest } = c as AuditCheckpoint;
  return verifySignature(key, checkpointPayload(rest), signature);
}

/**
 * Reads an anchor: a checkpoint (JSON), an export file (JSON with "checkpoint"), the last line
 * of a JSON-lines file of checkpoints / log lines, or "seq:hash".
 * A signed anchor must carry a valid signature of this installation.
 */
export function parseAnchor(text: string, source: string): Anchor {
  const raw = text.trim();
  if (!raw) throw new HttpError(400, `The ${source} is empty`);
  const simple = /^#?(\d+)\s*[:=,\s]\s*([0-9a-f]{64})$/i.exec(raw);
  if (simple) return { source, seq: Number(simple[1]), hash: simple[2]!.toLowerCase() };
  const candidates = [
    raw,
    ...raw
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .reverse(),
  ];
  for (const c of candidates) {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(c) as Record<string, unknown>;
    } catch {
      continue;
    }
    // a checkpoint, an export ({checkpoint}), a log line ({auditCheckpoint}) or an audit entry ({action, details})
    const obj = (v.checkpoint ?? v.auditCheckpoint ?? (v.action === 'audit.checkpoint' ? v.details : v)) as Partial<AuditCheckpoint> | undefined;
    if (!obj || typeof obj.seq !== 'number' || typeof obj.hash !== 'string') continue;
    if (obj.signature !== undefined && !validCheckpoint(obj)) {
      throw new HttpError(400, `The ${source} has an invalid signature – it was changed or does not come from this installation`, 'ANCHOR_SIGNATURE_INVALID');
    }
    return { source, seq: obj.seq, hash: obj.hash, digest: typeof obj.digest === 'string' ? obj.digest : undefined };
  }
  throw new HttpError(400, `The ${source} is not a checkpoint (expected JSON with seq and hash, or "seq:hash")`, 'ANCHOR_INVALID');
}

/** Anchors the server always compares with. Problems reading them are reported as failed anchors. */
export function configuredAnchors(): { anchors: Anchor[]; errors: { source: string; message: string }[]; names: string[] } {
  const anchors: Anchor[] = [];
  const errors: { source: string; message: string }[] = [];
  const names: string[] = [];
  const add = (source: string, read: () => string | null) => {
    try {
      const text = read();
      if (text === null) return;
      names.push(source);
      anchors.push(parseAnchor(text, source));
    } catch (e) {
      errors.push({ source, message: (e as Error).message });
    }
  };
  add('local anchor file', () => (fs.existsSync(anchorFile()) ? fs.readFileSync(anchorFile(), 'utf8') : null));
  add('anchor in SM_AUDIT_ANCHOR', () => process.env.SM_AUDIT_ANCHOR?.trim() || null);
  add('anchor file SM_AUDIT_ANCHOR_FILE', () => {
    const f = process.env.SM_AUDIT_ANCHOR_FILE?.trim();
    if (!f) return null;
    if (!fs.existsSync(f)) throw new Error(`SM_AUDIT_ANCHOR_FILE ${f} does not exist`);
    return fs.readFileSync(f, 'utf8');
  });
  return { anchors, errors, names };
}

/** Full verification against all anchors (configured + `extra`). */
export async function verifyWithAnchors(extra: Anchor[] = []): Promise<VerifyOutcome> {
  const conf = configuredAnchors();
  if (conf.errors.length) {
    const e = conf.errors[0]!;
    return {
      ok: false,
      checked: 0,
      message: `The ${e.source} cannot be used: ${e.message}`,
      anchors: conf.errors.map((x) => ({ source: x.source, seq: 0, ok: false, message: x.message })),
    };
  }
  return verifyAuditAsync({ anchors: [...conf.anchors, ...extra] });
}

let running: Promise<AuditCheckpoint | null> | null = null;

/**
 * Signs and records a checkpoint of the current head. Verifies the entries since the previous
 * checkpoint first (`verified`: a result of a full verification that just ran). Returns null
 * when nothing is to be done (vault locked, empty log, no new entries for an interval checkpoint)
 * or the chain is broken (then it is logged as an error, never signed).
 */
export function createCheckpoint(reason: 'interval' | 'verify' | 'export' | 'manual', verified?: VerifyOutcome): Promise<AuditCheckpoint | null> {
  const next = (running ?? Promise.resolve(null)).catch(() => null).then(() => doCheckpoint(reason, verified));
  running = next;
  void next.finally(() => {
    if (running === next) running = null;
  });
  return next;
}

async function doCheckpoint(reason: string, verified?: VerifyOutcome): Promise<AuditCheckpoint | null> {
  if (!vault().unlocked) return null;
  const key = ownKey();
  if (!key) return null;
  const prev = latestCheckpoint((c) => validCheckpoint(c, key.pub));
  let r = verified;
  if (!r?.ok || !r.head) {
    const conf = configuredAnchors();
    r = await verifyAuditAsync({
      from: prev ? { seq: prev.checkpoint.seq, hash: prev.checkpoint.hash, digest: prev.checkpoint.digest } : undefined,
      anchors: conf.anchors,
    });
  }
  if (!r.ok || !r.head) {
    logger.error({ audit: publicResult(r) }, 'audit chain verification failed – no checkpoint signed');
    return null;
  }
  const head = r.head;
  if (head.seq === 0) return null;
  if (reason === 'interval' && prev && head.seq <= prev.entrySeq) return null; // nothing new since the last checkpoint
  const body: Omit<AuditCheckpoint, 'signature'> = {
    v: 1,
    seq: head.seq,
    hash: head.hash,
    digest: head.digest,
    count: head.seq,
    ts: nowIso(),
    keyFingerprint: key.fingerprint,
  };
  const cp: AuditCheckpoint = { ...body, signature: vault().sign(checkpointPayload(body)) };
  audit({ actor: 'system', action: 'audit.checkpoint', entityType: 'audit', summary: `Signed audit checkpoint at entry #${cp.seq} (${reason})`, details: cp });
  try {
    const tmp = `${anchorFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cp, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, anchorFile());
  } catch (err) {
    logger.warn({ err }, 'could not write the local audit anchor file');
  }
  // One JSON line per checkpoint for the log shipper / SIEM.
  logger.info({ auditCheckpoint: cp }, 'audit checkpoint');
  void emailCheckpoint(cp).catch((err) => logger.warn({ err: (err as Error).message }, 'could not e-mail the audit checkpoint'));
  return cp;
}

// ---------- e-mail to auditors ----------

export function emailSettings(): { to: string[]; intervalHours: number } {
  return readSetting(EMAIL_KEY, { to: [] as string[], intervalHours: 24 });
}

export function saveEmailSettings(input: { to: string[]; intervalHours?: number }): { to: string[]; intervalHours: number } {
  const to = [...new Set(input.to.map((s) => s.trim()).filter(Boolean))];
  for (const a of to) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new HttpError(400, `"${a}" is not an e-mail address`, 'INVALID_EMAIL');
  if (to.length > 20) throw new HttpError(400, 'At most 20 recipients');
  const intervalHours = Math.min(24 * 7, Math.max(1, Math.round(input.intervalHours ?? 24)));
  const v = { to, intervalHours };
  writeSetting(EMAIL_KEY, v);
  audit({
    action: 'audit.anchoring_updated',
    entityType: 'audit',
    summary: `Checkpoint e-mails: ${to.length ? `${to.join(', ')} every ${intervalHours} h` : 'off'}`,
    details: v,
  });
  return v;
}

async function emailCheckpoint(cp: AuditCheckpoint, force = false): Promise<boolean> {
  const s = emailSettings();
  if (!s.to.length) return false;
  const last = readSetting<string | null>(EMAIL_LAST_KEY, null);
  if (!force && last && Date.now() - Date.parse(last) < s.intervalHours * 3600_000) return false;
  const { getNotificationSettings, channelSecrets } = await import('./notifications/settings.js');
  const { sendEmail } = await import('./notifications/channels.js');
  const n = getNotificationSettings();
  if (!n.email.enabled || !n.email.host) return false;
  const pub = ownKey();
  const body = [
    `Signed checkpoint of the ${BRAND.name} audit log. Keep this e-mail: it proves that the log had ${cp.count} entries and what entry #${cp.seq} was.`,
    `Verify the log against it: paste the JSON below in Audit log → Verify, or set SM_AUDIT_ANCHOR. Offline: npm run audit:verify-export -- --file export.json --public-key key.pem`,
    `Signing key fingerprint: ${pub?.fingerprint ?? cp.keyFingerprint}`,
    '',
    JSON.stringify(cp),
  ].join('\n');
  writeSetting(EMAIL_LAST_KEY, nowIso());
  for (const to of s.to) {
    await sendEmail(n.email, channelSecrets(), to, {
      event: 'audit.checkpoint',
      title: `Audit checkpoint #${cp.seq}`,
      body,
      locale: 'en',
      link: `${(await import('./notifications/settings.js')).publicBaseUrl()}/audit`,
      ts: cp.ts,
      data: { checkpoint: cp },
    });
  }
  return true;
}

// ---------- status & jobs ----------

export function anchoringStatus(): AuditAnchoring {
  const key = ownKey();
  const latest = vault().unlocked && key ? (latestCheckpoint((c) => validCheckpoint(c, key.pub))?.checkpoint ?? null) : null;
  const s = emailSettings();
  return {
    publicKeyPem: key ? publicKeyPem(key.pub) : null,
    fingerprint: key?.fingerprint ?? null,
    latest,
    intervalMinutes: CHECKPOINT_INTERVAL_MINUTES,
    configuredAnchors: configuredAnchors().names,
    emailRecipients: s.to,
    emailIntervalHours: s.intervalHours,
  };
}

export function verificationResult(r: VerifyOutcome, checkpoint: AuditCheckpoint | null): AuditVerifyResult {
  return publicResult(r, checkpoint ? { checkpoint } : {});
}

let timer: NodeJS.Timeout | undefined;
export function startAuditJobs(): void {
  if (timer) return;
  timer = setInterval(() => {
    void createCheckpoint('interval').catch((err) => logger.warn({ err }, 'audit checkpoint failed'));
  }, CHECKPOINT_INTERVAL_MINUTES * 60_000);
  timer.unref();
}
export function stopAuditJobs(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
