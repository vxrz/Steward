import crypto from 'node:crypto';
import net from 'node:net';
import jsonata from 'jsonata';
import { z } from 'zod';
import {
  WEBHOOK_AUTH_MODES,
  WEBHOOK_FORBIDDEN_HEADERS,
  type WebhookFire,
  type WebhookMappingPreview,
  type WebhookTrigger,
  type WebhookTriggerSecret,
  type WebhookTriggerSettings,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import { evalExpr } from '../engine/expr.js';

/**
 * Webhook triggers – management side (create, edit, rotate, delete, list).
 * The inbound endpoint lives in ./hook.ts.
 *
 * The secret is generated here, returned exactly once (creation / rotation) and
 * stored twice: encrypted with the vault key (to verify HMAC signatures) and as
 * a SHA-256 hash (constant-time comparison of static tokens). It never appears
 * in API responses, logs or audit entries.
 */

export interface TriggerRow {
  id: string;
  name: string;
  description: string;
  process_id: string;
  process_version: number | null;
  owner: string;
  enabled: number;
  dry_run: number;
  input_mapping: string;
  bindings: string;
  auth_mode: WebhookTrigger['authMode'];
  secret_enc: string;
  secret_hash: string;
  secret_prefix: string;
  secret_rotated_at: string;
  allowed_cidrs: string;
  allowed_headers: string;
  rate_limit_per_min: number;
  dedupe_seconds: number;
  skip_if_running: number;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  last_run_id: string | null;
  last_result: string | null;
  fire_count: number;
  rejected_count: number;
  last_rejected_at: string | null;
  last_rejected_reason: string | null;
  process_name?: string | null;
  last_run_status?: string | null;
}

export const SECRET_PREFIX = 'whs_';
export const TRIGGER_ID_RE = /^wht_[A-Za-z0-9_-]{8,40}$/;
export const hookPath = (id: string) => `/api/hooks/${id}`;

const SELECT = `SELECT t.*, p.name AS process_name, (SELECT status FROM runs WHERE id = t.last_run_id) AS last_run_status
  FROM webhook_triggers t LEFT JOIN processes p ON p.id = t.process_id`;

/** Rejections not yet written to the trigger row (flushed at most every few seconds). */
const pendingRejections = new Map<string, { count: number; at: string; reason: string }>();

function toTrigger(r: TriggerRow): WebhookTrigger {
  const pending = pendingRejections.get(r.id);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    processId: r.process_id,
    processName: r.process_name ?? undefined,
    processVersion: r.process_version,
    owner: r.owner,
    enabled: !!r.enabled,
    dryRun: !!r.dry_run,
    inputMapping: parseJson(r.input_mapping, {}),
    bindings: parseJson(r.bindings, {}),
    authMode: r.auth_mode,
    allowedCidrs: parseJson(r.allowed_cidrs, []),
    allowedHeaders: parseJson(r.allowed_headers, []),
    rateLimitPerMinute: r.rate_limit_per_min,
    dedupeSeconds: r.dedupe_seconds,
    skipIfRunning: !!r.skip_if_running,
    path: hookPath(r.id),
    secretPrefix: r.secret_prefix,
    secretRotatedAt: r.secret_rotated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastFiredAt: r.last_fired_at,
    lastRunId: r.last_run_id,
    lastRunStatus: r.last_run_status ?? null,
    lastResult: r.last_result,
    fireCount: r.fire_count,
    rejectedCount: r.rejected_count + (pending?.count ?? 0),
    lastRejectedAt: pending?.at ?? r.last_rejected_at,
    lastRejectedReason: pending?.reason ?? r.last_rejected_reason,
    canEdit: canEditTrigger(r),
  };
}

function canEditTrigger(r: { owner: string; process_id: string }): boolean {
  const u = currentUser();
  if (!u) return false;
  if (isAdmin(u) || r.owner.toLowerCase() === u.username.toLowerCase()) return true;
  return permissionsFor(r.process_id).includes('manage');
}

export function triggerRow(id: string): TriggerRow | undefined {
  if (!TRIGGER_ID_RE.test(id)) return undefined;
  return db().get<TriggerRow>(`${SELECT} WHERE t.id = ?`, id);
}

