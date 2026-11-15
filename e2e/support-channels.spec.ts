import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * Help and support (0.26.0, ADR 0039 parts 4–6, docs/SUPPORT.md): a designer gives a data product its channels, a
 * support level and a guide in the editor – checked before saving, a refusal of the server shown at its field – and the
 * product page shows them; a product supported by a service shows that service's channels and level, marked; the
 * service and application pages have the section; administrators keep Settings → Support levels. With axe, and on a
 * phone as cards without sideways scroll.
 */

test.use({ storageState: authFile('dana') });

test.beforeAll(async ({ apiAs }) => {
  const admin = await apiAs('admin');
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
});

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

test('a designer gives a product channels, a level and a guide; errors show at their field', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const name = uniq('E2E Invented support');
  const product = await json(await admin.post('/api/data-products', { data: { key: keyOf(name), name } }));
  // a level that goes away while the editor is open: the server's refusal is shown at the level field
  const doomed = await json(await admin.post('/api/support/levels', { data: { nameEn: uniq('E2E Invented doomed') } }));

  await page.goto(`/data-products/${product.id}`);
  const section = page.getByTestId('help-and-support');
  await expect(section).toContainText('No support channels yet.');
  await section.getByTestId('support-edit').click();
  const dialog = page.getByRole('dialog', { name: `Help and support of ${name}` });
  await expect(dialog.getByTestId('support-channel-hint')).toContainText('People are contacts');

  // a channel with an address Steward does not take: refused before saving, at the field
  await dialog.getByTestId('support-channel-add').click();
  await dialog.getByTestId('support-channel-address').fill('javascript:alert(1)');
  await dialog.getByTestId('support-save').click();
  await expect(dialog.getByTestId('support-channel-address')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog).toContainText('Enter an address starting with https://, mailto: or tel:');
  await dialog.getByTestId('support-channel-address').fill('mailto:orders-data@shop.example');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Orders data desk (invented)');
  await dialog.getByRole('textbox', { name: 'Hours' }).first().fill('Mo–Fr 08–17');
  // a second channel for incidents, then moved to the top
  await dialog.getByTestId('support-channel-add').click();
  const second = dialog.getByRole('group', { name: 'Channel 2' });
  await second.getByRole('combobox', { name: 'Purpose' }).click();
  await page.getByRole('option', { name: 'Issues and incidents' }).click();
  await second.getByRole('combobox', { name: 'Tool' }).click();
  await page.getByRole('option', { name: 'Ticket system' }).click();
  await second.getByTestId('support-channel-address').fill('https://tickets.example/new?queue=orders');
  await second.getByRole('textbox', { name: 'Note' }).fill('Assignment group ORDERS-DATA');
  await dialog.getByRole('button', { name: 'Move channel 2 up' }).click();
  // the focus stays on the moved row (now first: its up button is off, so on its down button), and it is said
  await expect(dialog.getByRole('button', { name: 'Move channel 1 down' })).toBeFocused();
  await expect(dialog.getByTestId('support-editor-status')).toHaveText('Channel moved to position 1 of 2');
  // a third channel, removed again: the focus goes to the remove button of the row before it
  await dialog.getByTestId('support-channel-add').click();
  await dialog.getByRole('button', { name: 'Remove channel 3' }).click();
  await expect(dialog.getByTestId('support-channel-row')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Remove channel 2' })).toBeFocused();
  await expect(dialog.getByTestId('support-editor-status')).toHaveText('Channel 3 removed');
  // a guide
  await dialog.getByTestId('support-guide-add').click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Orders data – user guide (invented)');
  await dialog.getByRole('textbox', { name: 'Web address' }).fill('https://wiki.example/orders-data/guide');
  await chooseOption(page, 'Support level', doomed.nameEn);
  await expectAccessible(page, 'support: the editor');

  expect((await admin.delete(`/api/support/levels/${doomed.id}`)).ok()).toBe(true);
  await dialog.getByTestId('support-save').click();
  await expect(dialog.getByTestId('support-level-select')).toHaveAttribute('aria-invalid', 'true');
  // said in words, without the level's internal id
  await expect(dialog).toContainText('This support level no longer exists');
  await expect(dialog).not.toContainText(doomed.id);
  await chooseOption(page, 'Support level', 'Extended');
  await dialog.getByTestId('support-save').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Help and support saved')).toBeVisible();
  // the focus is back on the button that opened the editor
  await expect(section.getByTestId('support-edit')).toBeFocused();

  // the page: channels first (incidents now on top), then the level with its promise, then the guide
  const channels = section.getByTestId('support-channel');
  await expect(channels).toHaveCount(2);
  await expect(channels.first()).toContainText('Issues and incidents');
  await expect(channels.first()).toContainText('Assignment group ORDERS-DATA');
  await expect(channels.nth(1).getByRole('link', { name: /orders-data@shop\.example/ })).toHaveAttribute('href', 'mailto:orders-data@shop.example');
  await expect(section.getByTestId('support-level')).toContainText('Extended');
  await expect(section.getByTestId('support-level')).toContainText('First response');
  await expect(section.getByTestId('support-guides').getByRole('link', { name: /user guide/ })).toHaveAttribute('target', '_blank');
  // the old fields are gone from the product form; the criticality says how it differs
  await page.getByTestId('product-edit').click();
  const form = page.getByRole('dialog').filter({ has: page.getByTestId('product-name') });
  await expect(form.getByText('Support tier')).toHaveCount(0);
  await expect(form).toContainText('How bad an outage of the product is');
  await page.keyboard.press('Escape');
  await expectAccessible(page, 'support: the product page');

  // the list: the support level is a column the reader can add (not shown at first)
  await page.goto(`/data-products?q=${encodeURIComponent(name)}`);
  const table = page.getByTestId('product-table');
  await expect(table.getByRole('link', { name })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Support level' })).toHaveCount(0);
  await page.getByTestId('product-columns').click();
  await page.getByTestId('product-column-supportLevel').check();
  await page.keyboard.press('Escape');
  await expect(table.getByRole('columnheader', { name: 'Support level' })).toBeVisible();
  await expect(table.getByRole('row').filter({ has: page.getByRole('link', { name }) })).toContainText('Extended');
});

test('a product supported by a service shows its channels and level, marked; services and applications have the section', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const svcName = uniq('E2E Invented shop service');
  const service = await json(await admin.post('/api/services', { data: { name: svcName, owners: [] } }));
  const levels = await json<{ id: string; nameEn: string }[]>(await admin.get('/api/support/levels'));
  await json(
    await admin.put(`/api/services/${service.id}/support`, {
      data: {
        levelId: levels.find((l) => l.nameEn === '24×7')?.id ?? levels[0]!.id,
        channels: [{ purpose: 'issues', tool: 'ticket', name: 'Shop incidents (invented)', address: 'https://tickets.example/shop' }],
      },
    }),
  );
  const name = uniq('E2E Invented supported');
  const product = await json(await admin.post('/api/data-products', { data: { key: keyOf(name), name } }));

  // the designer picks the service in the editor
  await page.goto(`/data-products/${product.id}`);
  await page.getByTestId('help-and-support').getByTestId('support-edit').click();
  const dialog = page.getByRole('dialog', { name: `Help and support of ${name}` });
  await dialog.getByTestId('support-service-select').fill(svcName.slice(0, 18));
  await page.getByRole('option', { name: svcName }).click();
  await dialog.getByTestId('support-save').click();
  await expect(dialog).toBeHidden();
  const section = page.getByTestId('help-and-support');
  await expect(section).toContainText('Shop incidents (invented)');
  await expect(section.getByRole('link', { name: `From the service ${svcName}` }).first()).toBeVisible();
  await expectAccessible(page, 'support: from the service');

  // the service page has the section
  await page.goto(`/services/${service.id}`);
  await expect(page.getByTestId('help-and-support')).toContainText('Shop incidents (invented)');
  await expectAccessible(page, 'support: a service');

  // and the application page
  const app = await json(await admin.post('/api/applications', { data: { name: uniq('E2E Invented app'), owners: [] } }));
  await page.goto(`/applications/${app.id}`);
  await settle(page);
  await expect(page.getByTestId('help-and-support')).toContainText('No support channels yet.');
  await page.getByTestId('help-and-support').getByTestId('support-edit').click();
  const appDialog = page.getByRole('dialog', { name: `Help and support of ${app.name}` });
  await appDialog.getByTestId('support-channel-add').click();
  await appDialog.getByTestId('support-channel-address').fill('tel:+49 30 1234567');
  await appDialog.getByTestId('support-save').click();
  await expect(appDialog).toBeHidden();
  await expect(page.getByTestId('help-and-support').getByRole('link', { name: /\+49 30 1234567/ })).toHaveAttribute('href', 'tel:+49 30 1234567');
});

