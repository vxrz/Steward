import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('dana') });

/**
 * The contacts directory (0.25.1, ADR 0038, docs/CONTACTS.md): a designer names a service's business contact with the
 * picker – a new one, then the same person on a second service from the search – and opens the contact's page, which
 * lists where it is named; Replace with… moves the links to another contact.
 */
test('a designer names contacts on services with the picker and replaces one with another', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const first = await json(await admin.post('/api/services', { data: { name: uniq('E2E Invented intake'), owners: [] } }));
  const second = await json(await admin.post('/api/services', { data: { name: uniq('E2E Invented returns'), owners: [] } }));
  const person = uniq('Invented Rita');

  // a new contact from the service form
  await page.goto(`/services/${first.id}?edit=1`);
  const form = page.getByRole('dialog').filter({ has: page.getByTestId('service-contacts') });
  await form.getByTestId('service-contacts-new').click();
  const create = page.getByRole('dialog', { name: 'New contact' });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill(person);
  await create.getByRole('textbox', { name: 'E-mail address' }).fill('rita@invented.example');
  await expectAccessible(page, 'contacts: new contact in the picker');
  await create.getByTestId('contact-submit').click();
  await expect(create).toBeHidden();
  await expect(form.getByTestId('service-contacts')).toContainText(person);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('main')).toContainText('rita@invented.example');

  // the same person on the second service, found by the search (as IT contact)
  await page.goto(`/services/${second.id}?edit=1`);
  const form2 = page.getByRole('dialog').filter({ has: page.getByTestId('service-contacts') });
  await form2.getByTestId('service-contacts-role').click();
  await page.getByRole('option', { name: 'IT operations' }).click();
  await form2.getByTestId('service-contacts-search').fill('rita@invented');
  await page.getByRole('option', { name: person }).click();
  await expect(form2.getByTestId('service-contacts')).toContainText(person);
  await expectAccessible(page, 'contacts: picker with a contact');
  await form2.getByRole('button', { name: 'Save' }).click();
  await expect(form2).toBeHidden();

  // one contact, named on both services
  await page.goto(`/contacts?q=${encodeURIComponent('rita@invented')}`);
  await expect(page.getByTestId('contact-list')).toContainText(person);
  await expectAccessible(page, 'contacts: the list');
  await page.getByRole('link', { name: person }).first().click();
  const used = page.getByTestId('contact-where-used');
  await expect(used).toContainText(first.name);
  await expect(used).toContainText(second.name);
  await expectAccessible(page, 'contacts: a contact');

  // Replace with… a successor, who then is named on both
  const successor = uniq('Invented Sven');
  await json(await (await apiAs('dana')).post('/api/contacts', { data: { name: successor, email: 'sven@invented.example' } }));
  await page.getByTestId('detail-actions').click();
  await page.getByTestId('contact-replace').click();
  const replace = page.getByRole('dialog', { name: 'Replace with another contact' });
  await replace.getByTestId('contact-replace-target').fill('sven@invented');
  await page.getByRole('option', { name: successor }).click();
  await replace.getByRole('checkbox', { name: 'Mark this contact as left' }).check();
  await replace.getByTestId('contact-replace-submit').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(successor);
  await expect(page.getByTestId('contact-where-used')).toContainText(first.name);
  await expect(page.getByTestId('contact-where-used')).toContainText(second.name);
});

/**
 * The picker by keyboard (WCAG 2.2): search, arrows and Enter pick a contact; removing one moves the focus to the
 * search; what changed is announced. A contact who has left is offered nowhere new – not in the search, not as an
 * e-mail match of a new contact. The New contact dialog gives the focus back to its button.
 */
