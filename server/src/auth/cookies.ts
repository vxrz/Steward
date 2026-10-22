import type { FastifyReply } from 'fastify';
import { config } from '../config.js';
import type { SessionKeys } from './users.js';

/**
 * Over HTTPS the cookie has the __Host- prefix: the browser then only accepts it with Secure, Path=/ and
 * without Domain, so a neighbouring (sub)domain cannot plant or overwrite it (OWASP ASVS V3.4.4).
 */
export const SESSION_COOKIE = config.secureCookies ? '__Host-sm_session' : 'sm_session';
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
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.round(config.session.maxMs / 1000)}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`;
}

/** Hands the session key and link key to the web app (response headers, read by web/src/api.ts). */
export function sendSessionKeys(reply: FastifyReply, keys: SessionKeys): void {
  reply.header('x-sm-session-key', keys.sessionKey);
  reply.header('x-sm-link-key', keys.linkKey);
  reply.header('cache-control', 'no-store');
}
