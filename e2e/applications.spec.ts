import { test, expect } from './support/fixtures';
import { authFile, appHref, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/**
 * Applications in the service catalogue (#84): create one, map a platform to it, rate it, add it to a service and see
 * the derived protection need there, and scope a living document to it.
 */
test('an application with a platform and a CIA rating gives its service a protection need and scopes a document', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const api = await apiAs('dana');
  const platformName = uniq('E2E IH tenant');
  const platform = await json<{ id: string }>(
    await admin.post('/api/platforms', {
      data: {
        name: platformName,
        kind: 'generic',
        baseUrl: `${baseURL()}/mock/test`,
        config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
      },
    }),
  );
  const serviceName = uniq('E2E plant service');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: serviceName, owners: [] } }));
  const name = uniq('E2E Insights Hub');

  try {
    // create the application
    await page.goto('/applications');
    await page.getByRole('button', { name: 'New application' }).first().click();
    const form = page.getByRole('dialog', { name: 'New application' });
    await form.getByRole('textbox', { name: 'Name' }).fill(name);
    await form.getByRole('textbox', { name: 'Vendor' }).fill('Siemens');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/applications\/app_[^/]+$/);
    const appId = page.url().split('/').pop()!;
    await expect(page.getByRole('heading', { level: 2 })).toContainText(name);

    // map the platform (integration)
    const integrations = page.getByTestId('application-integrations');
    await integrations.getByRole('button', { name: 'Map platform' }).click();
    const map = page.getByRole('dialog', { name: `Map a platform to ${name}` });
    await chooseOption(page, /^Platform/, platformName);
    await map.getByRole('button', { name: 'Save' }).click();
    await expect(map).toBeHidden();
    await expect(integrations.getByRole('link', { name: platformName })).toHaveAttribute('href', appHref(`/platforms/${platform.id}`));

    // rate it
    const rating = page.getByTestId('cia-rating');
    await rating.getByRole('button', { name: 'Rate' }).click();
    const rate = page.getByRole('dialog', { name: `CIA rating of ${name}` });
    await chooseOption(page, /^Confidentiality$/, /^High$/);
    await rate.getByRole('textbox', { name: /^Justification \(Confidentiality\)/ }).fill('Production data of customers');
    await chooseOption(page, /^Availability$/, 'Very high');
    await rate.getByRole('textbox', { name: /^Justification \(Availability\)/ }).fill('Plants stop without it');
    await rate.getByRole('button', { name: 'Save' }).click();
    await expect(rate).toBeHidden();
    await expect(rating.getByRole('row', { name: /Confidentiality/ })).toContainText('High');
    await expect(rating.getByRole('row', { name: /Confidentiality/ })).toContainText('Production data of customers');
    await expect(rating.getByRole('row', { name: /Integrity/ })).toContainText('Not rated');
    await settle(page);
    await expectAccessible(page, 'application page');

    // the platform page names its application
    await page.goto(`/platforms/${platform.id}`);
    await expect(page.getByTestId('platform-application').getByRole('link', { name })).toHaveAttribute('href', appHref(`/applications/${appId}`));

    // add it to the service: the service derives its protection need from it
    await page.goto(`/services/${svc.id}`);
    const apps = page.getByTestId('service-applications');
    await expect(apps).toContainText('No applications yet');
    await apps.getByRole('button', { name: 'Add application' }).click();
    const add = page.getByRole('dialog', { name: `Add an application to ${serviceName}` });
    await chooseOption(page, /^Application/, new RegExp(`^${name}`));
    await chooseOption(page, /^Role/, /^Primary$/);
    await add.getByRole('button', { name: 'Save' }).click();
    await expect(add).toBeHidden();
    await expect(apps.getByRole('listitem').filter({ hasText: name })).toContainText('Primary');
    await expect(apps.getByRole('listitem').filter({ hasText: name }).getByRole('link', { name: platformName })).toBeVisible();
    const need = page.getByTestId('protection-need');
    await expect(need.getByRole('row', { name: /Confidentiality/ })).toContainText('High');
    await expect(need.getByRole('row', { name: /Confidentiality/ })).toContainText(`from ${name}`);
    await expect(need.getByRole('row', { name: /Availability/ })).toContainText('Very high');
    await expect(need.getByRole('row', { name: /Integrity/ })).toContainText('0 of 1 applications rated');
    // … and it shows in the list
    await page.goto('/services');
    await expect(page.getByRole('row').filter({ hasText: serviceName }).getByLabel('Confidentiality: High')).toBeVisible();

    // a living document of the service applies to the application
    const title = uniq('E2E ICAM concept');
    const doc = await json<{ id: string }>(
      await api.post('/api/records', { data: { type: 'DOC', title, links: [{ kind: 'service', id: svc.id, note: '' }] } }),
    );
    await page.goto(`/records/${doc.id}`);
    const scope = page.getByTestId('record-applies-to');
    await expect(scope).toContainText('No application (the whole service)');
    await scope.getByRole('button', { name: 'Change' }).click();
    const scopeDialog = page.getByRole('dialog', { name: /^Applications DOC-/ });
    await chooseOption(page, /^Applications/, name);
    await page.keyboard.press('Escape'); // closes the dropdown, not the dialog
    await scopeDialog.getByRole('button', { name: 'Save' }).click();
    await expect(scopeDialog).toBeHidden();
    await expect(scope.getByRole('link', { name })).toHaveAttribute('href', appHref(`/applications/${appId}`));

    // the service groups its documents by application, the application lists it
    await page.goto(`/services/${svc.id}`);
    await expect(page.getByTestId(`service-documents-${appId}`)).toContainText(title);
    await settle(page);
    await expectAccessible(page, 'service with applications and protection need');
    await page.goto(`/applications/${appId}`);
    await expect(page.getByTestId('application-documents').getByRole('row').filter({ hasText: title })).toContainText('Draft');
    await expect(page.getByTestId('application-services').getByRole('link', { name: serviceName })).toBeVisible();

    // the list filters by service and protection need
    await page.goto('/applications');
    await chooseOption(page, /^Service/, serviceName);
    await expect(page.getByRole('table', { name: 'Applications' }).getByRole('link', { name })).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'applications list');

    // phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/applications/${appId}`);
    await expect(page.getByTestId('cia-rating')).toContainText('Production data of customers');
    await expectNoHorizontalScroll(page);
  } finally {
    await admin.delete(`/api/platforms/${platform.id}`);
  }
});

test.describe('CIA scale (administrator)', () => {
  test.use({ storageState: authFile('admin') });

  test('shows the BSI default levels and opens the editor', async ({ page }) => {
    await page.goto('/applications/cia-scale');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('CIA scale');
    const levels = page.getByRole('table', { name: 'Levels' });
    await expect(levels.getByRole('row')).toHaveCount(4);
    await expect(levels).toContainText('Very high');
    await page.getByRole('button', { name: 'Change scale' }).click();
    await page.getByRole('radio', { name: 'Own scale for all three dimensions' }).check();
    await expect(page.getByRole('button', { name: 'Add level' })).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'CIA scale editor');
    // nothing saved: the default stays (other tests rely on it)
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('BSI default (normal, high, very high)')).toBeVisible();
  });
});
