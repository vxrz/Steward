import crypto from 'node:crypto';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { nowIso, parseJson, sha256 } from '../util.js';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { permissionsFor } from '../processes/service.js';
import { getPlatform } from '../platforms/service.js';
import { startRun } from '../engine/runner.js';
import { addressAllowed, countRejection, evaluateMapping, pickHeaders, processArchived, triggerRow, type TriggerRow } from './service.js';

/**
 * Inbound webhook: `POST /api/hooks/<triggerId>`.
 *
 * Order of checks (cheap and non-revealing first):
 *   unknown/disabled trigger or source address not allowed → 404 (same answer, nothing leaks)
 *   vault locked → 503 · bad or missing secret → 401 · not JSON → 415 · invalid JSON → 400
 *   over the rate limit → 429 · identical payload within the dedupe window → 202 { skipped }
 *   owner lost rights / previous run still active → 202 { skipped } · otherwise → 202 { runId }
 * Rejections before the run decision are counted and audited at most once per
 * trigger and reason every 10 minutes (with the number of suppressed calls),
 * so a flood cannot fill the audit log. Accepted calls are audited one by one
 * (they are bounded by the rate limit).
 */

export interface HookRequest {
  triggerId: string;
  raw: Buffer | undefined;
  contentType: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  ip: string;
}

export interface HookResponse {
  status: number;
  body: { runId?: string; skipped?: string; error?: string };
  headers?: Record<string, string>;
}

const NOT_FOUND: HookResponse = { status: 404, body: { error: 'Not found' } };
const AUDIT_EVERY_MS = 10 * 60000;
const ACTIVE = ['running', 'waiting', 'queued', 'interrupted'];

// ---------- in-memory state (single instance per database is enforced at start-up) ----------

/** Accepted call timestamps per trigger (sliding one-minute window). */
const calls = new Map<string, number[]>();
/** Payload hash → last time seen, per trigger. */
const seen = new Map<string, Map<string, number>>();
/** Last audit entry per trigger + rejection reason. */
const rejectionAudit = new Map<string, { at: number; suppressed: number }>();
/** Triggers whose run is being started right now (closes the gap until last_run_id is written). */
const starting = new Set<string>();
/** One-time markers for test calls sent by the UI through the real endpoint. */
const testNonces = new Map<string, { triggerId: string; dryRun: boolean; expires: number }>();

export function registerTestNonce(triggerId: string, dryRun: boolean): string {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  for (const [k, v] of testNonces) if (v.expires < now) testNonces.delete(k);
  testNonces.set(nonce, { triggerId, dryRun, expires: now + 30000 });
  return nonce;
}

function takeTestNonce(value: string | undefined, triggerId: string): { dryRun: boolean } | null {
  if (!value) return null;
  const n = testNonces.get(value);
  if (!n) return null;
  testNonces.delete(value);
  return n.triggerId === triggerId && n.expires >= Date.now() ? { dryRun: n.dryRun } : null;
}

/** For tests: forget rate-limit/dedupe state. */
export function resetHookState(): void {
  calls.clear();
  seen.clear();
  rejectionAudit.clear();
}

const header = (h: HookRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

function reject(r: TriggerRow, req: HookRequest, reason: string, res: HookResponse): HookResponse {
  countRejection(r.id, reason);
  const key = `${r.id}|${reason}`;
  const now = Date.now();
  const st = rejectionAudit.get(key);
  if (!st || now - st.at >= AUDIT_EVERY_MS) {
    audit({
      actor: 'webhook',
      action: 'trigger.rejected',
      entityType: 'trigger',
      entityId: r.id,
      summary: `Webhook trigger "${r.name}" rejected a call from ${req.ip}: ${reason}${st?.suppressed ? ` (${st.suppressed} more since the last entry)` : ''}`,
      details: { reason, sourceIp: req.ip, status: res.status, suppressedSinceLastEntry: st?.suppressed ?? 0 },
    });
    rejectionAudit.set(key, { at: now, suppressed: 0 });
  } else st.suppressed++;
  logger.warn({ triggerId: r.id, reason, ip: req.ip, status: res.status }, 'webhook call rejected');
  return res;
}

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** What a caller must prove (shared with the monitor heartbeat endpoints). */
export interface HookSecret {
  auth_mode: string;
  secret_hash: string;
  secret_enc: string;
}
type HookCall = Pick<HookRequest, 'headers' | 'raw'>;

function tokenOk(r: HookSecret, req: HookCall): boolean {
  const presented = header(req.headers, 'x-steward-token') ?? /^Bearer\s+(\S+)\s*$/i.exec(header(req.headers, 'authorization') ?? '')?.[1];
  if (!presented || presented.length > 512) return false;
  return timingSafeHexEqual(sha256(presented.trim()), r.secret_hash);
}

function hmacOk(r: HookSecret, req: HookCall): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header(req.headers, 'x-steward-signature')?.trim() ?? '');
  if (!m) return false;
  const secret = vault().decrypt<string>(r.secret_enc);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.raw ?? Buffer.alloc(0))
    .digest('hex');
  return timingSafeHexEqual(m[1]!.toLowerCase(), expected);
}

