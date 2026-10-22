import crypto from 'node:crypto';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { sha256 } from '../util.js';
import { sourceRow, type SourceRow } from './service.js';
import { fetchSource } from './fetch.js';

/**
 * Inbound webhook of a source: `POST /api/hooks/sync/<sourceId>` – the Git host's push event.
 *
 * Accepted proofs (the secret is the source's webhook secret):
 *   X-Hub-Signature-256: sha256=<hex>   GitHub (and Forgejo/Gitea) – HMAC-SHA256 of the raw body
 *   X-Forgejo-Signature / X-Gitea-Signature: <hex>   Forgejo/Gitea – the same HMAC without prefix
 *   X-Gitlab-Token: <secret>   GitLab – the secret itself (compared as a hash)
 *
 * Unknown, disabled or webhook-less sources answer 404 (nothing leaks). The payload is not trusted
 * beyond the branch name: the fetch reads the repository through the API like any other fetch.
 * Rejections are audited at most once per source and reason every 10 minutes; accepted calls are
 * bounded by the rate limit and audited by the fetch.
 */

export interface SyncHookRequest {
  sourceId: string;
  raw: Buffer | undefined;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}
export interface SyncHookResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const NOT_FOUND: SyncHookResponse = { status: 404, body: { error: 'Not found' } };
const RATE_PER_MINUTE = 12;
const AUDIT_EVERY_MS = 10 * 60000;
const calls = new Map<string, number[]>();
const rejectionAudit = new Map<string, { at: number; suppressed: number }>();

export function resetSyncHookState(): void {
  calls.clear();
  rejectionAudit.clear();
}

const header = (h: SyncHookRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function verifySyncHook(r: Pick<SourceRow, 'webhook_secret_enc' | 'webhook_secret_hash'>, req: Pick<SyncHookRequest, 'headers' | 'raw'>): boolean {
  if (!r.webhook_secret_enc || !r.webhook_secret_hash) return false;
  const gitlab = header(req.headers, 'x-gitlab-token');
  if (gitlab !== undefined) return gitlab.length <= 512 && equalHex(sha256(gitlab.trim()), r.webhook_secret_hash);
  const sig =
    /^sha256=([0-9a-f]{64})$/i.exec(header(req.headers, 'x-hub-signature-256')?.trim() ?? '')?.[1] ??
    /^([0-9a-f]{64})$/i.exec(header(req.headers, 'x-forgejo-signature')?.trim() ?? '')?.[1] ??
    /^([0-9a-f]{64})$/i.exec(header(req.headers, 'x-gitea-signature')?.trim() ?? '')?.[1];
  if (!sig) return false;
  const expected = crypto
    .createHmac('sha256', vault().decrypt<string>(r.webhook_secret_enc))
    .update(req.raw ?? Buffer.alloc(0))
    .digest('hex');
  return equalHex(sig.toLowerCase(), expected);
}

function reject(r: SourceRow, req: SyncHookRequest, reason: string, res: SyncHookResponse): SyncHookResponse {
  const key = `${r.id}|${reason}`;
  const now = Date.now();
  const st = rejectionAudit.get(key);
  if (!st || now - st.at >= AUDIT_EVERY_MS) {
    audit({
      actor: 'webhook',
      action: 'sync.webhook_rejected',
      entityType: 'sync_source',
      entityId: r.id,
      summary: `Git sync "${r.name}" rejected a webhook call from ${req.ip}: ${reason}${st?.suppressed ? ` (${st.suppressed} more since the last entry)` : ''}`,
      details: { reason, sourceIp: req.ip, status: res.status, suppressedSinceLastEntry: st?.suppressed ?? 0 },
    });
    rejectionAudit.set(key, { at: now, suppressed: 0 });
  } else st.suppressed++;
  logger.warn({ sourceId: r.id, reason, ip: req.ip, status: res.status }, 'git sync webhook rejected');
  return res;
}

function overRateLimit(id: string): number | null {
  const now = Date.now();
  const list = (calls.get(id) ?? []).filter((t) => now - t < 60000);
  if (list.length >= RATE_PER_MINUTE) {
    calls.set(id, list);
    return Math.max(1, Math.ceil((60000 - (now - list[0]!)) / 1000));
  }
  list.push(now);
  calls.set(id, list);
  return null;
}

export function handleSyncHook(req: SyncHookRequest): SyncHookResponse {
  const r = sourceRow(req.sourceId);
  if (!r || !r.enabled || !r.webhook_enabled) return NOT_FOUND;
  if (!vault().unlocked) return { status: 503, body: { error: 'Service unavailable' } };
  if (!verifySyncHook(r, req)) return reject(r, req, 'missing or wrong signature', { status: 401, body: { error: 'Unauthorized' } });
  const retryAfter = overRateLimit(r.id);
  if (retryAfter !== null)
    return reject(r, req, 'rate limit exceeded', { status: 429, body: { error: 'Too many requests' }, headers: { 'retry-after': String(retryAfter) } });
  const event =
    header(req.headers, 'x-github-event') ??
    header(req.headers, 'x-gitea-event') ??
    header(req.headers, 'x-forgejo-event') ??
    header(req.headers, 'x-gitlab-event');
  if (event === 'ping') return { status: 200, body: { ok: true } };
  let ref: unknown;
  try {
    ref = req.raw?.length ? (JSON.parse(req.raw.toString('utf8')) as { ref?: unknown }).ref : undefined;
  } catch {
    return reject(r, req, 'invalid JSON', { status: 400, body: { error: 'Invalid JSON' } });
  }
  if (typeof ref === 'string' && ref !== `refs/heads/${r.branch}`) return { status: 202, body: { skipped: 'other branch' } };
  void fetchSource(r.id, 'webhook', 'webhook').catch((e) => logger.warn({ sourceId: r.id, err: (e as Error).message }, 'git sync webhook fetch failed'));
  return { status: 202, body: { fetching: true } };
}
