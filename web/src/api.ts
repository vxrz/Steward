import { notifications } from '@mantine/notifications';
import i18n from './i18n';
import { errorText } from './i18n/errors';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: string; message: string }[],
    public code?: string,
  ) {
    super(message);
  }
}

/** Called when the session/auth state changes (signed out, password change required, vault locked). */
let onAuthChange: (() => void) | undefined;
export function setAuthChangeHandler(fn: () => void): void {
  onAuthChange = fn;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-sm-client': '1',
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
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
    const d = data as { error?: string; code?: string; issues?: { path: string; message: string }[] } | null;
    if (!url.startsWith('/auth/') && (res.status === 401 || res.status === 423 || d?.code === 'PASSWORD_CHANGE_REQUIRED')) onAuthChange?.();
    throw new ApiError(res.status, d?.error ?? i18n.t('errors:http', { status: res.status }), d?.issues, d?.code);
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
  notifications.show({ color: 'red', title, message: errorText(e), autoClose: 8000 });
}
export function notifyOk(message: string, title?: string): void {
  notifications.show({ color: 'green', title, message });
}
