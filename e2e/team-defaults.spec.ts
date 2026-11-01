import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Team defaults (#136): an administrator sets which new resources a team owns, a daily summary for its members and
 * report branding; each shows whether it overrides the instance default. A member sees in their profile where their
 * values come from and chooses the team for their new resources.
 */
test("team defaults: new resources, daily summary for members and report branding, seen from a member's profile", async ({ page, browser, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Orders');
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name, members: ['olivia'] } }));
  try {
    await page.goto('/users');
    await page.getByRole('button', { name: `Settings of team ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: `Settings of team ${name}` });

    await dialog.getByRole('tab', { name: 'New resources' }).click();
    await expect(dialog.getByTestId('team-new-resources-scope')).toHaveText('Instance default');
    await dialog.getByText('Always', { exact: true }).click();
    await expect(page.getByText('Team settings saved')).toBeVisible();
    await expect(dialog.getByTestId('team-new-resources-scope')).toHaveText('Overrides the instance default');

    await dialog.getByRole('tab', { name: 'Daily summary' }).click();
    await expect(dialog.getByTestId('team-summary-scope')).toHaveText('Instance default');
    await dialog.getByRole('button', { name: 'Set a default for members' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('team-summary-scope')).toHaveText('Overrides the instance default');

    await dialog.getByRole('tab', { name: 'Report branding' }).click();
    await expect(dialog.getByTestId('team-branding-scope')).toHaveText('Instance default');
    await dialog.getByLabel('Company name').fill('Orders unit');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('team-branding-scope')).toHaveText('Overrides the instance default');
    await expectAccessible(page, 'team settings: report branding');
    await page.keyboard.press('Escape');

    // the member's profile: where the values come from
    const ctx = await browser.newContext({ storageState: authFile('olivia'), baseURL: baseURL() });
    try {
      const member = await ctx.newPage();
      await member.goto('/profile');
      await expect(member.getByTestId('daily-summary-source')).toHaveText(`Default of team ${name}`);
      await expect(member.getByTestId('new-resources-source')).toHaveText('Default of your teams');
      await expect(member.getByTestId('new-resources-now')).toHaveText(`New resources now belong to team ${name}.`);
      await member.getByRole('textbox', { name: 'New resources belong to' }).click();
      await member.getByRole('option', { name }).click();
      await expect(member.getByTestId('new-resources-source')).toHaveText('Your choice');
      await expectAccessible(member, 'profile: team defaults');
    } finally {
      await ctx.close();
    }
  } finally {
    await api.delete(`/api/teams/${team.id}`);
  }
});
