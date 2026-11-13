import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { USERS, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';
import { sessionState, ISOLATED_SETUP_MS, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * The module registry (0.11.0, ADR 0016): Settings → Modules lists the optional areas with their maturity and a
 * switch. Switched off, an area is gone from the sidebar and its tabs, its pages say so, its routes answer 404; on
 * again, its data is back. Switching changes the whole installation, so these tests run on a server of their own.
 * Also: what a person may see (honest empty states) and the glossary, on the shared demo server.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test.describe('switching a module (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  const contexts: BrowserContext[] = [];
  test.beforeAll(async () => {
    test.setTimeout(ISOLATED_SETUP_MS);
    srv = await startIsolatedServer({ demo: true });
    await srv.api('POST', '/demo/setup', {});
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  async function open(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      viewport,
      storageState: sessionState(srv.baseURL, srv.adminCookie, srv),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  test('Settings → Modules: maturity, a switch with a step-up; off, Costs is gone and explained; on, its data is back', async ({ browser }) => {
    test.setTimeout(120_000);
    const before = await srv.api('GET', '/costs?scope=service');
    const page = await open(browser);
    await page.goto('/settings/modules');
    const card = page.getByTestId('modules-card');
    await expect(card.getByRole('heading', { name: 'Modules' })).toBeVisible();
    const costs = card.getByTestId('module-costs');
    await expect(costs).toContainText('Costs');
    await expect(costs.getByTestId('maturity-badge')).toHaveText(/preview/);
    await expect(card.getByTestId('module-compliance').getByTestId('maturity-badge')).toHaveText(/stable/);
    // who may use it (ADR 0034): everyone signed in by default; the status pages cannot be restricted
    await expect(costs.getByTestId('module-costs-access-mode')).toContainText('Everyone signed in');
    await expect(costs.getByRole('button', { name: 'Who may use it: Costs' })).toBeVisible();
    await expect(card.getByTestId('module-statusPages-access')).toHaveCount(0);
    // the plant registry and its map are switched in their own cards below, off by default
    await expect(card.getByTestId('module-plant-state')).toHaveText('Off');
    await expect(card.getByTestId('module-plant').getByRole('switch')).toHaveCount(0);
    await expectAccessible(page, 'settings modules');

    // switching asks for a fresh confirmation
    await srv.api('DELETE', '/auth/step-up');
    const toggle = costs.getByRole('switch', { name: 'Switch Costs on' });
    await expect(toggle).toBeChecked();
    await toggle.click({ force: true });
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('step-up-actions')).toContainText('Switch a module on or off');
    await dialog.getByLabel('Your password').fill(USERS.admin.password);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('Costs is switched off – its data is kept')).toBeVisible();

    // off: no Costs tab beside Services, the page explains, the API answers 404
    await page.goto('/services');
    await settle(page);
    await expect(page.getByRole('navigation', { name: 'Services' }).getByRole('link')).toHaveText(['Services', 'Scorecard']);
    await page.goto('/costs');
    const off = page.getByTestId('module-off');
    await expect(off).toContainText('This area is switched off');
    await expect(off.getByRole('link', { name: 'Open Settings → Modules' })).toHaveAttribute('href', /\/settings\/modules$/);
    await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
    await expectAccessible(page, 'switched-off module page');
    const res = await page.request.get(`${srv.baseURL}/api/costs`, { headers: { 'x-sm-session': srv.sessionKey } });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe('MODULE_OFF');
    // the audit log has it
    const audit = (await srv.api('GET', '/audit?action=module.disabled')) as { entityId: string }[];
    expect(audit.map((e) => e.entityId)).toContain('module:costs');

    // on again (the confirmation is still fresh): the tab and the data are back
    await page.goto('/settings/modules');
    await page.getByTestId('module-costs').getByRole('switch').click({ force: true });
    await expect(page.getByTestId('module-costs').getByRole('switch')).toBeChecked();
    await page.goto('/costs');
    await settle(page);
    await expect(page.getByTestId('module-off')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Services' }).getByRole('link')).toHaveText(['Services', 'Scorecard', 'Costs']);
    expect(await srv.api('GET', '/costs?scope=service')).toEqual(before);
  });

  test('a module the person does not use (ADR 0034): gone from the sidebar and tabs, its pages say so, its API answers 404', async ({ browser }) => {
    test.setTimeout(120_000);
    // restricting narrows: no step-up; the administrators (and auditors) keep it
    await srv.api('PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [] });
    try {
      const login = await fetch(`${srv.baseURL}/api/auth/login`, {
        method: 'POST',
        headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERS.vera.username, password: USERS.vera.password }),
      });
      expect(login.ok).toBe(true);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const sessionKey = login.headers.get('x-sm-session-key') ?? '';
      const ctx = await browser.newContext({
        baseURL: srv.baseURL,
        serviceWorkers: 'block',
        locale: 'en-GB',
        viewport: { width: 1280, height: 900 },
        storageState: sessionState(srv.baseURL, cookie, { sessionKey, linkKey: login.headers.get('x-sm-link-key') ?? '' }),
      });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto('/services');
      await settle(page);
      await expect(page.getByRole('navigation', { name: 'Services' }).getByRole('link')).toHaveText(['Services', 'Scorecard']);
      await page.goto('/costs');
      const notYours = page.getByTestId('module-not-yours');
      await expect(notYours).toContainText('You do not use this module');
      await expect(notYours).toContainText('Ask an administrator if you need it.');
      await expect(notYours.getByRole('link')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
      await expectAccessible(page, 'module not used page');
      const res = await page.request.get(`${srv.baseURL}/api/costs`, { headers: { 'x-sm-session': sessionKey } });
      expect(res.status()).toBe(404);
      expect((await res.json()).code).toBe('MODULE_NO_ACCESS');
      // the administrator still has it
      const admin = await open(browser);
      await admin.goto('/costs');
      await settle(admin);
      await expect(admin.getByTestId('module-not-yours')).toHaveCount(0);
      await expect(admin.getByTestId('module-off')).toHaveCount(0);
    } finally {
      await srv.api('POST', '/auth/step-up', { password: USERS.admin.password });
      await srv.api('PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [] });
    }
  });

  test('a switched-off area leaves the sidebar; its pages are explained on a phone, too', async ({ browser }) => {
    await srv.api('PUT', '/settings/modules/compliance', { enabled: false });
    try {
      const page = await open(browser);
      await page.goto('/');
      await settle(page);
      await expect(sidebar(page).locator('[data-areas="ready"]')).toHaveCount(1);
      await expect(sidebar(page).getByRole('group', { name: 'Compliance', exact: true })).toHaveCount(0);
      await page.goto('/compliance/reconciliation');
      await expect(page.getByTestId('module-off')).toContainText('This area is switched off');

      const phone = await open(browser, { width: 390, height: 844 });
      await phone.goto('/compliance/controls');
      await expect(phone.getByTestId('module-off')).toBeVisible();
      await expectNoHorizontalScroll(phone);
    } finally {
      await srv.api('PUT', '/settings/modules/compliance', { enabled: true });
    }
  });
});

test.describe('what a viewer may see', () => {
  test.use({ storageState: authFile('vera') });

  test('an area with entries the viewer may not see says so, instead of "nothing yet"', async ({ page, apiAs }) => {
    // the demo has access checks; the viewer uses no platform, so none of them is theirs to read
    const checks = (await (await (await apiAs('admin')).get('/api/compliance/access-checks')).json()) as unknown[];
    expect(checks.length).toBeGreaterThan(0);
    await page.goto('/compliance/reconciliation');
    await settle(page);
    const empty = page.getByTestId('empty-restricted');
    await expect(empty).toContainText('Nothing here you may see');
    await expect(empty).toContainText('Ask an administrator or the team that owns them.');
    await expectAccessible(page, 'restricted empty state');
    // … and the sidebar has no entry for it
    await expect(sidebar(page).getByRole('link', { name: 'Access reconciliation' })).toHaveCount(0);
  });
});

test.describe('glossary', () => {
  test.use({ storageState: authFile('olivia') });

  test('Help → Glossary explains the catalogue terms (en and de)', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.getByTestId('help-menu').click();
    await page.getByRole('menuitem', { name: 'Glossary' }).click();
    const dialog = page.getByRole('dialog', { name: 'Glossary' });
    await expect(dialog).toContainText('A service consists of applications. An application runs on systems.');
    for (const term of ['Service', 'Application', 'System', 'Component', 'Platform', 'Process', 'Run', 'Monitor', 'Document', 'Owning team'])
      await expect(dialog.getByRole('rowheader', { name: new RegExp(term, 'i') }).first()).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Full glossary in the documentation' })).toHaveAttribute('href', /docs\/GLOSSARY\.md$/);
    await expectAccessible(page, 'glossary');
    await page.keyboard.press('Escape');

    await page.evaluate(() => localStorage.setItem('steward.language', 'de'));
    await page.reload();
    await settle(page);
    await page.getByTestId('help-menu').click();
    await page.getByRole('menuitem', { name: 'Glossar' }).click();
    const de = page.getByRole('dialog', { name: 'Glossar' });
    await expect(de).toContainText('Ein Service besteht aus Anwendungen.');
    await expect(de.getByRole('rowheader', { name: 'Plattform' })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('steward.language', 'en'));
  });
});
