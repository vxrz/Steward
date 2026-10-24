import fs from 'node:fs';
import { test as base, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { USERS, authFile, baseURL, type UserKey } from './env';
import { applyBasePath } from './basePath';

/**
 * Console messages that are expected and harmless. Keep this list short and explicit:
 * every entry needs a reason.
 */
export const BENIGN_CONSOLE: { pattern: RegExp; reason: string }[] = [
  {
    // The browser logs every non-2xx fetch. The UI handles these: 401 on a wrong password, 403/404 for optional
    // endpoints probed with getOptional(), 409/400 for validation messages shown to the user.
    pattern: /Failed to load resource: the server responded with a status of (400|401|403|404|409|423)/,
    reason: 'HTTP errors the UI handles and shows as messages',
  },
];

interface GuardState {
  problems: string[];
  allow: RegExp[];
}

/** Collects console errors and uncaught page errors of a page. */
function guard(page: Page, state: GuardState) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN_CONSOLE.some((b) => b.pattern.test(text)) || state.allow.some((a) => a.test(text))) return;
    state.problems.push(`console.error on ${page.url()}: ${text}`);
  });
  page.on('pageerror', (err) => {
    if (state.allow.some((a) => a.test(err.message))) return;
    state.problems.push(`uncaught error on ${page.url()}: ${err.message}`);
  });
}

export interface Fixtures {
  /** Extra console patterns a single test expects (e.g. a deliberate failure). */
  allowConsole: (pattern: RegExp) => void;
  /** Opens a new browser context signed in as the given demo user (closed automatically). */
  loginAs: (user: UserKey) => Promise<Page>;
  /** API client signed in as the given user (session cookie + CSRF header). */
  apiAs: (user: UserKey) => Promise<APIRequestContext>;
  /** Fails the test when the page logs console errors or throws (auto-applied). */
  consoleGuard: GuardState;
}

/** Worker-scoped: under E2E_BASE_PATH, app paths passed to goto() and API requests get the base path (support/basePath.ts). */
interface WorkerFixtures {
  basePathUrls: void;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  basePathUrls: [
    async ({ browser }, use) => {
      await applyBasePath(browser);
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  consoleGuard: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument
    async ({}, use) => {
      const state: GuardState = { problems: [], allow: [] };
      await use(state);
      expect(state.problems, 'the page logged errors (see e2e/support/fixtures.ts → BENIGN_CONSOLE for the allow-list)').toEqual([]);
    },
    { auto: true },
  ],
  page: async ({ page, consoleGuard }, use) => {
    guard(page, consoleGuard);
    await use(page);
  },
  allowConsole: async ({ consoleGuard }, use) => {
    await use((p) => consoleGuard.allow.push(p));
  },
  loginAs: async ({ browser, consoleGuard, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor, locale, timezoneId }, use) => {
    const contexts: BrowserContext[] = [];
    const options = { viewport, isMobile, hasTouch, userAgent, deviceScaleFactor, locale, timezoneId };
    await use(async (user) => {
      const ctx = await newUserContext(browser, user, options);
      contexts.push(ctx);
      const page = await ctx.newPage();
      guard(page, consoleGuard);
      return page;
    });
    for (const c of contexts) await c.close();
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument
  apiAs: async ({}, use) => {
    const clients: APIRequestContext[] = [];
    await use(async (user) => {
      const c = await pwRequest.newContext({
        baseURL: baseURL(),
        storageState: authFile(user),
        extraHTTPHeaders: { 'x-sm-client': '1', ...sessionHeaders(user) },
      });
      clients.push(c);
      return c;
    });
    for (const c of clients) await c.dispose();
  },
});

/**
 * The session key of a stored session (session binding: the cookie alone is not accepted). API calls made
 * with Playwright's `request` / `page.request` have to send it, like the web app does.
 */
export function sessionHeaders(user: UserKey): Record<string, string> {
  const state = JSON.parse(fs.readFileSync(authFile(user), 'utf8')) as { origins: { localStorage: { name: string; value: string }[] }[] };
  const key = state.origins.flatMap((o) => o.localStorage).find((e) => e.name === 'sm.sessionKey')?.value;
  return key ? { 'x-sm-session': key } : {};
}

/** The session key of a page that signed in through the UI. */
export async function pageSessionHeaders(page: Page): Promise<Record<string, string>> {
  const key = await page.evaluate(() => localStorage.getItem('sm.sessionKey'));
  return key ? { 'x-sm-session': key } : {};
}

export async function newUserContext(browser: Browser, user: UserKey, options: object = {}): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: authFile(user), baseURL: baseURL(), serviceWorkers: 'block' });
}

export { expect, USERS };