/** Triggers of processes the current user can see (like schedules). */
export function listTriggers(): WebhookTrigger[] {
  return db()
    .all<TriggerRow>(`${SELECT} ORDER BY t.name`)
    .filter((r) => permissionsFor(r.process_id).includes('view'))
    .map(toTrigger);
}

export function getTrigger(id: string): WebhookTrigger {
  const r = triggerRow(id);
  if (!r || !permissionsFor(r.process_id).includes('view')) throw new HttpError(404, 'Trigger not found');
  return toTrigger(r);
}

export function requireTriggerEdit(id: string): TriggerRow {
  const r = triggerRow(id);
  if (!r || !permissionsFor(r.process_id).includes('view')) throw new HttpError(404, 'Trigger not found');
  if (!canEditTrigger(r)) throw new HttpError(403, 'Only the owner, an administrator or a process manager can change this trigger');
  return r;
}

// ---------- validation ----------

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Parses "10.0.0.0/8", "192.168.1.5", "2001:db8::/32" → BlockList rule; throws on invalid input. */
export function parseCidr(entry: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
  const [addr = '', len] = entry.trim().split('/');
  const fam = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
  if (!fam) throw new HttpError(400, `Invalid IP address or CIDR "${entry}"`);
  const max = fam === 'ipv4' ? 32 : 128;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (len !== undefined && !/^\d+$/.test(len))) {
    throw new HttpError(400, `Invalid prefix length in "${entry}"`);
  }
  return { address: addr, prefix, family: fam };
}

export function addressAllowed(cidrs: string[], ip: string): boolean {
  if (!cidrs.length) return true;
  const list = new net.BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    list.addSubnet(p.address, p.prefix, p.family);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1]! : ip;
  if (net.isIPv4(addr)) return list.check(addr, 'ipv4');
  if (net.isIPv6(addr)) return list.check(addr, 'ipv6');
  return false;
}

export const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  processId: z.string().min(1),
  processVersion: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  inputMapping: z.record(z.string().max(2000)).default({}),
  bindings: z.record(z.string()).default({}),
  authMode: z.enum(WEBHOOK_AUTH_MODES).default('token'),
  allowedCidrs: z.array(z.string().max(64)).max(50).default([]),
  allowedHeaders: z.array(z.string().max(64)).max(20).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(30),
  dedupeSeconds: z.number().int().min(0).max(86400).default(60),
  skipIfRunning: z.boolean().default(true),
});

