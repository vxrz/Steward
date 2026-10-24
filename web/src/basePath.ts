/**
 * The path prefix Steward runs under behind a reverse proxy ('' at the root, e.g. '/steward' for
 * https://domain.tld/steward). The server writes it into index.html as `<base href="/steward/">`
 * (SM_BASE_PATH), so one build works under any prefix.
 *
 * Paths from the server (API calls, hook URLs, links in notifications) are app-relative ("/api/…",
 * "/runs/…"): the router adds the base itself (basename), everything else goes through these helpers.
 */
function readBasePath(): string {
  if (typeof document === 'undefined') return '';
  const href = document.querySelector('base')?.getAttribute('href') ?? '/';
  // only a plain absolute path (what the server writes); anything else counts as the root
  return /^\/[A-Za-z0-9._~/-]*$/.test(href) ? href.replace(/\/+$/, '') : '';
}

export const BASE_PATH = readBasePath();

/** An app-relative path ("/api/…", "/runs") as the browser has to request it. */
export const withBase = (path: string): string => BASE_PATH + path;

/** Absolute URL of an app-relative path on this Steward (copy-paste snippets: webhooks, MCP, API). */
export const appUrl = (path = ''): string => (typeof window !== 'undefined' ? window.location.origin : 'http://<host>') + BASE_PATH + path;

/** The current address without the base path ("/steward/runs?x" → "/runs?x"), e.g. to come back after signing in. */
export function appPath(): string {
  const path = window.location.pathname;
  const rest = BASE_PATH && (path === BASE_PATH || path.startsWith(BASE_PATH + '/')) ? path.slice(BASE_PATH.length) || '/' : path;
  return rest + window.location.search;
}
