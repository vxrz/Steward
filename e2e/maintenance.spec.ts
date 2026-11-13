import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { animationsDone, expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Maintenance windows (#108): a designer plans a weekly window for an application from its page, sees it on the
 * Maintenance page (list and calendar) and in the details with the calendar file, and cancels it; a monitor's
 * maintenance is planned with the same form (0.11); a viewer reads it without the buttons to change it.
 */

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('plans a weekly window from the application page, finds it in the list and calendar, cancels it', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const appName = uniq('E2E Maintained');
    const title = uniq('Patch night');
    const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name: appName, owners: [] } }));
    try {
      await page.goto(`/applications/${app.id}`);
      const panel = page.getByTestId('maintenance-panel');
      await expect(panel).toContainText('No maintenance planned.');
      await panel.getByRole('button', { name: 'Plan maintenance' }).click();
      const form = page.getByRole('dialog', { name: 'Plan maintenance' });
      await form.getByRole('textbox', { name: 'Title' }).fill(title);
      // the application is already listed
      await expect(form.getByTestId('maintenance-targets')).toBeVisible();
      await expect(form.getByText(appName)).toBeVisible();
      await form.getByRole('combobox', { name: 'Repeats' }).click();
      await animationsDone(page);
      await page.getByRole('option', { name: 'Weekly' }).click();
      await expect(form.getByRole('textbox', { name: 'Every' })).toHaveValue('1');
      await expectAccessible(page, 'maintenance dialog');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      await expect(panel.getByText(new RegExp(`Next: ${title}`))).toBeVisible();

      // the Maintenance page lists it, the details offer the calendar file
      await page.goto('/maintenance');
      const row = page.getByRole('row', { name: new RegExp(title) });
      await expect(row).toContainText('Weekly');
      await expect(row.getByRole('link', { name: appName })).toBeVisible();
      await expectAccessible(page, 'maintenance list');
      await row.getByRole('button', { name: `Details of ${title}` }).click();
      const detail = page.getByRole('dialog', { name: title });
      await expect(detail.getByTestId('maintenance-detail')).toContainText('Next occurrences');
      const ics = detail.getByRole('link', { name: 'Add to calendar (.ics)' });
      await expect(ics).toHaveAttribute('href', /\/api\/maintenance-windows\/mtw_[^/]+\/ics(\?|$)/);
      const body = await (await api.get((await ics.getAttribute('href'))!.split('?')[0]!)).text();
      expect(body).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1');
      await expectAccessible(page, 'maintenance details');
      await detail.getByRole('button', { name: 'Close' }).click();

      // the calendar shows it (tomorrow, or next month at the end of a month)
      await page.getByText('Calendar', { exact: true }).click();
      const calendar = page.getByTestId('maintenance-calendar');
      const shown = calendar.getByRole('button', { name: new RegExp(title) }).first();
      if (!(await shown.isVisible())) await calendar.getByRole('button', { name: 'Next month' }).click();
      await expect(calendar.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();
      await expectAccessible(page, 'maintenance calendar');

      // cancel it from the details
      await calendar
        .getByRole('button', { name: new RegExp(title) })
        .first()
        .click();
      await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Cancel maintenance' }).click();
      await page.getByTestId('confirm-dialog-confirm').click();
      await expect(page.getByRole('dialog', { name: title }).getByText('Cancelled', { exact: true })).toBeVisible();
    } finally {
      await api.put(`/api/applications/${app.id}`, { data: { name: appName, owners: [], archived: true } });
    }
  });
});

test.describe('a monitor’s maintenance (0.11: catalogue windows)', () => {
  test.use({ storageState: authFile('dana') });

  test('plans a window for a monitor on its page with the catalogue form; the monitor is in maintenance', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const name = uniq('E2E maintained monitor');
    const title = uniq('Gateway swap');
    const created = await json<{ monitor: { id: string } }>(
      await api.post('/api/monitors', {
        data: { definition: { name, checks: [{ id: 'hb', name: 'Gateway report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] } },
      }),
    );
    const id = created.monitor.id;
    try {
      await page.goto(`/monitors/${id}`);
      await page.getByRole('tab', { name: 'Maintenance' }).click();
      const tab = page.getByTestId('monitor-maintenance');
      await expect(tab).toContainText('No maintenance windows.');
      await tab.getByRole('button', { name: 'Plan maintenance' }).click();
      const form = page.getByRole('dialog', { name: 'Plan maintenance' });
      await form.getByRole('textbox', { name: 'Title' }).fill(title);
      // the monitor is already listed
      await expect(form.getByText(name)).toBeVisible();
      // now, for an hour – in the browser's time zone, which the form uses
      const [start, end] = await page.evaluate(() => {
        const local = (t: number) => {
          const d = new Date(t);
          const p = (n: number) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        return [local(Date.now() - 5 * 60_000), local(Date.now() + 3_600_000)];
      });
      await form.getByLabel(/^Start/).fill(start);
      await form.getByLabel(/^End/).fill(end);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      const item = tab.getByTestId('monitor-maintenance-window').filter({ hasText: title });
      await expect(item).toContainText('Lists this monitor');
      await expect
        .poll(async () => (await json<{ maintenance: { id: string } | null }>(await api.get(`/api/monitors/${id}`))).maintenance?.id ?? null)
        .not.toBeNull();
      await settle(page);
      await expectAccessible(page, 'monitor maintenance tab');
      // the details are the catalogue window's: cancel it there
      await item.getByRole('button', { name: title }).click();
      const detail = page.getByRole('dialog', { name: title });
      await detail.getByRole('button', { name: 'Cancel maintenance' }).click();
      await page.getByTestId('confirm-dialog-confirm').click();
      await expect(detail.getByText('Cancelled', { exact: true })).toBeVisible();
      await expect.poll(async () => (await json<{ maintenance: unknown }>(await api.get(`/api/monitors/${id}`))).maintenance).toBeNull();
    } finally {
      await api.delete(`/api/monitors/${id}`);
    }
  });
});

test.describe('as a viewer', () => {
  test.use({ storageState: authFile('vera') });

  test('reads planned maintenance without the buttons to change it', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const title = uniq('Viewer window');
    const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('E2E maint service'), owners: [] } }));
    // in two days at 09:00 UTC: one hour within the same day in Berlin
    const day = new Date(Date.now() + 2 * 86_400_000);
    const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9);
    const w = await json<{ id: string }>(
      await api.post('/api/maintenance-windows', {
        data: { title, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(), targets: [{ kind: 'service', id: svc.id }] },
      }),
    );
    try {
      // a window within one day names the day once: "18 Nov 2026, 10:00–11:00"
      await page.goto('/maintenance');
      await expect(page.getByRole('row').filter({ hasText: title })).toContainText(/\d{4}, \d{2}:00\s?–\s?\d{2}:00/);
      await page.goto(`/maintenance?open=${w.id}`);
      const detail = page.getByRole('dialog', { name: title });
      await expect(detail.getByRole('link', { name: 'Add to calendar (.ics)' })).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Cancel maintenance' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Plan maintenance' })).toHaveCount(0);
      await detail.getByRole('button', { name: 'Close' }).click();
      await page.goto(`/services/${svc.id}/maintenance`);
      await expect(page.getByTestId('maintenance-panel')).toContainText(`Next: ${title}`);
    } finally {
      await api.post(`/api/maintenance-windows/${w.id}/cancel`, { data: {} });
    }
  });
});
