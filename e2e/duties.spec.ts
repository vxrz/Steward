import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('dana') });

/**
 * Service duties (#85): define a duty on the service page, see its period go from due to done after a real run of the
 * process, and plan an exception that a second person approves (four-eyes).
 */
test('a duty is due until its process ran, and an exception needs a second person', async ({ page, apiAs, loginAs }) => {
  const api = await apiAs('dana');
  const processName = uniq('E2E restore test');
  const proc = await json<{ id: string }>(
    await api.post('/api/processes', { data: { definition: { name: processName, nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } } }),
  );
  const serviceName = uniq('E2E backup service');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: serviceName, owners: ['user:olivia'] } }));
  const dutyName = uniq('Monthly restore test');

  // define the duty on the service page
  await page.goto(`/services/${svc.id}`);
  const panel = page.getByTestId('duties-panel');
  await expect(panel).toContainText('No duties yet');
  await panel.getByRole('button', { name: 'Add duty' }).click();
  const form = page.getByRole('dialog', { name: 'Add duty' });
  await form.getByRole('textbox', { name: 'Name' }).fill(dutyName);
  await chooseOption(page, /^Process/, processName);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  const card = panel.getByRole('listitem').filter({ hasText: dutyName });
  await expect(card.getByTestId('duty-status').first()).toHaveText('Due');
  await expect(card).toContainText('Monthly');
  await expect(card).toContainText('Mandatory');
  await settle(page);
  await expectAccessible(page, 'service page with duties');

  // a dry run does not count; a real run makes the period done
  const dry = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: proc.id, dryRun: true } }));
  await waitForRun(api, dry.id, ['succeeded']);
  await page.reload();
  await expect(card.getByTestId('duty-status').first()).toHaveText('Due');
  const real = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: proc.id, dryRun: false } }));
  await waitForRun(api, real.id, ['succeeded']);
  await page.reload();
  await expect(card.getByTestId('duty-status').first()).toHaveText('Done');

  // plan an exception for the next month
  await card.getByRole('button', { name: `Ask for an exception of “${dutyName}”` }).click();
  const ask = page.getByRole('dialog', { name: `Ask for an exception of “${dutyName}”` });
  const period = await ask.getByRole('textbox', { name: /^Period/ }).inputValue();
  expect(period).toMatch(/^\d{4}-\d{2}$/);
  await ask.getByRole('textbox', { name: /^Reason/ }).fill('The backup system is replaced next month');
  await ask.getByRole('button', { name: 'Ask' }).click();
  await expect(ask).toBeHidden();
  await expect(card).toContainText('1 exception waits for a second person');
  await expect(card.getByTestId('planned-skips')).toHaveText('1 exception planned ahead');

  // the duty page: dana cannot decide her own request
  await card.getByRole('link', { name: dutyName }).click();
  await expect(page).toHaveURL(/\/duties\/dty_[^/]+$/);
  const dutyUrl = new URL(page.url()).pathname.replace(/^.*(\/duties\/)/, '$1');
  const skip = page.getByTestId(`skip-${period}`);
  await expect(skip).toContainText('Waiting for a second person');
  await expect(skip).toContainText('someone else decides the exception you asked for');
  await expect(skip.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByTestId('duty-periods').getByTestId('duty-status').first()).toHaveText('Done');
  await expect(page.getByTestId('duty-periods').getByTestId('run-version').first()).toHaveText('Process version 1');
  await settle(page);
  await expectAccessible(page, 'duty page');
  await expectNoHorizontalScroll(page);

  // olivia, an owner of the service, approves it
  const owner = await loginAs('olivia');
  await owner.goto(dutyUrl);
  const ownerSkip = owner.getByTestId(`skip-${period}`);
  await ownerSkip.getByRole('button', { name: 'Approve' }).click();
  const decide = owner.getByRole('dialog', { name: `Approve the exception for ${period}` });
  await decide.getByRole('textbox', { name: 'Comment' }).fill('Agreed');
  await decide.getByRole('button', { name: 'Approve' }).click();
  await expect(decide).toBeHidden();
  await expect(ownerSkip).toContainText('Approved by olivia');
  await settle(owner);
  await expectAccessible(owner, 'duty page after the approval');

  // the list of all duties shows it
  await page.goto('/duties');
  await expect(page.getByRole('link', { name: dutyName })).toBeVisible();
});
