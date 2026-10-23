import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/** Living documents: editions approved by someone else, the document changelog with a diff, a periodic review and the start page tile. */
test('a service document gets editions 1.0 and 1.1, a review, and shows on the start page when due', async ({ page, loginAs, apiAs }) => {
  const title = uniq('E2E operations manual');
  await page.goto('/records');
  await page.getByRole('button', { name: 'New record' }).click();
  const create = page.getByRole('dialog', { name: 'New record' });
  await create.getByRole('textbox', { name: 'Type' }).click();
  await page.getByRole('option', { name: /^DOC – Service documentation/ }).click();
  await create.getByRole('textbox', { name: 'Title' }).fill(title);
  await create.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/records\/rec_[^/]+\/edit$/);
  const text = page.getByRole('textbox', { name: 'Text (Markdown)' });
  await expect(text).toHaveValue(/## Purpose and scope/);
  await text.fill('## Purpose and scope\n\nRestart the plant gateway.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/records\/rec_[^/]+$/);
  const id = page.url().split('/').pop()!;

  // submit edition 1.0 with a change summary
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const submit = page.getByRole('dialog', { name: /^Submit: DOC-/ });
  await expect(submit.getByText('This becomes edition 1.0.')).toBeVisible();
  await expect(submit.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await submit.getByRole('textbox', { name: /What changed in this edition/ }).fill('First edition');
  await submit.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(submit).toBeHidden();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('In review');
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // four-eyes: Adam approves
  const adam = await loginAs('adam');
  await adam.goto(`/records/${id}`);
  await adam.getByRole('button', { name: 'Approve', exact: true }).click();
  const approve = adam.getByRole('dialog', { name: /^Approve: DOC-/ });
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approve).toBeHidden();
  await expect(adam.getByRole('heading', { level: 2 })).toContainText('Published');
  await expect(adam.getByRole('heading', { level: 2 })).toContainText('Edition 1.0');

  // a minor edition: drafted while 1.0 stays valid
  await page.reload();
  await page.getByRole('button', { name: 'New edition' }).click();
  const revise = page.getByRole('dialog', { name: /^New edition of DOC-/ });
  await revise.getByRole('textbox', { name: /Why is a new edition needed/ }).fill('Add the restart check');
  await revise.getByRole('button', { name: 'Start new edition' }).click();
  await expect(revise).toBeHidden();
  await expect(page.getByText('The next edition is being drafted. Edition 1.0 stays valid until it is approved.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text (Markdown)' }).fill('## Purpose and scope\n\nRestart the plant gateway and check the heartbeat.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(`/records/${id}`));
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const second = page.getByRole('dialog', { name: /^Submit: DOC-/ });
  await second.getByRole('radio', { name: /^Minor – editorial change \(becomes 1\.1\)/ }).check();
  await second.getByRole('textbox', { name: /What changed in this edition/ }).fill('Heartbeat check added');
  await second.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(second).toBeHidden();

  await adam.reload();
  await adam.getByRole('button', { name: 'Approve', exact: true }).click();
  const approve2 = adam.getByRole('dialog', { name: /^Approve: DOC-/ });
  await approve2.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approve2).toBeHidden();
  await expect(adam.getByRole('heading', { level: 2 })).toContainText('Edition 1.1');

  // the changelog: both editions, the diff and the frozen 1.0
  await adam.getByRole('tab', { name: /Changelog/ }).click();
  const log = adam.getByRole('table', { name: 'Document changelog' });
  await expect(log).toContainText('Heartbeat check added');
  await expect(log).toContainText('First edition');
  await log.getByRole('button', { name: 'Changes from edition 1.0 to 1.1' }).click();
  const diff = adam.getByRole('dialog', { name: 'Changes from edition 1.0 to 1.1' });
  await expect(diff.getByText('and check the heartbeat', { exact: false })).toBeVisible();
  await settle(adam);
  await expectAccessible(adam, 'edition diff');
  await diff.getByRole('button', { name: 'Close', exact: true }).last().click();
  await log.getByRole('button', { name: 'Open edition 1.0' }).click();
  const v10 = adam.getByRole('dialog', { name: /– edition 1\.0$/ });
  await expect(v10.getByText('Restart the plant gateway.')).toBeVisible();
  await v10.getByRole('button', { name: 'Close', exact: true }).last().click();

  // the periodic review: "Reviewed – no change"
  await adam.getByRole('button', { name: 'Reviewed – no change' }).click();
  const review = adam.getByRole('dialog', { name: /^Review DOC-/ });
  await review.getByRole('textbox', { name: 'Comment' }).fill('Still correct');
  await review.getByRole('button', { name: 'Reviewed – no change' }).click();
  await expect(review).toBeHidden();
  await expect(log).toContainText('Still correct');
  await expect(adam.getByTestId('document-review')).toContainText('Review current');
  await settle(adam);
  await expectAccessible(adam, 'document changelog');

  // an earlier review date makes it due soon: the start page tile and the list filter show it
  const api = await apiAs('dana');
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await json(await api.put(`/api/records/${id}/review-settings`, { data: { nextReviewAt: soon } }));
  await page.goto('/');
  const tile = page.getByTestId('tile-reviews');
  await expect(tile).toHaveAttribute('data-state', 'attention');
  await expect(tile).toContainText('Reviews due');
  await tile.click();
  await expect(page).toHaveURL(/\/records\?workflow=document&review=overdue%2CdueSoon|\/records\?workflow=document&review=overdue,dueSoon/);
  await expect(page.getByTestId('record-list')).toContainText(title);
  await expect(page.getByTestId('record-list')).toContainText('Review due soon');

  // phone width: the changelog fits
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/records/${id}?tab=changelog`);
  await expect(page.getByRole('table', { name: 'Document changelog' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
