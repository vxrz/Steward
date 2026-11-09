import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, startRunApi, uniq, waitForRun } from './support/helpers';

/**
 * Collapsible content (0.12, docs/reviews/UX-REVIEW.md "v0.12.0: collapsible content"): sections are headings with a toggle button
 * (aria-expanded, aria-controls), count and status in the header, the choice remembered per user where it recurs,
 * Expand all / Collapse all on long pages, opened by a link (#id), by an error and for printing; long lists show
 * their first entries and "Show all N". On a desktop and on a phone, with axe in both colour schemes.
 */

test.use({ storageState: authFile('admin') });

/** An application with 12 external links and two documents that link to it (backlinks). */
async function applicationWithLinks(api: APIRequestContext) {
  const app = await json<{ id: string; name: string }>(await api.post('/api/applications', { data: { name: uniq('E2E fold app'), owners: [] } }));
  for (let i = 1; i <= 12; i++) {
    const res = await api.post(`/api/applications/${app.id}/links`, {
      data: { url: `https://wiki.example.com/fold/${i}`, label: `Fold page ${String(i).padStart(2, '0')}`, note: '', linkType: null },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  const records: string[] = [];
  for (const title of [uniq('E2E fold note A'), uniq('E2E fold note B')]) {
    const rec = await json<{ id: string }>(
      await api.post('/api/records', { data: { type: 'DOC', title, links: [{ kind: 'application', id: app.id, note: '' }] } }),
    );
    records.push(rec.id);
  }
  return { app, records };
}

const toggle = (page: Page, id: string) => page.getByTestId(`${id}-toggle`);
const toggles = (page: Page) => page.getByRole('main').locator('.sm-section-toggle[aria-expanded]');

/** Buttons of at least 24 × 24 px (WCAG 2.2, 2.5.8), as accessibility.spec.ts checks them. */
async function expectTargetSize(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withRules(['target-size']).analyze();
  const bad = result.violations.flatMap((v) => v.nodes.filter((n) => /^<button/.test(n.html)).map((n) => n.target.join(' ')));
  expect(bad, `small buttons on ${name}`).toEqual([]);
}

async function expectAllOpen(list: Locator, open: boolean) {
  const n = await list.count();
  expect(n).toBeGreaterThan(4);
  for (let i = 0; i < n; i++) await expect(list.nth(i)).toHaveAttribute('aria-expanded', String(open));
}

test.describe('desktop', () => {
  test('application page: headings that fold, remembered per user, Expand all / Collapse all, #hash and print', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const { app, records } = await applicationWithLinks(api);
    try {
      await page.goto(`/applications/${app.id}`);
      await settle(page);

      // real headings with a button: an empty section is folded, its count in the header; one with entries is open
      const integrations = page.getByTestId('application-integrations');
      await expect(page.getByRole('heading', { level: 2, name: /^Integrations/ })).toBeVisible();
      const intToggle = toggle(page, 'application-integrations');
      await expect(intToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(intToggle).toHaveAttribute('aria-controls', 'integrations-body');
      await expect(intToggle).toContainText('0');
      await expect(integrations.getByText('No platform is mapped to this application.')).toBeHidden();
      // the action stays outside the toggle and usable while folded
      await expect(integrations.getByRole('button', { name: 'Map platform' })).toBeVisible();
      await expectAccessible(page, 'application page (light)');
      await expectTargetSize(page, 'application page');
      await page.emulateMedia({ colorScheme: 'dark' });
      await expectAccessible(page, 'application page (dark)');
      await page.emulateMedia({ colorScheme: 'light' });

      // links: the first 10, then Show all 12 / Show fewer
      const links = page.getByTestId('section-links');
      await expect(toggle(page, 'section-links')).toHaveAttribute('aria-expanded', 'true');
      await expect(links.getByTestId('external-links').getByRole('listitem')).toHaveCount(10);
      await links.getByTestId('show-all-links').click();
      await expect(links.getByTestId('external-links').getByRole('listitem')).toHaveCount(12);
      await expect(links.getByTestId('show-all-links')).toHaveText('Show fewer');
      await links.getByTestId('show-all-links').click();
      await expect(links.getByTestId('external-links').getByRole('listitem')).toHaveCount(10);

      // backlinks: a sub-section (h3) with its count, open with 10 or fewer; the choice is remembered on every page
      await expect(page.getByRole('heading', { level: 3, name: /^Linked from/ })).toBeVisible();
      const back = toggle(page, 'section-backlinks');
      await expect(back).toHaveAttribute('aria-expanded', 'true');
      await expect(back).toContainText('2');
      await back.click();
      await expect(back).toHaveAttribute('aria-expanded', 'false');

      // a section opened by the user stays open on the next visit (per user, for every application page)
      await intToggle.click();
      await expect(intToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(integrations.getByText('No platform is mapped to this application.')).toBeVisible();
      await page.reload();
      await settle(page);
      await expect(toggle(page, 'application-integrations')).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle(page, 'section-backlinks')).toHaveAttribute('aria-expanded', 'false');

      // keyboard: Enter and Space fold and unfold
      await toggle(page, 'application-integrations').focus();
      await page.keyboard.press('Enter');
      await expect(toggle(page, 'application-integrations')).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Space');
      await expect(toggle(page, 'application-integrations')).toHaveAttribute('aria-expanded', 'true');

      // Expand all / Collapse all change the view, not the remembered choices
      await page.getByTestId('sections-collapse-all').click();
      await expectAllOpen(toggles(page), false);
      await page.getByTestId('sections-expand-all').click();
      await expectAllOpen(toggles(page), true);
      await page.getByTestId('sections-collapse-all').click();
      await page.reload();
      await settle(page);
      await expect(toggle(page, 'application-integrations')).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle(page, 'section-links')).toHaveAttribute('aria-expanded', 'true');

      // printing opens everything and lists every link
      await page.getByTestId('sections-collapse-all').click();
      await expectAllOpen(toggles(page), false);
      await page.emulateMedia({ media: 'print' });
      await expectAllOpen(toggles(page), true);
      await expect(links.getByTestId('external-links').getByRole('listitem')).toHaveCount(12);
      await page.emulateMedia({ media: 'screen' });
      await expectAllOpen(toggles(page), false);

      // a link to #<section> opens it, also against the remembered choice
      await page.goto(`/applications/${app.id}#application-documents`);
      await settle(page);
      await expect(toggle(page, 'application-documents')).toHaveAttribute('aria-expanded', 'true');
      await page.goto(`/applications/${app.id}#backlinks`);
      await settle(page);
      await expect(toggle(page, 'section-backlinks')).toHaveAttribute('aria-expanded', 'true');
    } finally {
      for (const id of records) await api.delete(`/api/records/${id}`);
      await api.delete(`/api/applications/${app.id}`);
    }
  });

  test('process editor: errors that block saving open the problem list', async ({ page }) => {
    await page.goto(`/processes/${PROCESS.healthCheck}`);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    // a check without its condition: an error that blocks saving
    await page.getByRole('button', { name: 'Check / assertion' }).click();
    await page.locator('.react-flow__node').filter({ hasText: 'check1' }).last().click();
    await page.getByRole('textbox', { name: /^Passes when/ }).fill('');
    const list = page.getByTestId('process-issues-list');
    const head = page.getByTestId('process-issues-toggle');
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(head).toHaveAttribute('aria-controls', 'process-issues-list');
    await expect(page.getByTestId('process-issues-badges')).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toContainText('check1');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(list.getByText(/check1/).first()).toBeHidden();
    await page.getByRole('button', { name: 'Undo' }).click();
  });

  test('run page: failed steps start open, every step opens with the keyboard, #step-<id> opens one', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const name = uniq('E2E fold run');
    const proc = await json<{ id: string }>(
      await api.post('/api/processes', {
        data: {
          definition: {
            name,
            nodes: [
              { id: 'start', type: 'start', x: 0, y: 0 },
              { id: 'note', type: 'log', x: 0, y: 0, name: 'Say hello', message: 'hello' },
              { id: 'c', type: 'check', x: 0, y: 0, name: 'Endpoints healthy', condition: 'false', severity: 'error', message: 'Endpoint down' },
            ],
            wires: [
              { from: 'start', port: 'out', to: 'note' },
              { from: 'note', port: 'out', to: 'c' },
            ],
          },
        },
      }),
    );
    try {
      const runId = await startRunApi(api, proc.id, { bindings: {} });
      const run = await waitForRun(api, runId, ['succeeded', 'failed']);
      await page.goto(`/runs/${runId}`);
      await settle(page);
      const rows = page.getByTestId('run-step');
      const failed = rows.filter({ hasText: 'Endpoints healthy' });
      const passed = rows.filter({ hasText: 'Say hello' });
      await expect(failed.getByTestId('run-step-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(passed.getByTestId('run-step-toggle')).toHaveAttribute('aria-expanded', 'false');
      // a button: Enter and Space open and close it
      await passed.getByTestId('run-step-toggle').focus();
      await page.keyboard.press('Enter');
      await expect(passed.getByTestId('run-step-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(passed).toContainText('started');
      await page.keyboard.press('Space');
      await expect(passed.getByTestId('run-step-toggle')).toHaveAttribute('aria-expanded', 'false');
      await expectAccessible(page, 'run page with open steps');

      const step = (run.steps as { id: string; stepId: string }[]).find((s) => s.stepId === 'note')!;
      await page.goto(`/runs/${runId}#step-${step.id}`);
      await settle(page);
      await expect(page.getByTestId('run-step').filter({ hasText: 'Say hello' }).getByTestId('run-step-toggle')).toHaveAttribute('aria-expanded', 'true');
    } finally {
      await api.delete(`/api/processes/${proc.id}`);
    }
  });

  test('device profile: interfaces fold with protocol and counts; #iface-<id> opens one', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const res = await api.put('/api/settings/plant', { data: { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} } });
    expect(res.ok(), await res.text()).toBe(true);
    const profile = await json<{ interfaces: { id: string }[] }>(await api.get('/api/plant/profiles/example-meters-pm200'));
    await page.goto('/plant/profiles/example-meters-pm200');
    await settle(page);
    const iface = page.getByTestId('interface-modbus-tcp');
    const head = iface.getByTestId('interface-modbus-tcp-toggle');
    await expect(iface.getByRole('heading', { level: 3 })).toBeVisible();
    // open while the profile has at most three interfaces
    await expect(head).toHaveAttribute('aria-expanded', String(profile.interfaces.length <= 3));
    await expect(iface.getByTestId('interface-counts')).toContainText(/\d+ data points?/);
    if (profile.interfaces.length <= 3) await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(iface.getByTestId('data-point-table').first()).toBeHidden();
    // protocol and counts stay in the folded header
    await expect(iface).toContainText('Modbus/TCP');
    await expectAccessible(page, 'device profile with a folded interface');
    await page.goto('/plant/profiles/example-meters-pm200#iface-modbus-tcp');
    await settle(page);
    await expect(page.getByTestId('interface-modbus-tcp-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  test('audit log: every entry opens with the keyboard, several at a time', async ({ page }) => {
    await page.goto('/audit');
    await settle(page);
    const first = page.getByTestId('audit-row-toggle').nth(0);
    const second = page.getByTestId('audit-row-toggle').nth(1);
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(first).toHaveAccessibleName(/^Details of entry \d+$/);
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await second.focus();
    await page.keyboard.press('Space');
    await expect(second).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('audit-row-details')).toHaveCount(2);
    await expect(page.getByTestId('audit-row-details').first()).toContainText('hash');
    await expectAccessible(page, 'audit log with open entries');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('audit-row-details')).toHaveCount(1);
  });
});

test.describe('phone @mobile', () => {
  test('application page: secondary lists start folded with their counts', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const { app, records } = await applicationWithLinks(api);
    try {
      await page.goto(`/applications/${app.id}`);
      await settle(page);
      // links and backlinks are there, but folded on a phone; the count says how many
      const links = toggle(page, 'section-links');
      await expect(links).toHaveAttribute('aria-expanded', 'false');
      await expect(links).toContainText('12');
      await links.tap();
      await expect(links).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('external-links').getByRole('listitem')).toHaveCount(10);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expectAccessible(page, `application page on a phone (${scheme})`);
      }
      await expectTargetSize(page, 'application page on a phone');
    } finally {
      for (const id of records) await api.delete(`/api/records/${id}`);
      await api.delete(`/api/applications/${app.id}`);
    }
  });

  test('settings: the areas fold behind "Area: <current>"', async ({ page }) => {
    await page.goto('/settings/general');
    await settle(page);
    const areas = page.getByTestId('settings-area-toggle');
    await expect(areas).toHaveText('Area: General');
    await expect(areas).toHaveAttribute('aria-expanded', 'false');
    const nav = page.getByRole('navigation', { name: 'Settings areas' });
    await expect(nav).toBeHidden();
    await areas.tap();
    await expect(areas).toHaveAttribute('aria-expanded', 'true');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectAccessible(page, `settings areas on a phone (${scheme})`);
    }
    await nav.getByRole('link', { name: 'Security & sign-in' }).tap();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(areas).toHaveText('Area: Security & sign-in');
    await expect(areas).toHaveAttribute('aria-expanded', 'false');
  });
});
