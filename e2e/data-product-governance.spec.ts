import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Consumers, access and governance of data products (0.24.0, ADR 0036 phase 2; 0.25.1, ADR 0038 – Steward documents
 * governance, it doesn't run it): who really reads a port (read now), access documented on a registration (who decided
 * it, from the contacts), the consumers' contacts with copy and CSV, a port access review with its documented decision,
 * promotion from dev to prod with its preview and evidence, the endorsement recorded by the IT maintainer for the
 * domain's owner, asking for access answering 410, and the GDPR Art. 30 view with its exports – axe on each, cards and
 * no sideways scroll on phones. Seeded through the API.
 */

interface Seed {
  token: string;
  product: string;
  object: string;
  port: string;
}

let seeded: Promise<Seed> | null = null;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

async function seed(admin: APIRequestContext): Promise<Seed> {
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
  const token = `GOV${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const key = token.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  // the name rules of the promotion: suffix _DEV is dev, the token's prefix is prod
  await post(admin, '/api/data-products/discovery-sources', {
    name: `Governance ${token}`,
    platformId: snowflake,
    scope: [token, `${token}_DEV`],
    environmentRules: [
      { match: 'suffix', value: '_DEV', environment: 'dev' },
      { match: 'prefix', value: token, environment: 'prod' },
    ],
    enabled: false,
  });
  const el = async (name: string, environment: string) =>
    (await post(admin, '/api/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: name, environment })).id;
  const prod = await el(`${token}.SALES.ORDERS`, 'prod');
  const dev = await el(`${token}_DEV.SALES.ORDERS`, 'dev');
  await el(`${token}.RAW.ORDERS`, 'prod');
  const devRaw = await el(`${token}_DEV.RAW.ORDERS`, 'dev');
  const domain = (await post(admin, '/api/data-domains', { key: `${key}-sales`, name: `Sales ${token}`, owners: ['user:adam'] })).id;
  const product = (await post(admin, '/api/data-products', { key: `${key}-orders`, name: `Governed orders ${token}`, owners: ['user:dana'], domainId: domain }))
    .id;
  const port = (await post(admin, `/api/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  expect((await admin.put(`/api/data-products/${product}/ports/${port}/bindings/prod`, { data: { elementIds: [prod] } })).ok()).toBe(true);
  expect((await admin.put(`/api/data-products/${product}/ports/${port}/bindings/dev`, { data: { elementIds: [dev] } })).ok()).toBe(true);
  await post(admin, `/api/data-products/${product}/members`, { elementIds: [devRaw], role: 'internal' });
  const object = (
    await post(admin, '/api/data-objects', {
      key: `${key}-customer`,
      name: `Customer ${token}`,
      personalData: 'personal',
      categories: ['contact'],
      subjects: ['customers'],
      legalBasis: 'contract',
      retention: 'P10Y',
    })
  ).id;
  expect((await admin.post(`/api/data-objects/${object}/elements`, { data: { elementId: prod } })).ok()).toBe(true);
  // a registration marked as pending – its approval is not documented yet –, with its contact (0.25.1)
  await post(admin, `/api/data-products/${product}/ports/${port}/consumers`, {
    kind: 'text',
    text: `Invented BI ${token}`,
    purpose: 'Monthly close',
    endDate: '2027-12-31',
    approval: 'notDocumented',
    contacts: [{ role: 'consumerContact', contact: { name: `Invented BI lead ${token}`, email: `bi.lead.${key}@invented.example` } }],
  });
  return { token, product, object, port };
}

