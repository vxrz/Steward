import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

const CR_FIELDS = { reason: 'Certificate expires', risk: 'low', rollbackPlan: 'Restore the old certificate' };

test('a change request is approved by someone else and generated as PDF with two signers', async ({ page, loginAs, apiAs }) => {
  const title = uniq('E2E change');
  await page.goto('/records');
  await page.getByRole('button', { name: 'New record' }).click();
  const create = page.getByRole('dialog', { name: 'New record' });
  await create.getByRole('textbox', { name: 'Type' }).click();
  await page.getByRole('option', { name: /^CR – / }).click();
  await create.getByRole('textbox', { name: 'Title' }).fill(title);
  await create.getByRole('button', { name: 'Create draft' }).click();

  // editor: fields and Markdown with preview
  await expect(page).toHaveURL(/\/records\/rec_[^/]+\/edit$/);
  await page.getByRole('textbox', { name: 'Reason' }).fill(CR_FIELDS.reason);
  await chooseOption(page, 'Risk', 'low');
  await page.getByRole('textbox', { name: 'Rollback plan' }).fill(CR_FIELDS.rollbackPlan);
  await page.getByRole('textbox', { name: 'Text (Markdown)' }).fill('## Description\n\nReplace the **gateway certificate**.\n\n<script>alert(1)</script>\n');
  await expect(page.getByRole('region', { name: 'Preview' }).getByText('gateway certificate')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview' }).getByText('<script>alert(1)</script>')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/records\/rec_[^/]+$/);
  const id = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { level: 2 })).toContainText(title);

  // submit
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const submit = page.getByRole('dialog', { name: /^Submit: CR-/ });
  await submit.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(submit).toBeHidden();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Submitted');
  // the author cannot approve (and is no approver)
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // four-eyes: Adam approves
  const adam = await loginAs('adam');
  await adam.goto(`/records/${id}`);
  await adam.getByRole('button', { name: 'Approve', exact: true }).click();
  const approve = adam.getByRole('dialog', { name: /^Approve: CR-/ });
  await approve.getByRole('textbox', { name: 'Comment' }).fill('Fine, go ahead');
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(adam.getByRole('heading', { level: 2 })).toContainText('Approved');

  // PDF with two external signers
  await adam.getByRole('button', { name: 'More actions' }).click();
  await adam.getByRole('menuitem', { name: 'Generate PDF' }).click();
  const dialog = adam.getByRole('dialog', { name: /^PDF of CR-/ });
  await dialog.getByRole('button', { name: 'Add signer' }).click();
  await dialog.getByRole('button', { name: 'Add signer' }).click();
  const names = dialog.getByRole('textbox', { name: 'Name' });
  const roles = dialog.getByRole('textbox', { name: 'Role' });
  await names.nth(0).fill('Erika Mustermann');
  await roles.nth(0).fill('Business owner');
  await names.nth(1).fill('Max Requester');
  await roles.nth(1).fill('Requester');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(dialog.getByText('The PDF was generated and stored with the record.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(adam).toHaveURL(/tab=pdfs/);
  const generated = adam.getByRole('table', { name: 'Generated PDFs' });
  await expect(generated).toContainText('Erika Mustermann (Business owner), Max Requester (Requester)');
  await expectAccessible(adam, 'record PDF tab');

  // the PDF carries two empty signature fields
  const api = await apiAs('dana');
  const rec = await json(await api.get(`/api/records/${id}`));
  const pdf = rec.attachments.find((a: any) => a.kind === 'generated');
  const file = await api.get(`/api/records/${id}/attachments/${pdf.id}/download`);
  expect(file.headers()['content-type']).toBe('application/pdf');
  expect((await file.body()).toString('latin1').match(/\/FT \/Sig/g)).toHaveLength(2);

  // history and accessibility of the detail page
  await page.reload();
  await page.getByRole('tab', { name: /Approvals & comments/ }).click();
  await expect(page.getByText('Fine, go ahead')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'record discussion');
});

test('an ADR in Markdown is imported as a draft', async ({ page }) => {
  const title = uniq('Use PostgreSQL');
  const md = `---\nstatus: accepted\ndate: 2024-05-14\ndeciders: [Dana, Olivia]\n---\n\n# ${title}\n\n## Context and Problem Statement\n\nSeveral instances share one database.\n\n## Decision Outcome\n\nPostgreSQL.\n`;
  await page.goto('/records');
  await page.getByRole('button', { name: 'Import Markdown' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Markdown files' });
  await dialog.locator('input[type=file]').setInputFiles({ name: '0007-use-postgresql.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
  const preview = dialog.getByRole('table', { name: 'Preview' });
  await expect(preview).toContainText('0007-use-postgresql.md');
  await expect(preview).toContainText(`ADR · ${title}`);
  await expect(preview).toContainText('Status in the file: accepted (imported as draft)');
  await expectAccessible(page, 'import dialog');
  await dialog.getByRole('button', { name: 'Import 1 file' }).click();
  await expect(dialog.getByText('1 record created.')).toBeVisible();
  await dialog.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { level: 2 })).toContainText(title);
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Draft');
  await expect(page.getByText('Several instances share one database.')).toBeVisible();
  await expect(page.getByText(/imported records start as drafts/i)).toBeVisible();
});

test('a service is created and linked to a record, with backlinks both ways', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const rec = await json(await api.post('/api/records', { data: { type: 'CR', title: uniq('E2E service change'), fields: CR_FIELDS } }));
  const name = uniq('E2E plant data');
  await page.goto('/services');
  await page.getByRole('button', { name: 'New service' }).click();
  const form = page.getByRole('dialog', { name: 'New service' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('textbox', { name: 'E-mail' }).first().fill('erika@example.com');
  await chooseOption(page, 'Criticality', 'High');
  await form.getByRole('textbox', { name: 'System' }).fill('ServiceNow');
  await form.getByRole('textbox', { name: 'ID' }).fill('CI0042');
  await form.getByRole('textbox', { name: 'Link to the entry' }).fill('https://example.service-now.com/ci/CI0042');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/services\/svc_/);
  await expect(page.getByRole('heading', { level: 2 })).toContainText(name);
  await expect(page.getByRole('link', { name: /Open in CMDB/ })).toHaveAttribute('href', 'https://example.service-now.com/ci/CI0042');

  // link the record
  await page.getByRole('button', { name: 'Add link' }).click();
  const link = page.getByRole('dialog', { name: 'Add link' });
  await chooseOption(page, 'Kind', 'Record');
  await link.getByRole('textbox', { name: 'Target' }).fill(rec.number);
  await page.getByRole('option', { name: new RegExp(rec.number) }).click();
  await link.getByRole('textbox', { name: 'Note' }).fill('affected');
  await link.getByRole('button', { name: 'Add link' }).click();
  await expect(link).toBeHidden();
  await expect(page.getByRole('table', { name: 'Links' }).getByRole('link', { name: new RegExp(rec.number) })).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'service detail');

  // backlink on the record
  await page
    .getByRole('table', { name: 'Links' })
    .getByRole('link', { name: new RegExp(rec.number) })
    .click();
  await page.getByRole('tab', { name: /Links/ }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();
});

test('records list is accessible and filters by status', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const title = uniq('E2E filter');
  const rec = await json(await api.post('/api/records', { data: { type: 'CR', title, fields: CR_FIELDS } }));
  await json(await api.post(`/api/records/${rec.id}/transition`, { data: { action: 'submit' } }));
  await page.goto('/records');
  await page.getByRole('textbox', { name: 'Search' }).fill(title);
  await chooseOption(page, 'Status', 'Submitted');
  await expect(page.getByRole('table', { name: 'Records' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table', { name: 'Records' })).toContainText(rec.number);
  await settle(page);
  await expectAccessible(page, 'records list');
});

test.describe('phone @mobile', () => {
  test('records and services fit the screen', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const rec = await json(await api.post('/api/records', { data: { type: 'ADR', title: uniq('E2E phone decision') } }));
    for (const path of ['/records', `/records/${rec.id}`, `/records/${rec.id}/edit`, '/services']) {
      await page.goto(path);
      await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });
});
