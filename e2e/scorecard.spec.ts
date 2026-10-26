import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/**
 * Availability objectives and the service scorecard (#86): define an objective on a Gatus endpoint on the service
 * page, then see the scorecard of the service with its four parts – duties, availability, documentation, protection
 * need – on the service page and on the Scorecard page.
 */
test('define an availability objective and see the scorecard of the service', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const api = await apiAs('dana');
  const adam = await apiAs('adam');

  // the demo Gatus platform with metrics mode and Gatus' uptime figures (read with the scrape)
  const gatus = (await json<{ id: string; name: string; kind: string }[]>(await admin.get('/api/platforms'))).find((p) => p.kind === 'gatus')!;
  await json(await admin.put(`/api/gatus/sources/${gatus.id}`, { data: { enabled: true, intervalSeconds: 3600, fetchUptimes: true } }));
  await expect.poll(async () => (await admin.post(`/api/gatus/sources/${gatus.id}/scrape`)).status(), { timeout: 30_000, intervals: [1000, 5000] }).toBe(200);
  const endpoint = (
    await json<{ key: string; group: string; name: string; gatusUptime: { h24: number | null } | null }[]>(
      await api.get(`/api/gatus/sources/${gatus.id}/endpoints`),
    )
  ).find((e) => e.gatusUptime?.h24 !== null && e.gatusUptime?.h24 !== undefined)!;
  expect(endpoint).toBeTruthy();

  // a service with a duty, a rated application and a released document
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('E2E scorecard service'), owners: [] } }));
  const proc = await json<{ id: string }>(
    await api.post('/api/processes', { data: { definition: { name: uniq('E2E scorecard process'), nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } } }),
  );
  await json(
    await api.post('/api/duties', { data: { serviceId: svc.id, name: uniq('Monthly check'), processId: proc.id, interval: 'monthly', level: 'mandatory' } }),
  );
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('E2E scorecard app'), owners: [] } }));
  await json(await api.put(`/api/services/${svc.id}/applications/${app.id}`, { data: { role: 'primary' } }));
  const justification = 'E2E assessment';
  await json(
    await api.put(`/api/applications/${app.id}/rating`, {
      data: {
        confidentiality: { level: 'high', justification },
        integrity: { level: 'normal', justification },
        availability: { level: 'normal', justification },
      },
    }),
  );
  const doc = await json<{ id: string }>(
    await api.post('/api/records', { data: { type: 'DOC', title: uniq('E2E operations manual'), links: [{ kind: 'service', id: svc.id, note: '' }] } }),
  );
  await json(await api.post(`/api/records/${doc.id}/transition`, { data: { action: 'submit', changeSummary: 'First edition' } }));
  await json(await adam.post(`/api/records/${doc.id}/transition`, { data: { action: 'approve' } }));

  // define the objective on the service page
  await page.goto(`/services/${svc.id}`);
  const panel = page.getByTestId('objectives-panel');
  await expect(panel).toContainText('No availability objectives yet');
  await panel.getByRole('button', { name: 'Add objective' }).click();
  const form = page.getByRole('dialog', { name: 'Add objective' });
  await chooseOption(page, /^Gatus platform/, gatus.name);
  await chooseOption(page, /^Endpoint/, endpoint.group ? `${endpoint.group}/${endpoint.name}` : endpoint.name);
  await expect(form.getByRole('textbox', { name: /^Name/ })).toHaveValue(endpoint.name);
  await form.getByRole('textbox', { name: 'Target for 24 h' }).fill('1');
  await form.getByRole('textbox', { name: 'Target for 30 days' }).fill('');
  await form.getByRole('checkbox', { name: /Send a message/ }).check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  const card = panel.getByRole('listitem').filter({ hasText: endpoint.name });
  await expect(card.getByTestId('objective-status')).toHaveText('Met');
  await expect(card.getByTestId('window-h24')).toContainText('(≥ 1 %)');
  await expect(card).toContainText('Sends a message');
  await card.getByRole('button', { name: 'Show history' }).click();
  await expect(card.getByTestId('objective-history')).toContainText('in the last 30 days');

  // the scorecard of the service: four parts, each with its own status
  await page.reload();
  const sc = page.getByTestId('scorecard-panel');
  await expect(sc.getByTestId('part-duties').getByTestId('part-status')).toHaveText('Open');
  await expect(sc.getByTestId('part-duties')).toContainText('Mandatory: 0 of 1 met, 1 open');
  await expect(sc.getByTestId('part-availability').getByTestId('part-status')).toHaveText('OK');
  await expect(sc.getByTestId('part-availability')).toContainText('1 of 1 met');
  await expect(sc.getByTestId('part-documentation').getByTestId('part-status')).toHaveText('OK');
  await expect(sc.getByTestId('part-documentation')).toContainText('1 of 1 documents released');
  await expect(sc.getByTestId('part-protection').getByTestId('part-status')).toHaveText('OK');
  await expect(sc.getByTestId('part-protection')).toContainText('Confidentiality: High');
  await expect(sc.getByTestId('attention')).toHaveText('OK');
  await settle(page);
  await expectAccessible(page, 'service page with objectives and scorecard');

  // the Scorecard page lists the service with its parts
  await page.goto('/scorecard');
  const row = page.getByTestId(`scorecard-${svc.id}`);
  await expect(row.getByTestId('attention')).toHaveText('OK');
  await expect(row.getByTestId('part-status')).toHaveText(['Open', 'OK', 'OK', 'OK']);
  await expect(page.getByTestId('scorecard-rollup')).toContainText('Services');
  await expect(page.getByTestId('scorecard-rules')).toContainText('No rules.');
  await settle(page);
  await expectAccessible(page, 'scorecard page');
  await expectNoHorizontalScroll(page);
  // on a phone: a card per service, no horizontal scrolling
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByTestId('part-status')).toHaveText(['Open', 'OK', 'OK', 'OK']);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'scorecard page on a phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  // attention only: the service is not listed
  await page.getByText('Attention needed only', { exact: true }).click(); // Mantine hides the input behind its label
  await expect(page.getByRole('switch', { name: 'Attention needed only' })).toBeChecked();
  await expect(page).toHaveURL(/attention=1/);
  await expect(page.getByTestId(`scorecard-${svc.id}`)).toHaveCount(0);

  // objectives are archived, not deleted: the archived one is listed below the active ones
  await page.goto(`/services/${svc.id}`);
  const objectives = page.getByTestId('objectives-panel');
  await objectives.getByRole('button', { name: `Archive the objective “${endpoint.name}”` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
  await expect(objectives).toContainText('No availability objectives yet');
  await expect(objectives).toContainText('1 archived objective');
});
