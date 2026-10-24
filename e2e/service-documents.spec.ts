import { test, expect } from './support/fixtures';
import { authFile, appHref } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/** The documentation of a service: a new document written for the service, approved as 1.0 by someone else, listed with its review status. */
test('a document created from the service page shows in its documentation section with edition and review status', async ({ page, loginAs, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E docs service');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name, owners: [] } }));
  const title = uniq('E2E service manual');

  await page.goto(`/services/${svc.id}`);
  const section = page.getByTestId('service-documents');
  await expect(section).toContainText('No documents for this service yet.');
  await section.getByRole('button', { name: 'New document' }).click();
  const create = page.getByRole('dialog', { name: `New document for ${name}` });
  // more than one document type (other tests may add some): pick the built-in one
  const type = create.getByRole('textbox', { name: 'Type' });
  if (await type.count()) {
    await type.click();
    await page.getByRole('option', { name: /^DOC – / }).click();
  }
  await create.getByRole('textbox', { name: 'Title' }).fill(title);
  await create.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/records\/rec_[^/]+\/edit$/);
  await page.getByRole('textbox', { name: 'Text (Markdown)' }).fill('## Purpose and scope\n\nHow the service is run.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/records\/rec_[^/]+$/);
  const id = page.url().split('/').pop()!;

  // the document page names the service next to the title
  const services = page.getByTestId('record-services');
  await expect(services).toContainText('Services:');
  await expect(services.getByRole('link', { name })).toHaveAttribute('href', appHref(`/services/${svc.id}`));

  // still a draft: listed without an edition
  await page.goto(`/services/${svc.id}`);
  const table = section.getByRole('table', { name: 'Documentation' });
  const row = table.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('Draft');
  await expect(row).toContainText('No review planned');

  // submit edition 1.0; Adam approves (four-eyes)
  await page.goto(`/records/${id}`);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const submit = page.getByRole('dialog', { name: /^Submit: DOC-/ });
  await submit.getByRole('textbox', { name: /What changed in this edition/ }).fill('First edition');
  await submit.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(submit).toBeHidden();
  const adam = await loginAs('adam');
  await adam.goto(`/records/${id}`);
  await adam.getByRole('button', { name: 'Approve', exact: true }).click();
  const approve = adam.getByRole('dialog', { name: /^Approve: DOC-/ });
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(adam.getByRole('heading', { level: 2 })).toContainText('Edition 1.0');

  // the service page: edition 1.0, published, review current with the next review date
  await adam.goto(`/services/${svc.id}`);
  const adamRow = adam.getByTestId('service-documents').getByRole('row').filter({ hasText: title });
  await expect(adamRow).toContainText('Edition 1.0');
  await expect(adamRow).toContainText('Published');
  await expect(adamRow).toContainText('Review current');
  await expect(adamRow.getByRole('cell').last()).not.toHaveText('–');
  await adamRow.getByRole('link', { name: title }).click();
  await expect(adam).toHaveURL((url) => url.pathname.endsWith(`/records/${id}`));
  await adam.goto(`/services/${svc.id}`);
  await settle(adam);
  await expectAccessible(adam, 'service documentation');

  // no overdue review: no indicator in the list
  await page.goto('/services');
  await expect(page.getByRole('row').filter({ hasText: name }).getByTestId('overdue-reviews')).toHaveCount(0);

  // phone width: the section fits
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/services/${svc.id}`);
  await expect(page.getByTestId('service-documents')).toContainText(title);
  await expectNoHorizontalScroll(page);
});
