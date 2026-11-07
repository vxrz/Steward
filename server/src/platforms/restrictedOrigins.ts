import type { Platform, PlatformConfig } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { RESTRICTED_KINDS, assertPathAllowed, pathSegments } from './deniedPaths.js';

/**
 * The rules of a platform kind by destination (0.9.0): a request to the origin of a platform of a kind with rules of
 * its own – read-only (Kafka Connect, changedetection.io, container registries) or refused paths and values removed
 * from answers (IBM Verify Privilege Vault, changedetection.io) – gets that kind's rules, whichever platform sends it:
 * another platform with an absolute URL, a redirect hop, a process step on another connection. Where such a platform
 * is: below its base URL (templates expanded) – its origin and, when the base URL has a path (a reverse proxy's
 * sub-path, the demo's mock platforms on Steward's own port), the requests on that origin below that path – and its
 * trusted origins as a whole, where its credentials go too. Paths are compared by decoded, lower-case segments, so
 * "..", "%2e%2e", "%2F" or a different case do not leave the base path; a path that cannot be decoded counts as inside.
 */

interface RestrictedRow {
  id: string;
  kind: string;
  base_url: string;
  config: string;
  updated_at: string;
}

/** Where a platform is: an origin and the path segments below which requests reach it (none: the whole origin). */
interface Place {
  origin: string;
  segments: string[];
}

const cache = new Map<string, { stamp: string; kind: string; places: Place[] }>();

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

async function placesOf(r: RestrictedRow): Promise<Place[]> {
  const config = parseJson<PlatformConfig>(r.config, {} as PlatformConfig);
  const out: Place[] = [];
  try {
    const { resolveBaseUrl } = await import('./http.js');
    // credentials in a base URL template are rare: they are read (never checked, never sent) only then
    let secrets: Record<string, string> = {};
    if (r.base_url.includes('secrets')) {
      const { getSecretsUnchecked } = await import('./service.js');
      secrets = getSecretsUnchecked(r.id);
    }
    const base = new URL(await resolveBaseUrl({ id: r.id, name: '', kind: r.kind, baseUrl: r.base_url, config } as Platform, secrets));
    const o = originOf(base.toString());
    if (o) out.push({ origin: o, segments: pathSegments(base.pathname) ?? [] });
  } catch {
    /* a base URL that cannot be resolved (a variable is missing): no place of its own – only the trusted origins */
  }
  for (const t of config.http?.trustedOrigins ?? []) {
    const o = originOf(t);
    if (o) out.push({ origin: o, segments: [] });
  }
  return out;
}

function inside(place: Place, origin: string, segments: string[] | null): boolean {
  if (place.origin !== origin) return false;
  if (!segments) return true; // undecodable: refuse rather than guess where it is routed
  return place.segments.every((s, i) => segments[i] === s);
}

/** The kinds with rules of their own whose platforms this URL reaches (empty for most URLs). */
export async function destinationKinds(url: string): Promise<string[]> {
  const origin = originOf(url);
  if (!origin) return [];
  const segments = pathSegments(new URL(url).pathname);
  const rows = db().all<RestrictedRow>(
    `SELECT id, kind, base_url, config, updated_at FROM platforms WHERE kind IN (${RESTRICTED_KINDS.map(() => '?').join(', ')})`,
    ...RESTRICTED_KINDS,
  );
  const seen = new Set(rows.map((r) => r.id));
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  const kinds = new Set<string>();
  for (const r of rows) {
    let hit = cache.get(r.id);
    if (!hit || hit.stamp !== `${r.updated_at}|${r.kind}`) {
      hit = { stamp: `${r.updated_at}|${r.kind}`, kind: r.kind, places: await placesOf(r) };
      cache.set(r.id, hit);
    }
    if (hit.places.some((p) => inside(p, origin, segments))) kinds.add(hit.kind);
  }
  return [...kinds];
}

/**
 * The kind rules of a request: the sending platform's kind, and the kinds whose platforms own the URL's origin
 * (method and path rules, assertPathAllowed). Returns the kinds whose answers rules apply to (stripValues).
 */
export async function assertKindRules(senderKind: string | undefined, url: string, method: string): Promise<string[]> {
  if (senderKind) assertPathAllowed(senderKind, url, method);
  const kinds = (await destinationKinds(url)).filter((k) => k !== senderKind);
  for (const k of kinds) assertPathAllowed(k, url, method, { destination: true });
  return senderKind ? [senderKind, ...kinds] : kinds;
}