/** Static token (constant-time hash comparison) and/or HMAC-SHA256 signature of the raw body, per auth mode. */
export function authenticated(r: HookSecret, req: HookCall): boolean {
  switch (r.auth_mode) {
    case 'token':
      return tokenOk(r, req);
    case 'hmac':
      return hmacOk(r, req);
    default:
      return tokenOk(r, req) || hmacOk(r, req);
  }
}

export const isJson = (ct: string | undefined) => !!ct && /^application\/([a-z0-9.+-]*\+)?json\s*(;|$)/i.test(ct.trim());

function overRateLimit(r: TriggerRow): number | null {
  const now = Date.now();
  const list = (calls.get(r.id) ?? []).filter((t) => now - t < 60000);
  if (list.length >= r.rate_limit_per_min) {
    calls.set(r.id, list);
    return Math.max(1, Math.ceil((60000 - (now - list[0]!)) / 1000));
  }
  list.push(now);
  calls.set(r.id, list);
  return null;
}

function duplicate(r: TriggerRow, hash: string): boolean {
  if (r.dedupe_seconds <= 0) return false;
  const now = Date.now();
  const m = seen.get(r.id) ?? new Map<string, number>();
  for (const [h, t] of m) if (now - t >= r.dedupe_seconds * 1000) m.delete(h);
  seen.set(r.id, m);
  if (m.has(hash)) return true;
  m.set(hash, now);
  if (m.size > 1000) m.delete(m.keys().next().value!);
  return false;
}

function recordFire(
  r: TriggerRow,
  req: HookRequest,
  f: { hash: string; outcome: 'started' | 'skipped' | 'failed'; reason?: string; runId?: string; test: boolean },
) {
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO webhook_trigger_fires (trigger_id, ts, source_ip, payload_hash, outcome, reason, run_id, test) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.id,
      ts,
      req.ip,
      f.hash,
      f.outcome,
      f.reason ?? null,
      f.runId ?? null,
      f.test ? 1 : 0,
    );
    // keep the newest 500 calls per trigger
    db().run(
      'DELETE FROM webhook_trigger_fires WHERE trigger_id = ? AND id NOT IN (SELECT id FROM webhook_trigger_fires WHERE trigger_id = ? ORDER BY id DESC LIMIT 500)',
      r.id,
      r.id,
    );
    const result = f.outcome === 'started' ? 'started' : `${f.outcome}: ${f.reason ?? ''}`;
    db().run(
      `UPDATE webhook_triggers SET last_fired_at = ?, last_result = ?, fire_count = fire_count + ?${f.runId ? ', last_run_id = ?' : ''} WHERE id = ?`,
      ...[ts, result.slice(0, 300), f.outcome === 'started' ? 1 : 0, ...(f.runId ? [f.runId] : []), r.id],
    );
    audit({
      actor: 'webhook',
      action: f.outcome === 'started' ? 'trigger.fired' : f.outcome === 'skipped' ? 'trigger.skipped' : 'trigger.failed',
      entityType: 'trigger',
      entityId: r.id,
      runId: f.runId ?? null,
      summary:
        `Webhook trigger "${r.name}"${f.test ? ' (test call)' : ''} called from ${req.ip}: ` +
        (f.outcome === 'started' ? `run ${f.runId} started as ${r.owner}` : `${f.outcome === 'skipped' ? 'run skipped' : 'run not started'} – ${f.reason}`),
      details: {
        sourceIp: req.ip,
        payloadHash: f.hash,
        runId: f.runId ?? null,
        owner: r.owner,
        processId: r.process_id,
        test: f.test,
        reason: f.reason ?? null,
      },
    });
  });
}

