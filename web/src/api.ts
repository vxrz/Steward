import { notifications } from '@mantine/notifications';
import type { ErrorParams } from '@sm/shared';
import i18n from './i18n';
import { errorText } from './i18n/errors';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: string; message: string }[],
    public code?: string,
    public params?: ErrorParams,
  ) {
    super(message);
  }
}

/** Called when the session/auth state changes (signed out, password change required, vault locked). */
let onAuthChange: (() => void) | undefined;
export function setAuthChangeHandler(fn: () => void): void {
  onAuthChange = fn;
}

/**
 * Session binding: besides the HttpOnly cookie, the server hands out a per-session key at sign-in.
 * It is kept in localStorage – readable only by pages of this exact origin (scheme, host and port) –
 * and sent with every request. Browsers send cookies to every port of a host, so a program on another
 * local port could receive the cookie, but never this key. Links (downloads, images) cannot carry a
 * header and get a separate read-only link key as ?_sk=. The SSO callback page stores the same keys.
 */
const SESSION_KEY = 'sm.sessionKey';
const LINK_KEY = 'sm.linkKey';
let memoryKeys: { session?: string; link?: string } = {}; // when localStorage is unavailable

function readKey(name: string): string | undefined {
  try {
    return localStorage.getItem(name) ?? undefined;
  } catch {
    return name === SESSION_KEY ? memoryKeys.session : memoryKeys.link;
  }
}

function storeKeys(session: string | null, link: string | null): void {
  memoryKeys = { session: session ?? undefined, link: link ?? undefined };
  try {
    if (session) localStorage.setItem(SESSION_KEY, session);
    else localStorage.removeItem(SESSION_KEY);
    if (link) localStorage.setItem(LINK_KEY, link);
    else localStorage.removeItem(LINK_KEY);
  } catch {
    /* private mode: keys live in memory until the page is reloaded */
  }
}

/** Headers that authenticate a request of this browser tab (for the few places that call fetch directly). */
export function authHeaders(): Record<string, string> {
  const key = readKey(SESSION_KEY);
  return { 'x-sm-client': '1', ...(key ? { 'x-sm-session': key } : {}) };
}

/** URL of an API resource for links, downloads and images (GET only): "/api" + path + the link key. */
export function apiUrl(path: string): string {
  const key = readKey(LINK_KEY);
  if (!key) return '/api' + path;
  return `/api${path}${path.includes('?') ? '&' : '?'}_sk=${encodeURIComponent(key)}`;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...authHeaders(),
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const newKey = res.headers.get('x-sm-session-key');
  if (newKey) storeKeys(newKey, res.headers.get('x-sm-link-key'));
  if (url === '/auth/logout' && res.ok) storeKeys(null, null);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string; params?: ErrorParams; issues?: { path: string; message: string }[] } | null;
    if (!url.startsWith('/auth/') && (res.status === 401 || res.status === 423 || d?.code === 'PASSWORD_CHANGE_REQUIRED')) onAuthChange?.();
    throw new ApiError(res.status, d?.error ?? i18n.t('errors:http', { status: res.status }), d?.issues, d?.code, d?.params);
  }
  return data as T;
}

export const get = <T = unknown>(url: string) => api<T>('GET', url);
export const post = <T = unknown>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T = unknown>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const patch = <T = unknown>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const del = <T = unknown>(url: string) => api<T>('DELETE', url);

/** True for "this endpoint does not exist (yet)" / "not allowed" – used to hide optional features gracefully. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 405 || e.status === 501);
}

/** GET that resolves to `fallback` when the endpoint is missing or forbidden (optional server features). */
export async function getOptional<T>(url: string, fallback: T): Promise<T> {
  try {
    return await get<T>(url);
  } catch (e) {
    if (isUnavailable(e)) return fallback;
    throw e;
  }
}

export function notifyError(e: unknown, title: string = i18n.t('errors:title')): void {
  notifications.show({ color: 'red', title, message: errorText(e), autoClose: 8000, closeButtonProps: { 'aria-label': i18n.t('common:close') } });
}
export function notifyOk(message: string, title?: string): void {
  notifications.show({ color: 'green', title, message, closeButtonProps: { 'aria-label': i18n.t('common:close') } });
}
