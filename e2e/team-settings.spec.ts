import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Team settings (#136): the team's own channel overrides the instance default, and goes back to it. */
test('a team gets its own channel and goes back to the instance default', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Payments');
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name, members: [] } }));
  try {
    await page.goto('/users');
    await page.getByRole('button', { name: `Settings of team ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: `Settings of team ${name}` });
    await expect(dialog.getByTestId('team-channel-scope')).toHaveText('Instance default');
    await expect(dialog.getByText(/The team uses the instance channel/)).toBeVisible();
    await expectAccessible(page, 'team settings: instance default');

    await dialog.getByRole('button', { name: 'Use an own channel' }).click();
    await dialog.getByLabel('URL').fill('https://payments.webhook.example/hook?sig=e2e');
    await dialog.getByText('Not there (instead)').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Team settings saved')).toBeVisible();
    await expect(dialog.getByTestId('team-channel-scope')).toHaveText('Overrides the instance default');
    await expect(dialog.getByText('A URL is stored. Enter a new one to replace it.')).toBeVisible();
    await expectAccessible(page, 'team settings: own channel');

    await dialog.getByRole('button', { name: 'Back to the instance default' }).click();
    await expect(page.getByText('The team uses the instance channel again')).toBeVisible();
    await expect(dialog.getByTestId('team-channel-scope')).toHaveText('Instance default');
  } finally {
    await api.delete(`/api/teams/${team.id}`);
  }
});
