/**
 * Request rate limits of the web app's API (/api), the inbound webhooks and the web UI's files,
 * with @fastify/rate-limit (registered once on the root app, see app.ts).
 *
 * - Who is counted: the signed-in user (session or API token) – `user:<id>` – otherwise the client
 *   address (`ip:<address>`, IPv6 by /64; behind a proxy only with SM_TRUST_PROXY). The limiter runs
 *   as a route `preHandler`, i.e. after the session check in app.ts, so made-up session cookies
 *   or tokens never get a bucket of their own: they count against the address. Requests the session
 *   check refuses (401) count against the address too (`countRefused`).
 * - How much: SM_RATE_LIMIT_PER_MINUTE (default 600) requests per minute and key; `0`/`off` = no limits.
 *   Expensive actions have lower limits of their own (ROUTE_LIMITS, a separate bucket per route).
 *   The web UI's files and start-up requests of people not signed in (`web:<address>`) and inbound
 *   webhooks get ten times the general limit per address: a browser with an empty cache fetches
 *   dozens of files per page, and several people can share one address.
 * - Not counted here: the public API (/api/v1) and the MCP endpoint (own per-token limiters),
 *   health and readiness probes, and the demo's mock platforms.
 * - Counters live in memory, per server process (a fixed one-minute window); they reset on restart.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normalizeIP, type RateLimitOptions, type RateLimitPluginOptions } from '@fastify/rate-limit';
import { logger } from './log.js';
import { HttpError } from './util.js';

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
const WINDOW_MS = 60_000;
/** Web UI files and inbound webhooks: an address bucket of this many times the general limit. */
const ADDRESS_FACTOR = 10;

const OFF = ['off', '0', 'false', 'no', 'disabled'];
const warned = new Set<string>();

/** Requests per minute and user or address (SM_RATE_LIMIT_PER_MINUTE, default 600; 0 or "off" = no limits). */
export function rateLimitPerMinute(): number {
  const raw = process.env.SM_RATE_LIMIT_PER_MINUTE?.trim().toLowerCase();
  if (!raw) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (OFF.includes(raw)) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    if (!warned.has(raw)) {
      warned.add(raw);
      logger.warn(`SM_RATE_LIMIT_PER_MINUTE="${raw}" is not a whole number – using ${DEFAULT_RATE_LIMIT_PER_MINUTE}`);
    }
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  return n;
}

/** The signed-in user of a request, set by the session check in app.ts. */
const subjects = new WeakMap<FastifyRequest, string>();
export function setRateLimitUser(req: FastifyRequest, userId: string | undefined): void {
  if (userId) subjects.set(req, userId);
}

/** `user:<id>` for signed-in users, else `web:<address>` for the web UI's files, else `ip:<address>`. */
export function rateLimitKey(req: FastifyRequest, webUi: (req: FastifyRequest) => boolean = () => false): string {
  const user = subjects.get(req);
  if (user) return `user:${user}`;
  return `${webUi(req) ? 'web' : 'ip'}:${normalizeIP(req.ip)}`;
}

/** Requests answered 429 by these limits (the access log does not warn about each of them). */
const limited = new WeakSet<FastifyRequest>();
export const wasRateLimited = (req: FastifyRequest): boolean => limited.has(req);

/** One log line per key, limit and window – not one per refused request. */
const loggedUntil = new Map<string, number>();
function exceeded(limit: string) {
  return (req: FastifyRequest, key: string) => {
    limited.add(req);
    const now = Date.now();
    const id = `${limit}|${key}`;
    if ((loggedUntil.get(id) ?? 0) > now) return;
    if (loggedUntil.size > 10_000) for (const [k, until] of loggedUntil) if (until <= now) loggedUntil.delete(k);
    loggedUntil.set(id, now + WINDOW_MS);
    logger.warn({ reqId: req.id, key, limit, method: req.method, route: req.routeOptions.url ?? req.url.split('?')[0] }, 'rate limit reached');
  };
}

const errorResponse: RateLimitOptions['errorResponseBuilder'] = (_req, ctx) => {
  const seconds = Math.max(1, Math.ceil(ctx.ttl / 1000));
  return new HttpError(ctx.statusCode, `Too many requests – try again in ${seconds} s`, 'RATE_LIMITED', { context: 'wait', seconds });
};

/**
 * Options of the root registration. `exempt`: requests never counted here; `webUi`: the web UI's
 * files and start-up requests, counted per address with the higher limit.
 */
export function rateLimitOptions(opts: { exempt: (req: FastifyRequest) => boolean; webUi: (req: FastifyRequest) => boolean }): RateLimitPluginOptions {
  const { exempt, webUi } = opts;
  return {
    global: true,
    hook: 'preHandler',
    timeWindow: WINDOW_MS,
    max: (_req, key) => rateLimitPerMinute() * (key.startsWith('web:') ? ADDRESS_FACTOR : 1),
    keyGenerator: (req) => rateLimitKey(req, webUi),
    allowList: (req) => rateLimitPerMinute() === 0 || exempt(req),
    // RateLimit-Limit/-Remaining/-Reset (and Retry-After on 429), as on /api/v1
    enableDraftSpec: true,
    errorResponseBuilder: errorResponse,
    onExceeded: exceeded('general'),
  };
}

/** A lower limit of its own for a route (per user or address and minute; off with the general limit). */
const routeLimit = (name: string, max: RateLimitOptions['max']): RateLimitOptions => ({ max, timeWindow: WINDOW_MS, onExceeded: exceeded(name) });

/**
 * Per-route limits (`config: { rateLimit: ROUTE_LIMITS.heavy }`). Each route counts on its own and
 * not against the general limit. Generous for people, tight enough to stop a script hammering them.
 */
export const ROUTE_LIMITS = {
  /** PDF/report rendering, evidence packs, bundle and audit exports, imports, audit verification, clean-up */
  heavy: routeLimit('heavy', 30),
  /** Starting runs and checks, tests and fetches that call out to platforms or send messages */
  action: routeLimit('action', 120),
  /** Password and master passphrase changes (deliberately slow key derivation) */
  credential: routeLimit('credential', 10),
  /** Inbound webhooks: machine traffic, per address; triggers, heartbeats and gateways have their own limits too */
  webhook: routeLimit('webhook', () => rateLimitPerMinute() * ADDRESS_FACTOR),
} satisfies Record<string, RateLimitOptions>;

/**
 * For the session check in app.ts: a request it refuses (401) counts against the client address,
 * so made-up session cookies or tokens cannot be tried without limit. `limit` is fastify.rateLimit()
 * (the root limiter); calls `refuse` when the request is within the limit, else ends it with 429.
 */
export function countRefused(
  limit: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
  refuse: () => void,
): void {
  limit(req, reply).then(refuse, (err: Error) => done(err));
}
