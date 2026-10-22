import crypto from 'node:crypto';
import { HEARTBEAT_MAX_BATCH, type HeartbeatReport, type MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { nowIso, parseJson, sha256 } from '../util.js';
import { authenticated, isJson, type HookRequest } from '../triggers/hook.js';
import { addressAllowed } from '../triggers/service.js';
import { checkEnabled, parseDefinition, type CheckRow, type GatewayRow } from './model.js';
import { countGateway, keyAllowed } from './gateways.js';
import * as engine from './engine.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { permissionsOfRow } from './model.js';

/**
 * Heartbeat endpoints (push checks):
 *   POST /api/hooks/monitor/<hookId>   one check, its own secret
 *   POST /api/hooks/monitors           a gateway reports many checks: { "reports": [ { "key", "ts", "value", "status", "data" } ] }
 *
 * Same security model as webhook triggers (server/src/triggers): unknown, disabled or
 * not-allowed source → 404 (nothing leaks) · vault locked → 503 · bad secret → 401 ·
 * not JSON → 415 · invalid JSON or report → 400 · body > 64 KB → 413 · over the rate
 * limit → 429. Secrets are compared in constant time (SHA-256) or verified as HMAC
 * signature of the raw body. Accepted reports are counted, rejected calls are audited
 * at most once per endpoint and reason every 10 minutes.
 */

/**
 * Global cap on concurrent heartbeat evaluations across all gateways/batches, so
 * a flood of gateway reports cannot amplify into unbounded CPU on the shared
 * Node process (each evaluation runs guarded JSONata and DB writes).
 */
const MAX_CONCURRENT_EVALS = Number(process.env.SM_MONITOR_EVAL_CONCURRENCY) || 8;
let activeEvals = 0;
const evalQueue: (() => void)[] = [];
function acquireEval(): Promise<() => void> {
  const release = () => {
    const next = evalQueue.shift();
    if (next) next();
    else activeEvals--;
  };
  if (activeEvals < MAX_CONCURRENT_EVALS) {
    activeEvals++;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => evalQueue.push(() => resolve(release)));
}

export type MonitorHookRequest = Omit<HookRequest, 'triggerId' | 'query'>;
export interface MonitorHookResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const NOT_FOUND: MonitorHookResponse = { status: 404, body: { error: 'Not found' } };
const AUDIT_EVERY_MS = 10 * 60000;
const calls = new Map<string, number[]>();
const rejectionAudit = new Map<string, { at: number; suppressed: number }>();

export function resetMonitorHookState(): void {
  calls.clear();
  rejectionAudit.clear();
}

function overLimit(key: string, perMinute: number): number | null {
  const now = Date.now();
  const list = (calls.get(key) ?? []).filter((t) => now - t < 60000);
  if (list.length >= perMinute) {
    calls.set(key, list);
    return Math.max(1, Math.ceil((60000 - (now - list[0]!)) / 1000));
  }
  list.push(now);
  calls.set(key, list);
  return null;
}

function reject(
  entity: { type: 'monitor' | 'monitor-gateway'; id: string; name: string },
  ip: string,
  reason: string,
  res: MonitorHookResponse,
): MonitorHookResponse {
  const key = `${entity.id}|${reason}`;
  const now = Date.now();
  const st = rejectionAudit.get(key);
  if (!st || now - st.at >= AUDIT_EVERY_MS) {
    audit({
      actor: entity.type === 'monitor' ? 'heartbeat' : 'gateway',
      action: 'monitor.report_rejected',
      entityType: entity.type,
      entityId: entity.id,
      summary: `${entity.type === 'monitor' ? 'Heartbeat' : 'Gateway'} "${entity.name}" rejected a call from ${ip}: ${reason}${st?.suppressed ? ` (${st.suppressed} more since the last entry)` : ''}`,
      details: { reason, sourceIp: ip, status: res.status, suppressedSinceLastEntry: st?.suppressed ?? 0 },
    });
    rejectionAudit.set(key, { at: now, suppressed: 0 });
  } else st.suppressed++;
  logger.warn({ entity: entity.id, reason, ip, status: res.status }, 'monitor report rejected');
  return res;
}

function parseBody(req: MonitorHookRequest): { ok: true; body: unknown } | { ok: false; res: MonitorHookResponse; reason: string } {
  if (!isJson(req.contentType))
    return { ok: false, reason: 'content type is not JSON', res: { status: 415, body: { error: 'Content-Type must be application/json' } } };
  const raw = req.raw ?? Buffer.alloc(0);
  try {
    return { ok: true, body: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  } catch {
    return { ok: false, reason: 'invalid JSON', res: { status: 400, body: { error: 'Invalid JSON' } } };
  }
}

/** Normalizes one report; returns an error text when it is not acceptable. */
function normalizeReport(x: unknown): HeartbeatReport | string {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return 'a report must be a JSON object';
  const r = x as Record<string, unknown>;
  const out: HeartbeatReport = {};
  if (r.ts !== undefined && r.ts !== null) {
    const t = typeof r.ts === 'number' ? (r.ts < 1e12 ? r.ts * 1000 : r.ts) : Date.parse(String(r.ts));
    if (!Number.isFinite(t)) return '"ts" must be an ISO 8601 timestamp or Unix time';
    out.ts = new Date(t).toISOString();
  }
  if (r.status !== undefined && r.status !== null) {
    if (typeof r.status !== 'string' && typeof r.status !== 'boolean') return '"status" must be a string or a boolean';
    out.status = typeof r.status === 'string' ? r.status.slice(0, 50) : r.status;
  }
  if (r.value !== undefined) out.value = r.value;
  if (r.data !== undefined) out.data = r.data;
  if (typeof r.key === 'string') out.key = r.key;
  return out;
}

function store(row: Pick<CheckRow, 'monitor_id' | 'check_id'>, report: HeartbeatReport): void {
  const { key: _k, ...rest } = report;
  db().run(
    'UPDATE monitor_checks SET last_push_at = ?, last_push = ? WHERE monitor_id = ? AND check_id = ?',
    new Date(engine.monitorNow()).toISOString(),
    JSON.stringify(rest),
    row.monitor_id,
    row.check_id,
  );
}

interface Target extends CheckRow {
  monitor_name: string;
  monitor_enabled: number;
  is_template: number;
  definition: string;
}

function heartbeatCheck(t: Target | undefined) {
  if (!t || !t.monitor_enabled || t.is_template) return null;
  const c = parseDefinition(t.definition).checks.find((x) => x.id === t.check_id);
  return c && c.type === 'heartbeat' && checkEnabled(c) ? c : null;
}

const TARGET = `SELECT c.*, m.name AS monitor_name, m.enabled AS monitor_enabled, m.is_template, m.definition FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id`;

/** POST /api/hooks/monitor/:hookId */
export async function handleHeartbeat(hookId: string, req: MonitorHookRequest): Promise<MonitorHookResponse> {
  if (!/^hb_[A-Za-z0-9_-]{6,40}$/.test(hookId)) return NOT_FOUND;
  const t = db().get<Target>(`${TARGET} WHERE c.hook_id = ?`, hookId);
  const c = heartbeatCheck(t);
  if (!t || !c || !t.secret_hash || !t.secret_enc) return NOT_FOUND;
  const entity = { type: 'monitor' as const, id: t.monitor_id, name: `${t.monitor_name} › ${c.name}` };
  if (!vault().unlocked) return { status: 503, body: { error: 'Service unavailable' } };
  if (!addressAllowed(c.allowedCidrs ?? [], req.ip)) return reject(entity, req.ip, 'source address not allowed', NOT_FOUND);
  if (!authenticated({ auth_mode: c.authMode, secret_hash: t.secret_hash, secret_enc: t.secret_enc }, req)) {
    return reject(entity, req.ip, 'missing or wrong secret', { status: 401, body: { error: 'Unauthorized' } });
  }
  const parsed = parseBody(req);
  if (!parsed.ok) return reject(entity, req.ip, parsed.reason, parsed.res);
  const retry = overLimit(`hb:${hookId}`, c.rateLimitPerMinute ?? 60);
  if (retry !== null)
    return reject(entity, req.ip, 'rate limit exceeded', { status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': String(retry) } });
  const report = normalizeReport(parsed.body);
  if (typeof report === 'string') return reject(entity, req.ip, `invalid report: ${report}`, { status: 400, body: { error: report } });
  store(t, report);
  await withTimeout(engine.evaluateCheck(t.monitor_id, t.check_id), 3000);
  const status = db().get<{ status: MonitorStatus }>(
    'SELECT status FROM monitor_checks WHERE monitor_id = ? AND check_id = ?',
    t.monitor_id,
    t.check_id,
  )?.status;
  return { status: 202, body: { accepted: true, status: status ?? 'unknown' } };
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);
}

function timingSafeHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const header = (h: MonitorHookRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Finds the gateway: by `X-Steward-Gateway: <id>`, else by the hash of the presented token. */
function findGateway(req: MonitorHookRequest): GatewayRow | undefined {
  const id = header(req.headers, 'x-steward-gateway')?.trim();
  if (id) return /^gw_[A-Za-z0-9_-]{6,40}$/.test(id) ? db().get<GatewayRow>('SELECT * FROM monitor_gateways WHERE id = ?', id) : undefined;
  const presented = header(req.headers, 'x-steward-token') ?? /^Bearer\s+(\S+)\s*$/i.exec(header(req.headers, 'authorization') ?? '')?.[1];
  if (!presented || presented.length > 512) return undefined;
  const hash = sha256(presented.trim());
  const g = db().get<GatewayRow>('SELECT * FROM monitor_gateways WHERE secret_hash = ?', hash);
  return g && timingSafeHex(hash, g.secret_hash) ? g : undefined;
}

/** POST /api/hooks/monitors – many reports of one gateway. */
export async function handleGatewayBatch(req: MonitorHookRequest): Promise<MonitorHookResponse> {
  const g = findGateway(req);
  if (!vault().unlocked) return { status: 503, body: { error: 'Service unavailable' } };
  if (!g) {
    // no gateway could be identified: answer like a wrong secret (the endpoint itself exists)
    logger.warn({ ip: req.ip }, 'gateway report without a valid gateway secret');
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  const entity = { type: 'monitor-gateway' as const, id: g.id, name: g.name };
  if (!g.enabled) return reject(entity, req.ip, 'gateway disabled', NOT_FOUND);
  if (!addressAllowed(parseJson(g.allowed_cidrs, []), req.ip)) return reject(entity, req.ip, 'source address not allowed', NOT_FOUND);
  if (!authenticated(g, req)) {
    countGateway(g.id, 'rejected');
    return reject(entity, req.ip, 'missing or wrong secret', { status: 401, body: { error: 'Unauthorized' } });
  }
  const parsed = parseBody(req);
  if (!parsed.ok) {
    countGateway(g.id, 'rejected');
    return reject(entity, req.ip, parsed.reason, parsed.res);
  }
  const retry = overLimit(`gw:${g.id}`, g.rate_limit_per_min);
  if (retry !== null) {
    countGateway(g.id, 'rejected');
    return reject(entity, req.ip, 'rate limit exceeded', { status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': String(retry) } });
  }
  const b = parsed.body as { reports?: unknown } | unknown[];
  const list = Array.isArray(b) ? b : (b as { reports?: unknown }).reports;
  if (!Array.isArray(list))
    return reject(entity, req.ip, 'no reports array', { status: 400, body: { error: 'Expected { "reports": [ … ] } or an array of reports' } });
  if (list.length > HEARTBEAT_MAX_BATCH)
    return reject(entity, req.ip, 'too many reports', { status: 400, body: { error: `At most ${HEARTBEAT_MAX_BATCH} reports per call` } });
  const patterns = parseJson<string[]>(g.allowed_keys, []);
  const rejected: { index: number; key: string | null; reason: string }[] = [];
  const accepted: { key: string; monitorId: string; checkId: string }[] = [];
  // the newest report per key counts
  const latest = new Map<string, HeartbeatReport>();
  list.forEach((x, index) => {
    const r = normalizeReport(x);
    if (typeof r === 'string') return rejected.push({ index, key: null, reason: r });
    if (!r.key?.trim()) return rejected.push({ index, key: null, reason: '"key" is required' });
    const k = r.key.trim().toLowerCase();
    if (!keyAllowed(patterns, k)) return rejected.push({ index, key: r.key, reason: 'key not allowed for this gateway' });
    const prev = latest.get(k);
    if (!prev || Date.parse(String(r.ts ?? '')) >= Date.parse(String(prev.ts ?? '')) || !r.ts) latest.set(k, r);
  });
  // The gateway reports with its owner's rights: only checks of monitors the owner may edit are accepted.
  const owner = findUserByName(g.owner);
  const ownerUser = owner && owner.active ? toAuthUser(owner) : null;
  const evaluations: Promise<void>[] = [];
  for (const [k, r] of latest) {
    const t = db().get<Target>(`${TARGET} WHERE c.heartbeat_key = ?`, k);
    const monitorRow = t ? db().get<{ owner: string; acl: string }>('SELECT owner, acl FROM monitors WHERE id = ?', t.monitor_id) : undefined;
    if (!heartbeatCheck(t) || !monitorRow || !permissionsOfRow(monitorRow, ownerUser).includes('edit')) {
      rejected.push({
        index: list.findIndex(
          (x) =>
            String((x as { key?: string })?.key ?? '')
              .trim()
              .toLowerCase() === k,
        ),
        key: r.key!,
        reason: 'unknown key',
      });
      continue;
    }
    store(t!, r);
    accepted.push({ key: r.key!, monitorId: t!.monitor_id, checkId: t!.check_id });
    const target = t!;
    evaluations.push(
      (async () => {
        const release = await acquireEval();
        try {
          await engine.evaluateCheck(target.monitor_id, target.check_id);
        } finally {
          release();
        }
      })(),
    );
  }
  await withTimeout(Promise.all(evaluations), 5000);
  countGateway(g.id, 'accepted', accepted.length);
  if (rejected.length) countGateway(g.id, 'rejected', rejected.length);
  return { status: 202, body: { accepted: accepted.length, rejected, ts: nowIso() } };
}
