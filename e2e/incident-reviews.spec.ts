import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Incident reviews (#109): a designer starts a review from a resolved ticket reference, adds a measure, opens the
 * timeline picker, and the overdue measure shows on the service page.
 */

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('starts a review from a resolved ticket, keeps a measure, sees it on the service', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const svcName = uniq('E2E reviewed service');
    const number = uniq('INC');
    const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: svcName, owners: [] } }));
    const tk = await json<{ id: string }>(
      await api.post('/api/ticket-references', {
        data: { source: 'vendor', externalNumber: number, title: 'Gateway timeouts', vendor: 'NetCo', links: [{ kind: 'service', id: svc.id }] },
      }),
    );
    await api.post(`/api/ticket-references/${tk.id}/status`, { data: { status: 'resolved' } });

    // start the review from the ticket
    await page.goto(`/tickets/${tk.id}`);
    await page.getByRole('button', { name: 'Start incident review' }).click();
    await expect(page).toHaveURL(/\/records\/rec_/);
    await expect(page.getByRole('heading', { name: `${number} Gateway timeouts` })).toBeVisible();

    // a measure that is already overdue
    const measures = page.getByTestId('review-measures');
    await measures.getByRole('button', { name: 'Add measure' }).click();
    const form = page.getByRole('dialog', { name: 'Add measure' });
    await form.getByRole('textbox', { name: 'Measure' }).fill('Alert on gateway latency');
    await form.getByTestId('subjects-input').click();
    await page.getByRole('option', { name: /Dana/ }).first().click();
    await page.keyboard.press('Escape');
    await form.getByLabel('Due date').fill(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
    await expectAccessible(page, 'measure dialog');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    await expect(measures.getByRole('row', { name: /Alert on gateway latency/ })).toContainText('Overdue');

    // the timeline picker
    await page.getByRole('button', { name: 'Fill in the timeline' }).click();
    const timeline = page.getByRole('dialog', { name: 'What Steward saw in the time window' });
    await timeline.getByRole('button', { name: 'Show entries' }).click();
    await expect(timeline.getByText(/Nothing found|Ticket/).first()).toBeVisible();
    await expectAccessible(page, 'timeline dialog');
    await timeline.getByRole('button', { name: 'Cancel' }).click();
    await expectAccessible(page, 'review page');

    // the service shows the open measure
    await page.goto(`/services/${svc.id}`);
    const open = page.getByTestId('service-measures');
    await expect(open).toContainText('Alert on gateway latency');
    await expect(open).toContainText('Overdue');
  });
});