function validate(input: WebhookTriggerSettings): WebhookTriggerSettings {
  const proc = getProcess(input.processId, input.processVersion ?? undefined);
  if (processArchived(input.processId)) throw new HttpError(400, 'The process is archived');
  const names = new Set((proc.definition.inputs ?? []).map((i) => i.name));
  const mapping: Record<string, string> = {};
  for (const [name, expr] of Object.entries(input.inputMapping)) {
    if (!expr.trim()) continue;
    if (!names.has(name)) throw new HttpError(400, `Input mapping: the process has no input "${name}"`);
    try {
      jsonata(expr);
    } catch (e) {
      throw new HttpError(400, `Input mapping for "${name}": ${(e as Error).message}`);
    }
    mapping[name] = expr;
  }
  const headers = [...new Set(input.allowedHeaders.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  for (const h of headers) {
    if (!HEADER_NAME.test(h)) throw new HttpError(400, `Invalid header name "${h}"`);
    if ((WEBHOOK_FORBIDDEN_HEADERS as readonly string[]).includes(h)) throw new HttpError(400, `Header "${h}" carries credentials and cannot be mapped`);
  }
  const cidrs = [...new Set(input.allowedCidrs.map((c) => c.trim()).filter(Boolean))];
  cidrs.forEach(parseCidr);
  const slots = new Set(proc.definition.connections.map((c) => c.slot));
  for (const slot of Object.keys(input.bindings)) if (!slots.has(slot)) throw new HttpError(400, `The process has no connection slot "${slot}"`);
  return { ...input, description: input.description ?? '', inputMapping: mapping, allowedHeaders: headers, allowedCidrs: cidrs };
}

export const processArchived = (processId: string): boolean =>
  !!db().get<{ archived: number }>('SELECT archived FROM processes WHERE id = ?', processId)?.archived;

function newSecret(): { secret: string; enc: string; hash: string; prefix: string } {
  const secret = SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { secret, enc: vault().encrypt(secret), hash: sha256(secret), prefix: secret.slice(0, SECRET_PREFIX.length + 4) };
}

/** Settings as recorded in the audit log (no secret material). */
const auditable = (s: WebhookTriggerSettings) => ({
  processId: s.processId,
  processVersion: s.processVersion ?? null,
  enabled: s.enabled,
  dryRun: s.dryRun,
  inputMapping: s.inputMapping,
  bindings: s.bindings,
  authMode: s.authMode,
  allowedCidrs: s.allowedCidrs,
  allowedHeaders: s.allowedHeaders,
  rateLimitPerMinute: s.rateLimitPerMinute,
  dedupeSeconds: s.dedupeSeconds,
  skipIfRunning: s.skipIfRunning,
});

// ---------- CRUD ----------

export function createTrigger(raw: WebhookTriggerSettings): WebhookTriggerSecret {
  const owner = currentUser()?.username;
  if (!owner) throw new HttpError(401, 'Please sign in');
  const s = validate(raw);
  const id = newId('wht_');
  const sec = newSecret();
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO webhook_triggers (id, name, description, process_id, process_version, owner, enabled, dry_run, input_mapping, bindings, auth_mode,
         secret_enc, secret_hash, secret_prefix, secret_rotated_at, allowed_cidrs, allowed_headers, rate_limit_per_min, dedupe_seconds, skip_if_running, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.name,
      s.description ?? '',
      s.processId,
      s.processVersion ?? null,
      owner,
      s.enabled ? 1 : 0,
      s.dryRun ? 1 : 0,
      JSON.stringify(s.inputMapping),
      JSON.stringify(s.bindings),
      s.authMode,
      sec.enc,
      sec.hash,
      sec.prefix,
      ts,
      JSON.stringify(s.allowedCidrs),
      JSON.stringify(s.allowedHeaders),
      s.rateLimitPerMinute,
      s.dedupeSeconds,
      s.skipIfRunning ? 1 : 0,
      ts,
      ts,
    );
    audit({
      action: 'trigger.created',
      entityType: 'trigger',
      entityId: id,
      summary: `Webhook trigger "${s.name}" created for process ${s.processId}${s.enabled ? '' : ' (disabled)'}${s.dryRun ? ' (dry run)' : ''}, runs as ${owner}`,
      details: { ...auditable(s), owner, secretPrefix: sec.prefix },
    });
  });
  return { trigger: getTrigger(id), secret: sec.secret };
}

export function updateTrigger(id: string, raw: WebhookTriggerSettings): WebhookTrigger {
  const before = requireTriggerEdit(id);
  const s = validate(raw);
  const prev = toTrigger(before);
  const changed = (Object.keys(auditable(s)) as (keyof ReturnType<typeof auditable>)[]).filter(
    (k) => JSON.stringify(auditable(s)[k]) !== JSON.stringify(auditable(prev)[k]),
  );
  db().tx(() => {
    db().run(
      `UPDATE webhook_triggers SET name = ?, description = ?, process_id = ?, process_version = ?, enabled = ?, dry_run = ?, input_mapping = ?, bindings = ?,
         auth_mode = ?, allowed_cidrs = ?, allowed_headers = ?, rate_limit_per_min = ?, dedupe_seconds = ?, skip_if_running = ?, updated_at = ? WHERE id = ?`,
      s.name,
      s.description ?? '',
      s.processId,
      s.processVersion ?? null,
      s.enabled ? 1 : 0,
      s.dryRun ? 1 : 0,
      JSON.stringify(s.inputMapping),
      JSON.stringify(s.bindings),
      s.authMode,
      JSON.stringify(s.allowedCidrs),
      JSON.stringify(s.allowedHeaders),
      s.rateLimitPerMinute,
      s.dedupeSeconds,
      s.skipIfRunning ? 1 : 0,
      nowIso(),
      id,
    );
    audit({
      action: 'trigger.updated',
      entityType: 'trigger',
      entityId: id,
      summary: `Webhook trigger "${s.name}" updated${changed.length ? ` (${changed.join(', ')})` : ''}${s.enabled ? '' : ', disabled'}`,
      details: { ...auditable(s), changed, owner: before.owner },
    });
  });
  return getTrigger(id);
}