test('administrators keep the support levels', async ({ loginAs }) => {
  const page = await loginAs('admin');
  await page.goto('/settings/support');
  const card = page.getByTestId('support-levels');
  await expect(card).toContainText('Business hours');
  await expectAccessible(page, 'support: settings');
  const level = uniq('E2E Invented gold');
  await card.getByTestId('support-level-add').click();
  const dialog = page.getByRole('dialog', { name: 'New support level' });
  await dialog.getByTestId('support-level-name').fill(level);
  await dialog.getByRole('textbox', { name: 'Hours' }).fill('Mo–Sa 07–20');
  await dialog.getByRole('textbox', { name: 'First response' }).fill('2 hours');
  await dialog.getByRole('textbox', { name: 'SLA document' }).fill('ftp://not-a-web-address');
  await dialog.getByTestId('support-level-save').click();
  await expect(dialog).toContainText('Enter a web address starting with https://');
  // a name another level has: the server's refusal at the name field, which gets the focus
  await dialog.getByTestId('support-level-name').fill('Business hours');
  await dialog.getByRole('textbox', { name: 'SLA document' }).fill('https://wiki.example/sla/gold');
  await dialog.getByTestId('support-level-save').click();
  await expect(dialog.getByTestId('support-level-name')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByTestId('support-level-name')).toBeFocused();
  await expect(dialog).toContainText('A support level named Business hours exists already');
  await dialog.getByTestId('support-level-name').fill(level);
  await dialog.getByRole('textbox', { name: 'SLA document' }).fill('https://wiki.example/sla/gold');
  await expectAccessible(page, 'support: level form');
  await dialog.getByTestId('support-level-save').click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText(level);
  // moved up – the focus stays on its button, the move is said – and removed again (the focus stays in the list)
  await card.getByRole('button', { name: `Move ${level} up` }).click();
  await expect(card.getByRole('button', { name: `Move ${level} up` })).toBeFocused();
  await expect(card.getByTestId('support-levels-status')).toContainText(`${level} moved to position`);
  await card.getByRole('button', { name: `Remove ${level}` }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Delete|Remove/ })
    .last()
    .click();
  await expect(card).not.toContainText(level);
  await expect(card.locator('[data-level-edit]:focus')).toHaveCount(1);
});

