import { notifications } from '@mantine/notifications';

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
    throw new ApiError(res.status, d?.error ?? `HTTP ${res.status}`, d?.issues, d?.code);
  }
  return data as T;
}

export const get = <T = unknown>(url: string) => api<T>('GET', url);
export const post = <T = unknown>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T = unknown>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const del = <T = unknown>(url: string) => api<T>('DELETE', url);

export function notifyError(e: unknown, title = 'Something went wrong'): void {
  notifications.show({ color: 'red', title, message: (e as Error)?.message ?? String(e), autoClose: 8000 });
}
export function notifyOk(message: string, title?: string): void {
  notifications.show({ color: 'green', title, message });
}