test('the picker by keyboard, with announcements; a contact who has left is offered nowhere', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const dana = await apiAs('dana');
  const service = await json(await admin.post('/api/services', { data: { name: uniq('E2E Invented keyboard'), owners: [] } }));
  const kim = uniq('Invented Kim');
  const lea = uniq('Invented Lea');
  const leaMail = `${lea.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@invented.example`;
  // made by dana (seen by her while linked to nothing); Lea has left
  await json(await dana.post('/api/contacts', { data: { name: kim, email: `${kim.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@invented.example` } }));
  const left = await json(await dana.post('/api/contacts', { data: { name: lea, email: leaMail } }));
  expect((await admin.put(`/api/contacts/${left.id}`, { data: { kind: 'person', name: lea, email: leaMail, status: 'left' } })).ok()).toBe(true);

  await page.goto(`/services/${service.id}?edit=1`);
  const picker = page.getByTestId('service-contacts');
  const search = page.getByTestId('service-contacts-search');
  await search.focus();
  await page.keyboard.type(kim);
  // the server's answer to what was typed (not the list shown before it)
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option', { name: kim })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker.getByRole('listitem')).toContainText(kim);
  await expect(page.getByTestId('service-contacts-status')).toHaveText(`${kim} added as Business owner`);

  // left: not found
  await search.fill(lea);
  await expect(page.getByText('No contact found.')).toBeVisible();
  await expect(page.getByRole('option', { name: lea })).toHaveCount(0);
  await search.fill('');

  // remove by keyboard: the focus goes to the search, the removal is announced
  await picker.getByRole('button', { name: `Remove ${kim}` }).focus();
  await page.keyboard.press('Enter');
  await expect(picker.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByTestId('service-contacts-status')).toHaveText(`${kim} removed`);
  await expect(search).toBeFocused();

  // a new contact with Lea's address: she is named as left, not offered
  await page.getByTestId('service-contacts-new').click();
  const create = page.getByRole('dialog', { name: 'New contact' });
  await create.getByRole('textbox', { name: 'E-mail address' }).fill(leaMail);
  await expect(create.getByTestId('contact-matches-left')).toContainText(lea);
  await expect(create.getByRole('button', { name: `Use ${lea}` })).toHaveCount(0);
  await expectAccessible(page, 'contacts: a match who has left');
  await create.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
  await expect(create).toBeHidden();
  await expect(page.getByTestId('service-contacts-new')).toBeFocused();
});

/** Administrators: contacts that share an e-mail address under Possible duplicates; Replace with… gives the focus back; Erase. */
test('administrators see possible duplicates and erase a contact', async ({ loginAs, apiAs }) => {
  const admin = await apiAs('admin');
  const mail = `${uniq('dup')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')}@invented.example`;
  const first = await json(await admin.post('/api/contacts', { data: { name: uniq('Invented Dup A'), email: mail } }));
  const second = await json(await admin.post('/api/contacts', { data: { name: uniq('Invented Dup B'), email: mail } }));
  const page = await loginAs('admin');
  await page.goto('/contacts?tab=duplicates');
  const dup = page.getByTestId('contact-duplicates');
  await expect(dup).toContainText(mail);
  await expect(dup.getByRole('link', { name: first.name })).toBeVisible();
  await expectAccessible(page, 'contacts: possible duplicates');
  await dup.getByRole('link', { name: second.name }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(second.name);

  // Replace with…, cancelled: the focus is back on the menu's button
  await page.getByTestId('detail-actions').click();
  await page.getByTestId('contact-replace').click();
  await expect(page.getByRole('dialog', { name: 'Replace with another contact' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('detail-actions')).toBeFocused();

  // Erase (GDPR Art. 17): asked first, then gone
  await page.getByTestId('detail-actions').click();
  await page.getByTestId('contact-erase').click();
  await page.getByRole('dialog', { name: 'Erase this contact?' }).getByRole('button', { name: 'Erase' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Contact erased' })).toBeVisible();
  await expect(page).toHaveURL(/\/contacts$/);
  expect((await admin.get(`/api/contacts/${second.id}`)).status()).toBe(404);
  await page.close();
});

/** On a phone: the list and a contact's links are cards, nothing scrolls sideways, axe is clean. */
test('contacts on a phone @mobile', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const mail = `${uniq('phone')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')}@invented.example`;
  const name = uniq('Invented Pia');
  const service = await json(
    await admin.post('/api/services', { data: { name: uniq('E2E Invented phone service'), owners: [], contacts: [{ role: 'business', email: mail, name }] } }),
  );
  await page.goto(`/contacts?q=${encodeURIComponent(mail)}`);
  const list = page.getByTestId('contact-list');
  await expect(list.getByRole('link', { name })).toBeVisible();
  await expect(list.locator('table')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'contacts on a phone');
  await list.getByRole('link', { name }).click();
  const used = page.getByTestId('contact-where-used');
  await expect(used.getByRole('link', { name: service.name })).toBeVisible();
  await expect(used.locator('table')).toHaveCount(0);
  await expect(used).toContainText('Service · Business owner');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'a contact on a phone');
});
