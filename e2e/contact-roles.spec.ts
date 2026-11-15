import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';
import { expectAccessible } from './support/axe';

/**
 * Contact roles, deputy and until (0.26.0, ADR 0039, docs/CONTACTS.md): an administrator keeps the role catalogue under
 * Settings → Contacts → Roles – the built-in roles, an own role made, switched off and deleted while unused, the focus
 * back on the button after the dialog; a designer names an application's business contacts with the picker, one as
 * the deputy of the other with an end date.
 */
test.describe('the role catalogue', () => {
  test.use({ storageState: authFile('admin') });

  test('an administrator makes, switches off and deletes an own role; built-in roles stay', async ({ page }) => {
    await page.goto('/settings/contacts');
    const card = page.getByTestId('contact-roles');
    await expect(card.getByTestId('contact-role-productOwner')).toContainText('Product owner');
    await expect(card.getByTestId('contact-role-applicationManager')).toContainText('Application manager');
    // built-in roles are switched off, never deleted: they have no delete button
    await expect(card.getByTestId('contact-role-delete-productOwner')).toHaveCount(0);
    await expect(card.getByTestId('contact-role-productOwner').getByRole('button', { name: 'Edit “Product owner”' })).toBeVisible();
    await expectAccessible(page, 'contact roles: the catalogue');

    const label = uniq('Invented reviewer');
    await card.getByTestId('contact-role-new').click();
    const form = page.getByRole('dialog', { name: 'New contact role' });
    await form.getByTestId('contact-role-label-en').fill(label);
    await form.getByTestId('contact-role-label-de').fill(`${label} (de)`);
    await form.getByTestId('contact-role-kind-system').check();
    await form.getByText('One (plus deputies)').click();
    // a key that is taken: the server's refusal is shown at the key field, which gets the focus
    await form.getByTestId('contact-role-key').fill('productOwner');
    await form.getByTestId('contact-role-save').click();
    await expect(form.getByTestId('contact-role-key')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByTestId('contact-role-key')).toBeFocused();
    await expect(form).toContainText('The key “productOwner” is taken');
    await form.getByTestId('contact-role-key').fill('');
    await expectAccessible(page, 'contact roles: a new role');
    await form.getByTestId('contact-role-save').click();
    await expect(form).toBeHidden();
    await expect(card.getByTestId('contact-role-new')).toBeFocused();
    const row = card.locator('[data-testid^="contact-role-"]').filter({ hasText: label }).first();
    await expect(row).toContainText('System');
    await expect(row).toContainText('Unused');

    // switched off
    await row.getByRole('button', { name: `Edit “${label}”` }).click();
    const edit = page.getByRole('dialog', { name: `Edit “${label}”` });
    await expect(edit.getByTestId('contact-role-key')).toBeDisabled();
    await edit.getByRole('switch', { name: 'Switched on' }).uncheck({ force: true });
    await edit.getByTestId('contact-role-save').click();
    await expect(edit).toBeHidden();
    await expect(row).toContainText('Off');

    // deleted (unused)
    await row.getByRole('button', { name: `Delete: ${label}` }).click();
    await page
      .getByRole('dialog', { name: `Delete the role “${label}”?` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(card.locator('[data-testid^="contact-role-"]').filter({ hasText: label })).toHaveCount(0);
    // the focus stays in the list (on the row that took its place, or the last one), not lost to the page
    await expect(card.locator('[data-role-edit]:focus')).toHaveCount(1);
  });

  test('the plant site form picks a role of the catalogue; the registry shows its label', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const label = uniq('Invented gate keeper');
    const role = await json(await admin.post('/api/contact-roles', { data: { labels: { en: label }, kinds: ['plant_site'] } }));
    // the plant registry on, as the other plant specs turn it on (the demo's enterprise)
    const on = await admin.put('/api/settings/plant', { data: { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} } });
    expect(on.ok(), await on.text()).toBe(true);
    const site = uniq('e2e-roles')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');
    const made = await admin.post('/api/plant/sites', { data: { id: site, name: `Invented ${site}` } });
    expect(made.ok(), await made.text()).toBe(true);
    const person = uniq('Invented Quinn');
    await json(await admin.post('/api/contacts', { data: { name: person, email: `${person.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@invented.example` } }));

    await page.goto(`/plant/sites/${site}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const picker = page.getByTestId('site-contacts');
    await picker.getByTestId('site-contacts-role').click();
    await page.getByRole('option', { name: label }).click();
    await picker.getByTestId('site-contacts-search').fill(person);
    await page.getByRole('option', { name: person }).click();
    await expect(picker.getByRole('listitem')).toContainText(label);
    await expectAccessible(page, 'contacts: the site form with a role of the catalogue');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText(label);
    // the shape of before: the label where the text was; the link names the key
    const saved = await json(await admin.get(`/api/plant/sites/${site}`));
    expect(saved.contacts.map((c: { role: string }) => c.role)).toEqual([label]);
    expect(saved.contactLinks.map((l: { role: string }) => l.role)).toEqual([role.key]);
    await admin.delete(`/api/plant/sites/${site}`);
  });

  test('the catalogue on a phone @mobile', async ({ page }) => {
    await page.goto('/settings/contacts');
    const card = page.getByTestId('contact-roles');
    await expect(card.getByTestId('contact-role-productOwner')).toBeVisible();
    await expect(card.locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'contact roles on a phone');
  });
});

test.describe('business contacts of an application', () => {
  test.use({ storageState: authFile('dana') });

  test('a designer names a business owner and a deputy with an end date', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const dana = await apiAs('dana');
    const app = await json(await admin.post('/api/applications', { data: { name: uniq('E2E Invented roles app'), owners: [] } }));
    // made by dana: she sees them while they are linked to nothing
    const first = uniq('Invented Olga');
    const second = uniq('Invented Pavel');
    for (const name of [first, second])
      await json(await dana.post('/api/contacts', { data: { name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@invented.example` } }));

    await page.goto(`/applications/${app.id}`);
    const section = page.getByTestId('application-contacts');
    await section.getByTestId('application-contacts-edit').click();
    const picker = section.getByTestId('application-contacts-picker');
    await expect(picker.getByTestId('application-contacts-picker-role')).toHaveValue('Business owner');
    for (const name of [first, second]) {
      await picker.getByTestId('application-contacts-picker-search').fill(name);
      await page.getByRole('option', { name }).click();
      await expect(picker).toContainText(name);
    }
    // the second stands in for the first until the end of 2999
    await picker.getByRole('button', { name: `Deputy and end date: ${second}` }).click();
    await picker.getByTestId('application-contacts-picker-deputy').click();
    await page.getByRole('option', { name: first }).click();
    await picker.getByTestId('application-contacts-picker-until').fill('2999-12-31');
    await expect(picker).toContainText(`Deputy for ${first}`);
    await expectAccessible(page, 'contacts: deputy and until in the picker');
    await section.getByTestId('application-contacts-save').click();
    await expect(picker).toBeHidden();
    await expect(section).toContainText(`Deputy for ${first}`);
    await expect(section).toContainText('Until');
    await expectAccessible(page, 'contacts: an application’s business contacts');

    const saved = await json(await dana.get(`/api/applications/${app.id}`));
    const ids = Object.fromEntries(saved.contacts.map((l: { contact: { id: string; name: string } }) => [l.contact.name, l.contact.id]));
    expect(saved.contacts).toEqual([
      expect.objectContaining({ role: 'businessOwner', contact: expect.objectContaining({ name: first }) }),
      expect.objectContaining({ role: 'businessOwner', deputyOf: ids[first], until: '2999-12-31', contact: expect.objectContaining({ name: second }) }),
    ]);
  });
});