export function rotateSecret(id: string): WebhookTriggerSecret {
  const r = requireTriggerEdit(id);
  const sec = newSecret();
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE webhook_triggers SET secret_enc = ?, secret_hash = ?, secret_prefix = ?, secret_rotated_at = ?, updated_at = ? WHERE id = ?',
      sec.enc,
      sec.hash,
      sec.prefix,
      ts,
      ts,
      id,
    );
    audit({
      action: 'trigger.secret_rotated',
      entityType: 'trigger',
      entityId: id,
      summary: `Secret of webhook trigger "${r.name}" rotated (old secret ${r.secret_prefix}… is no longer accepted)`,
      details: { oldPrefix: r.secret_prefix, newPrefix: sec.prefix },
    });
  });
  return { trigger: getTrigger(id), secret: sec.secret };
}

export function deleteTrigger(id: string): void {
  const r = requireTriggerEdit(id);
  db().tx(() => {
    db().run('DELETE FROM webhook_triggers WHERE id = ?', id);
    db().run('DELETE FROM webhook_trigger_fires WHERE trigger_id = ?', id);
    audit({ action: 'trigger.deleted', entityType: 'trigger', entityId: id, summary: `Webhook trigger "${r.name}" deleted` });
  });
  pendingRejections.delete(id);
}

/** The decrypted secret – only for server-side test calls, never returned to clients. */
export function revealSecretForTest(r: TriggerRow): string {
  return vault().decrypt<string>(r.secret_enc);
}

export function listFires(id: string, limit = 50): WebhookFire[] {
  getTrigger(id);
  return db()
    .all<{
      id: number;
      ts: string;
      source_ip: string;
      payload_hash: string;
      outcome: WebhookFire['outcome'];
      reason: string | null;
      run_id: string | null;
      test: number;
    }>('SELECT * FROM webhook_trigger_fires WHERE trigger_id = ? ORDER BY id DESC LIMIT ?', id, Math.min(Math.max(1, limit), 500))
    .map((f) => ({
      id: f.id,
      ts: f.ts,
      sourceIp: f.source_ip,
      payloadHash: f.payload_hash,
      outcome: f.outcome,
      reason: f.reason,
      runId: f.run_id,
      test: !!f.test,
    }));
}

// ---------- input mapping ----------

/** Evaluation limits for mapping expressions (the payload is untrusted data). */
const EVAL_GUARD = { timeoutMs: 1000, maxDepth: 200 };

export interface MappingScope {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, unknown>;
}

/** Header values available to the mapping: allow-listed names only, never credentials. */
export function pickHeaders(headers: Record<string, string | string[] | undefined>, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowed) {
    if ((WEBHOOK_FORBIDDEN_HEADERS as readonly string[]).includes(name)) continue;
    const v = headers[name];
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

export async function evaluateMapping(mapping: Record<string, string>, scope: MappingScope): Promise<WebhookMappingPreview> {
  const inputs: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [name, expr] of Object.entries(mapping)) {
    try {
      const v = await evalExpr(expr, scope, {}, EVAL_GUARD);
      if (v !== undefined) inputs[name] = v;
    } catch (e) {
      errors[name] = (e as Error).message;
    }
  }
  return { inputs, errors };
}

// ---------- rejection counters ----------

let lastFlush = 0;
/** Counts a rejected call; the trigger row is updated at most every 5 s (cheap under a flood). */
export function countRejection(id: string, reason: string): void {
  const p = pendingRejections.get(id) ?? { count: 0, at: '', reason: '' };
  p.count++;
  p.at = nowIso();
  p.reason = reason;
  pendingRejections.set(id, p);
  if (Date.now() - lastFlush > 5000) flushRejections();
}

export function flushRejections(): void {
  lastFlush = Date.now();
  for (const [id, p] of pendingRejections) {
    db().run(
      'UPDATE webhook_triggers SET rejected_count = rejected_count + ?, last_rejected_at = ?, last_rejected_reason = ? WHERE id = ?',
      p.count,
      p.at,
      p.reason,
      id,
    );
  }
  pendingRejections.clear();
}
