import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Data products phase 3, package D (0.25.0, ADR 0037 parts 4 and 6): the Semantic model tab – a version started from
 * the bound contract, saved, signed off by a second person, "which model was valid on a day", a second version
 * compared with the first; the port's preview with the contract's examples; the Kafka peek of a topic element
 * (the platform's manager); the GDPR Art. 30 details of a product in the records of processing – axe on each, cards
 * and no sideways scroll on phones. Seeded through the API.
 */

interface Seed {
  token: string;
  product: string;
  object: string;
}

let seeded: Promise<Seed> | null = null;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

async function seed(admin: APIRequestContext): Promise<Seed> {
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
  const token = `SEM${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const key = token.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  const contract = (
    await post(admin, '/api/data-contracts', {
      yaml: [
        'apiVersion: v3.0.2',
        'kind: DataContract',
        `id: ${key}-orders`,
        `name: Semantic orders ${token}`,
        'version: 1.0.0',
        'status: active',
        'schema:',
        '  - name: orders',
        `    physicalName: ${token}.SALES.ORDERS`,
        '    properties:',
        '      - { name: id, logicalType: integer, primaryKey: true, examples: [1001, 1002] }',
        '      - { name: total, logicalType: number, examples: [42.5] }',
        '      - name: customer_email',
        '        logicalType: string',
        '        examples: [erika@example.com]',
        '        customProperties: [{ property: personalData, value: true }]',
      ].join('\n'),
    })
  ).id;
  const table = (
    await post(admin, '/api/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: `${token}.SALES.ORDERS`, environment: 'prod' })
  ).id;
  const product = (await post(admin, '/api/data-products', { key: `${key}-orders`, name: `Semantic orders ${token}`, owners: ['user:dana'] })).id;
  const port = (await post(admin, `/api/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  expect((await admin.put(`/api/data-products/${product}/ports/${port}/bindings/prod`, { data: { elementIds: [table], contractId: contract } })).ok()).toBe(
    true,
  );
  const object = (
    await post(admin, '/api/data-objects', {
      key: `${key}-buyer`,
      name: `Buyer ${token}`,
      personalData: 'personal',
      categories: ['contact'],
      subjects: ['buyers'],
    })
  ).id;
  expect((await admin.post(`/api/data-objects/${object}/elements`, { data: { elementId: table } })).ok()).toBe(true);
  return { token, product, object };
}

test.describe('semantic models, previews and the Art. 30 details', () => {
  test.use({ storageState: authFile('dana') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('a version from the bound contract, signed off by a second person, valid from today and compared', async ({ page, loginAs }) => {
    test.setTimeout(180_000);
    await page.goto(`/data-products/${s.product}/semantic-model`);
    await expect(page.getByTestId('semantic-none')).toBeVisible();
    await page.getByTestId('semantic-new').click();
    // an empty document is not saved, and the field says why
    await page.getByTestId('semantic-save').click();
    await expect(page.getByRole('dialog').getByText('Required', { exact: true })).toBeVisible();
    await page.getByTestId('semantic-start-from').click();
    await expect(page.getByTestId('semantic-drafted')).toContainText('1 dataset');
    expect(await page.getByTestId('semantic-document-input').inputValue()).toContain(`source: ${s.token}.SALES.ORDERS`);
    await settle(page);
    await expectAccessible(page, 'semantic model form');
    await page.getByTestId('semantic-note').fill('From the contract');
    await page.getByTestId('semantic-save').click();
    await expect(page.getByTestId('semantic-version-1')).toBeVisible();
    // people by their display names, as elsewhere in the app
    await expect(page.getByTestId('semantic-version-1')).toContainText('Dana Designer');
    await expect(page.getByTestId('semantic-current')).toContainText('saved by Dana Designer');
    // the draft has neither lint findings nor drift
    await expect(page.getByTestId('semantic-lint-none')).toBeVisible();
    await expect(page.getByTestId('semantic-drift-none')).toBeVisible();
    await expect(page.getByTestId('semantic-document')).toContainText('customer_email');
    // who saved it does not sign it off
    await expect(page.getByTestId('semantic-version-1').getByRole('button', { name: 'Sign off version 1' })).toHaveCount(0);
    // … and is told why
    await expect(page.getByTestId('semantic-version-1').getByTestId('semantic-own-version')).toHaveText(
      'You saved or proposed this version: a second person signs it off.',
    );
    await settle(page);
    await expectAccessible(page, 'semantic model tab');

    // an approver who sees the product signs it off
    const adam = await loginAs('adam');
    await adam.goto(`/data-products/${s.product}/semantic-model`);
    await adam.getByTestId('semantic-version-1').getByRole('button', { name: 'Sign off version 1' }).click();
    await expect(adam.getByTestId('semantic-document').last()).toContainText('customer_email');
    await adam.getByTestId('semantic-signoff-note').fill('Matches the contract');
    await adam.getByTestId('semantic-signoff-save').click();
    await expect(adam.getByTestId('semantic-valid-today')).toContainText('Valid today: version 1, signed off by Adam Approver');
    // which model was valid on a day
    const today = new Date().toISOString().slice(0, 10);
    await adam.getByTestId('semantic-valid-date').fill(today);
    await adam.getByTestId('semantic-valid-check').click();
    await expect(adam.getByTestId('semantic-valid-answer')).toContainText('Version 1 – signed off by Adam Approver');
    await adam.getByTestId('semantic-valid-date').fill('2020-01-01');
    await adam.getByTestId('semantic-valid-check').click();
    await expect(adam.getByTestId('semantic-valid-answer')).toContainText('No version was signed off and valid on');
    await settle(adam);
    await expectAccessible(adam, 'semantic model signed off');
    await adam.close();

    // a second version with a field the contract does not have: drift, and the comparison
    await page.reload();
    await page.getByTestId('semantic-new').click();
    const input = page.getByTestId('semantic-document-input');
    const text = await input.inputValue();
    await input.fill(
      text.replace(
        '        fields:\n',
        '        fields:\n          - name: discount\n            expression:\n              dialects:\n                - dialect: ANSI_SQL\n                  expression: \'"discount"\'\n',
      ),
    );
    await page.getByTestId('semantic-save').click();
    await expect(page.getByTestId('semantic-version-2')).toBeVisible();
    await expect(page.getByTestId('semantic-drift')).toContainText('reads the column discount, which is not in the bound contract');
    await expect(page.getByTestId('semantic-diff')).toContainText('discount');
    await expect(page.getByTestId('semantic-valid-today')).toContainText('version 1');
    await settle(page);
    await expectAccessible(page, 'semantic model compared');
  });

  test('the port’s preview: the contract’s examples, personal fields marked', async ({ page }) => {
    await page.goto(`/data-products/${s.product}/ports`);
    await page.getByTestId('port-orders').getByTestId('port-preview').click();
    const modal = page.getByTestId('port-preview-modal');
    await expect(modal.getByTestId('port-preview-examples')).toContainText(`Examples of Semantic orders ${s.token} (version 1)`);
    await expect(modal.getByTestId('port-preview-examples')).toContainText('erika@example.com');
    await expect(modal.getByTestId('port-preview-examples')).toContainText('Personal');
    await expect(modal.getByTestId('port-preview-recordings')).toContainText('No recorded responses are linked.');
    await settle(page);
    await expectAccessible(page, 'port preview');
    // Esc in the dialog opened inside closes that one only; the focus is back on its button
    await modal.getByTestId('port-recording-link').click();
    await expect(page.getByRole('dialog', { name: 'Link a recorded response' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Link a recorded response' })).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('port-recording-link')).toBeFocused();
  });

  test('the peek of a topic element: masked, for the platform’s manager', async ({ page: dana, loginAs, apiAs }) => {
    const admin = await apiAs('admin');
    const found = await json<{ items: { id: string }[] }>(await admin.get('/api/data-elements?prefix=orders.v1&kind=kafka.topic&environment=prod'));
    test.skip(!found.items.length, 'the data products demo is not loaded');
    // who does not manage the platform gets no eye
    await dana.goto(`/data-elements/${found.items[0]!.id}`);
    await expect(dana.getByTestId('element-readout')).toBeVisible();
    await expect(dana.getByTestId('element-peek')).toHaveCount(0);
    const page = await loginAs('admin');
    await page.goto(`/data-elements/${found.items[0]!.id}`);
    await page.getByTestId('element-peek').click();
    const modal = page.getByTestId('element-peek-modal');
    await modal.getByTestId('element-peek-read').click();
    await expect(modal.getByTestId('element-peek-message').first()).toBeVisible();
    await expect(modal).not.toContainText('@example.com');
    await settle(page);
    await expectAccessible(page, 'element peek');
    await page.close();
  });

  test('transfers and measures of a product in the records of processing', async ({ page }) => {
    await page.goto(`/data-products/${s.product}`);
    const card = page.getByTestId('ropa-details');
    await expect(card).toContainText('No transfers recorded.');
    await card.getByTestId('ropa-details-edit').click();
    await page.getByTestId('ropa-transfer-add').click();
    await page.getByTestId('ropa-country').fill('United States');
    await page.getByTestId('ropa-toms-kind').getByText('A link').click();
    await page.getByTestId('ropa-toms-url').fill('https://wiki.example/measures');
    await settle(page);
    await expectAccessible(page, 'records of processing form');
    await page.getByTestId('ropa-details-save').click();
    await expect(card.getByTestId('ropa-transfer')).toContainText('United States – Standard contractual clauses (Art. 46(2)(c))');
    await expect(card.getByTestId('ropa-toms')).toContainText('https://wiki.example/measures');
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    const table = page.getByTestId('ropa-table');
    await expect(table).toContainText(`United States: Standard contractual clauses (Art. 46(2)(c)) (through Semantic orders ${s.token})`);
    await expect(table).toContainText('https://wiki.example/measures');
    await expect(page.getByTestId('ropa-truncated')).toHaveCount(0);
    await expectAccessible(page, 'records of processing with transfers');
  });

  test('a version that does not parse: drift not checked, said so', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const broken = await post(admin, '/api/data-products', { key: `${s.token.toLowerCase()}-broken`, name: `Broken model ${s.token}`, owners: ['user:dana'] });
    await post(admin, `/api/data-products/${broken.id}/semantic-model/versions`, { document: 'version: 0.1.1\nsemantic_model: [1\n' });
    await page.goto(`/data-products/${broken.id}/semantic-model`);
    const version = page.getByTestId('semantic-version');
    await expect(version.getByTestId('semantic-drift-unchecked')).toHaveText('Not checked: the document does not parse (see the lint below).');
    await expect(version.getByTestId('semantic-drift-none')).toHaveCount(0);
    await expect(version).not.toContainText('Columns known for');
    await expect(version.getByTestId('semantic-lint')).toContainText('The document does not parse');
  });

  test('semantic model and records of processing on a phone @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    await post(admin, `/api/data-products/${s.product}/semantic-model/versions`, {
      document: `version: 0.1.1\nsemantic_model:\n  - name: phone\n    datasets:\n      - { name: orders, source: ${s.token}.SALES.ORDERS }\n`,
    });
    await page.goto(`/data-products/${s.product}/semantic-model`);
    await expect(page.getByTestId('semantic-version-table')).toBeVisible();
    await expect(page.getByTestId('semantic-version-table').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'semantic model on a phone');
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    await expect(page.getByTestId('ropa-card').first()).toBeVisible();
    await expect(page.getByTestId('ropa-card').first()).toContainText('Transfers to third countries');
    await expectNoHorizontalScroll(page);
  });
});
