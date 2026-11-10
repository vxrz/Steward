import fs from 'node:fs';
import path from 'node:path';
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { AUTH_DIR, USERS, authFile, baseURL, origin } from './env';
import { test } from './fixtures';

/**
 * A user of its own for a spec: specs that load many pages and make many API calls would otherwise share a demo user's
 * request budget (SM_RATE_LIMIT_PER_MINUTE counts per user) with every other spec running at the same time, and be
 * answered 429 now and then. Created by the admin with a password, signed in once (the first password changed, the
 * session confirmed for sensitive actions); its stored session is a file like the demo users'.
 */
export interface OwnUser {
  username: string;
  /** Storage state (cookie and session key) for `test.use({ storageState })` */
  file: string;
  /** Headers an API client needs (the session key: the cookie alone is not accepted) */
  headers: Record<string, string>;
}

const PASSWORD = 'Own-e2e-password-1';
const NEXT = 'Own-e2e-password-2';

type Session = { cookie: string; key: string; link: string };

async function call(method: string, url: string, body: unknown, session?: Session) {
  const res = await fetch(baseURL() + url, {
    method,
    headers: {
      'x-sm-client': '1',
      ...(session ? { cookie: session.cookie, 'x-sm-session': session.key } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  expect(res.ok, `${method} ${url} → ${res.status}: ${text}`).toBe(true);
  const set = res.headers.get('set-cookie');
  const key = res.headers.get('x-sm-session-key');
  return {
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    session: set && key ? { cookie: set.split(';')[0]!, key, link: res.headers.get('x-sm-link-key') ?? '' } : undefined,
  };
}

/** The admin's stored session (written by the global setup). */
function adminSession(): Session {
  const state = JSON.parse(fs.readFileSync(authFile('admin'), 'utf8')) as {
    cookies: { name: string; value: string }[];
    origins: { localStorage: { name: string; value: string }[] }[];
  };
  const stored = state.origins.flatMap((o) => o.localStorage);
  return {
    cookie: state.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    key: stored.find((e) => e.name === 'sm.sessionKey')?.value ?? '',
    link: stored.find((e) => e.name === 'sm.linkKey')?.value ?? '',
  };
}

/** Creates a user with these roles and a signed-in session of it. */
export async function ownUser(prefix: string, roles: string[], displayName = 'E2E own user'): Promise<OwnUser> {
  const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const admin = adminSession();
  // adding a user with roles is a sensitive action: the admin's session confirms it
  await call('POST', '/api/auth/step-up', { password: USERS.admin.password }, admin);
  await call('POST', '/api/users', { username, displayName, roles, password: PASSWORD }, admin);
  const login = await call('POST', '/api/auth/login', { username, password: PASSWORD });
  const session = login.session!;
  // the password an administrator set is changed at the first sign-in
  await call('POST', '/api/auth/password', { current: PASSWORD, next: NEXT }, session);
  await call('POST', '/api/auth/step-up', { password: NEXT }, session);
  const [name, ...value] = session.cookie.split('=');
  const file = path.join(AUTH_DIR, `own-${username}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      cookies: [{ name, value: value.join('='), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }],
      origins: [
        {
          origin: origin(),
          localStorage: [
            { name: 'sm.lastUser', value: username },
            { name: 'sm.sessionKey', value: session.key },
            { name: 'sm.linkKey', value: session.link },
          ],
        },
      ],
    }),
  );
  return { username, file, headers: { 'x-sm-client': '1', 'x-sm-session': session.key } };
}

/** An API client signed in as the user (dispose it when done). */
export const ownApi = (u: OwnUser): Promise<APIRequestContext> =>
  pwRequest.newContext({ baseURL: baseURL(), storageState: u.file, extraHTTPHeaders: u.headers });

/**
 * The fixtures' `test` with a designer of its own per worker (`designer`), signed in for the pages (`storageState`) and
 * as an API client (`designerApi`).
 */
export const designerTest = test.extend<{ designerApi: APIRequestContext }, { designer: OwnUser }>({
  designer: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument
    async ({}, use) => {
      await use(await ownUser('e2e-designer-', ['designer'], 'Dana Designer (own)'));
    },
    { scope: 'worker' },
  ],
  storageState: async ({ designer }, use) => use(designer.file),
  designerApi: async ({ designer }, use) => {
    const api = await ownApi(designer);
    await use(api);
    await api.dispose();
  },
});