/** Why the owner may not start this run right now (like scheduled runs), or null. */
function ownerProblem(r: TriggerRow): { problem: string } | { user: ReturnType<typeof toAuthUser> } {
  const owner = findUserByName(r.owner);
  if (!owner || !owner.active) return { problem: `owner ${r.owner} is missing or deactivated` };
  const user = toAuthUser(owner);
  const problem = runAs(user, () => {
    if (processArchived(r.process_id)) return 'the process is archived';
    if (!permissionsFor(r.process_id).includes('run')) return `${user.username} may not run process ${r.process_id}`;
    for (const pid of Object.values(parseJson<Record<string, string>>(r.bindings, {}))) {
      let ok: boolean;
      try {
        ok = getPlatform(pid).permissions.includes('use');
      } catch {
        return `platform ${pid} no longer exists`;
      }
      if (!ok) return `${user.username} may not use platform ${pid}`;
    }
    return null;
  });
  return problem ? { problem } : { user };
}

export async function handleHook(req: HookRequest): Promise<HookResponse> {
  const r = triggerRow(req.triggerId);
  if (!r || !r.enabled) {
    logger.debug({ ip: req.ip }, 'webhook call for an unknown or disabled trigger');
    return NOT_FOUND;
  }
  const test = takeTestNonce(header(req.headers, 'x-steward-test'), r.id);
  if (!vault().unlocked) return { status: 503, body: { error: 'Service unavailable' } };
  // Test calls come from the server itself on behalf of a signed-in editor.
  if (!test && !addressAllowed(parseJson(r.allowed_cidrs, []), req.ip)) return reject(r, req, 'source address not allowed', NOT_FOUND);
  if (!authenticated(r, req)) return reject(r, req, 'missing or wrong secret', { status: 401, body: { error: 'Unauthorized' } });
  if (!isJson(req.contentType)) return reject(r, req, 'content type is not JSON', { status: 415, body: { error: 'Content-Type must be application/json' } });
  const raw = req.raw ?? Buffer.alloc(0);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return reject(r, req, 'invalid JSON', { status: 400, body: { error: 'Invalid JSON' } });
  }
  const retryAfter = overRateLimit(r);
  if (retryAfter !== null) {
    return reject(r, req, 'rate limit exceeded', { status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': String(retryAfter) } });
  }
  const hash = sha256(raw);
  if (duplicate(r, hash)) return reject(r, req, `duplicate payload within ${r.dedupe_seconds} s`, { status: 202, body: { skipped: 'duplicate' } });

  const base = { hash, test: !!test };
  const mapped = await evaluateMapping(parseJson(r.input_mapping, {}), {
    body,
    headers: pickHeaders(req.headers, parseJson(r.allowed_headers, [])),
    query: req.query ?? {},
  });
  const mapErrors = Object.entries(mapped.errors);
  if (mapErrors.length) {
    recordFire(r, req, {
      ...base,
      outcome: 'failed',
      reason: `input mapping failed: ${mapErrors
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
        .slice(0, 500)}`,
    });
    return { status: 422, body: { error: 'Input mapping failed' } };
  }
  const owner = ownerProblem(r);
  if ('problem' in owner) {
    logger.warn({ triggerId: r.id, reason: owner.problem }, 'webhook run skipped');
    recordFire(r, req, { ...base, outcome: 'skipped', reason: owner.problem });
    return { status: 202, body: { skipped: 'not permitted' } };
  }
  if (r.skip_if_running) {
    const last = r.last_run_id ? db().get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.last_run_id) : undefined;
    if (starting.has(r.id) || (last && ACTIVE.includes(last.status))) {
      recordFire(r, req, { ...base, outcome: 'skipped', reason: `previous run ${r.last_run_id ?? ''} is still ${last?.status ?? 'starting'}` });
      return { status: 202, body: { skipped: 'previous run still active' } };
    }
  }
  let runId: string;
  starting.add(r.id);
  try {
    runId = await runAs(owner.user, () =>
      startRun(
        {
          processId: r.process_id,
          version: r.process_version ?? undefined,
          inputs: mapped.inputs,
          bindings: parseJson(r.bindings, {}),
          dryRun: !!r.dry_run || !!test?.dryRun,
        },
        { trigger: 'webhook', actor: owner.user.username, webhook: { triggerId: r.id, triggerName: r.name, test: !!test } },
      ),
    );
  } catch (e) {
    recordFire(r, req, { ...base, outcome: 'failed', reason: `run could not be started: ${(e as Error).message}`.slice(0, 500) });
    return { status: 422, body: { error: 'Run could not be started' } };
  } finally {
    starting.delete(r.id);
  }
  recordFire(r, req, { ...base, outcome: 'started', runId });
  return { status: 202, body: { runId } };
}
