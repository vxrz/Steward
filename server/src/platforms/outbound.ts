import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import type { LookupFunction } from 'node:net';
import { fetch, type Dispatcher } from 'undici';
import type { Platform } from '@sm/shared';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { HttpError } from '../util.js';
import { logger } from '../log.js';

/**
 * Outbound destination policy (SSRF protection) and secret-egress scanning.
 *
 * Every request a *process* controls – the http node, pagination, browser
 * navigation and sub-requests, OpenAPI import by URL – is checked here before
 * it is sent. The module is deliberately free of engine/run state so other
 * features (e.g. Monitors) can reuse the exact same policy.
 *
 * Two independent layers:
 *   1. Origin policy (configurable): which hosts a process may reach at all.
 *   2. Address safety (always on): cloud-metadata / link-local addresses and
 *      the server's own listening port are never reachable, and the resolved
 *      IP is pinned for the connection so DNS cannot be rebound afterwards.
 */

// ---------------------------------------------------------------------------
// Always-denied addresses (independent of the configured policy)
// ---------------------------------------------------------------------------

/** A host name of a URL without the brackets of an IPv6 literal (WHATWG URL keeps them in `hostname`). */
export function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** An IPv4 subnet in the IPv6 forms that embed an IPv4 address in their last 32 bits: NAT64 (64:ff9b::/96), IPv4-compatible (::/96). */
function embeddedV4(list: net.BlockList, v4: string, prefix: number): void {
  const o = v4.split('.').map(Number);
  const hex = `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  list.addSubnet(`64:ff9b::${hex}`, 96 + prefix, 'ipv6');
  list.addSubnet(`::${hex}`, 96 + prefix, 'ipv6');
}

/**
 * Addresses that are never reachable, by class (0.9.0: every literal form – IPv4, IPv6, IPv4-mapped ::ffff:a.b.c.d in
 * the dotted and the hex form the URL parser writes, NAT64 and IPv4-compatible – is classified with net.BlockList, which
 * checks IPv4-mapped IPv6 addresses against the IPv4 rules itself).
 */
const BLOCKED: { reason: string; list: net.BlockList }[] = (() => {
  const metadata = new net.BlockList();
  metadata.addAddress('100.100.100.200', 'ipv4');
  embeddedV4(metadata, '100.100.100.200', 32);
  metadata.addAddress('fd00:ec2::254', 'ipv6');
  const linkLocal = new net.BlockList();
  linkLocal.addSubnet('169.254.0.0', 16, 'ipv4');
  embeddedV4(linkLocal, '169.254.0.0', 16);
  linkLocal.addSubnet('fe80::', 10, 'ipv6');
  return [
    { reason: 'cloud metadata address', list: metadata },
    { reason: 'link-local / cloud metadata address (169.254.0.0/16, fe80::/10)', list: linkLocal },
  ];
})();

/** This machine: loopback (127.0.0.0/8, ::1) and unspecified (0.0.0.0/8, ::) – each also IPv4-mapped. */
const LOCAL = (() => {
  const l = new net.BlockList();
  l.addSubnet('127.0.0.0', 8, 'ipv4');
  l.addSubnet('0.0.0.0', 8, 'ipv4');
  l.addAddress('::1', 'ipv6');
  l.addAddress('::', 'ipv6');
  return l;
})();

/** An address literal without zone id and brackets, and its family (0: not an address). */
function literal(ipRaw: string): { ip: string; family: 0 | 4 | 6 } {
  const ip = bareHost(ipRaw.trim()).replace(/%.*$/, '');
  const v = net.isIP(ip);
  return { ip, family: v === 4 ? 4 : v === 6 ? 6 : 0 };
}

/** A reason string if this resolved IP must never be reached, else null. */
export function blockedAddressReason(ipRaw: string): string | null {
  const { ip, family } = literal(ipRaw);
  if (!family) return null;
  if (ip.toLowerCase() === 'fd00:ec2::254') return 'cloud metadata address (fd00:ec2::254)';
  for (const b of BLOCKED) if (b.list.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return b.reason;
  return null;
}

/** Loopback, unspecified (0.0.0.0, ::) – also IPv4-mapped – or an address of one of this machine's interfaces. */
export function isLocalAddress(ipRaw: string): boolean {
  const { ip, family } = literal(ipRaw);
  if (!family) return false;
  if (LOCAL.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return true;
  const mine = new net.BlockList();
  for (const a of Object.values(os.networkInterfaces()).flat()) {
    if (!a) continue;
    const own = literal(a.address);
    if (own.family) mine.addAddress(own.ip, own.family === 4 ? 'ipv4' : 'ipv6');
  }
  return mine.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether a URL's path is this Steward server's own API surface (below the base path; not the public health checks). */
function isOwnApiPath(u: URL): boolean {
  // Decoded (the router decodes too: /%61pi/… is /api/…) and below the base path (SM_BASE_PATH), where the API lives then.
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return true; // malformed escapes: refuse rather than guess what the server would route
  }
  const base = config.basePath;
  if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length) || '/';
  // The public liveness/readiness endpoints expose nothing and are legitimate to monitor;
  // everything else under /api (and /metrics) is the self-SSRF surface and stays blocked.
  if (/^\/api\/(health|ready)\/?$/i.test(p)) return false;
  return /^\/+(api|metrics)(\/|$)/i.test(p);
}

/**
 * True when a URL points at this Steward server's own API on its port: the host is `localhost`, or one of its
 * addresses (the literal, or what the name resolves to) is loopback, unspecified or one of this machine's (0.9.0: also
 * [::1], [::ffff:127.0.0.1], 0.0.0.0 and names that resolve there). We block the server's own `/api` surface
 * (self-SSRF / pivoting) but not other paths on the same port, because the demo/tests serve mock platforms from the
 * same port under `/mock`.
 */
function isOwnServerApi(u: URL, addresses: string[]): boolean {
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (port !== config.port) return false;
  const h = bareHost(u.hostname).toLowerCase().replace(/\.$/, '');
  const local = h === 'localhost' || h.endsWith('.localhost') || addresses.some(isLocalAddress);
  return local && isOwnApiPath(u);
}

// ---------------------------------------------------------------------------
// DNS resolution + pinning (defuses DNS rebinding)
// ---------------------------------------------------------------------------

/**
 * A node `lookup` that resolves a host, rejects any resolved cloud-metadata /
 * link-local address, and pins the result. Used as undici's `connect.lookup`
 * so the socket connects to exactly the address we validated.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const literal = net.isIP(hostname);
  if (literal) {
    const reason = blockedAddressReason(hostname);
    if (reason) return callback(Object.assign(new Error(`Blocked outbound request to ${reason}`), { code: 'ESSRFBLOCKED' }), '', literal);
    return callback(null, hostname, literal);
  }
  dns.lookup(hostname, { all: true, verbatim: true }).then(
    (addrs) => {
      for (const a of addrs) {
        const reason = blockedAddressReason(a.address);
        if (reason)
          return callback(
            Object.assign(new Error(`Blocked outbound request to ${hostname} – it resolves to a ${reason}`), { code: 'ESSRFBLOCKED' }),
            '',
            a.family,
          );
      }
      const first = addrs[0];
      if (!first) return callback(new Error(`Could not resolve ${hostname}`), '', 4);
      // Return every resolved address so undici may fail over, but each has been checked.
      if ((options as { all?: boolean })?.all) return (callback as unknown as (e: Error | null, a: typeof addrs) => void)(null, addrs);
      callback(null, first.address, first.family);
    },
    (e) => callback(e as Error, '', 4),
  );
};

/** The address a connection to `host` may use: resolved and checked like guardedLookup does (literals as they are). */
export function checkedAddress(host: string): Promise<string> {
  return new Promise((resolve, reject) =>
    guardedLookup(host, {}, (err, address) => (err ? reject(err) : resolve(typeof address === 'string' ? address : String(address)))),
  );
}

// ---------------------------------------------------------------------------
// Origin policy
// ---------------------------------------------------------------------------

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Cache of a platform's resolved base-URL origin, keyed by id+updatedAt (so it refreshes on change). */
const originCache = new Map<string, { stamp: string; origin: string | undefined }>();

/** Resolve the configured platforms' allowed origins (base URL origin + trusted origins). */
async function platformOrigins(
  platforms: () => Promise<Platform[]> | Platform[],
  resolveOrigin: (p: Platform) => Promise<string | undefined>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const live = await platforms();
  const seen = new Set(live.map((p) => p.id));
  for (const id of originCache.keys()) if (!seen.has(id)) originCache.delete(id);
  for (const p of live) {
    const stamp = p.updatedAt ?? '';
    let hit = originCache.get(p.id);
    if (!hit || hit.stamp !== stamp) {
      const base = await resolveOrigin(p).catch(() => undefined); // no base URL (e.g. a variable is missing): the platform adds no origin
      hit = { stamp, origin: base ? (originOf(base) ?? undefined) : undefined };
      originCache.set(p.id, hit);
    }
    if (hit.origin) out.add(hit.origin);
    for (const t of p.config.http?.trustedOrigins ?? []) {
      const o = originOf(t);
      if (o) out.add(o);
    }
  }
  return out;
}

/** Does an allow-list entry (origin, host, host glob or CIDR) match this URL? */
export function allowListMatches(entry: string, url: URL): boolean {
  const e = entry.trim();
  if (!e) return false;
  // Full origin
  if (/^https?:\/\//i.test(e)) return originOf(e) === url.origin;
  // CIDR (only meaningful for IP literal hosts)
  if (e.includes('/') && net.isIP(e.split('/')[0]!)) return cidrMatches(e, url.hostname);
  // Host or host glob (*.example.com), optional :port
  const [hostPart, portPart] = e.split(':');
  if (portPart && portPart !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
  const host = url.hostname.toLowerCase();
  const pat = hostPart!.toLowerCase();
  if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
  return host === pat;
}

function cidrMatches(cidr: string, hostname: string): boolean {
  const host = literal(hostname);
  if (!host.family) return false;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const family = net.isIP(range!);
  if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
  // net.BlockList also matches an IPv4-mapped IPv6 host against an IPv4 range (0.9.0)
  const list = new net.BlockList();
  list.addSubnet(range!, bits, family === 4 ? 'ipv4' : 'ipv6');
  return list.check(host.ip, host.family === 4 ? 'ipv4' : 'ipv6');
}

export interface OutboundContext {
  /** All configured platforms (for the 'platforms' policy). */
  platforms: () => Promise<Platform[]> | Platform[];
  /** Resolve a platform's effective base URL (templates expanded). */
  resolveOrigin: (p: Platform) => Promise<string | undefined>;
}

/**
 * Address-safety that applies whatever the policy and whatever the caller (also
 * the browser, whose requests do not go through our undici dispatcher): the
 * cloud-metadata / link-local ranges and the server's own port are never
 * reachable. Host names are resolved and every resolved address is checked.
 */
export async function assertAddressSafe(url: string): Promise<void> {
  const u = originOf(url) ? new URL(url) : null;
  if (!u) throw new HttpError(400, `Invalid outbound URL "${String(url).slice(0, 120)}"`);
  const host = bareHost(u.hostname);
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new HttpError(403, `Blocked: request to a ${reason}`);
    if (isOwnServerApi(u, [host])) throw new HttpError(403, 'Blocked: a process may not call the Steward server itself');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    addrs = []; // unresolvable – the request will simply fail (a name like localhost is still checked)
  }
  if (
    isOwnServerApi(
      u,
      addrs.map((a) => a.address),
    )
  )
    throw new HttpError(403, 'Blocked: a process may not call the Steward server itself');
  for (const a of addrs) {
    const reason = blockedAddressReason(a.address);
    if (reason) throw new HttpError(403, `Blocked: ${host} resolves to a ${reason}`);
  }
}

/**
 * The address check of an IP literal alone (no DNS): for requests whose names the pinning lookup (guardedLookup) checks
 * when it connects – it is never asked for a literal, so a literal is checked here, before anything is sent.
 */
export function assertLiteralAddressSafe(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return; // reported by fetch
  }
  const host = bareHost(u.hostname);
  if (!net.isIP(host)) return;
  const reason = blockedAddressReason(host);
  if (reason) throw Object.assign(new HttpError(403, `Blocked: request to a ${reason}`), { retryable: false });
}

/** The origin policy alone (no address safety): the policy `open`, the allow-list or – under `platforms` – a platform's origin. */
async function policyAllows(u: URL, ctx: OutboundContext, opts: { platformOrigins?: string[] }): Promise<boolean> {
  const settings = getSettings();
  const policy = settings.outboundPolicy ?? 'platforms';
  if (policy === 'open') return true;

  const allowList = settings.outboundAllowList ?? [];
  if (allowList.some((e) => allowListMatches(e, u))) return true;

  if (policy === 'platforms') {
    // origins that belong to a platform for this one call (an AWS service endpoint a step names, v0.3.1)
    if (opts.platformOrigins?.some((o) => originOf(o) === u.origin)) return true;
    const origins = await platformOrigins(ctx.platforms, ctx.resolveOrigin);
    if (origins.has(u.origin)) return true;
  }
  return false;
}

/**
 * Throw a clear HttpError if a process may not send a request to `url` under the
 * current policy. Always rejects the metadata ranges and the server's own port.
 * `platformOrigins`: further origins that count as a platform's own for this call
 * (policy `platforms` only), e.g. the AWS endpoint an http step names with `aws`.
 */
export async function assertOutboundAllowed(url: string, ctx: OutboundContext, opts: { platformOrigins?: string[] } = {}): Promise<void> {
  const u = originOf(url) ? new URL(url) : null;
  if (!u) throw new HttpError(400, `Invalid outbound URL "${String(url).slice(0, 120)}"`);

  await assertAddressSafe(url);
  if (await policyAllows(u, ctx, opts)) return;
  throw new HttpError(
    403,
    `Blocked by the outbound policy: ${u.origin} is not a configured platform or on the allow-list. ` +
      `An administrator can allow it under Settings → Outbound access (outboundAllowList).`,
  );
}

/** The port a URL connects to (its default when it names none). */
function portOf(u: URL): string {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/**
 * A redirect that stays where the request already went: the same origin as one of the URLs sent so far, or the same
 * host from http to https (on the default https port or the same port). It is not checked against the policy again –
 * the first request was – but address safety still applies (the server's own API is a path, not an origin).
 */
function staysWhereSent(target: URL, sent: string[]): boolean {
  return sent.some((s) => {
    const from = originOf(s) ? new URL(s) : null;
    if (!from) return false;
    if (from.origin === target.origin) return true;
    return (
      from.protocol === 'http:' &&
      target.protocol === 'https:' &&
      from.hostname.toLowerCase() === target.hostname.toLowerCase() &&
      (!target.port || portOf(target) === portOf(from))
    );
  });
}

/** Whether a redirect target stays where the request already went (staysWhereSent) – for callers that keep a body there. */
export function sameDestination(target: string, sent: string[]): boolean {
  const u = originOf(target) ? new URL(target) : null;
  return !!u && staysWhereSent(u, sent);
}

/**
 * The parts of a webhook URL that carry its credential (a Teams Workflows signature `sig=…`, a Slack-style
 * `/services/T…/B…/<token>` path): the URL itself, query values of 8+ characters and path segments of 16+ characters.
 */
export function urlSecrets(url: string): string[] {
  const out = [url];
  try {
    const u = new URL(url);
    for (const v of u.searchParams.values()) if (v.length >= 8) out.push(v);
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) out.push(decodeURIComponent(seg));
  } catch {
    /* not a URL: the string itself */
  }
  return out;
}

/** A request body as the text that is sent (or a superset of it): what the redirect body check searches. */
function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof URLSearchParams) return body.toString();
  try {
    return JSON.stringify(body) ?? '';
  } catch {
    return String(body);
  }
}

/**
 * A 307/308 redirect sends the request body again, to the redirect target (0.9.0, #243). When the target is not where
 * the credentials may go (the platform's own origins) and not where the request already went, the body must not carry
 * one of the credentials – in clear text or a simple encoding (secretEncodings). Throws a 403 that is not retried,
 * before anything is sent there.
 */
export function assertRedirectBodyClean(body: unknown, values: string[], hop: { from: string; to: string; status: number; platformName?: string }): void {
  const text = bodyText(body);
  if (!text || !values.length) return;
  const leaks = values.some((v) => typeof v === 'string' && secretEncodings(v).some((enc) => text.includes(enc)));
  if (!leaks) return;
  const from = originOf(hop.from) ?? 'the server';
  const to = originOf(hop.to) ?? hop.to.slice(0, 120);
  logger.warn(
    { from, to, status: hop.status, platform: hop.platformName },
    'redirect refused: it would send a credential in the request body to another origin',
  );
  const whose = hop.platformName ? `a credential of platform "${hop.platformName}"` : 'a credential';
  throw Object.assign(
    new HttpError(
      403,
      `Blocked: ${from} redirected (HTTP ${hop.status}) to ${to}, which would receive the request body again – and the body contains ${whose}. ` +
        `Nothing was sent there.${hop.platformName ? ` If ${to} belongs to the platform, add it to its trusted origins.` : ''}`,
      'REDIRECT_BODY_SECRET',
      { from, to, status: hop.status },
    ),
    { retryable: false },
  );
}

/**
 * The outbound policy for a redirect hop (0.9.0, #243): every redirect target is checked with the same rules as the
 * first request, not only the first URL. `sent`: the URLs of this request sent so far (the first one first) – a
 * redirect that stays on their origins (or goes from http to https on the same host) passes; `own`: the target is one
 * of the platform's own origins (base URL, trusted origins, AWS endpoints – where its credentials go), which counts as
 * allowed exactly as for the first request. Address safety applies to every hop. A refused hop throws a 403 that is
 * not retried and names the target and how to allow it.
 */
export async function assertRedirectAllowed(
  target: string,
  sent: string[],
  ctx: OutboundContext,
  opts: { own?: boolean; platformName?: string; platformOrigins?: string[] } = {},
): Promise<void> {
  const u = originOf(target) ? new URL(target) : null;
  if (!u) throw new HttpError(400, `Invalid redirect target "${String(target).slice(0, 120)}"`);
  await assertAddressSafe(target);
  if (opts.own || staysWhereSent(u, sent) || (await policyAllows(u, ctx, opts))) return;
  const from = originOf(sent[sent.length - 1] ?? '') ?? 'the server';
  const how = opts.platformName
    ? `An administrator can allow it under Settings → Outbound access (outboundAllowList), or add it to the trusted origins of platform "${opts.platformName}" (its credentials are then sent there too).`
    : 'An administrator can allow it under Settings → Outbound access (outboundAllowList).';
  logger.warn({ from, to: u.origin, platform: opts.platformName }, 'redirect refused by the outbound policy');
  throw Object.assign(
    new HttpError(
      403,
      `Blocked by the outbound policy: ${from} redirected to ${u.origin}, which is not a configured platform or on the allow-list. ${how}`,
      opts.platformName ? 'PLATFORM_REDIRECT_BLOCKED' : 'OUTBOUND_REDIRECT_BLOCKED',
      { from, to: u.origin, ...(opts.platformName ? { platform: opts.platformName } : {}) },
    ),
    { retryable: false },
  );
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch for a request to one URL without a platform (a monitor's webhook output, an OpenAPI import by URL): follows up
 * to `maxRedirects` redirects itself and checks every target with assertRedirectAllowed (0.9.0, #243), as fetch's own
 * `redirect: 'follow'` would not. The caller checks the first URL. 301/302 of a POST and every 303 continue as a GET
 * without body, 307/308 keep method and body (as fetch does) – but not to another origin when the body contains one of
 * `bodySecrets` (assertRedirectBodyClean).
 */
export async function fetchCheckingRedirects(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; dispatcher?: Dispatcher; signal?: AbortSignal },
  ctx: OutboundContext,
  opts: { maxRedirects?: number; bodySecrets?: string[] } = {},
): Promise<Awaited<ReturnType<typeof fetch>>> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let method = init.method ?? 'GET';
  let body = init.body;
  const sent: string[] = [];
  for (let hop = 0; ; hop++) {
    sent.push(url);
    const res = await fetch(url, { ...init, method, body, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT_CODES.has(res.status) || !location) return res;
    await res.body?.cancel().catch(() => undefined); // a redirect's body is not read: a failed cancel changes nothing
    if (hop >= maxRedirects) throw new HttpError(502, `Too many redirects (more than ${maxRedirects}) starting at ${originOf(sent[0]!) ?? 'the URL'}`);
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new HttpError(502, `Invalid redirect target from ${originOf(url) ?? 'the server'}`);
    }
    await assertRedirectAllowed(next, sent, ctx);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    // 307/308 send the body again: not with a credential in it to another origin
    if (body !== undefined && !sameDestination(next, sent)) assertRedirectBodyClean(body, opts.bodySecrets ?? [], { from: url, to: next, status: res.status });
    url = next;
  }
}

/**
 * Policy for a raw host:port target (monitor tcp/ping checks, Zabbix sender) that
 * has no URL scheme. Always rejects metadata/link-local and the server's own port.
 * A bare host:port is NOT matched against a platform's base-URL origin (that would
 * let a platform on a host enable port-scanning of it): internal hosts (e.g. plant
 * PowerMeters) must be allow-listed explicitly by IP/host/CIDR. `ctx` is accepted
 * for symmetry/future use.
 */
export async function assertNetAllowed(host: string, port: number, _ctx: OutboundContext): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, '');
  const synthetic = `http://${net.isIP(bare) === 6 ? `[${bare}]` : bare}${port ? `:${port}` : ''}`;
  let u: URL;
  try {
    u = new URL(synthetic);
  } catch {
    throw new HttpError(400, `Invalid host "${String(host).slice(0, 120)}"`);
  }
  await assertAddressSafe(u.toString());

  const settings = getSettings();
  const policy = settings.outboundPolicy ?? 'platforms';
  if (policy === 'open') return;
  if ((settings.outboundAllowList ?? []).some((e) => allowListMatches(e, u))) return;

  throw new HttpError(
    403,
    `Blocked by the outbound policy: ${host}${port ? `:${port}` : ''} is not on the allow-list. ` +
      `An administrator can allow it (e.g. its IP or CIDR) under Settings → Outbound access (outboundAllowList).`,
  );
}

