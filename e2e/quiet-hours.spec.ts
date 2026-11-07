import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Quiet hours and digests (0.10.0, ADR 0012): a person sets them in the profile, the bell says when messages are held,
 * administrators see who uses them, and a team sets a default for its members.
 */

test.use({ storageState: authFile('audrey') });

const ALL_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const OFF = { quietHours: { enabled: false, timeZone: 'UTC', windows: [], allDay: [], urgentBreaksThrough: true }, digests: { timeZone: 'UTC', groups: {} } };

test('a person sets quiet hours and a digest, and administrators see who uses them', async ({ page, loginAs, apiAs }) => {
  await page.goto('/profile');
  await settle(page);
  const card = page.getByTestId('quiet-hours-card');
  await expect(card.getByTestId('quiet-source')).toHaveText('Off (default)');
  await card.getByLabel('Quiet hours for my e-mails').click();
  await expect(card.getByTestId('quiet-week-grid')).toBeVisible();
  // the default: weekdays 18:00–07:30 and the weekend
  await expect(card.getByTestId('quiet-window')).toHaveCount(1);
  await expect(card.getByLabel('From')).toHaveValue('18:00');
  await card.getByLabel('Until').fill('06:45');
  await card.getByRole('button', { name: 'Add a time' }).click();
  await expect(card.getByTestId('quiet-window')).toHaveCount(2);
  await card.getByRole('button', { name: 'Remove this time' }).last().click();
  await expect(card.getByTestId('quiet-window')).toHaveCount(1);
  // a digest: reports once a week
  await card.getByRole('combobox', { name: 'Reports and releases' }).click();
  await page.getByRole('option', { name: 'Weekly' }).click();
  await expect(card.getByTestId('digest-reports').getByRole('combobox', { name: 'Day' })).toHaveValue('Friday');
  // decisions: at most hourly
  await card.getByRole('combobox', { name: 'Decisions' }).click();
  await expect(page.getByRole('option', { name: 'Daily' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectAccessible(page, 'profile: quiet hours');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Quiet hours and digests saved')).toBeVisible();
  await expect(card.getByTestId('quiet-source')).toHaveText('Your own settings');

  await page.reload();
  await settle(page);
  await expect(card.getByLabel('Until')).toHaveValue('06:45');

  // administrators: who uses them, never the content
  const admin = await loginAs('admin');
  await admin.goto('/settings/notifications');
  await settle(admin);
  const row = admin.getByRole('table', { name: 'Quiet hours and digests' }).getByRole('row').filter({ hasText: 'audrey' });
  await expect(row).toContainText('Reports and releases: Weekly');
  await expectAccessible(admin, 'settings: quiet hours');

  // back to the default
  await card.getByRole('button', { name: 'Back to the default' }).click();
  await expect(card.getByTestId('quiet-source')).toHaveText('Off (default)');
  expect((await json<{ source: { from: string } }>(await (await apiAs('audrey')).get('/api/me/notification-prefs'))).source.from).toBe('instance');
});

test('the bell says when messages are held during quiet hours', async ({ loginAs, apiAs }) => {
  const api = await apiAs('adam');
  await api.put('/api/me/notification-prefs', {
    data: { ...OFF, quietHours: { enabled: true, timeZone: 'Europe/Berlin', windows: [], allDay: ALL_WEEK, urgentBreaksThrough: true } },
  });
  try {
    const page = await loginAs('adam');
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByTestId('quiet-hours-line')).toContainText('Quiet hours');
    await expect(drawer.getByTestId('quiet-hours-line')).toContainText('0 messages held');
    await expectAccessible(page, 'bell during quiet hours');
  } finally {
    await api.delete('/api/me/notification-prefs');
  }
});

test('a team sets quiet hours for its members, and its Teams channel gets its own', async ({ browser, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Night shift');
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name, members: ['olivia'] } }));
  const ctx = await browser.newContext({ storageState: authFile('admin'), baseURL: baseURL() });
  try {
    const page = await ctx.newPage();
    await page.goto('/users');
    await page.getByRole('button', { name: `Settings of team ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: `Settings of team ${name}` });
    await dialog.getByRole('tab', { name: 'Quiet hours' }).click();
    await expect(dialog.getByTestId('team-quiet-scope')).toHaveText('Instance default');
    await dialog.getByRole('button', { name: 'Set a default for members' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('team-quiet-scope')).toHaveText('Overrides the instance default');
    await expectAccessible(page, 'team settings: quiet hours');

    // the channel in Teams format has quiet hours of its own
    await dialog.getByRole('tab', { name: 'Channel' }).click();
    await dialog.getByRole('button', { name: 'Use an own channel' }).click();
    await expect(dialog.getByTestId('team-channel-quiet')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Format' }).click();
    await page.getByRole('option', { name: 'JSON webhook' }).click();
    await expect(dialog.getByTestId('team-channel-quiet')).toHaveCount(0);

    const member = await browser.newContext({ storageState: authFile('olivia'), baseURL: baseURL() });
    try {
      const p = await member.newPage();
      await p.goto('/profile');
      await expect(p.getByTestId('quiet-source')).toHaveText(`Default of team ${name}`);
    } finally {
      await member.close();
    }
  } finally {
    await ctx.close();
    await api.delete(`/api/teams/${team.id}`);
  }
});

test('quiet hours on a phone @mobile', async ({ page }) => {
  await page.goto('/profile');
  await settle(page);
  const card = page.getByTestId('quiet-hours-card');
  await card.getByLabel('Quiet hours for my e-mails').click();
  await expect(card.getByTestId('quiet-week-grid')).toBeVisible();
  // nothing wider than the screen
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'profile: quiet hours (phone)');
});