test.describe('business contacts of a system', () => {
  test.use({ storageState: authFile('dana') });

  test('an expected role is hinted at; the focus moves into the picker and back; a refusal shows at the picker', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const dana = await apiAs('dana');
    const label = uniq('Invented backup owner');
    const role = await json(await admin.post('/api/contact-roles', { data: { labels: { en: label }, kinds: ['system'], expected: true } }));
    const sys = await json(await admin.post('/api/systems', { data: { name: uniq('E2E Invented roles system'), kind: 'server', owners: [] } }));
    const person = uniq('Invented Rhea');
    await json(await dana.post('/api/contacts', { data: { name: person, email: `${person.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@invented.example` } }));
    try {
      await page.goto(`/systems/${sys.id}`);
      const section = page.getByTestId('system-contacts');
      // the hint names the expected role, in a colour readable on the page (axe checks the contrast)
      await expect(section.getByTestId('contacts-expected')).toContainText(`Expected, but nobody is named: ${label}`);
      await expectAccessible(page, 'contacts: an expected role without a contact');

      // Edit puts the focus into the picker; Cancel gives it back to Edit
      await section.getByTestId('system-contacts-edit').click();
      const picker = section.getByTestId('system-contacts-picker');
      await expect(picker.getByTestId('system-contacts-picker-role')).toBeFocused();
      await section.getByRole('button', { name: 'Cancel' }).click();
      await expect(section.getByTestId('system-contacts-edit')).toBeFocused();

      // the role is switched off while the picker is open: the refusal is shown at the picker, not as a passing notice
      await section.getByTestId('system-contacts-edit').click();
      await picker.getByTestId('system-contacts-picker-role').click();
      await page.getByRole('option', { name: label }).click();
      await picker.getByTestId('system-contacts-picker-search').fill(person);
      await page.getByRole('option', { name: person }).click();
      await json(
        await admin.put(`/api/contact-roles/${role.key}`, {
          data: { labels: role.labels, description: role.description, kinds: role.kinds, cardinality: role.cardinality, expected: true, active: false },
        }),
      );
      await section.getByTestId('system-contacts-save').click();
      await expect(picker.getByRole('alert')).toContainText('is switched off here');
      await expect(picker).toBeVisible();
    } finally {
      await admin.delete(`/api/contact-roles/${role.key}`);
    }
  });
});
