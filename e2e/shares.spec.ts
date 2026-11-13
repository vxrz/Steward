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

test('a team named as owner gives an implied share, not a scope: the Access tab says so and leads to the owning teams', async ({ browser, page, apiAs }) => {
  const admin = await apiAs('admin');
  const team = await json<{ id: string; name: string }>(
    await admin.post('/api/teams', { data: { name: uniq('Owner team').replace(/[^\w .@-]/g, ''), members: [] } }),
  );
  const sys = await json<{ id: string }>(
    await admin.post('/api/systems', { data: { name: uniq('Invented line server'), kind: 'server', owners: [`team:${team.name.toLowerCase()}`] } }),
  );
  expect((await admin.put(`/api/owning-teams/system/${sys.id}`, { data: { teamIds: [] } })).ok()).toBe(true);
  try {
    await page.goto(`/systems/${sys.id}`);
    const panel = page.getByTestId('shares-panel');
    // the scope line says there are no owning teams, the implied share says it does not scope the item
    await expect(panel.getByTestId('shares-scope')).toHaveText(
      "Scope: the whole instance – no owning teams, so everybody's roles apply, and the shares below add to them.",
    );
    await expect(panel.getByTestId('shares-implied')).toContainText('Owner – Edit (implied)');
    await expect(panel.getByTestId('shares-implied-hint')).toHaveText(
      'The owner field gives these shares, and they go when the owner is removed. They do not limit who sees the item – owning teams do.',
    );
    // an administrator gets the way to the owning teams: the button puts the focus into their field
    await expect(panel.getByTestId('shares-scope-teams')).toContainText('To keep this item to some teams, set its owning teams.');
    await expectAccessible(page, 'access of a system with a team as owner');
    await panel.getByRole('button', { name: 'Set owning teams' }).click();
    await expect(page.getByRole('combobox', { name: 'Teams' })).toBeFocused();

    // German
    const ctx = await browser.newContext({ baseURL: baseURL(), serviceWorkers: 'block', storageState: authFile('admin'), locale: 'de-DE' });
    try {
      const de = await ctx.newPage();
      await de.addInitScript(() => localStorage.setItem('steward.language', 'de'));
      await de.goto(`/systems/${sys.id}`);
      const dePanel = de.getByTestId('shares-panel');
      await expect(dePanel.getByTestId('shares-scope')).toContainText('keine zuständigen Teams');
      await expect(dePanel.getByTestId('shares-implied-hint')).toContainText('Sie begrenzen nicht, wer den Eintrag sieht – das tun die zuständigen Teams.');
      await dePanel.getByRole('button', { name: 'Zuständige Teams festlegen' }).click();
      await expect(de.getByRole('combobox', { name: 'Teams' })).toBeFocused();
    } finally {
      await ctx.close();
    }

    // with an owning team, the scope names it and the way there is gone
    expect((await admin.put(`/api/owning-teams/system/${sys.id}`, { data: { teamIds: [team.id] } })).ok()).toBe(true);
    await page.reload();
    await expect(panel.getByTestId('shares-scope')).toContainText(`Scope: the owning teams (${team.name})`);
    await expect(panel.getByTestId('shares-scope-teams')).toHaveCount(0);
  } finally {
    await admin.delete(`/api/systems/${sys.id}`);
    await admin.delete(`/api/teams/${team.id}`);
  }
});

test('a supplier has the Access tab; the merge preview names a share that opens a source', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const reader = await ownUser('e2e-reader-', ['viewer'], 'Rita Reader (own)');
  const name = uniq('Invented Share Mail');
  const teamA = await json<{ id: string }>(await admin.post('/api/teams', { data: { name: uniq('Share A').replace(/[^\w .@-]/g, ''), members: [] } }));
  const teamB = await json<{ id: string }>(await admin.post('/api/teams', { data: { name: uniq('Share B').replace(/[^\w .@-]/g, ''), members: [] } }));
  for (const t of [teamA, teamB]) expect((await admin.put(`/api/teams/${t.id}/settings`, { data: { newResources: 'never' } })).ok()).toBe(true);
  const target = await json<{ id: string }>(await admin.post('/api/suppliers', { data: { name } }));
  const source = await json<{ id: string }>(await admin.post('/api/suppliers', { data: { name: `${name} GmbH` } }));
  expect((await admin.put(`/api/owning-teams/supplier/${target.id}`, { data: { teamIds: [teamA.id] } })).ok()).toBe(true);
  expect((await admin.put(`/api/owning-teams/supplier/${source.id}`, { data: { teamIds: [teamB.id] } })).ok()).toBe(true);
  const put = await admin.put(`/api/access/supplier/${target.id}/shares`, { data: { shares: [{ subject: `user:${reader.username}`, level: 'view' }] } });
  expect(put.ok(), await put.text()).toBe(true);
  try {
    await page.goto(`/suppliers/${target.id}?tab=access`);
    const panel = page.getByTestId('shares-panel');
    await expect(panel.getByTestId('share-row')).toContainText('Rita Reader (own)');
    await expect(page.getByText('Owning teams', { exact: true })).toBeVisible();
    await expectAccessible(page, 'access tab of a supplier');

    await page.goto('/suppliers?status=unconfirmed');
    const group = page.getByTestId('shared-group').filter({ hasText: `${name} GmbH` });
    await group.getByTestId('shared-merge').click();
    const preview = page.getByTestId('merge-preview');
    await expect(preview.getByTestId('merge-shares')).toContainText('Rita Reader (own) (View)');
    await expectAccessible(page, 'merge preview naming a share');
  } finally {
    for (const s of [target, source]) await admin.post(`/api/suppliers/${s.id}/archive`, { data: { archived: true } });
    for (const t of [teamA, teamB]) await admin.delete(`/api/teams/${t.id}`);
  }
});
