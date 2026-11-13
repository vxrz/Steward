import { type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';
import { ownApi, ownUser, type OwnUser } from './support/ownUser';

test.use({ storageState: authFile('admin') });

/** The password of users made with ownUser() after their first sign-in. */
const OWN_PASSWORD = 'Own-e2e-password-2';

/**
 * The Access tab (ADR 0033, #290, #291): _Shared with_ on a service – add, change and remove a share, the preview of
 * who gains and loses what, the step-up for a widening, a share the reader may not see kept, and the owners' implied
 * Edit share.
 */

async function pageAs(browser: import('@playwright/test').Browser, u: OwnUser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: baseURL(), serviceWorkers: 'block', storageState: u.file });
  return { ctx, page: await ctx.newPage() };
}

test('a share is added, changed and removed with a preview; giving access asks for the step-up', async ({ browser, apiAs }) => {
  const admin = await apiAs('admin');
  const designer = await ownUser('e2e-sharer-', ['designer'], 'Sam Sharer (own)');
  const reader = await ownUser('e2e-reader-', ['viewer'], 'Rita Reader (own)');
  const team = await json<{ id: string }>(
    await admin.post('/api/teams', { data: { name: uniq('Shares').replace(/[^\w .@-]/g, ''), members: [designer.username] } }),
  );
  const service = await json<{ id: string }>(await admin.post('/api/services', { data: { name: uniq('Invented order intake'), owners: [] } }));
  expect((await admin.put(`/api/owning-teams/service/${service.id}`, { data: { teamIds: [team.id] } })).ok()).toBe(true);
  // the designer's session is not confirmed: giving access asks for the step-up
  const dApi = await ownApi(designer);
  expect((await dApi.delete('/api/auth/step-up')).ok()).toBe(true);
  const { ctx, page } = await pageAs(browser, designer);
  const shares = async () => (await json<{ shares: { subject: string; level: string }[] }>(await admin.get(`/api/access/service/${service.id}/shares`))).shares;
  try {
    await page.goto(`/services/${service.id}/access`);
    const panel = page.getByTestId('shares-panel');
    await expect(panel.getByRole('heading', { name: 'Shared with' })).toBeVisible();
    await expect(panel.getByTestId('shares-empty')).toHaveText('Not shared with anyone.');
    await expectAccessible(page, 'access tab of a service');

    // add: Rita, View
    await panel.getByRole('combobox', { name: 'Share with' }).click();
    await page.keyboard.type(reader.username);
    await page.getByRole('option', { name: `(${reader.username})` }).click();
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(panel.getByTestId('share-row')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Save shares' }).click();
    const preview = page.getByRole('dialog', { name: 'Before you save' });
    await expect(preview).toContainText('Rita Reader (own) gains: View');
    await expectAccessible(page, 'preview of a share');
    await preview.getByRole('button', { name: 'Save', exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
    await stepUp.getByLabel('Your password').fill(OWN_PASSWORD);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Shares saved')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Shared with' })).toBeFocused();
    expect(await shares()).toEqual([expect.objectContaining({ subject: `user:${reader.username}`, level: 'view' })]);

    // change: View → Edit (the session is confirmed now)
    await panel.getByRole('combobox', { name: 'Level for Rita Reader (own)' }).click();
    await page.getByRole('option', { name: 'Edit' }).click();
    await panel.getByRole('button', { name: 'Save shares' }).click();
    await expect(preview).toContainText('Rita Reader (own) gains: Edit');
    await preview.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect.poll(async () => (await shares())[0]?.level).toBe('edit');

    // remove: a narrowing, confirmed in the preview
    await panel.getByRole('button', { name: 'Remove the share with Rita Reader (own)' }).click();
    await panel.getByRole('button', { name: 'Save shares' }).click();
    await expect(preview).toContainText('Rita Reader (own) loses: View, Edit');
    await preview.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect.poll(async () => (await shares()).length).toBe(0);

    // the phone layout: the tab fits the screen
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByTestId('shares-empty')).toBeVisible();
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
    await dApi.dispose();
    await admin.put(`/api/owning-teams/service/${service.id}`, { data: { teamIds: [] } });
    await admin.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
    await admin.delete(`/api/teams/${team.id}`);
  }
});

test('a share with a subject the reader may not see is counted, not named, and kept', async ({ browser, apiAs }) => {
  const admin = await apiAs('admin');
  // a viewer who manages the service by a share: viewers may not list users and teams
  const manager = await ownUser('e2e-sharemgr-', ['viewer'], 'Mia Manager (own)');
  const reader = await ownUser('e2e-reader-', ['viewer'], 'Rita Reader (own)');
  const teamName = uniq('Hidden').replace(/[^\w .@-]/g, '');
  const team = await json<{ id: string }>(await admin.post('/api/teams', { data: { name: teamName, members: [] } }));
  const service = await json<{ id: string }>(await admin.post('/api/services', { data: { name: uniq('Invented payroll'), owners: [] } }));
  const put = await admin.put(`/api/access/service/${service.id}/shares`, {
    data: {
      shares: [
        { subject: `user:${manager.username}`, level: 'manage' },
        { subject: `team:${teamName.toLowerCase()}`, level: 'view' },
      ],
    },
  });
  expect(put.ok(), await put.text()).toBe(true);
  const { ctx, page } = await pageAs(browser, manager);
  try {
    await page.goto(`/services/${service.id}/access`);
    const panel = page.getByTestId('shares-panel');
    await expect(panel.getByTestId('shares-hidden')).toHaveText('And 1 share with a user or team you may not see – it is kept when you save.');
    await expect(panel).not.toContainText(teamName);
    await panel.getByRole('textbox', { name: 'Share with' }).fill(`user:${reader.username}`);
    await panel.getByRole('button', { name: 'Add', exact: true }).click();
    await panel.getByRole('button', { name: 'Save shares' }).click();
    const preview = page.getByRole('dialog', { name: 'Before you save' });
    await expect(preview).toContainText(`${reader.username} gains: View`);
    await preview.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Shares saved')).toBeVisible();
    const after = await json<{ shares: { subject: string }[] }>(await admin.get(`/api/access/service/${service.id}/shares`));
    expect(after.shares.map((s) => s.subject).sort()).toEqual([`team:${teamName.toLowerCase()}`, `user:${manager.username}`, `user:${reader.username}`].sort());
  } finally {
    await ctx.close();
    await admin.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
    await admin.delete(`/api/teams/${team.id}`);
  }
});

test('an owner shows as an implied Edit share on the Access tab and in Why do I have access?', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const owner = await ownUser('e2e-owner-', ['viewer'], 'Olga Owner (own)');
  const app = await json<{ id: string }>(
    await admin.post('/api/applications', { data: { name: uniq('Invented order portal'), owners: [`user:${owner.username}`] } }),
  );
  try {
    await page.goto(`/applications/${app.id}`);
    const implied = page.getByTestId('shares-implied');
    await expect(implied).toContainText('Olga Owner (own)');
    await expect(implied).toContainText('Owner – Edit (implied)');
    await page.getByRole('button', { name: 'Why do I have access?' }).click();
    const why = page.getByRole('dialog', { name: 'Who may do what, and why' });
    await why.getByRole('combobox', { name: 'For user' }).fill(owner.username, { force: true });
    await page.getByRole('option', { name: `(${owner.username})` }).click();
    await expect(why.getByText(`Owner (user:${owner.username}): Edit (implied)`)).toBeVisible();
  } finally {
    await admin.post(`/api/applications/${app.id}/archive`, { data: { archived: true } });
  }
});
