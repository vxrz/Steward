import { request as pwRequest, type BrowserContext } from '@playwright/test';
import { test, expect, USERS } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';
import { sessionState } from './support/server';

test.use({ storageState: authFile('admin') });

/**
 * Owners from outside the owning teams (#195): the form says before saving that the person will see and change the
 * item, saving asks for the step-up, and "Why do I have access?" names the entry as a named owner.
 */
test('naming an owner from outside the owning teams is said before saving, confirmed and explained', async ({ browser, apiAs, loginAs }) => {
  const admin = await apiAs('admin');
  const teamName = uniq('Orders').replace(/[^\w .@-]/g, '');
  const team = await json<{ id: string }>(await admin.post('/api/teams', { data: { name: teamName, members: [USERS.dana.username] } }));
  const serviceName = uniq('Order intake');
  const service = await json<{ id: string }>(await admin.post('/api/services', { data: { name: serviceName, owners: [] } }));
  await admin.put(`/api/owning-teams/service/${service.id}`, { data: { teamIds: [team.id] } });
  // Dana (a designer in the team) in a session of her own that is not confirmed
  const api = await pwRequest.newContext({ baseURL: baseURL(), extraHTTPHeaders: { 'x-sm-client': '1' } });
  let ctx: BrowserContext | undefined;
  try {
    const login = await api.post('/api/auth/login', { data: { username: USERS.dana.username, password: USERS.dana.password } });
    expect(login.ok()).toBeTruthy();
    const cookie = login.headers()['set-cookie']!.split(';')[0]!;
    const keys = { sessionKey: login.headers()['x-sm-session-key']!, linkKey: login.headers()['x-sm-link-key']! };
    const ended = await api.delete('/api/auth/step-up', { headers: { cookie, 'x-sm-session': keys.sessionKey } });
    expect(ended.ok(), `${ended.status()} ${await ended.text()}`).toBeTruthy();
    ctx = await browser.newContext({ baseURL: baseURL(), serviceWorkers: 'block', storageState: sessionState(baseURL(), cookie, keys) });
    const page = await ctx.newPage();
    await page.goto(`/services/${service.id}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.getByRole('dialog', { name: `Edit ${serviceName}` });
    // a member of the team: no hint
    await form.getByTestId('subjects-input').click();
    await page.keyboard.type(USERS.dana.username);
    await page.getByRole('option', { name: new RegExp(`\\(${USERS.dana.username}\\)`) }).click();
    await page.keyboard.press('Escape');
    await expect(form.getByTestId('named-outside-hint')).toBeHidden();
    // Vera (outside the team): the hint says what saving does
    await form.getByTestId('subjects-input').click();
    await page.keyboard.type(USERS.vera.username);
    await page.getByRole('option', { name: new RegExp(`\\(${USERS.vera.username}\\)`) }).click();
    await page.keyboard.press('Escape');
    const hint = form.getByTestId('named-outside-hint');
    await expect(hint).toContainText(`user:${USERS.vera.username} is not in the owning teams (${teamName}) and will see and change this item`);
    await expectAccessible(page, 'owner from outside the owning teams');
    await form.getByRole('button', { name: 'Save' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog.getByTestId('step-up-actions')).toContainText('Name an owner or responsible from outside the owning teams');
    await dialog.getByLabel('Your password').fill(USERS.dana.password);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();
    await expect(form).toBeHidden();
    const saved = await json<{ owners: string[] }>(await admin.get(`/api/services/${service.id}`));
    expect(saved.owners).toEqual([`user:${USERS.dana.username}`, `user:${USERS.vera.username}`]);

    // Vera sees the service now, and why
    const vera = await loginAs('vera');
    await vera.goto(`/services/${service.id}`);
    await vera.getByRole('button', { name: 'Why do I have access?' }).click();
    const why = vera.getByRole('dialog', { name: 'Who may do what, and why' });
    await expect(why.getByText(`Named owner (user:${USERS.vera.username}): view, edit`)).toBeVisible();
  } finally {
    await ctx?.close();
    await api.dispose();
    await admin.put(`/api/owning-teams/service/${service.id}`, { data: { teamIds: [] } });
    await admin.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
    await admin.delete(`/api/teams/${team.id}`);
  }
});
