import { type Browser, type BrowserContext } from '@playwright/test';
import { test, expect, USERS } from './support/fixtures';
import { expectAccessible } from './support/axe';
import { sessionState, ISOLATED_SETUP_MS, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Assurance policy (#210): Settings → Assurance policy shows every control point with its four-eyes and step-up rule,
 * the baseline locked; an administrator turns on the step-up for approving records, and the approver then confirms
 * it is them in the step-up dialog before the approval goes through. On a server of its own: the policy is instance-wide.
 */

let srv: IsolatedServer;
test.beforeAll(async () => {
  test.setTimeout(ISOLATED_SETUP_MS);
  srv = await startIsolatedServer({ demo: true });
  await srv.api('POST', '/demo/setup', {});
});
test.afterAll(async () => {
  await srv?.stop();
});

/** A session of its own for `user` (the API with its cookie and key); `unconfirmed`: its step-up is ended first. */
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
    if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  if (opts.unconfirmed) await call('DELETE', '/auth/step-up');
  return { cookie, keys, call };
}

const contextFor = (browser: Browser, cookie: string, keys: { sessionKey: string; linkKey: string }, mobile = false): Promise<BrowserContext> =>
  browser.newContext({
    baseURL: srv.baseURL,
    serviceWorkers: 'block',
    locale: 'en-GB',
    storageState: sessionState(srv.baseURL, cookie, keys),
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  });

test('the assurance policy page shows the control points with their baseline, overrides and the report', async ({ browser }) => {
  const ctx = await contextFor(browser, srv.adminCookie, { sessionKey: srv.sessionKey, linkKey: srv.linkKey });
  try {
    const page = await ctx.newPage();
    await page.goto('/settings/assurance');
    await expect(page.getByRole('heading', { name: 'Assurance policy', level: 5 })).toBeVisible();
    await expect(page.getByTestId('assurance-version')).toHaveText(/^Version \d+$/);
    for (const g of ['Identity and access', 'Audit and evidence', 'Changes and documents', 'Processes and runs', 'MCP and AI'])
      await expect(page.getByRole('heading', { name: g })).toBeVisible();
    // the baseline is locked; the new points are off and marked new
    const vault = page.getByTestId('assurance-row-vault.passphrase');
    await expect(vault.locator('[data-locked]')).toHaveText('Always – Baseline – cannot be lowered');
    const approve = page.getByTestId('assurance-row-record.approve');
    await expect(approve).toContainText('Approve or reject a document');
    await expect(approve).toContainText('new');
    await expect(page.getByTestId('assurance-overrides')).toContainText('Document type');
    await expect(page.getByTestId('assurance-history')).toBeVisible();
    await expect(page.getByTestId('assurance-report-download')).toBeVisible();
    await expectAccessible(page, 'assurance policy');
  } finally {
    await ctx.close();
  }
});

test('the assurance policy page works on a phone @mobile', async ({ browser }) => {
  const ctx = await contextFor(browser, srv.adminCookie, { sessionKey: srv.sessionKey, linkKey: srv.linkKey }, true);
  try {
    const page = await ctx.newPage();
    await page.goto('/settings/assurance');
    await expect(page.getByTestId('assurance-row-record.approve')).toBeVisible();
    // no horizontal page scroll: the tables scroll inside their cards
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(page.getByTestId('assurance-report-download')).toBeVisible();
    await expectAccessible(page, 'assurance policy (phone)');
  } finally {
    await ctx.close();
  }
});

test('turning on the step-up for record approval asks the approver to confirm before approving', async ({ browser }) => {
  // the administrator turns it on (a stricter rule applies at once)
  const adminCtx = await contextFor(browser, srv.adminCookie, { sessionKey: srv.sessionKey, linkKey: srv.linkKey });
  const page = await adminCtx.newPage();
  await page.goto('/settings/assurance');
  // (the server of this file is fresh: nothing turned the step-up on yet)
  await expect(page.getByTestId('assurance-version')).toHaveText('Version 0');
  await expect(page.getByTestId('assurance-stepup-record.approve')).not.toBeChecked();
  await page.getByTestId('assurance-stepup-record.approve').check({ force: true });
  await expect(page.getByTestId('settings-save-bar')).toContainText('Unsaved changes');
  await page.getByTestId('settings-save-bar').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('assurance-version')).toHaveText('Version 1');
  await expect(page.getByTestId('assurance-history')).toContainText('Approve or reject a document – step-up: off → on');
  await adminCtx.close();

  // Dana submits a change request
  const dana = await session('dana');
  const record = await dana.call('POST', '/records', {
    type: 'CR',
    title: 'Assurance e2e change',
    fields: { reason: 'Test', risk: 'low', rollbackPlan: 'Undo' },
    body: 'x',
  });
  await dana.call('POST', `/records/${record.id}/transition`, { action: 'submit' });

  // Adam approves: the dialog asks for his password first, then the approval goes through by itself
  const a = await session('adam', { unconfirmed: true });
  const adam = await contextFor(browser, a.cookie, a.keys);
  try {
    const ap = await adam.newPage();
    await ap.goto(`/records/${record.id}`);
    await ap.getByRole('button', { name: 'Approve', exact: true }).click();
    const decide = ap.getByRole('dialog', { name: /^Approve: CR-/ });
    await decide.getByRole('textbox', { name: 'Comment' }).fill('Confirmed');
    await decide.getByRole('button', { name: 'Approve', exact: true }).click();
    const stepUp = ap.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(stepUp).toBeVisible();
    await expect(stepUp.getByTestId('step-up-actions')).toContainText('Approve or reject a document');
    await expectAccessible(ap, 'step-up dialog (record approval)');
    await stepUp.getByLabel('Your password').fill(USERS.adam.password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(stepUp).toBeHidden();
    await expect(ap.getByRole('heading', { level: 1 })).toContainText('Approved');
  } finally {
    await adam.close();
  }
  // the approval carries its proof in the audit log
  const entries = await srv.api('GET', `/audit?entityId=${record.id}&limit=20`);
  const approved = entries.find((e: { action: string }) => e.action === 'record.approve');
  expect(approved.details.assurance[0]).toMatchObject({
    point: 'record.approve',
    actor: 'adam',
    stepUp: { method: 'password' },
    fourEyes: { approver: 'adam' },
  });
});
