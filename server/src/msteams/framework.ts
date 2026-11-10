import { BRAND } from '@sm/shared';
import { assertOutboundAllowed, fetchCheckingRedirects } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';

/**
 * Microsoft's documented hosts the bot talks to (ADR 0013): the Bot Framework's OpenID metadata (its signing keys),
 * the Entra token endpoint (the bot's own token), and the Teams service hosts a `serviceUrl` may name. Every call goes
 * through address safety and the outbound policy (Settings → Outbound access), like every other call of Steward.
 */

export interface FrameworkEndpoints {
  /** OpenID metadata of the Bot Framework (its jwks_uri lists the keys that sign inbound calls) */
  openIdMetadata: string;
  /** Entra token endpoint; {tenant} is replaced */
  tokenEndpoint: string;
  /** Hosts a serviceUrl may name (Steward sends its own token there) */
  serviceHosts: readonly string[];
  /** Only the mock in tests: plain http to 127.0.0.1 */
  allowHttp: boolean;
}

export const ISSUER = 'https://api.botframework.com';
export const BOT_SCOPE = 'https://api.botframework.com/.default';

const PRODUCTION: FrameworkEndpoints = {
  openIdMetadata: 'https://login.botframework.com/v1/.well-known/openidconfiguration',
  tokenEndpoint: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  // the Teams service hosts (public cloud, GCC, GCC High, DoD)
  serviceHosts: ['smba.trafficmanager.net', 'smba.infra.gcc.teams.microsoft.com', 'smba.infra.gov.teams.microsoft.us', 'smba.infra.dod.teams.microsoft.us'],
  allowHttp: false,
};

let endpoints: FrameworkEndpoints = PRODUCTION;

export const frameworkEndpoints = (): FrameworkEndpoints => endpoints;

/** Tests only: point the bot at the mock Bot Framework (server/src/mock/mockBotConnector.ts). */
export function useMockFramework(e: FrameworkEndpoints | null): void {
  if (!process.env.VITEST) throw new Error('useMockFramework is for tests');
  endpoints = e ?? PRODUCTION;
}

/** Whether a serviceUrl may receive the bot's token: https (the mock: http) and a host on the fixed list. */
export function serviceUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol !== 'https:' && !(endpoints.allowHttp && u.protocol === 'http:')) return false;
  return endpoints.serviceHosts.includes(u.hostname.toLowerCase());
}

/** A request to one of Microsoft's hosts (outbound policy and address safety apply; a redirect is an error). */
export async function frameworkFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  bodySecrets: string[] = [],
): Promise<{ status: number; json: unknown; retryAfter?: number }> {
  const ctx = outboundContext();
  await assertOutboundAllowed(url, ctx);
  const res = await fetchCheckingRedirects(url, { ...init, headers: { 'user-agent': BRAND.slug, ...init.headers }, signal: AbortSignal.timeout(10_000) }, ctx, {
    bodySecrets,
    // no redirects: a hop would carry the bot's token or client assertion to another host (security review 0.10.0)
    maxRedirects: 0,
  });
  const text = await res.text().catch(() => '');
  const parse = (): unknown => {
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null; // not JSON: the caller looks at the status
    }
  };
  // Retry-After in seconds (throttling, ADR 0025); an HTTP date is read as the seconds until then
  const ra = res.headers.get('retry-after');
  const retryAfter =
    ra === null ? undefined : /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) || undefined;
  return { status: res.status, json: parse(), ...(retryAfter !== undefined ? { retryAfter } : {}) };
}
