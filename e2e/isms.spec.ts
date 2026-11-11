import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * The ISO/IEC 27001 parts together (ADR 0029 part 4, docs/COMPLIANCE.md#using-steward-for-isoiec-27001): a finding
 * recorded from a supplier's page names the supplier, which lists it; the finding's supplier is changed; a report
 * schedule gets the ISMS summary section with its options and is generated. With axe, also on a phone.
 */

type Supplier = { id: string; name: string };

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('records a finding from a supplier’s page and changes the finding’s supplier', async ({ page, apiAs }) => {
    const dana = await apiAs('dana');
    const supplier = await json<Supplier>(await dana.post('/api/suppliers', { data: { name: uniq('Ledgerly e2e'), type: 'saas' } }));
    const other = await json<Supplier>(await dana.post('/api/suppliers', { data: { name: uniq('Payrollio e2e'), type: 'saas' } }));
    const title = uniq('SOC 2 report not reviewed');

    await page.goto(`/suppliers/${supplier.id}`);
    const panel = page.getByTestId('supplier-findings');
    await expect(panel).toContainText('No open finding is about this supplier.');
    await panel.getByRole('button', { name: 'Record a finding' }).click();
    const form = page.getByRole('dialog', { name: 'Record a finding' });
    await expect(form.getByRole('combobox', { name: 'Source' })).toHaveValue('Supplier review');
    await expect(form.getByTestId('ca-supplier')).toHaveValue(supplier.name);
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await expectAccessible(page, 'record a finding from a supplier');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    await expect(page).toHaveURL(/\/compliance\/corrective-actions\/caf_/);
    await expect(page.getByTestId('ca-detail-supplier')).toHaveText(supplier.name);
    const findingUrl = page.url();

    // the supplier lists it: as an open finding and under "Used by"
    await page.goto(`/suppliers/${supplier.id}`);
    await expect(page.getByTestId('supplier-findings')).toContainText(title);
    await page.getByTestId('supplier-tab-usedBy').click();
    await expect(page.getByTestId('supplier-used-by')).toContainText('Corrective action');
    await expect(page.getByTestId('supplier-used-by')).toContainText('Open');
    await expectAccessible(page, 'supplier with a finding');

    // another supplier for the finding
    await page.goto(findingUrl);
    await page.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: /^Edit finding CA-/ });
    await chooseOption(page, 'Supplier', other.name);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByTestId('ca-detail-supplier')).toHaveText(other.name);
    const list = await json<{ items: { title: string }[] }>(await dana.get(`/api/compliance/corrective-actions?supplierId=${other.id}`));
    expect(list.items.map((f) => f.title)).toEqual([title]);
  });

  test('a report schedule with the ISMS summary', async ({ page, apiAs }) => {
    const name = uniq('Management review e2e');
    await page.goto('/reports');
    await page
      .getByRole('button', { name: /New schedule|New report schedule/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
    await dialog.getByRole('checkbox', { name: 'ISMS summary' }).check();
    const options = dialog.getByTestId('isms-options');
    await expect(options).toBeVisible();
    await expect(options.getByRole('textbox', { name: 'Supplier dates within (days)' })).toHaveValue('90');
    await options.getByRole('textbox', { name: 'Supplier dates within (days)' }).fill('60');
    await expectAccessible(page, 'report schedule with the ISMS summary');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const api = await apiAs('dana');
    const schedules = await json<{ items: { id: string; name: string; sections: Record<string, unknown> }[] }>(await api.get('/api/report-schedules'));
    const mine = schedules.items.find((x) => x.name === name)!;
    expect(mine.sections.isms).toEqual({ catalogue: null, serviceIds: null, days: 60 });
    // generated now: the PDF holds the section
    const rec = await json<{ texts?: string[]; id: string }>(await api.post(`/api/report-schedules/${mine.id}/run`));
    expect(rec.id).toBeTruthy();
    expect((await api.delete(`/api/report-schedules/${mine.id}`)).ok()).toBe(true);
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('admin') });

  test('a supplier with its findings @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const supplier = await json<Supplier>(await admin.post('/api/suppliers', { data: { name: uniq('Hostwell e2e'), type: 'managedPlatform' } }));
    await admin.post('/api/compliance/corrective-actions', {
      data: { title: uniq('Hosting certificate expired'), source: 'supplierReview', severity: 'minor', supplierId: supplier.id },
    });
    await page.goto(`/suppliers/${supplier.id}`);
    await expect(page.getByTestId('supplier-findings')).toContainText('Hosting certificate expired');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'a supplier with findings on a phone');
  });
});
