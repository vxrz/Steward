import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { settle } from './support/axe';
import { json } from './support/helpers';

/**
 * The observed delay of an Insights Hub freshness check (0.13): the demo's PowerMeter PM-17 uploads every 5 minutes
 * (mock data path, a week of reads seeded at demo setup); its check shows the peak age and suggests an allowance that
 * the editor applies, old and new value shown.
 */

test.use({ storageState: authFile('dana') });

test('the observed delay is shown and the suggested allowance is applied in the editor', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const list = await json(await api.get('/api/monitors'));
  const pm = (list.items ?? list).find((m: { key: string }) => m.key === 'machine-17-powermeter');
  const detail = await json(await api.get(`/api/monitors/${pm.id}`));
  const before = detail.checks.find((c: { checkId: string }) => c.checkId === 'pm-ih');
  const change = before.observedDelay.suggestion.changes.find((c: { field: string }) => c.field === 'allowedDelaySeconds');
  expect(change.from).toBe(360);
  expect(change.to).toBeGreaterThan(360);

  // the check's panel: the figures of the week
  await page.goto(`/monitors/${pm.id}`);
  await page.getByTestId('monitor-node-pm-ih').click();
  const panel = page.getByTestId('check-panel');
  await expect(panel.getByTestId('observed-delay')).toContainText('Peak age before new data (7 days)');
  await expect(panel.getByTestId('observed-delay-figures')).toContainText(
    /median \d+ min, 95 % \d+ min, max \d+ min · delay .+ · \d+ samples · checked every 1 min/,
  );
  await expect(panel.getByTestId('observed-delay')).toContainText('only a clock that is ahead can be detected');

  // the editor: the suggestion with old and new value, applied to the form
  await page.goto(`/monitors/${pm.id}/edit`);
  await settle(page);
  await page.getByTestId('monitor-node-pm-ih').click();
  const form = page.getByTestId('check-form');
  const allowance = form.getByRole('textbox', { name: /^Allowed delay/ });
  await expect(allowance).toHaveValue('360');
  const suggestion = form.getByTestId('observed-delay-suggestion');
  await expect(suggestion.getByTestId('suggestion-allowedDelaySeconds')).toHaveText(`Allowed delay: 6 min → ${change.to / 60} min`);
  await suggestion.getByRole('button', { name: 'Apply suggestion' }).click();
  await expect(allowance).toHaveValue(String(change.to));
  await expect(form.getByTestId('observed-delay-covered')).toBeVisible();

  // saved like any edit: the setting now covers the observed peak age
  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => (await json(await api.get(`/api/monitors/${pm.id}`))).definition.checks.find((c: { id: string }) => c.id === 'pm-ih').allowedDelaySeconds)
    .toBe(change.to);
  const after = (await json(await api.get(`/api/monitors/${pm.id}`))).checks.find((c: { checkId: string }) => c.checkId === 'pm-ih');
  expect(after.observedDelay.suggestion.changes).toEqual([]);
});