// ---------------------------------------------------------------------------
// Secret egress scanning (F2)
// ---------------------------------------------------------------------------

/** The simple encodings a secret value might be hidden behind on the way out. */
export function secretEncodings(value: string): string[] {
  if (!value || value.length < 4) return [];
  const out = new Set<string>([value]);
  try {
    out.add(Buffer.from(value, 'utf8').toString('base64'));
    out.add(Buffer.from(value, 'utf8').toString('base64url'));
  } catch {
    /* not encodable: the other forms still count */
  }
  try {
    const uri = encodeURIComponent(value);
    const form = new URLSearchParams({ a: value }).toString().slice(2); // x-www-form-urlencoded: also ~ ! ' ( ) escaped, space as +
    const pct = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
    // encodeURIComponent, with + for spaces, encodeURI, RFC 3986 strict (! ' ( ) * escaped), URLSearchParams (+ and %20) …
    for (const v of [uri, uri.replace(/%20/g, '+'), encodeURI(value), uri.replace(/[!'()*]/g, pct), form, form.replace(/\+/g, '%20')]) {
      out.add(v);
      out.add(v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())); // … and each with lowercase hex digits
    }
  } catch {
    /* ignore (lone surrogates) */
  }
  // JSON string escaping (quotes stripped so it matches inside a larger body)
  const j = JSON.stringify(value);
  out.add(j.slice(1, -1));
  return [...out].filter((v) => v.length >= 4);
}

/** Secret values worth scanning for on the way out (length ≥ 5 to avoid noise). */
export function egressSecretValues(secrets: Record<string, string>): string[] {
  return Object.values(secrets).filter((v) => typeof v === 'string' && v.length >= 5);
}

export interface SecretBinding {
  /** Human name for the error message. */
  platformName: string;
  /** Secret values that belong to this platform. */
  values: string[];
  /** Whether this platform's secrets may be sent to the given URL (origin check). */
  allowed: (url: string) => Promise<boolean> | boolean;
  /**
   * The binding is not the one the request is sent with (0.9.0): its secrets may not be in the request at all, wherever
   * it goes – a platform's credentials only travel in requests through its own connection. `slot`: its connection in
   * the process, `sender`: the connection the request is sent with (null: none, e.g. a browser step without one).
   */
  foreign?: { slot: string; sender: string | null };
}

/** Flatten a request into text the scanner searches (URL, header names+values, body). */
function requestText(url: string, headers: Record<string, string>, body: unknown): string {
  const parts = [url];
  for (const [k, v] of Object.entries(headers)) parts.push(k, String(v));
  if (body !== undefined && body !== null) parts.push(typeof body === 'string' ? body : JSON.stringify(body));
  return parts.join('\n');
}

/**
 * Fail (throw HttpError) if any bound platform's secret value – in clear text or
 * a simple encoding – would be sent to a URL that platform does not allow.
 */
export async function assertNoSecretLeak(url: string, headers: Record<string, string>, body: unknown, bindings: SecretBinding[]): Promise<void> {
  if (!bindings.length) return;
  const haystack = requestText(url, headers, body);
  for (const b of bindings) {
    if (!b.foreign && (await b.allowed(url))) continue;
    for (const value of b.values) {
      for (const enc of secretEncodings(value)) {
        if (haystack.includes(enc)) {
          if (b.foreign) {
            const { slot, sender } = b.foreign;
            logger.warn({ platform: b.platformName, slot, sender, origin: originOf(url) }, "blocked a request that carried another connection's secret");
            throw Object.assign(
              new HttpError(
                403,
                `Blocked: this request ${sender ? `on connection "${sender}"` : 'without a connection'} contains a credential of connection "${slot}" (platform "${b.platformName}"). ` +
                  `A platform's credentials may only be used in requests sent through its own connection – send the request on connection "${slot}".`,
                'SECRET_OTHER_SLOT',
                { slot, sender: sender ?? '', platform: b.platformName },
              ),
              { retryable: false },
            );
          }
          logger.warn({ platform: b.platformName, origin: originOf(url) }, 'blocked a request that would have leaked a platform secret to another origin');
          throw new HttpError(
            403,
            `Blocked: this request would send a secret of platform "${b.platformName}" to ${originOf(url) ?? url}, ` +
              `which is not one of its allowed origins. Secrets may only be sent to the platform itself (base URL origin or its trusted origins).`,
          );
        }
      }
    }
  }
}
