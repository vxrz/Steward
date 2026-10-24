import type { FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { SessionKeys } from './users.js';

/**
 * Over HTTPS the cookie has the __Host- prefix: the browser then only accepts it with Secure, Path=/ and
 * without Domain, so a neighbouring (sub)domain cannot plant or overwrite it (OWASP ASVS V3.4.4).
 * Under a path prefix (SM_BASE_PATH) __Host- is impossible (it requires Path=/): the cookie is then
 * __Secure-sm_session with Path=<base path> – still Secure and host-only, but other applications on the
 * same host share Steward's origin (docs/INSTALL.md recommends an own subdomain).
 */
export const SESSION_COOKIE = config.secureCookies ? (config.basePath ? '__Secure-sm_session' : '__Host-sm_session') : 'sm_session';
/** Path attribute of Steward's cookies: the base path, or / at the root. */
export const COOKIE_PATH = config.basePath || '/';
/** Header with the per-session key (see users.ts SessionBinding). */
export const SESSION_HEADER = 'x-sm-session';
/** Query parameter with the link key on download links and images (GET only). */
export const LINK_PARAM = '_sk';
/** localStorage keys of the web app (also written by the SSO callback page). */
export const SESSION_KEY_STORAGE = 'sm.sessionKey';
export const LINK_KEY_STORAGE = 'sm.linkKey';

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The session cookie. Secure with built-in TLS or an https:// SM_PUBLIC_URL (TLS at a reverse proxy).
 * Cookies are not isolated by port, so the cookie alone does not authenticate a request: the web app
 * also sends the session key (x-sm-session), which only pages of this origin can read.
 */
export function sessionCookie(token: string | null): string {
  const secure = config.secureCookies ? '; Secure' : '';
  return token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.round(config.session.maxMs / 1000)}`
    : `${SESSION_COOKIE}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

/** Hands the session key and link key to the web app (response headers, read by web/src/api.ts). */
export function sendSessionKeys(reply: FastifyReply, keys: SessionKeys): void {
  reply.header('x-sm-session-key', keys.sessionKey);
  reply.header('x-sm-link-key', keys.linkKey);
  reply.header('cache-control', 'no-store');
}
