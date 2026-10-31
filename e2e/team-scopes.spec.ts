import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Team-scoped access (#131): roles in a team, owning teams of a process, and why someone has access. */
test('an administrator gives a team a process and a member a role in the team; others no longer see it', async ({ page, apiAs, loginAs }) => {
  const api = await apiAs('admin');
  const teamName = uniq('Orders');
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name: teamName, members: ['vera'] } }));
  const name = uniq('Team process');
  const proc = await json<{ id: string }>(
    await api.post('/api/processes', { data: { definition: { name, nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } } }),
  );
  try {
    // a role in the team for the viewer vera
    await page.goto('/users');
    await page.getByRole('button', { name: `Edit team ${teamName}` }).click();
    const dialog = page.getByRole('dialog', { name: `Edit team ${teamName}` });
    await dialog.getByRole('textbox', { name: 'vera: roles in the team' }).click({ force: true });
    await page.getByRole('option', { name: 'designer', exact: true }).click();
    await dialog.getByRole('heading', { name: `Edit team ${teamName}` }).click(); // closes the dropdown
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Team "${teamName}" saved`)).toBeVisible();
    await expect(page.getByText('vera · designer')).toBeVisible();

    // the team owns the process
    await page.goto(`/processes/${proc.id}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByText(/belongs to the whole instance/)).toBeVisible();
    await page.getByRole('textbox', { name: 'Teams' }).fill(teamName, { force: true });
    await page.getByRole('option', { name: teamName }).click();
    await page.getByText('Owning teams', { exact: true }).click(); // closes the dropdown
    await page.getByRole('button', { name: 'Save owning teams' }).click();
    await expect(page.getByText('Owning teams saved')).toBeVisible();
    await expect(page.getByText(/Members of these teams have their roles/)).toBeVisible();
    await expectAccessible(page, 'process access with owning teams');

    // why vera may edit it
    await page.getByRole('button', { name: 'Why do I have access?' }).click();
    const why = page.getByRole('dialog', { name: 'Who may do what, and why' });
    await expect(why.getByText(/Administrator:/)).toBeVisible();
    await why.getByRole('textbox', { name: 'For user' }).fill('vera', { force: true });
    await page.getByRole('option', { name: /\(vera\)/ }).click();
    await expect(why.getByText(new RegExp(`designer in team ${teamName}`))).toBeVisible();
    await expectAccessible(page, 'access explanation');
    await page.keyboard.press('Escape');

    // services, applications and systems have the same panel
    const service = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('Team service'), owners: [] } }));
    await page.goto(`/services/${service.id}`);
    await expect(page.getByText('Owning teams', { exact: true })).toBeVisible();
    await expect(page.getByText(/This service belongs to the whole instance/)).toBeVisible();
    await api.delete(`/api/services/${service.id}`);

    // vera (a member) edits it, dana (a designer outside the team) does not see it
    const vera = await loginAs('vera');
    await vera.goto(`/processes/${proc.id}`);
    await expect(vera.getByRole('heading', { name })).toBeVisible();
    const dana = await apiAs('dana');
    expect((await dana.get(`/api/processes/${proc.id}`)).status()).toBe(404);
  } finally {
    await api.put(`/api/owning-teams/process/${proc.id}`, { data: { teamIds: [] } });
    await api.delete(`/api/processes/${proc.id}`);
    await api.delete(`/api/teams/${team.id}`);
  }
});

test('a record has owning teams on its access tab; a whole service is moved with a preview', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const teamName = uniq('Payments');
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name: teamName, members: ['vera'] } }));
  const service = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('Card payments'), owners: [] } }));
  const rec = await json<{ id: string }>(
    await api.post('/api/records', { data: { type: 'ADR', title: uniq('Tokenise cards'), links: [{ kind: 'service', id: service.id }] } }),
  );
  try {
    await page.goto(`/records/${rec.id}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByText(/This record belongs to the whole instance/)).toBeVisible();
    await expectAccessible(page, 'record access tab');

    await page.goto(`/services/${service.id}`);
    await page.getByRole('button', { name: 'Owning teams for the whole service…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Owning teams for the service and what belongs to it' });
    await dialog.getByRole('textbox', { name: 'Teams' }).fill(teamName, { force: true });
    await page.getByRole('option', { name: teamName }).click();
    await dialog.getByText(/Covers the service/).click(); // closes the dropdown
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.getByRole('cell', { name: /Tokenise cards/ })).toBeVisible();
    await expect(dialog.getByRole('cell', { name: new RegExp(`→ ${teamName}`) }).first()).toBeVisible();
    await expectAccessible(page, 'bulk owning teams preview');
    await dialog.getByRole('button', { name: /Apply to \d+ resources/ }).click();
    await expect(page.getByText(/Owning teams changed on \d+ resources/)).toBeVisible();
    await page.goto(`/records/${rec.id}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByText(/Only members of these teams see this record/)).toBeVisible();
  } finally {
    await api.post('/api/owning-teams/bulk', { data: { service: service.id, teamIds: [] } });
    await api.delete(`/api/services/${service.id}`);
    await api.delete(`/api/teams/${team.id}`);
  }
});
