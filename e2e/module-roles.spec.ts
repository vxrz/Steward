import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { USERS } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';
import { sessionState, ISOLATED_SETUP_MS, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Module roles (0.23.0, ADR 0034 phase 2): viewer, contributor and manager per module. Settings → Modules → Who may use
 * it gives a team or user a module role (the preview names whose role changes; widening asks for the step-up), the user
 * form gives a person theirs, and a granted manager of the plant registry changes its content settings. Module roles
 * change the whole installation: a server of its own.
 */

test.describe('module roles (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  const contexts: BrowserContext[] = [];
  test.beforeAll(async () => {
    test.setTimeout(ISOLATED_SETUP_MS);
    srv = await startIsolatedServer({ demo: true });
    await srv.api('POST', '/demo/setup', {});
    await srv.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Components AG', labels: {}, fields: {} });
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  /** A session of `username` on the own server (the admin's by default). */
  async function session(username?: string, password?: string): Promise<{ cookie: string; sessionKey: string; linkKey: string }> {
    if (!username) return { cookie: srv.adminCookie, sessionKey: srv.sessionKey, linkKey: srv.linkKey };
    const res = await fetch(`${srv.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(res.status).toBe(200);
    return {
      cookie: res.headers.get('set-cookie')!.split(';')[0]!,
      sessionKey: res.headers.get('x-sm-session-key') ?? '',
      linkKey: res.headers.get('x-sm-link-key') ?? '',
    };
  }

  async function open(
    browser: Browser,
    o: { viewport?: { width: number; height: number }; lang?: 'en' | 'de'; user?: { username: string; password: string } } = {},
  ): Promise<Page> {
    const s = await session(o.user?.username, o.user?.password);
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: o.lang === 'de' ? 'de-DE' : 'en-GB',
      viewport: o.viewport ?? { width: 1280, height: 900 },
      storageState: sessionState(srv.baseURL, s.cookie, s),
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    if (o.lang) await page.addInitScript((lang) => localStorage.setItem('steward.language', lang), o.lang);
    return page;
  }

  const grants = async (id: string) =>
    ((await srv.api('GET', `/settings/modules/${id}/access`)) as { grants: { subject: string; role: string | null }[] }).grants;

  test('give a user the plant registry’s manager role: the preview names the change, saving asks for the step-up', async ({ browser }) => {
    test.setTimeout(150_000);
    await srv.api('DELETE', '/auth/step-up');
    const page = await open(browser);
    await page.goto('/settings/modules');
    const row = page.getByTestId('module-plant');
    await row.getByRole('button', { name: 'Who may use it: Plant registry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Who may use Plant registry' });
    // open to everyone: the list holds module roles only
    await expect(dialog.getByTestId('module-access-roles')).toContainText('viewer, contributor and manager');
    await dialog.getByTestId('subjects-input').click();
    await page.keyboard.type(USERS.vera.username);
    await page.getByRole('option', { name: `(${USERS.vera.username})` }).click();
    await page.keyboard.press('Escape');
    // each row's role field is named after its person (not only "Module role")
    const roleField = dialog.getByTestId(`module-role-user:${USERS.vera.username}`);
    await expect(roleField).toHaveAccessibleName(/^Module role of .*vera/i);
    await roleField.click();
    await page.getByRole('option', { name: /^Manager/ }).click();
    const changes = dialog.getByTestId('module-access-role-changes');
    await expect(changes).toContainText('1 person’s module role changes');
    await expect(changes).toContainText('Viewer → Manager');
    await expect(dialog).toContainText('saving asks you to confirm that it is you');
    await expectAccessible(page, 'module roles in the access dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
    await stepUp.getByLabel('Your password').fill(USERS.admin.password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();
    expect(await grants('plant')).toEqual([expect.objectContaining({ subject: `user:${USERS.vera.username}`, role: 'manager', source: 'admin' })]);
    const audit = (await srv.api('GET', '/audit?action=access.module_access_changed&limit=1')) as { details: { roles?: unknown } }[];
    expect(audit[0]!.details.roles).toEqual([{ subject: `user:${USERS.vera.username}`, before: null, after: 'manager' }]);
  });

  test('a granted manager changes the registry’s settings, not its switch', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser, { user: USERS.vera });
    await page.goto('/plant/sites');
    await page.getByTestId('plant-manager-settings').click();
    await expect(page).toHaveURL(/\/plant\/settings$/);
    await expect(page.getByTestId('plant-manager-settings-hint')).toContainText('Switching the module, who uses it and the map stay with administrators');
    await expect(page.getByTestId('plant-enabled')).toHaveCount(0);
    // the way back to the sites, and not the switch's description ("off, nothing of it shows")
    await expect(page.getByTestId('breadcrumb').getByRole('link', { name: 'Sites' })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('nothing of it shows');
    await expectAccessible(page, 'plant registry settings for managers');
    await page.getByLabel('Enterprise').fill('Invented Components AG (managed)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => ((await srv.api('GET', '/settings/plant')) as { enterprise: string }).enterprise).toBe('Invented Components AG (managed)');
  });

  test('the user form gives a person a module role; the list shows it', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser);
    await page.goto('/users');
    await page.getByRole('row').filter({ hasText: USERS.olivia.displayName }).getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    const select = dialog.getByTestId('user-module-role-costs');
    await select.click();
    await page.getByRole('option', { name: /^Manager/ }).click();
    await expectAccessible(page, 'module roles in the user form');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
    if (await stepUp.isVisible().catch(() => false)) {
      await stepUp.getByLabel('Your password').fill(USERS.admin.password);
      await stepUp.getByRole('button', { name: 'Confirm' }).click();
    }
    await expect
      .poll(async () => {
        const list = (await srv.api('GET', '/users')) as { username: string; moduleRoles?: { module: string; role: string }[] }[];
        return list.find((u) => u.username === USERS.olivia.username)?.moduleRoles;
      })
      .toEqual([{ module: 'costs', role: 'manager', source: 'admin' }]);
    await expect(page.getByText('Costs: Manager').first()).toBeVisible();
  });

  test('a Costs-only user: the sidebar holds Costs alone, Home leads there, other pages say why they are not there', async ({ browser }) => {
    test.setTimeout(120_000);
    const username = 'cora-costs';
    const first = 'Temporary-password-1';
    const own = 'Own password of Cora 2';
    await srv.api('POST', '/users', { username, displayName: 'Cora Costs', roles: [], password: first, moduleRoles: [{ module: 'costs', role: 'manager' }] });
    // the temporary password changed through the API: the session stays
    const s = await session(username, first);
    const res = await fetch(`${srv.baseURL}/api/auth/password`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json', cookie: s.cookie, 'x-sm-session': s.sessionKey },
      body: JSON.stringify({ current: first, next: own }),
    });
    expect(res.status).toBe(200);
    const status = await (
      await fetch(`${srv.baseURL}/api/auth/status`, { headers: { 'x-sm-client': '1', cookie: s.cookie, 'x-sm-session': s.sessionKey } })
    ).json();
    expect(status.me.capabilities.moduleOnly).toEqual(['costs']);
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await open(browser, { viewport, user: { username, password: own } });
      await page.goto('/');
      await expect(page).toHaveURL(/\/costs$/);
      await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
      if (viewport.width < 500)
        await page
          .getByRole('button', { name: /navigation/i })
          .first()
          .click();
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav.getByRole('link', { name: 'Costs', exact: true })).toBeVisible();
      for (const name of ['Home', 'Processes', 'Services', 'Records', 'Sites']) await expect(nav.getByRole('link', { name, exact: true }), name).toHaveCount(0);
      if (viewport.width < 500) {
        await page.keyboard.press('Escape');
        await expectNoHorizontalScroll(page);
      }
      await expectAccessible(page, `Costs for a Costs-only user (${viewport.width})`);
      await page.goto('/processes');
      await expect(page.getByTestId('empty-state')).toContainText('You only use some areas of this instance');
      await page.goto('/profile');
      await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();
    }
  });

  test('the dialog with module roles on a phone, in German', async ({ browser }) => {
    const page = await open(browser, { viewport: { width: 390, height: 844 }, lang: 'de' });
    await page.goto('/settings/modules');
    const row = page.getByTestId('module-plant');
    await row.getByRole('button', { name: 'Wer darf es nutzen: Werksregister' }).click();
    const dialog = page.getByRole('dialog', { name: 'Wer darf Werksregister nutzen' });
    await expect(dialog.getByTestId('module-access-roles')).toContainText('Leser, Mitwirkender und Verwalter');
    await expect(dialog.getByTestId(`module-role-user:${USERS.vera.username}`)).toHaveValue(/Verwalter/);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'module roles on a phone (de)');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeHidden();
  });
});
