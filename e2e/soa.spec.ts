import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * The statement of applicability with the responsibility matrix (ADR 0029 part 2, docs/COMPLIANCE.md#statement-of-applicability):
 * a service's matrix names who does its backup; a new statement of a catalogue of its own takes the suggestion of the
 * matrix for one row, is submitted and approved by a second person (an approver), and its signed file is offered. On a
 * phone: the demo statement and the responsibilities of a demo service, with axe.
 */

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('takes a suggestion of the matrix, submits a version and has it approved by a second person', async ({ page, apiAs, browser }) => {
    const admin = await apiAs('admin');
    // a catalogue of its own (one statement per catalogue), with three controls
    const key = `E2E-SOA-${Date.now().toString(36)}`;
    const cat = await json<{ id: string; name: string }>(await admin.post('/api/compliance/catalogues', { data: { key, name: uniq('E2E controls') } }));
    const control = async (ref: string, title: string) =>
      json<{ id: string }>(await admin.post(`/api/compliance/catalogues/${cat.id}/controls`, { data: { ref, title } }));
    const backup = await control('B.1', 'backups of the service');
    const premises = await control('P.1', 'physical premises');
    const patching = await control('V.1', 'patching');
    const service = await json<{ id: string; name: string }>(await admin.post('/api/services', { data: { name: uniq('E2E soa service'), owners: [] } }));

    // the matrix: the team does the backup – and is asked for a recovery-test duty
    await page.goto(`/services/${service.id}/responsibilities`);
    const area = page.getByTestId('responsibility-backup');
    await expect(area).toContainText('Not decided');
    await area.getByRole('button', { name: 'Change Backup' }).click();
    const form = page.getByRole('dialog', { name: new RegExp(`^Backup – `) });
    await form.getByTestId('responsibility-party').click();
    await page.getByRole('option', { name: 'Our team' }).click();
    await expectAccessible(page, 'responsibility form');
    await form.getByTestId('responsibility-save').click();
    await expect(form).toBeHidden();
    await expect(area).toContainText('Our team');
    await expect(page.getByTestId('responsibility-backup-no-test')).toBeVisible();
    await expectAccessible(page, 'service responsibilities');

    // a new statement of the catalogue, scoped to the service, the backup control in the area "Backup"
    await page.goto('/compliance/soa');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Statement of applicability');
    await page.getByTestId('soa-new').click();
    const create = page.getByRole('dialog', { name: 'New statement of applicability' });
    await create.getByTestId('soa-new-catalogue').click();
    await page.getByRole('option', { name: new RegExp(`^${cat.name}`) }).click();
    await expectAccessible(page, 'new statement dialog');
    await create.getByTestId('soa-new-submit').click();
    await expect(page).toHaveURL(new RegExp(`/compliance/soa/${key}$`));
    expect(
      (await admin.put(`/api/compliance/soa/${key}/settings`, { data: { scopeServiceIds: [service.id], areaControls: { backup: [backup.id] } } })).ok(),
    ).toBe(true);
    for (const [id, body] of [
      [premises.id, { applicable: false, justification: 'No premises of our own' }],
      [patching.id, { applicable: true, justification: 'Internet-facing', status: 'planned' }],
    ] as const)
      expect((await admin.put(`/api/compliance/soa/${key}/entries/${id}`, { data: body })).ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('soa-submit')).toBeDisabled();

    // the backup row: take the suggestion of the matrix, decide it
    await page.getByRole('button', { name: 'B.1 backups of the service' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'B.1 backups of the service' });
    await expect(drawer.getByTestId('soa-suggestion')).toContainText('Our team: 1 service');
    await drawer.getByTestId('soa-take-suggestion').click();
    await expect(drawer.getByTestId('soa-party')).toHaveValue('Our team');
    await drawer.getByTestId('soa-applicable').getByText('Applies', { exact: true }).click();
    await drawer.getByTestId('soa-justification').fill('Customer data must be restorable');
    await drawer.getByTestId('soa-status').click();
    await page.getByRole('option', { name: 'Implemented', exact: true }).click();
    await expectAccessible(page, 'statement row drawer');
    await drawer.getByTestId('soa-entry-save').click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('soa-entries')).toContainText('Our team');
    await expectAccessible(page, 'statement of applicability');

    // submit: the administrator who submitted does not approve
    await page.getByTestId('soa-submit').click();
    await expect(page.getByTestId('soa-waiting')).toContainText('Version 1 waits for approval');
    await expect(page.getByTestId('soa-waiting')).toContainText('a second person approves it');
    await expect(page.getByTestId('soa-approve')).toHaveCount(0);
    // what waits: the rows as frozen
    await page.getByTestId('soa-view-waiting').click();
    const frozen = page.getByTestId('soa-version-view');
    await expect(frozen).toContainText('Customer data must be restorable');
    await expect(frozen).toContainText('SHA-256');
    await expectAccessible(page, 'a version as submitted');
    await page.keyboard.press('Escape');
    await expect(frozen).toBeHidden();
    const url = page.url();

    const ctx = await browser.newContext({ storageState: authFile('adam'), baseURL: baseURL() });
    try {
      const ap = await ctx.newPage();
      await ap.goto(url);
      await ap.getByTestId('soa-approve').click();
      const decision = ap.getByRole('dialog', { name: 'Approve version 1' });
      await decision.getByRole('textbox', { name: 'Comment' }).fill('Reviewed with the service owner');
      await expectAccessible(ap, 'approve a version');
      await decision.getByTestId('soa-decision-submit').click();
      await expect(decision).toBeHidden();
      await expect(ap.getByTestId('soa-versions')).toContainText('Approved');
    } finally {
      await ctx.close();
    }

    // the signed file of the approved version
    await page.reload();
    await expect(page.getByTestId('soa-export-zip-1')).toBeVisible();
    const zip = await admin.get(`/api/compliance/soa/${key}/versions/1/export?format=zip`);
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toContain('application/zip');
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('reads the demo statement and the responsibilities of a demo service @mobile', async ({ page, apiAs }) => {
    await page.goto('/compliance/soa');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Statement of applicability');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'statements of applicability on a phone');
    await page.goto('/compliance/soa/ISO27001');
    await expect(page.getByTestId('soa-counts')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'a statement on a phone');
    await page.getByRole('button', { name: '5.15 access control' }).first().click();
    const drawer = page.getByRole('dialog', { name: '5.15 access control' });
    await expect(drawer.getByTestId('soa-evidence')).toBeVisible();
    await expectAccessible(page, 'a statement row on a phone');
    await page.keyboard.press('Escape');

    const services = await json<{ id: string; name: string }[]>(await (await apiAs('dana')).get('/api/services'));
    const shop = services.find((s) => s.name === 'Online shop (demo)')!;
    await page.goto(`/services/${shop.id}/responsibilities`);
    await expect(page.getByTestId('responsibility-backup')).toContainText('Example Cloud GmbH');
    await expect(page.getByTestId('responsibility-backup-contract')).toContainText('RTO');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'service responsibilities on a phone');
  });
});
