import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * The monitor editor (#141): cards keep their identity when ids collide, problems show on the fields and in a
 * summary that leads to them, a card can be duplicated and tried before saving, and changes can be undone.
 */

test.use({ storageState: authFile('dana') });

test('duplicate ids, required fields, problem summary, duplicate, check now and undo', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E editor');
  await page.goto('/monitors/new');
  await settle(page);
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');

  // a TCP card, tried before saving (nothing listens on port 9)
  await palette.getByRole('button', { name: 'TCP port' }).click();
  await form.getByLabel('Host').fill('127.0.0.1');
  await form.getByRole('textbox', { name: 'Port' }).fill('9');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('127.0.0.1:9');

  // duplicate: a second card with its own id
  await form.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('monitor-node-tcp-1-copy')).toBeVisible();
  await expect(form.getByLabel('Check id')).toHaveValue('tcp-1-copy');

  // the same id as the first card: an error on the field, and both cards stay
  await form.getByLabel('Check id').fill('tcp-1');
  await expect(form.getByText('duplicate check id "tcp-1"')).toBeVisible();
  await expect(page.getByTestId('monitor-node-tcp-1')).toHaveCount(2);
  await form.getByLabel('Check id').fill('tcp-2');
  await expect(form.getByText(/duplicate check id/)).toHaveCount(0);
  await expect(page.getByTestId('monitor-node-tcp-2')).toBeVisible();
  await expect(page.getByTestId('monitor-node-tcp-1')).toHaveCount(1);

  // a new check goes below the selected card and depends on it: the link hint disappears
  await expect(page.getByTestId('link-hint')).toBeVisible();
  await palette.getByRole('button', { name: 'Data freshness' }).click();
  await expect(page.getByTestId('link-hint')).toHaveCount(0);
  await expect(form.getByLabel(/^Variables/)).toHaveAttribute('required', '');

  // saving lists the problems; an entry leads to the card and the field
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  const problems = page.getByTestId('monitor-problems');
  await expect(problems).toContainText(/problems to fix before saving/);
  await expect(problems).toContainText('Check "Data in Insights Hub" (freshness-1) – Asset id: Required');
  await expect(problems).toContainText('Check "Data in Insights Hub" (freshness-1) – Variables: Required');
  await expectAccessible(page, 'monitor editor problems');
  await problems.getByRole('button', { name: /– Variables/ }).click();
  await expect(page.getByTestId('check-form').getByLabel(/^Variables/)).toBeFocused();
  await expect(page.getByTestId('monitor-node-freshness-1')).toHaveAttribute('data-problem', 'true');

  // Delete removes the selected card (outside text fields); undo brings it back, redo removes it again
  await page.getByTestId('monitor-node-freshness-1').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('monitor-node-freshness-1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('monitor-node-freshness-1')).toBeVisible();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByTestId('monitor-node-freshness-1')).toHaveCount(0);

  // without problems it saves
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/monitors\/mon_[^/]+$/);
  const id = page.url().split('/').pop()!;
  const saved = await json(await api.get(`/api/monitors/${id}`));
  expect(saved.definition.checks.map((c: { id: string }) => c.id)).toEqual(['tcp-1', 'tcp-2']);
  await api.delete(`/api/monitors/${id}`);
});
