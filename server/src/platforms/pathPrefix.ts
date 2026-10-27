/**
 * Path prefix of an imported API specification: the path part of its server URL (OpenAPI 3 `servers[0].url`,
 * Swagger 2 `basePath`), put in front of every operation path. Requests still go to the platform's base URL, so
 * the prefix must be a plain relative path: it may never change the origin or climb out of the base URL path
 * (platform credentials only go to the platform's own origins).
 */

export const PATH_PREFIX_MAX = 200;

/** Empty, or "/seg/seg…" with segments of unreserved URL characters; no dot segments. */
const PREFIX = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/** Why a path prefix is not allowed (undefined: it is). */
export function pathPrefixProblem(prefix: string): string | undefined {
  if (prefix.length > PATH_PREFIX_MAX) return `at most ${PATH_PREFIX_MAX} characters`;
  if (!PREFIX.test(prefix)) return 'use "/segment/segment" with letters, digits and . _ ~ - only (no "//", "%", "?", "#", "\\", "{…}", scheme or host)';
  if (prefix.split('/').some((seg) => seg === '.' || seg === '..')) return '"." and ".." segments are not allowed';
  return undefined;
}

export const isValidPathPrefix = (prefix: string): boolean => pathPrefixProblem(prefix) === undefined;

/** Leading slash, no trailing slash; "/" becomes empty. */
export function normalizePathPrefix(raw: string): string {
  let p = raw.trim().replace(/^\.\//, '');
  if (p === '.') p = '';
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+$/, '');
}

type ServerVariables = Record<string, { default?: unknown } | undefined>;

/**
 * The path of a server URL: OpenAPI server variables take their default, scheme and host are dropped, a
 * relative URL is its own path. Not validated (see derivePathPrefix).
 */
export function serverUrlPath(serverUrl: string, variables?: ServerVariables): string {
  const url = serverUrl.trim().replace(/\{([^{}]+)\}/g, (m, name: string) => (variables?.[name]?.default !== undefined ? String(variables[name]!.default) : m));
  const origin = /^(?:[^:/?#]+:)?\/\/[^/?#]*/.exec(url);
  const path = (origin ? url.slice(origin[0].length) : url).split(/[?#]/)[0]!;
  return normalizePathPrefix(path);
}

/**
 * The path of a platform base URL without rendering it (undefined: it holds a template – which may render to a
 * path anywhere, even in the host part – or it is not absolute).
 */
export function literalBasePath(baseUrl: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(baseUrl.trim());
  if (!m || baseUrl.includes('{{')) return undefined;
  return m[1]!.replace(/\/+$/, '');
}

/**
 * The default prefix of a specification.
 * - empty when the platform base URL path already ends with it (basePath undefined: not known – keep it);
 * - empty when every operation path already starts with it (specs that repeat the server path in their paths);
 * - empty (with `invalid`) when the derived path is not an allowed prefix.
 */
export function derivePathPrefix(
  serverUrl: string | undefined | null,
  opts: { variables?: ServerVariables; basePath?: string; opPaths?: string[] } = {},
): { prefix: string; derived: string; invalid?: string } {
  if (!serverUrl) return { prefix: '', derived: '' };
  const derived = serverUrlPath(serverUrl, opts.variables);
  if (!derived) return { prefix: '', derived };
  const invalid = pathPrefixProblem(derived);
  if (invalid) return { prefix: '', derived, invalid };
  if (opts.basePath !== undefined && opts.basePath.endsWith(derived)) return { prefix: '', derived };
  if (opts.opPaths?.length && opts.opPaths.every((p) => p === derived || p.startsWith(`${derived}/`))) return { prefix: '', derived };
  return { prefix: derived, derived };
}

/** An operation path with the prefix in front. */
export function withPrefix(prefix: string, path: string): string {
  if (!prefix) return path;
  return path.startsWith('/') ? prefix + path : `${prefix}/${path}`;
}
