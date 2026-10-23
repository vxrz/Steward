import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, platformId, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

test('an access change made outside Steward shows up as undocumented, is documented after the fact and lands in an evidence pack', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const hub = await platformId(api, 'insights-hub');
  const name = uniq('E2E access check');
  const check = await json(
    await api.post('/api/compliance/access-checks', { data: { name, platformId: hub, source: 'insights-hub', cron: '0 5 * * *', timezone: 'UTC' } }),
  );
  await json(await api.post(`/api/compliance/access-checks/${check.id}/run`, { data: {} })); // baseline

  await page.goto(`/compliance/reconciliation?check=${check.id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Access reconciliation' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Open (0)' })).toBeVisible();
  await expect(page.getByText('No undocumented changes')).toBeVisible();

  // someone grants the tenant administrator role directly in (the simulated) Insights Hub
  const simulated = page.waitForResponse((r) => r.url().endsWith('/api/compliance/demo/simulate-change') && r.status() === 200);
  await page.getByRole('button', { name: 'Simulate a change outside Steward' }).click();
  const granted = (await (await simulated).json()).granted as { userName: string };
  const findings = page.getByRole('table', { name: 'Findings' });
  const row = findings.getByRole('row').filter({ hasText: granted.userName });
  await expect(row).toContainText('mdsp:core:TenantAdmin');
  await expect(row).toContainText('Open');
  await expectAccessible(page, 'access reconciliation');

  // one click: document it after the fact
  await row.getByRole('button', { name: `Document the change of ${granted.userName}` }).click();
  const dialog = page.getByRole('dialog', { name: `Document the change of ${granted.userName}` });
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Emergency access during the outage, approved by phone (INC0042)');
  await dialog.getByRole('textbox', { name: 'Request reference' }).fill('INC0042');
  await dialog.getByRole('button', { name: 'Document', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(findings.getByRole('row').filter({ hasText: granted.userName })).toHaveCount(0);

  // the entry is in the access changes, marked as documented after the fact
  await page.getByRole('tab', { name: 'All findings' }).click();
  const documented = page.getByRole('table', { name: 'Findings' }).getByRole('row').filter({ hasText: granted.userName });
  await expect(documented).toContainText('Documented');
  await page.goto('/compliance/access-changes');
  await page.getByRole('textbox', { name: 'Subject' }).fill(granted.userName);
  const entries = page.getByRole('table', { name: 'Access changes' });
  await expect(entries.getByRole('row').filter({ hasText: granted.userName }).first()).toContainText('After the fact');
  await settle(page);
  await expectAccessible(page, 'access changes');

  // an evidence pack for ISO/IEC 27001 5.18 (access rights)
  await page.goto('/compliance/controls?catalogue=ISO27001');
  await expect(page.getByRole('heading', { level: 2, name: 'Controls' })).toBeVisible();
  const control = page.getByRole('row').filter({ hasText: 'access rights' }).filter({ hasText: '5.18' });
  await expect(control).toContainText('Covered');
  await settle(page);
  await expectAccessible(page, 'controls');
  await control.getByRole('checkbox', { name: 'Select control 5.18' }).check();
  await page.getByRole('button', { name: 'Evidence pack for 1 control' }).click();
  const create = page.getByRole('dialog', { name: 'New evidence pack' });
  const title = uniq('E2E evidence');
  await create.getByRole('textbox', { name: 'Title' }).fill(title);
  await create.getByRole('button', { name: 'Create pack' }).click();
  await expect(create).toBeHidden();
  const packRow = page.getByRole('table', { name: 'Evidence packs' }).getByRole('row').filter({ hasText: title });
  await expect(packRow).toContainText('Ready', { timeout: 30_000 });
  const href = await packRow.getByRole('link', { name: 'Download' }).getAttribute('href');
  expect(href).toContain('/download');
  const pack = (await json<any[]>(await api.get('/api/compliance/evidence-packs'))).find((p) => p.title === title);
  const zip = await api.get(`/api/compliance/evidence-packs/${pack.id}/download`);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect((await zip.body()).subarray(0, 2).toString('latin1')).toBe('PK');
  await settle(page);
  await expectAccessible(page, 'evidence packs');
});

test('with four-eyes dismissals, a second person confirms the dismissal of a finding', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const dana = await apiAs('dana');
  const hub = await platformId(admin, 'insights-hub');
  const check = await json(
    await dana.post('/api/compliance/access-checks', {
      data: { name: uniq('E2E four-eyes check'), platformId: hub, source: 'insights-hub', cron: '0 5 * * *', timezone: 'UTC' },
    }),
  );
  await json(await dana.post(`/api/compliance/access-checks/${check.id}/run`, { data: {} })); // baseline
  await json(await admin.put('/api/settings', { data: { findingDismissFourEyes: true } }));
  try {
    const sim = await json(await dana.post('/api/compliance/demo/simulate-change', { data: { accessCheckId: check.id } }));
    const finding = sim.result.findings[0];
    // the owner of the check asks for the dismissal: the finding stays open
    const asked = await json(await dana.post(`/api/compliance/findings/${finding.id}/dismiss`, { data: { comment: 'Vendor test account' } }));
    expect(asked).toMatchObject({ status: 'open', dismissRequestedBy: 'dana' });

    await page.goto(`/compliance/reconciliation?check=${check.id}`);
    const findings = page.getByRole('table', { name: 'Findings' });
    const row = findings.getByRole('row').filter({ hasText: finding.subjectName });
    await expect(row).toContainText('dana asked to dismiss it: Vendor test account');
    await row.getByRole('button', { name: `Confirm the dismissal of the change of ${finding.subjectName}` }).click();
    const dialog = page.getByRole('dialog', { name: `Confirm the dismissal of the change of ${finding.subjectName}` });
    await expect(dialog).toContainText('Vendor test account');
    await expectAccessible(page, 'confirm dismissal');
    await dialog.getByRole('button', { name: 'Confirm dismissal' }).click();
    await expect(dialog).toBeHidden();
    await expect(findings.getByRole('row').filter({ hasText: finding.subjectName })).toHaveCount(0);
    await page.getByRole('tab', { name: 'All findings' }).click();
    await expect(page.getByRole('table', { name: 'Findings' }).getByRole('row').filter({ hasText: finding.subjectName })).toContainText('Dismissed');
  } finally {
    await admin.put('/api/settings', { data: { findingDismissFourEyes: false } });
  }
});

test('the compliance pages work at phone width @mobile', async ({ page }) => {
  for (const [path, heading] of [
    ['/compliance/controls', 'Controls'],
    ['/compliance/access-changes', 'Access changes'],
    ['/compliance/reconciliation', 'Access reconciliation'],
    ['/compliance/evidence-packs', 'Evidence packs'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls horizontally`).toBeLessThanOrEqual(1);
  }
});
