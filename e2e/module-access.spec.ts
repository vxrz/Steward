import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { USERS } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';
import { sessionState, ISOLATED_SETUP_MS, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Who may use a module (0.21.0, ADR 0034, #295): Settings → Modules → Who may use it restricts a module to selected
 * teams and users. The dialog previews who gains and who loses the module; narrowing is confirmed in the dialog,
 * widening with the step-up. The report schedule form names the recipients who get the report without the sections of
 * a module they do not use. Changing who uses a module affects the whole installation: a server of its own.
 */

test.describe('who may use a module (own server)', () => {
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

  async function open(browser: Browser, o: { viewport?: { width: number; height: number }; lang?: 'en' | 'de' } = {}): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: o.lang === 'de' ? 'de-DE' : 'en-GB',
      viewport: o.viewport ?? { width: 1280, height: 900 },
      storageState: sessionState(srv.baseURL, srv.adminCookie, srv),
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    if (o.lang) await page.addInitScript((lang) => localStorage.setItem('steward.language', lang), o.lang);
    return page;
  }

  const grants = async (id: string) => ((await srv.api('GET', `/settings/modules/${id}/access`)) as { grants: { subject: string }[] }).grants.map((g) => g.subject);

  test('restrict Costs to one user: preview and confirmation; widen with the step-up; open it again', async ({ browser }) => {
    test.setTimeout(150_000);
    const page = await open(browser);
    await page.goto('/settings/modules');
    const row = page.getByTestId('module-costs');
    await expect(row.getByTestId('module-costs-access-mode')).toHaveAttribute('data-mode', 'everyone');
    await expect(row.getByTestId('module-costs-access-mode')).toContainText('Everyone signed in');
    // the status pages publish: they cannot be restricted
    await expect(page.getByTestId('module-statusPages-access')).toHaveCount(0);

    // narrowing: the preview names who loses the module, and the dialog asks once more
    await row.getByRole('button', { name: 'Who may use Costs' }).click();
    const dialog = page.getByRole('dialog', { name: 'Who may use Costs' });
    await expect(dialog).toContainText('Now: everyone signed in uses this module.');
    await dialog.getByRole('radio', { name: 'Selected teams and users' }).check();
    await dialog.getByTestId('subjects-input').click();
    await page.keyboard.type(USERS.dana.username);
    await page.getByRole('option', { name: `(${USERS.dana.username})` }).click();
    await page.keyboard.press('Escape');
    const loses = dialog.getByTestId('module-access-loses');
    await expect(loses).toContainText(/people lose the module/);
    await expect(loses).toContainText(`(${USERS.vera.username})`);
    await expect(loses).not.toContainText(`(${USERS.dana.username})`);
    await expect(dialog.getByTestId('module-access-gains')).toHaveCount(0);
    await expectAccessible(page, 'module access dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const confirm = dialog.getByTestId('module-access-confirm');
    await expect(confirm).toContainText('Restrict Costs');
    await expect(confirm).toContainText(/people lose the module/);
    await expectAccessible(page, 'module access confirmation');
    await confirm.getByRole('button', { name: 'Restrict access' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Saved who may use Costs')).toBeVisible();
    await expect(row.getByTestId('module-costs-access-mode')).toHaveAttribute('data-mode', 'selected');
    expect(await grants('costs')).toEqual([`user:${USERS.dana.username}`]);

    // widening: the preview names who gains it, saving asks for the step-up
    await srv.api('DELETE', '/auth/step-up');
    await row.getByRole('button', { name: 'Who may use Costs' }).click();
    await expect(dialog).toContainText('Now: Dana');
    await dialog.getByTestId('subjects-input').click();
    await page.keyboard.type(USERS.vera.username);
    await page.getByRole('option', { name: `(${USERS.vera.username})` }).click();
    await page.keyboard.press('Escape');
    await expect(dialog.getByTestId('module-access-gains')).toContainText('1 person gains the module');
    await expect(dialog).toContainText('saving asks you to confirm that it is you');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(stepUp.getByTestId('step-up-actions')).toContainText('Give rights in an access list');
    await stepUp.getByLabel('Your password').fill(USERS.admin.password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();
    expect((await grants('costs')).sort()).toEqual([`user:${USERS.dana.username}`, `user:${USERS.vera.username}`]);

    // open to everyone again (the confirmation is still fresh)
    await row.getByRole('button', { name: 'Who may use Costs' }).click();
    await dialog.getByRole('radio', { name: 'Everyone signed in' }).check();
    await expect(dialog.getByTestId('module-access-gains')).toContainText(/gain/);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId('module-costs-access-mode')).toHaveAttribute('data-mode', 'everyone');
    const audit = (await srv.api('GET', '/audit?action=access.module_access_changed')) as { action: string; entityId: string }[];
    expect(audit.filter((e) => e.entityId === 'module:costs')).toHaveLength(3);
  });

  test('the dialog on a phone, in German', async ({ browser }) => {
    const page = await open(browser, { viewport: { width: 390, height: 844 }, lang: 'de' });
    await page.goto('/settings/modules');
    const row = page.getByTestId('module-plant');
    await expect(row.getByTestId('module-plant-access-mode')).toContainText('Alle angemeldeten Personen');
    await row.getByRole('button', { name: 'Wer darf Werksregister nutzen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Wer darf Werksregister nutzen' });
    await expect(dialog).toContainText('Administratoren und Auditoren nutzen immer jedes Modul.');
    await dialog.getByRole('radio', { name: 'Ausgewählte Teams und Benutzer' }).check();
    await expect(dialog.getByTestId('module-access-loses')).toContainText(/Personen verlieren das Modul/);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'module access dialog on a phone (de)');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeHidden();
    expect(await grants('plant')).toEqual([]);
  });

  test('the report schedule form names recipients who get the report without a module they do not use', async ({ browser }) => {
    // narrowing: no step-up
    await srv.api('PUT', '/settings/modules/scorecard/access', { mode: 'selected', grants: [{ subject: `user:${USERS.dana.username}` }] });
    try {
      const page = await open(browser);
      await page.goto('/reports');
      await page
        .getByRole('button', { name: /New schedule|New report schedule/ })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Name' }).fill('Invented weekly review (modules)');
      await dialog.getByRole('checkbox', { name: 'Service scorecard' }).check();
      await dialog.getByRole('textbox', { name: 'Users' }).click();
      await page.keyboard.type(USERS.vera.username);
      await page.getByRole('option', { name: `(${USERS.vera.username})` }).click();
      await page.keyboard.press('Escape');
      const hint = dialog.getByTestId('schedule-module-recipients');
      await expect(hint).toContainText('Without the Scorecard sections (they do not use the module):');
      await expect(hint).toContainText(`(${USERS.vera.username})`);
      await expectAccessible(page, 'report schedule with recipients who do not use a module');
      // Dana uses it: only Vera is named
      await dialog.getByRole('textbox', { name: 'Users' }).click();
      await page.keyboard.type(USERS.dana.username);
      await page.getByRole('option', { name: `(${USERS.dana.username})` }).click();
      await page.keyboard.press('Escape');
      await expect(hint).not.toContainText(`(${USERS.dana.username})`);
    } finally {
      await srv.api('POST', '/auth/step-up', { password: USERS.admin.password });
      await srv.api('PUT', '/settings/modules/scorecard/access', { mode: 'everyone', grants: [] });
    }
  });
});