test('help and support on a phone: cards, no sideways scroll @mobile', async ({ page, apiAs, loginAs }) => {
  const admin = await apiAs('admin');
  const name = uniq('E2E Invented phone');
  const product = await json(await admin.post('/api/data-products', { data: { key: keyOf(name), name } }));
  await json(
    await admin.put(`/api/data-products/${product.id}/support`, {
      data: {
        channels: [
          {
            purpose: 'questions',
            tool: 'teams',
            name: 'A rather long channel name of the invented orders data team',
            address: 'https://teams.example/l/channel/19%3Aa-very-long-identifier-of-the-invented-channel%40thread.example/Orders',
            hours: 'Mo–Fr 08–17',
          },
        ],
        guides: [{ title: 'Guide', url: 'https://wiki.example/a/very/long/path/to/the/invented/orders/data/guide/page' }],
      },
    }),
  );
  await page.goto(`/data-products/${product.id}`);
  await expect(page.getByTestId('support-channel')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'support: phone');
  await page.getByTestId('help-and-support').getByTestId('support-edit').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'support: the editor on a phone');

  const adminPage = await loginAs('admin');
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.goto('/settings/support');
  await expect(adminPage.getByTestId('support-levels')).toContainText('Business hours');
  await expectNoHorizontalScroll(adminPage);
  await expectAccessible(adminPage, 'support: settings on a phone');
});
