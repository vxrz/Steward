import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, USERS } from './support/fixtures';
import { expectAccessible } from './support/axe';
import { chooseRunMode } from './support/helpers';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Privileged identities (0.14.0, ADR 0009 step 4): a platform manager marks an identity privileged, an operator starts a
 * run with it (the step-up dialog asks first), the run waits for a start approval, the operator cannot approve it, and
 * a second person approves it (with a step-up) – then it runs. On a server of its own: the sessions here are unconfirmed.
 */

let srv: IsolatedServer;
let platform: { id: string; name: string };
let identityId = '';
let processId = '';
const IDENTITY = 'Directory admin';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  srv = await startIsolatedServer({ demo: true });
  await srv.api('POST', '/demo/setup', {});
  // a platform of its own with the demo Insights Hub's address, sign-in and specs (credentials through the API only)
  const demo = (await srv.api('GET', '/platforms')).find((p: { kind: string }) => p.kind === 'insights-hub');
  const full = await srv.api('GET', `/platforms/${demo.id}`);
  const { mcpGateway: _gateway, ...config } = full.config;
  const p = await srv.api('POST', '/platforms', { name: 'E2E privileged directory', kind: 'insights-hub', baseUrl: full.baseUrl, config });
  await srv.api('PUT', `/platforms/${p.id}/secrets`, { clientId: 'demo-client', clientSecret: 'demo-secret' });
  platform = { id: p.id, name: p.name };
  const i = await srv.api('POST', `/platforms/${p.id}/identities`, { name: IDENTITY, description: 'Administers the directory' });
  identityId = i.id;
  await srv.api('PUT', `/platforms/${p.id}/identities/${i.id}/secrets`, { clientId: 'demo-client', clientSecret: 'demo-secret' });
  await srv.api('PUT', `/platforms/${p.id}/identities/${i.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
  processId = (
    await srv.api('POST', '/processes', {
      definition: {
        name: 'E2E privileged read',
        privilegedFourEyes: true,
        connections: [{ slot: 'hub', kind: 'insights-hub' }],
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'users', type: 'http', connection: 'hub', method: 'GET', path: '/api/identitymanagement/v3/Users', x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'users' }],
      },
    })
  ).id;
});
test.afterAll(async () => {
  await srv?.stop();
});

/** A session of its own for `user`; `unconfirmed`: its step-up is ended first (the next sensitive action asks). */
async function session(user: keyof typeof USERS, opts: { unconfirmed?: boolean } = {}) {
  const login = await fetch(`${srv.baseURL}/api/auth/login`, {
    method: 'POST',
    headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERS[user].username, password: USERS[user].password }),
  });
  expect(login.ok).toBeTruthy();
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const keys = { sessionKey: login.headers.get('x-sm-session-key')!, linkKey: login.headers.get('x-sm-link-key')! };
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`${srv.baseURL}/api${url}`, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': keys.sessionKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  if (opts.unconfirmed) await call('DELETE', '/auth/step-up');
  return { cookie, keys, call };
}

const contextFor = (browser: Browser, s: { cookie: string; keys: { sessionKey: string; linkKey: string } }, mobile = false): Promise<BrowserContext> =>
  browser.newContext({
    baseURL: srv.baseURL,
    serviceWorkers: 'block',
    locale: 'en-GB',
    storageState: sessionState(srv.baseURL, s.cookie, s.keys),
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  });

async function confirmStepUp(page: Page, user: keyof typeof USERS, action: RegExp) {
  const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(stepUp).toBeVisible();
  await expect(stepUp.getByTestId('step-up-actions')).toContainText(action);
  await expectAccessible(page, 'step-up dialog (privileged identity)');
  await stepUp.getByLabel('Your password').fill(USERS[user].password);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

test('mark an identity privileged, start a run with it – it waits for a second person, who approves it', async ({ browser }) => {
  test.setTimeout(240_000);
  // the platform manager marks the identity privileged (a tightening: no confirmation)
  const admin = await contextFor(browser, { cookie: srv.adminCookie, keys: { sessionKey: srv.sessionKey, linkKey: srv.linkKey } });
  try {
    const page = await admin.newPage();
    await page.goto(`/platforms/${platform.id}`);
    await page.getByRole('tab', { name: 'Identities' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Identities' });
    await panel.getByTestId('identity-row').filter({ hasText: IDENTITY }).click();
    const dialog = page.getByRole('dialog', { name: `Identity “${IDENTITY}”` });
    await dialog.getByRole('switch', { name: 'Privileged' }).check();
    await dialog.getByTestId('identity-save').click();
    await expect(dialog.getByTestId('identity-register')).toContainText('no entry in the credentials register');
    await expectAccessible(page, 'privileged identity dialog');
    await page.keyboard.press('Escape');
    const row = panel.getByTestId('identity-row').filter({ hasText: IDENTITY });
    await expect(row.getByTestId('identity-privileged')).toHaveText('Privileged');
    await expect(row.getByTestId('identity-register-missing')).toBeVisible();
  } finally {
    await admin.close();
  }
  const stored = (await srv.api('GET', `/platforms/${platform.id}`)).identities.find((i: { id: string }) => i.id === identityId);
  expect(stored).toMatchObject({ privileged: true, default: false });

  // the operator starts it from the run dialog: the dialog says it is privileged, the step-up dialog asks first
  const o = await session('olivia', { unconfirmed: true });
  const olivia = await contextFor(browser, o);
  let runId: string;
  try {
    const page = await olivia.newPage();
    await page.goto(`/processes/${processId}`);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const run = page.getByRole('dialog', { name: /^Run: / });
    await run.getByRole('combobox', { name: /^Connection .hub/ }).click();
    await page.getByRole('option', { name: platform.name }).click();
    await run.getByTestId('identity-select-hub').click();
    await page.getByRole('option', { name: new RegExp(`${IDENTITY}.*Privileged`) }).click();
    await expect(run.getByTestId('identity-privileged-hint')).toBeVisible();
    await chooseRunMode(run, 'Run');
    await run.getByRole('button', { name: 'Start run' }).click();
    await confirmStepUp(page, 'olivia', /privileged platform identity/);
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    runId = page.url().split('/').pop()!;
    // waiting for the start approval; the starter cannot approve it
    await expect(page.getByTestId('run-start-approval')).toContainText('Waiting for a second person to approve the start');
    const approval = page.getByTestId('start-approval');
    await expect(approval).toContainText(`${platform.name} · ${IDENTITY}`);
    await expect(approval).toContainText('Asked by olivia');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByText(/not whoever started the run/)).toBeVisible();
    await expectAccessible(page, 'run waiting for its start approval');
  } finally {
    await olivia.close();
  }
  const waiting = await srv.api('GET', `/runs/${runId}`);
  expect(waiting.status).toBe('waiting');
  const task = waiting.tasks.find((t: { stepKey: string }) => t.stepKey === '$start');
  // self-approval refused on the server too
  const self = await o.call('POST', `/tasks/${task.id}/complete`, { approved: true });
  expect(self.status).toBe(403);
  expect(self.body.code).toBe('FOUR_EYES_START');

  // a second person with the approve right approves – with a step-up – and the run starts
  const a = await session('adam', { unconfirmed: true });
  const adam = await contextFor(browser, a);
  try {
    const page = await adam.newPage();
    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId('start-approval')).toBeVisible();
    await page.getByRole('textbox', { name: 'Comment' }).fill('Expected maintenance');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmStepUp(page, 'adam', /privileged platform identity/);
    await expect(page.getByRole('main').getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await adam.close();
  }
  const done = await srv.api('GET', `/runs/${runId}`);
  expect(done.status).toBe('succeeded');
  expect(done.bindings.hub).toMatchObject({ identityId, identityName: IDENTITY, privileged: true });
});

test('the start approval on a phone @mobile', async ({ browser }) => {
  test.setTimeout(120_000);
  await srv.api('PUT', `/platforms/${platform.id}/identities/${identityId}`, { privileged: true });
  const o = await session('olivia');
  const started = await o.call('POST', '/runs', { processId, bindings: { hub: platform.id }, identities: { hub: identityId } });
  expect(started.status).toBe(200);
  const a = await session('adam');
  const ctx = await contextFor(browser, a, true);
  try {
    const page = await ctx.newPage();
    await page.goto(`/runs/${started.body.id}`);
    await expect(page.getByTestId('run-start-approval')).toBeVisible();
    await expect(page.getByTestId('start-approval')).toContainText(IDENTITY);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expectAccessible(page, 'start approval (phone)');
  } finally {
    await ctx.close();
  }
  await srv.api('POST', `/runs/${started.body.id}/cancel`, {});
});
