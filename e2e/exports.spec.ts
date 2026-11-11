import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { USERS } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll } from './support/helpers';
import { sessionState, ISOLATED_SETUP_MS, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * 0.16.0 (ADR 0027): Settings → Exports – an export of the cost plans and the plant registry to the demo's S3, run now,
 * its run in the history – and Settings → Backups → Contents: leaving run artifacts out shows what a restore lacks.
 * – and (0.18.0) a backup target changed by whoever manages its platform, confirmed again. They change the whole
 * installation (backup settings, the plant module), so they run on a server of their own.
 */

test.describe('exports and backup contents (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  const contexts: BrowserContext[] = [];
  test.beforeAll(async () => {
    test.setTimeout(ISOLATED_SETUP_MS);
    srv = await startIsolatedServer({ demo: true });
    await srv.api('POST', '/demo/setup', {});
    await srv.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    await srv.api('POST', '/platforms', {
      name: 'Invented export bucket',
      kind: 'generic',
      baseUrl: `${srv.baseURL}/mock/s3/e2e-exports`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
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

  /** Confirms with the password when the step-up dialog asks before `done` shows. */
  async function confirmIfAsked(page: Page, done: Locator): Promise<void> {
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(done.or(dialog).first()).toBeVisible();
    if (await dialog.isVisible()) {
      await dialog.getByLabel('Your password').fill(USERS.admin.password);
      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(dialog).toBeHidden();
    }
  }

  test('Settings → Exports: define an export of the cost plans and the plant registry, run it, see the run', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser);
    await page.goto('/settings/exports');
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Exports');
    await expect(page.getByText(/not for a restore/)).toBeVisible();
    await expect(page.getByTestId('empty-state')).toContainText('No exports yet');

    // defining an export asks for a fresh confirmation (control point export.settings)
    await srv.api('DELETE', '/auth/step-up');
    await page.getByRole('button', { name: 'New export' }).click();
    const form = page.getByRole('dialog', { name: 'New export' });
    await expect(form).toBeVisible();
    await form.getByLabel('Name').fill('finance-share');
    await chooseOption(page, /S3 storage/, 'Invented export bucket');
    await form.getByTestId('export-part-costPlans').check();
    await form.getByTestId('export-part-plant').check();
    await chooseOption(page, 'Format of Plant registry', 'YAML');
    await expect(form.getByRole('combobox', { name: 'Fiscal year' })).toHaveValue('Current fiscal year');
    // readable by default; encryption needs the backup passphrase
    await expect(form.getByRole('switch', { name: 'Encrypt the files with the backup key' })).not.toBeChecked();
    await expectAccessible(page, 'export form');
    await form.getByRole('button', { name: 'Save' }).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(stepUp).toBeVisible();
    await expect(stepUp.getByTestId('step-up-actions')).toContainText('Define, change or remove a scheduled export');
    await stepUp.getByLabel('Your password').fill(USERS.admin.password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(form).toBeHidden();

    const card = page.getByTestId('export-card').filter({ hasText: 'finance-share' });
    await expect(card).toContainText('Cost plans and entries · CSV');
    await expect(card).toContainText('Plant registry · YAML');
    await expect(card).toContainText('Readable');
    await card.getByRole('button', { name: 'Run now' }).click();
    await expect(card.getByTestId('export-last-status')).toHaveText('Succeeded', { timeout: 30_000 });

    await card.getByRole('button', { name: 'History' }).click();
    const runs = card.getByTestId('export-runs');
    await expect(runs).toContainText('Succeeded');
    await runs.getByText('Succeeded').first().click();
    await expect(card.getByText(/^plant-registry\.yaml · /)).toBeVisible();
    await expect(card.getByText(/^manifest\.json · /)).toBeVisible();
    await expect(card.getByText(/^cost-plan-lines-FY-\d{4}/)).toBeVisible();
    await expectAccessible(page, 'settings exports');

    // what the bucket holds: the run's files, readable
    const [job] = (await srv.api('GET', '/exports')).jobs;
    expect(job.lastRun.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['plant-registry.yaml', 'manifest.json']));
  });

  test('Settings → Exports on a phone', { tag: '@mobile' }, async ({ browser }) => {
    // the mobile project runs this test alone, on a server of its own: the export comes from the API there
    if (!(await srv.api('GET', '/exports')).jobs.length) {
      await srv.api('POST', '/auth/step-up', { password: USERS.admin.password });
      const platformId = (await srv.api('GET', '/platforms')).find((p: { name: string }) => p.name === 'Invented export bucket').id;
      await srv.api('POST', '/exports', {
        name: 'finance-share',
        enabled: true,
        platformId,
        prefix: 'exports/',
        cron: '30 3 * * 1',
        timezone: 'Europe/Berlin',
        parts: [{ id: 'costPlans', format: 'csv', fiscalYear: 'current' }],
        encrypt: false,
        keepRuns: 5,
      });
    }
    const page = await open(browser, { width: 390, height: 844 });
    await page.goto('/settings/exports');
    await expect(page.getByTestId('export-card').filter({ hasText: 'finance-share' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('Settings → Backups → Contents: leaving out run artifacts shows what a restore lacks', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await open(browser);
    await page.goto('/settings/backups');
    const contents = page.getByTestId('backup-contents');
    await expect(contents.getByRole('heading', { name: 'Contents' })).toBeVisible();
    await expect(contents.getByText('Vault (vault.json)')).toBeVisible();
    await expect(contents.getByText('Always included').first()).toBeVisible();
    await contents.getByRole('button', { name: 'Show sizes' }).click();
    await expect(contents.getByText(/ in \d+ files?$/).first()).toBeVisible();
    const artifacts = contents.getByRole('checkbox', { name: 'Run artifacts (artifacts/)' });
    await expect(artifacts).toBeChecked();
    await expect(page.getByTestId('backup-contents-warning')).toHaveCount(0);

    await artifacts.uncheck();
    const warning = page.getByTestId('backup-contents-warning');
    await expect(warning).toContainText('A restore from these backups lacks evidence');
    await expect(warning).toContainText('Left out: Run artifacts (artifacts/)');
    await expect(contents).toContainText('cannot be made again');
    await expectAccessible(page, 'backup contents');
    await contents.getByRole('button', { name: 'Save contents' }).click();
    // leaving evidence out is confirmed, naming what a restore lacks
    const confirm = page.getByRole('dialog', { name: 'A restore from these backups lacks evidence' });
    await expect(confirm).toContainText('Run artifacts (artifacts/)');
    await confirm.getByRole('button', { name: 'Save contents' }).click();
    await confirmIfAsked(page, page.getByText('Backup contents saved'));
    await expect(page.getByText('Backup contents saved')).toBeVisible();
    expect((await srv.api('GET', '/backups')).settings.exclude).toEqual(['artifacts']);

    // stays after a reload
    await page.reload();
    await expect(page.getByTestId('backup-contents-warning')).toContainText('Run artifacts (artifacts/)');
    await expect(page.getByTestId('backup-contents').getByRole('checkbox', { name: 'Run artifacts (artifacts/)' })).not.toBeChecked();
  });

  test('Settings → Backups: a changed S3 target fails the backups until an administrator confirms it', async ({ browser }) => {
    test.setTimeout(120_000);
    await srv.api('POST', '/auth/step-up', { password: USERS.admin.password });
    const platform = await srv.api('POST', '/platforms', {
      name: 'Invented backup bucket',
      kind: 'generic',
      baseUrl: `${srv.baseURL}/mock/s3/e2e-backups`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    await srv.api('PUT', '/backups/passphrase', { passphrase: 'an invented backup passphrase 7' });
    const { settings } = await srv.api('GET', '/backups');
    await srv.api('PUT', '/backups/settings', { ...settings, platformId: platform.id, prefix: 'e2e/' });
    // whoever manages the platform points it at another bucket
    await srv.api('PUT', `/platforms/${platform.id}`, { baseUrl: `${srv.baseURL}/mock/s3/e2e-other-backups` });

    const page = await open(browser);
    await page.goto('/settings/backups');
    const alert = page.getByTestId('backup-target-changed');
    await expect(alert).toContainText('The S3 target changed – confirm it again');
    await expectAccessible(page, 'backup target changed');
    await srv.api('DELETE', '/auth/step-up');
    await alert.getByRole('button', { name: 'Confirm target' }).click();
    await confirmIfAsked(page, page.getByText('Target confirmed'));
    await expect(page.getByText('Target confirmed')).toBeVisible();
    await expect(alert).toBeHidden();
    expect((await srv.api('GET', '/backups')).targetChanged).toBe(false);
  });
});
