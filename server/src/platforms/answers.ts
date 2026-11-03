import { isGitPlatformKind, unsentCredentials, type Platform } from '@sm/shared';
import type { HttpResult } from './http.js';

/**
 * Plain-words descriptions of what an integration answered (v0.3.1): who answered (HTML page, redirect, empty
 * response), the likely cause and the fix – shared by the connection test, the Git hosts and Prometheus, so the
 * same answer reads the same everywhere. Never echoes credentials: callers redact the platform's secrets.
 */

/** Origin and path of a URL – never the query (it may carry credentials or personal data). */
export function where(url: string, base?: string): string {
  try {
    const u = new URL(url, base);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'an invalid address';
  }
}

/** Response headers that tell who answered and why; nothing that carries a session (Set-Cookie) or a credential. */
const SHOWN_HEADERS = ['content-type', 'content-length', 'server', 'via', 'www-authenticate', 'location', 'x-powered-by', 'retry-after'];

export function shownHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(SHOWN_HEADERS.filter((k) => h[k] !== undefined).map((k) => [k, String(h[k]).slice(0, 300)]));
}

export const isEmptyBody = (b: unknown): boolean => b === null || b === undefined || (typeof b === 'string' && !b.trim());

/** An HTML page (content type text/html, or a text body that starts with "<"). */
export function isHtml(r: Pick<HttpResult, 'headers' | 'body'>): boolean {
  return /text\/html|application\/xhtml/i.test(r.headers['content-type'] ?? '') || (typeof r.body === 'string' && r.body.trimStart().startsWith('<'));
}

/** A JSON answer: declared as JSON, or a body that parsed as an object or list. */
export function isJson(r: Pick<HttpResult, 'headers' | 'body'>): boolean {
  return (r.body !== null && typeof r.body === 'object') || (/json/i.test(r.headers['content-type'] ?? '') && !isEmptyBody(r.body));
}

/** The first ~200 characters of a text body on one line (the caller redacts secrets). */
export function textStart(body: unknown, max = 200): string {
  const s = (typeof body === 'string' ? body : (JSON.stringify(body) ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * What a non-JSON body was, for an error message: "an empty response", "an HTML page" or its start.
 */
export function bodyKind(r: Pick<HttpResult, 'headers' | 'body'>): string {
  if (isEmptyBody(r.body)) return 'an empty response';
  if (isHtml(r)) return 'an HTML page';
  const ct = r.headers['content-type'];
  return `${ct ? `${ct.split(';')[0]}: ` : ''}"${textStart(r.body)}"`;
}

/** The detail of an error body: `message` (text or an object, e.g. GitLab validation errors), `error`, `error_description`. */
export function errorDetail(r: Pick<HttpResult, 'headers' | 'body'>): string {
  const b = r.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const o = b as Record<string, unknown>;
    const str = (v: unknown) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    const parts = [str(o.message), str(o.error), str(o.error_description)].filter(Boolean);
    const text = [...new Set(parts)].join(' – ');
    return text ? text.slice(0, 300) : textStart(b);
  }
  if (isEmptyBody(b)) return 'an empty response';
  if (isHtml(r)) return 'an HTML page';
  return textStart(b);
}

/** Why a sign-in was refused (401/403), in plain words: the auth type trap first, then the usual causes. */
export function authHint(p: Platform, status: number): string {
  const unsent = unsentCredentials(p, p.secretKeys ?? []);
  if (unsent)
    return `Authentication is set to "none" – the ${unsent.keys.join('/')} you entered ${unsent.keys.length > 1 ? 'are' : 'is'} not sent. Choose "${unsent.suggest}" under Settings → Authentication.`;
  const type = p.config.auth?.type ?? 'none';
  if (type === 'none') return 'Authentication is set to "none", but the platform wants credentials – choose the authentication under Settings.';
  if (isGitPlatformKind(p.kind)) return gitAuthHint(p.kind, status);
  if (status === 403) return 'Signed in, but not allowed: check the rights or scopes of the user or token.';
  return `The platform refused the credentials (authentication "${type}"): wrong, expired or revoked, or a proxy in front of the platform removed the header.`;
}

/** The usual causes of a 401/403 from a Git host. */
export function gitAuthHint(kind: string, status: number): string {
  if (status === 403)
    return kind === 'gitlab'
      ? 'The token is valid but lacks a right: it needs the scope read_api and the role Reporter or more (deploy keys and tokens: Maintainer).'
      : 'The token is valid but lacks a right – see the token rights in docs/GIT-PLATFORMS.md.';
  const header = kind === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization';
  return [
    'Likely causes: the token expired or was revoked;',
    kind === 'gitlab' ? 'it is the wrong type (deploy tokens and feed tokens do not work for the API; use a personal, group or project access token);' : '',
    `a proxy or sign-in gateway in front of the host removed the ${header} header.`,
    kind === 'gitlab' ? 'A missing read_api scope answers 403, not 401.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A redirect, in plain words: where to, and what it usually means for an API base URL. */
export function redirectHint(location: string, from: string, apiExample?: string): string {
  return `redirected to ${where(location, from)} – the base URL must be the API${apiExample ? ` (${apiExample})` : ''} and reachable without browser sign-in`;
}
