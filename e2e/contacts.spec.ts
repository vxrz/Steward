import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, uniq } from './support/helpers';
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
  await page.getByRole('option', { name: 'IT' }).click();
  await form2.getByTestId('service-contacts-search').fill('rita@invented');
  await page.getByRole('option', { name: new RegExp(person) }).click();
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
  await page.getByRole('option', { name: new RegExp(successor) }).click();
  await replace.getByRole('checkbox', { name: 'Mark this contact as left' }).check();
  await replace.getByTestId('contact-replace-submit').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(successor);
  await expect(page.getByTestId('contact-where-used')).toContainText(first.name);
  await expect(page.getByTestId('contact-where-used')).toContainText(second.name);
});
