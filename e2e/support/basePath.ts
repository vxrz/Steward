import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { BASE_PATH } from './env';

/**
 * UI tests under a path prefix (E2E_BASE_PATH): the specs keep writing app paths as at the root –
 * `page.goto('/runs')`, `request.get('/api/runs')` – and these calls get the base path in front.
 * (Playwright resolves a leading-slash URL against the origin of `baseURL`, not against its path.)
 *
 * Only the URLs the tests pass in are changed: everything the app itself requests or links to is
 * left alone, so a missing base path in the web UI still fails the test.
 */
export function withBasePath(url: string): string {
  if (!BASE_PATH || !url.startsWith('/') || url.startsWith('//')) return url;
  if (url === BASE_PATH || url.startsWith(BASE_PATH + '/') || url.startsWith(BASE_PATH + '?')) return url;
  return BASE_PATH + url;
}

const PATCHED = Symbol('smBasePathPatched');

function patch(proto: object, methods: string[]): void {
  const p = proto as Record<string | symbol, unknown>;
  if (p[PATCHED]) return;
  for (const m of methods) {
    const original = p[m];
    if (typeof original !== 'function') throw new Error(`E2E_BASE_PATH: Playwright has no ${m}() to adjust – update e2e/support/basePath.ts`);
    p[m] = function (this: unknown, url: unknown, ...rest: unknown[]) {
      return (original as (...a: unknown[]) => unknown).call(this, typeof url === 'string' ? withBasePath(url) : url, ...rest);
    };
  }
  p[PATCHED] = true;
}

/** Once per worker: page.goto and the API request methods add the base path (no-op at the root). */
export async function applyBasePath(browser: Browser): Promise<void> {
  if (!BASE_PATH) return;
  const ctx = await browser.newContext();
  try {
    const page: Page = await ctx.newPage();
    patch(Object.getPrototypeOf(page), ['goto']);
    const request: APIRequestContext = ctx.request;
    patch(Object.getPrototypeOf(request), ['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
  } finally {
    await ctx.close();
  }
}