test.describe('governance of data products', () => {
  test.use({ storageState: authFile('dana') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('who reads, documented access, the consumers’ contacts, a port review, promotion and endorsement', async ({ page, loginAs, apiAs }) => {
    test.setTimeout(240_000);
    // who really reads: read now (the demo account's ACCESS_HISTORY)
    // the read's answer is shown at once, not after the page's queries are read again: under load that re-read (seven
    // requests, the port's view last) took longer than this test waited. Here the view's re-read is held back for
    // longer than the expectation waits – the answer must not need it.
    let views = 0;
    await page.route(/\/actual\?environment=/, async (r) => {
      if (views++ > 0) await new Promise((ok) => setTimeout(ok, 12_000));
      await r.continue().catch(() => undefined);
    });
    await page.goto(`/data-products/${s.product}/ports`);
    const port = page.getByTestId('port-orders');
    await port.getByTestId('port-actual-toggle').click();
    // the port's view is there (the toggle says what it found) before Read now is pressed
    await expect(port.getByTestId('port-actual-toggle')).toContainText(' seen, ');
    await port.getByTestId('actual-read-now').click();
    await expect(port.getByTestId('actual-read-ok')).toBeVisible();
    await page.unroute(/\/actual\?environment=/);
    await settle(page);
    // with WCAG 2.2: the toggle of a port's readers is a target of at least 24 px
    await expectAccessible(page, 'actual consumers');

    // the access was decided elsewhere: the IT maintainer documents it – who decided, from the contacts
    await post(await apiAs('dana'), '/api/contacts', { name: `Invented product owner ${s.token}` });
    await page.reload();
    await page.getByTestId('port-orders').getByTestId('port-consumers-toggle').click();
    await expect(page.getByTestId('consumer-approval-notDocumented')).toBeVisible();
    await page.getByRole('button', { name: `Change the consumer Invented BI ${s.token}` }).click();
    await page.getByTestId('consumer-documented').check();
    await page.getByTestId('consumer-decision-by-search').fill(`Invented product owner ${s.token}`);
    await page.getByRole('option', { name: new RegExp(`Invented product owner ${s.token}`) }).click();
    await expectAccessible(page, 'documented access form');
    await page.getByTestId('consumer-save').click();
    await expect(page.getByTestId('consumer-approval-documented')).toBeVisible();
    await expect(page.getByTestId('port-orders')).toContainText(`Decided by Invented product owner ${s.token}`);
    await settle(page);
    await expectAccessible(page, 'documented registration');

    // the consumers' contacts for the maintainers: names, roles, e-mail addresses, copy and CSV
    await page.getByTestId('consumer-contacts-open').click();
    const contacts = page.getByTestId('consumer-contacts');
    await expect(contacts.getByTestId('consumer-contact-row')).toContainText(`Invented BI lead ${s.token}`);
    await expect(contacts).toContainText(`bi.lead.${s.token.toLowerCase()}@invented.example`);
    await expect(contacts.getByTestId('consumer-contacts-copy')).toBeVisible();
    const csv = await page.request.get((await contacts.getByTestId('consumer-contacts-csv').getAttribute('href'))!);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(`bi.lead.${s.token.toLowerCase()}@invented.example`);
    await expectAccessible(page, 'consumers contacts');
    // a reader sees names and roles, no addresses
    const olivia = await loginAs('olivia');
    await olivia.goto(`/data-products/${s.product}/ports?contacts=all`);
    await expect(olivia.getByTestId('consumer-contacts')).toContainText(`Invented BI lead ${s.token}`);
    await expect(olivia.getByTestId('consumer-contacts')).not.toContainText('@invented.example');
    await expect(olivia.getByTestId('consumer-contacts-csv')).toHaveCount(0);
    await olivia.close();

    await page.goto(`/data-products/${s.product}/access`);
    await settle(page);
    await expectAccessible(page, 'access tab');

    // a port access review of prod: the registration, kept; the outcome decided elsewhere, recorded; four eyes off
    await page.getByTestId('review-start').click();
    await expect(page.getByTestId('review-start-four-eyes')).toContainText('Four eyes is off');
    await page.getByTestId('review-start-save').click();
    const review = page.getByTestId('review-modal');
    await expect(review.getByTestId('review-entry')).toHaveCount(1);
    await expect(review.getByTestId('review-entry')).not.toContainText('user:');
    await review.getByTestId('review-decision').click();
    await page.getByRole('option', { name: 'Keep' }).click();
    await expect(review.getByTestId('review-decision')).toHaveValue('Keep');
    await expect(review.getByTestId('review-submit')).toBeDisabled();
    await review.getByTestId('review-decision-form-by-search').fill(`Invented product owner ${s.token}`);
    await page.getByRole('option', { name: new RegExp(`Invented product owner ${s.token}`) }).click();
    await review.getByTestId('review-decision-save').click();
    await expect(review.getByTestId('review-decision-line')).toContainText(`Invented product owner ${s.token}`);
    await review.getByTestId('review-submit').click();
    await expect(review).toContainText('Approved');
    // the frozen facts in the reader's language: the registration's end date
    await expect(review.getByTestId('review-entry').first()).toContainText('until 31 Dec 2027');
    await expectAccessible(page, 'port access review');
    await page.keyboard.press('Escape');
    // … and in German, with the German date
    await page.evaluate(() => localStorage.setItem('steward.language', 'de'));
    await page.reload();
    await page.getByTestId('review-row').first().getByTestId('review-open').click();
    await expect(page.getByTestId('review-modal').getByTestId('review-entry').first()).toContainText('bis 31.12.2027');
    await expect(page.getByTestId('review-modal').getByTestId('review-entry').first()).toContainText('Registrierter Konsument');
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('steward.language', 'en'));
    await page.reload();

    // promotion from dev to prod by the name rules, with its evidence
    await page.goto(`/data-products/${s.product}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('product-promote').click();
    const preview = page.getByTestId('promotion-preview');
    await expect(preview.getByTestId('promotion-counts')).toContainText('1 found');
    await expect(preview).toContainText(`${s.token}.RAW.ORDERS`);
    await expectAccessible(page, 'promotion preview');
    await page.getByTestId('promotion-evidence-kind').click();
    await page.getByRole('option', { name: 'Change record' }).click();
    await page.getByTestId('promotion-evidence-ref').fill('CR-4711');
    await page.getByTestId('promotion-save').click();
    await expect(page.getByTestId('promotion-done')).toBeVisible();
    await expect(page.getByTestId('promotion-history')).toContainText('CR-4711');
    // promoted: the dialog closes without asking to discard what was entered
    await page.getByTestId('promotion-close').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // opened from the menu: the focus is back on the menu's button
    await expect(page.getByTestId('detail-actions')).toBeFocused();

    // the IT maintainer records the endorsement the domain's owner gave (offered first: the domain's owners)
    await page.goto(`/data-products/${s.product}`);
    await expect(page.getByTestId('product-endorsement')).toContainText('Its domain owners: Adam Approver');
    await page.getByTestId('endorse').click();
    await expect(page.getByTestId('endorse-decision')).toContainText('Adam Approver');
    await expectAccessible(page, 'endorsement form');
    await page.getByTestId('endorse-save').click();
    await expect(page.getByTestId('product-endorsement').getByTestId('product-endorsed-badge')).toContainText('Endorsed');
    await expect(page.getByTestId('endorsement-decision')).toContainText('Decided by Adam Approver');
    await expectAccessible(page, 'endorsed product');
  });

  test('asking for access answers 410: Steward documents access, the inbox is gone', async ({ apiAs, page }) => {
    const olivia = await apiAs('olivia');
    const res = await olivia.post(`/api/data-products/${s.product}/ports/${s.port}/access-requests`, {
      data: { environment: 'prod', consumer: { kind: 'text', text: 'x' }, purpose: 'x' },
    });
    expect(res.status()).toBe(410);
    expect((await res.json()).code).toBe('DATA_ACCESS_DOCUMENTED_ONLY');
    // the old address of the inbox leads to the products
    await page.goto('/data-products/access-requests');
    await expect(page).toHaveURL(/\/data-products$/);
  });

  test('the records of processing with their exports', async ({ page }) => {
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Records of processing' })).toBeVisible();
    const table = page.getByTestId('ropa-table');
    await expect(table.getByRole('link', { name: `Customer ${s.token}` })).toBeVisible();
    await expect(table).toContainText(`Governed orders ${s.token}`);
    await expect(table).toContainText('Contract – Art. 6(1)(b)');
    // the retention P10Y as people read it
    await expect(table).toContainText('10 years');
    await expect(table).not.toContainText('P10Y');
    const csv = page.getByTestId('ropa-csv');
    await expect(csv).toHaveAccessibleName('Download the records of processing as CSV');
    await expect(csv).toHaveAttribute('href', /records-of-processing\.csv\?q=/);
    const res = await page.request.get((await csv.getAttribute('href'))!);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(`Customer ${s.token}`);
    await expect(page.getByTestId('ropa-pdf')).toHaveAttribute('href', /records-of-processing\.pdf\?q=/);
    await expectAccessible(page, 'records of processing');
    // in the sidebar's Data group
    const data = page.locator('[data-group="data"]');
    await expect(data.getByRole('link', { name: 'Records of processing' })).toBeVisible();
    await expect(data.getByRole('link', { name: 'Access requests' })).toHaveCount(0);
  });

  test('governance on a phone @mobile', async ({ page, apiAs }) => {
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    await expect(page.getByTestId('ropa-card').first()).toBeVisible();
    // the card says what the table says: the data subjects too
    await expect(page.getByTestId('ropa-card').first()).toContainText('Data subjects: customers');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'records of processing on a phone');
    await page.goto(`/data-products/${s.product}/ports?contacts=all`);
    await expect(page.getByTestId('consumer-contact-row').first()).toBeVisible();
    await expect(page.getByTestId('consumer-contacts').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'consumers contacts on a phone');
    await page.goto(`/data-products/${s.product}/access`);
    await expect(page.getByTestId('product-port-reviews')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'access tab on a phone');
    await page.goto(`/data-products/${s.product}/ports`);
    await page.getByTestId('port-orders').getByTestId('port-actual-toggle').click();
    await expect(page.getByTestId('port-actual')).toBeVisible();
    // who reads: cards, no table
    await expect(page.getByTestId('port-actual').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // a port access review on a product of its own (the desktop test counts the entries of its own): the whole
    // screen, a card per entry
    const admin = await apiAs('admin');
    const own = (await post(admin, '/api/data-products', { key: `${s.token.toLowerCase()}-phone`, name: `Phone review ${s.token}`, owners: ['user:dana'] })).id;
    const ownPort = (await post(admin, `/api/data-products/${own}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
    const el = await json<{ items: { id: string }[] }>(await admin.get(`/api/data-elements?prefix=${s.token}.SALES.ORDERS&environment=prod`));
    expect((await admin.put(`/api/data-products/${own}/ports/${ownPort}/bindings/prod`, { data: { elementIds: [el.items[0]!.id] } })).ok()).toBe(true);
    await post(admin, `/api/data-products/${own}/ports/${ownPort}/consumers`, { kind: 'text', text: 'Invented phone reader' });
    await post(admin, `/api/data-products/${own}/ports/${ownPort}/reviews`, { environment: 'prod' });
    await page.goto(`/data-products/${own}/access`);
    await page.getByTestId('review-row').first().getByTestId('review-open').click();
    const review = page.getByTestId('review-modal');
    await expect(review).toBeVisible();
    await expect(review.locator('table')).toHaveCount(0);
    await expect(review.getByTestId('review-entry').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'port access review on a phone');
    await page.keyboard.press('Escape');

    // the promotion's preview: cards
    await page.goto(`/data-products/${s.product}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('product-promote').click();
    await expect(page.getByTestId('promotion-preview')).toBeVisible();
    await expect(page.getByTestId('promotion-preview').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});
