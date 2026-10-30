import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

/** Owners are picked from the users and teams (#143); a team is deleted after seeing where it is still named. */

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('owners come from the list; deleting a team shows where it is named', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const teamName = uniq('E2E Team').replace(/[^\w .@-]/g, '');
    const team = await json<{ id: string; name: string }>(await api.post('/api/teams', { data: { name: teamName, members: [] } }));
    const appName = uniq('E2E Owned');
    let appId = '';
    try {
      await page.goto('/applications');
      await page.getByRole('button', { name: 'New application' }).first().click();
      const form = page.getByRole('dialog', { name: 'New application' });
      await form.getByRole('textbox', { name: 'Name' }).fill(appName);
      const owners = form.getByTestId('subjects-input');
      await owners.click();
      await page.keyboard.type(teamName);
      await page.getByRole('option', { name: `Team ${teamName}` }).click();
      await page.keyboard.press('Escape');
      await expectAccessible(page, 'owner picker');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(/\/applications\/app_/);
      appId = page.url().split('/').pop()!;
      const saved = await json<{ owners: string[] }>(await api.get(`/api/applications/${appId}`));
      expect(saved.owners).toEqual([`team:${teamName.toLowerCase()}`]);

      // the team is still an owner: the confirmation names the application
      await page.goto('/users');
      await page.getByRole('button', { name: `Delete team ${teamName}` }).click();
      const refs = page.getByTestId('subject-references');
      await expect(refs).toContainText('Applications (1)');
      await expect(refs).toContainText(appName);
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(async () => (await json<{ owners: string[] }>(await api.get(`/api/applications/${appId}`))).owners).toEqual([]);
    } finally {
      await api.delete(`/api/teams/${team.id}`).catch(() => undefined);
      if (appId) await api.post(`/api/applications/${appId}/archive`, { data: { archived: true } });
    }
  });
});
