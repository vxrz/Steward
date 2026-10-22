import dns from 'node:dns/promises';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
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

/** Normalise an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its IPv4 form. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** A reason string if this resolved IP must never be reached, else null. */
export function blockedAddressReason(ipRaw: string): string | null {
  const ip = unmap(ipRaw.replace(/%.*$/, '')); // drop any zone id
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    // 169.254.0.0/16 – link-local incl. 169.254.169.254 (cloud metadata)
    if (o[0] === 169 && o[1] === 254) return 'link-local / cloud metadata address (169.254.0.0/16)';
    // Alibaba/other metadata service
    if (ip === '100.100.100.200') return 'cloud metadata address (100.100.100.200)';
    return null;
  }
  if (v === 6) {
    const lc = ip.toLowerCase();
    if (lc.startsWith('fe80') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb')) return 'link-local IPv6 address (fe80::/10)';
    if (lc === 'fd00:ec2::254') return 'cloud metadata address (fd00:ec2::254)';
    return null;
  }
  return null;
}

/**
 * True when a URL points at this Steward server's own API on its loopback port.
 * We block the server's own `/api` surface (self-SSRF / pivoting) but not other
 * paths on the same port, because the demo/tests serve mock platforms from the
 * same port under `/mock`.
 */
function isOwnServerApi(u: URL): boolean {
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (port !== config.port) return false;
  const h = unmap(u.hostname).toLowerCase();
  const loopback = h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
  if (!loopback) return false;
  return /^\/(api|metrics)(\/|$)/i.test(u.pathname);
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
        if (reason) return callback(Object.assign(new Error(`Blocked outbound request to ${hostname} – it resolves to a ${reason}`), { code: 'ESSRFBLOCKED' }), '', a.family);
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

/** Resolve the configured platforms' allowed origins (base URL origin + trusted origins). */
async function platformOrigins(platforms: () => Promise<Platform[]> | Platform[], resolveOrigin: (p: Platform) => Promise<string | undefined>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of await platforms()) {
    const base = await resolveOrigin(p).catch(() => undefined);
    if (base) {
      const o = originOf(base);
      if (o) out.add(o);
    }
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

function cidrMatches(cidr: string, host: string): boolean {
  if (net.isIP(host) === 0) return false;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (net.isIP(range!) === 4 && net.isIP(host) === 4) {
    const toInt = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(range!) & mask) === (toInt(host) & mask);
  }
  return false;
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
  if (isOwnServerApi(u)) throw new HttpError(403, 'Blocked: a process may not call the Steward server itself');
  if (net.isIP(u.hostname)) {
    const reason = blockedAddressReason(u.hostname);
    if (reason) throw new HttpError(403, `Blocked: request to a ${reason}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch {
    return; // unresolvable – the request will simply fail
  }
  for (const a of addrs) {
    const reason = blockedAddressReason(a.address);
    if (reason) throw new HttpError(403, `Blocked: ${u.hostname} resolves to a ${reason}`);
  }
}

/**
 * Throw a clear HttpError if a process may not send a request to `url` under the
 * current policy. Always rejects the metadata ranges and the server's own port.
 */
export async function assertOutboundAllowed(url: string, ctx: OutboundContext): Promise<void> {
  const u = originOf(url) ? new URL(url) : null;
  if (!u) throw new HttpError(400, `Invalid outbound URL "${String(url).slice(0, 120)}"`);

  await assertAddressSafe(url);

  const settings = getSettings();
  const policy = settings.outboundPolicy ?? 'platforms';
  if (policy === 'open') return;

  const allowList = settings.outboundAllowList ?? [];
  if (allowList.some((e) => allowListMatches(e, u))) return;

  if (policy === 'platforms') {
    const origins = await platformOrigins(ctx.platforms, ctx.resolveOrigin);
    if (origins.has(u.origin)) return;
  }

  throw new HttpError(
    403,
    `Blocked by the outbound policy: ${u.origin} is not a configured platform or on the allow-list. ` +
      `An administrator can allow it under Settings → Outbound access (outboundAllowList).`,
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
    /* ignore */
  }
  try {
    out.add(encodeURIComponent(value));
    out.add(encodeURI(value));
  } catch {
    /* ignore */
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
    if (await b.allowed(url)) continue;
    for (const value of b.values) {
      for (const enc of secretEncodings(value)) {
        if (haystack.includes(enc)) {
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
