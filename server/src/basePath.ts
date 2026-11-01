/**
 * Running under a path prefix (SM_BASE_PATH, e.g. https://domain.tld/steward behind a reverse proxy).
 *
 * Everything Steward serves lives below the base path: the web UI, /api (incl. /api/v1, /api/mcp,
 * /api/hooks, health and metrics), the manifest and the service worker. The reverse proxy passes the
 * path on unchanged (it does not strip the prefix); the server strips it once, before routing
 * (app.ts → rewriteUrl), so every route, check and limit inside works on the same paths as at the root.
 *
 * Kept free of other imports: config.ts reads it at start-up.
 */

/** Longest base path accepted (the whole prefix, slashes included). */
export const MAX_BASE_PATH_LENGTH = 100;
/** One path segment: unreserved URL characters only (RFC 3986) – nothing to encode, decode or normalise. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Normalises and validates a base path: '' (the root) or '/a' / '/a/b' – a leading slash, no trailing
 * slash. Throws on anything else (empty or dot segments, encoded or reserved characters, too long).
 */
export function parseBasePath(raw: string | undefined, name = 'SM_BASE_PATH'): string {
  const s = (raw ?? '').trim();
  if (s === '' || s === '/') return '';
  const p = ('/' + s.replace(/^\/+/, '')).replace(/\/+$/, '');
  if (p.length > MAX_BASE_PATH_LENGTH) throw new Error(`${name}: "${s.slice(0, 120)}" is longer than ${MAX_BASE_PATH_LENGTH} characters`);
  for (const seg of p.slice(1).split('/')) {
    if (!seg) throw new Error(`${name}: "${s}" contains an empty path segment ("//")`);
    if (seg === '.' || seg === '..') throw new Error(`${name}: "${s}" contains a "." or ".." segment`);
    if (!SEGMENT.test(seg))
      throw new Error(`${name}: "${s}" may only contain letters, digits and . _ ~ - in its segments (no spaces, "%", "?", "#" or other characters)`);
  }
  return p;
}

/**
 * The public URL (SM_PUBLIC_URL) and the base path (SM_BASE_PATH) together:
 * - only SM_BASE_PATH: that base path;
 * - only SM_PUBLIC_URL with a path (https://domain.tld/steward): its path is the base path;
 * - both: the public URL's path must be the base path – a mismatch refuses to start.
 * The returned public URL is normalised (origin + base path, no trailing slash).
 */
export function resolveBasePath(env: { SM_BASE_PATH?: string; SM_PUBLIC_URL?: string }): { basePath: string; publicUrl: string | undefined } {
  const fromEnv = env.SM_BASE_PATH?.trim() ? parseBasePath(env.SM_BASE_PATH) : undefined;
  const rawUrl = env.SM_PUBLIC_URL?.trim();
  if (!rawUrl) return { basePath: fromEnv ?? '', publicUrl: undefined };
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`SM_PUBLIC_URL: "${rawUrl}" is not an absolute URL – use e.g. https://steward.example.com`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`SM_PUBLIC_URL: "${rawUrl}" must start with https:// or http://`);
  if (u.username || u.password || u.search || u.hash)
    throw new Error(`SM_PUBLIC_URL: "${rawUrl}" must not contain a user name, password, query string or fragment`);
  // The raw path, not the parsed one: the URL parser would quietly resolve "..", "%2e" and the like.
  const rawPath = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const fromUrl = parseBasePath(rawPath, 'SM_PUBLIC_URL (its path)');
  if (fromEnv !== undefined && fromEnv !== fromUrl) {
    throw new Error(
      `SM_BASE_PATH ("${fromEnv || '/'}") and the path of SM_PUBLIC_URL ("${fromUrl || '/'}") differ – set SM_PUBLIC_URL to ${u.origin}${fromEnv || ''} or leave SM_BASE_PATH out`,
    );
  }
  return { basePath: fromUrl, publicUrl: u.origin + fromUrl };
}

/** Marker on requests whose path is outside the base path (set by stripBasePath, read by app.ts). */
export const OUTSIDE_BASE = Symbol('smOutsideBasePath');
/** Marker on requests for the base path itself without the trailing slash ("/steward", "/steward?x"): redirected to "/steward/". */
export const BARE_BASE = Symbol('smBareBasePath');
/** Where requests outside the base path are routed: matches no route of Steward's own (app.ts answers them with 404 first). */
export const OUTSIDE_BASE_URL = '/__outside_base_path__';

/**
 * Fastify's rewriteUrl: "/steward/api/health?x" → "/api/health?x", "/steward" → "/" (marked: app.ts redirects
 * it to "/steward/", the app's own address – the scope of its service worker and its router). Paths outside the
 * base path ("/", "/stewardx", "/Steward/…", "/steward%2Fapi", "//steward/…") are marked and routed to
 * OUTSIDE_BASE_URL. The match is literal and case-sensitive on the raw request target, before any
 * decoding; non-origin-form targets ("http://host/…", "*") are left alone (app.ts answers them with 400).
 */
export function stripBasePath(req: { url?: string; [OUTSIDE_BASE]?: boolean; [BARE_BASE]?: boolean }, basePath: string): string {
  const url = req.url ?? '/';
  if (!basePath || !url.startsWith('/')) return url;
  if (url === basePath || url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
    const rest = url.slice(basePath.length);
    if (rest.startsWith('/')) return rest;
    req[BARE_BASE] = true;
    return '/' + rest;
  }
  // OAuth discovery for MCP clients (#12): the well-known addresses put the issuer's or resource's path after the
  // well-known prefix (RFC 8414, RFC 9728), outside the base path – exactly these two are let in
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q);
  if (path === `/.well-known/oauth-authorization-server${basePath}`) return `/.well-known/oauth-authorization-server${query}`;
  if (path === `/.well-known/oauth-protected-resource${basePath}/api/mcp`) return `/.well-known/oauth-protected-resource/api/mcp${query}`;
  req[OUTSIDE_BASE] = true;
  return OUTSIDE_BASE_URL;
}

/** An app-relative redirect target ("/x") below the base path; absolute and protocol-relative targets stay as they are. */
export function withBasePath(location: string, basePath: string): string {
  if (!basePath || !location.startsWith('/') || location.startsWith('//') || location.startsWith('/\\')) return location;
  return basePath + location;
}

/**
 * Sets `<base href="<base path>/">` in the web UI's index.html (its relative asset URLs, the app's runtime base):
 * replaces the build's `<base href="/">`, or inserts the tag at the start of <head>.
 */
export function injectBaseHref(html: string, basePath: string): string {
  const tag = `<base href="${basePath}/" />`;
  if (/<base\s[^>]*>/i.test(html)) return html.replace(/<base\s[^>]*>/i, tag);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}
