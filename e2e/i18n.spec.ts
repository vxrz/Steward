import { request as pwRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { baseURL, origin } from './support/env';
import { json, uniq } from './support/helpers';

/**
 * The German UI shows no English: every main page is visited in German and its visible texts (buttons,
 * labels, headings, messages, aria-labels, titles, placeholders) are checked against words and phrases
 * that only the English UI uses. User data (table rows, record text, code) is left out, because other
 * tests create English names in parallel.
 */

/** English UI words that do not occur in the German UI (whole words, case-sensitive). */
const ENGLISH = [
  'Save',
  'Cancel',
  'Delete',
  'Close',
  'Search',
  'Settings',
  'Records',
  'Record types',
  'New record',
  'Change request',
  'Decision record',
  'Credentials',
  'Reports',
  'Monitors',
  'Owner',
  'Created',
  'Description',
  'Approve',
  'Submit',
  'Reject',
  'Reason',
  'Risk',
  'Rollback plan',
  'Planned start',
  'Implementation plan',
  'Context and problem statement',
  'Four-eyes',
  'Loading',
  'not found',
  'You are not allowed',
  'Something went wrong',
  'Edit',
  'Remove',
  'Required',
  'Choose',
  'Select',
  'Please',
];
const ENGLISH_RE = new RegExp(`(?<![\\w-])(${ENGLISH.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);

/** Visible UI texts of the page (or of one part of it): text nodes and the text attributes, without user data. */
async function uiTexts(page: Page, root = 'body'): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const skip = 'tbody, code, pre, .mono, [data-i18n-skip], .md-view, script, style, svg title';
    const base = document.querySelector(sel);
    if (!base) return out;
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element);
      if (!el || el.closest(skip)) continue;
      if (n.nodeType === Node.TEXT_NODE) {
        const s = n.textContent?.trim();
        if (s) out.push(s);
      } else {
        for (const a of ['aria-label', 'title', 'placeholder', 'aria-description']) {
          const v = (n as Element).getAttribute(a)?.trim();
          if (v) out.push(v);
        }
      }
    }
    return out;
  }, root);
}

async function expectGerman(page: Page, where: string, root = 'body') {
  const texts = await uiTexts(page, root);
  expect(texts.length, `${where}: no texts found`).toBeGreaterThan(3);
  const english = texts.filter((s) => ENGLISH_RE.test(s));
  expect(english, `${where}: English texts in the German UI`).toEqual([]);
}

/** A fresh administrator whose profile language is German (other tests keep their own users in English). */
async function germanAdmin(browser: Browser, admin: APIRequestContext): Promise<{ page: Page; close: () => Promise<void>; headers: Record<string, string> }> {
  const username = uniq('i18n-de').replace(/\s/g, '').toLowerCase();
  await json(await admin.post('/api/users', { data: { username, displayName: 'Deutsche Administratorin', roles: ['admin'], password: 'Temp-password-1' } }));
  const api = await pwRequest.newContext({ baseURL: baseURL(), extraHTTPHeaders: { 'x-sm-client': '1' } });
  const login = await api.post('/api/auth/login', { data: { username, password: 'Temp-password-1' } });
  expect(login.status()).toBe(200);
  let sessionKey = login.headers()['x-sm-session-key']!;
  let linkKey = login.headers()['x-sm-link-key']!;
  const changed = await api.post('/api/auth/password', {
    data: { current: 'Temp-password-1', next: 'Own-password-2' },
    headers: { 'x-sm-session': sessionKey },
  });
  expect(changed.status()).toBe(200);
  sessionKey = changed.headers()['x-sm-session-key'] ?? sessionKey;
  linkKey = changed.headers()['x-sm-link-key'] ?? linkKey;
  expect((await api.patch('/api/me', { data: { locale: 'de' }, headers: { 'x-sm-session': sessionKey } })).status()).toBe(200);
  const { cookies } = await api.storageState();
  await api.dispose();
  const ctx = await browser.newContext({
    baseURL: baseURL(),
    serviceWorkers: 'block',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies,
      origins: [
        {
          origin: origin(),
          localStorage: [
            { name: 'sm.sessionKey', value: sessionKey },
            { name: 'sm.linkKey', value: linkKey },
            { name: 'steward.language', value: 'de' },
          ],
        },
      ],
    },
  });
  const page = await ctx.newPage();
  return { page, close: () => ctx.close(), headers: { 'x-sm-client': '1', 'x-sm-session': sessionKey } };
}
test('the German UI shows no English texts on the main pages', async ({ browser, apiAs }) => {
  test.setTimeout(180_000);
  const admin = await apiAs('admin');
  const { page, headers, close } = await germanAdmin(browser, admin);
  try {
    await checkPages(page, headers);
  } finally {
    await close();
  }
});

async function checkPages(page: Page, headers: Record<string, string>) {
  const api = page.request;

  // a draft without the required rollback plan, and a submitted one the author may not approve (four-eyes)
  const draft = await json(
    await api.post('/api/records', { headers, data: { type: 'CR', title: uniq('Zertifikat erneuern'), fields: { reason: 'Läuft ab', risk: 'low' } } }),
  );
  const submitted = await json(
    await api.post('/api/records', {
      headers,
      data: { type: 'CR', title: uniq('Firewall-Regel'), fields: { reason: 'Neuer Partner', risk: 'medium', rollbackPlan: 'Regel entfernen' } },
    }),
  );
  expect((await api.post(`/api/records/${submitted.id}/transition`, { headers, data: { action: 'submit' } })).status()).toBe(200);
  const service = await json(await api.post('/api/services', { headers, data: { name: uniq('Kundenportal'), description: 'Portal für Kunden.' } }));

  // Records: list, import dialog, types and the type editor
  await page.goto('/records');
  await expect(page.getByRole('heading', { name: 'Dokumente', level: 2 })).toBeVisible();
  await expectGerman(page, 'records list');
  await page.getByRole('button', { name: 'Markdown importieren' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectGerman(page, 'records import', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Neues Dokument' }).click();
  const create = page.getByRole('dialog');
  await create.getByRole('textbox', { name: 'Art' }).click();
  await page.getByRole('option', { name: /^CR – Änderungsantrag/ }).click();
  // the description of the built-in type in German
  await expect(create.getByText(/Eine geplante Änderung an einem Service/)).toBeVisible();
  await expectGerman(page, 'new record dialog', '[role="dialog"]');
  await page.keyboard.press('Escape');

  await page.goto('/records/types');
  await expect(page.getByRole('heading', { name: 'Dokumentarten', level: 2 })).toBeVisible();
  await expectGerman(page, 'record types');

  // Record detail: built-in field labels and values, the four-eyes reason and a translated server error
  await page.goto(`/records/${submitted.id}`);
  await expect(page.getByText('Rückfallplan', { exact: true })).toBeVisible();
  await expect(page.getByText('mittel', { exact: true })).toBeVisible();
  await expectGerman(page, 'record detail');
  await page.getByRole('button', { name: 'Freigeben', exact: true }).hover({ force: true });
  await expect(page.getByRole('tooltip')).toContainText('Vier-Augen-Prinzip');

  await page.goto(`/records/${draft.id}`);
  await page.getByRole('button', { name: 'Einreichen', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Einreichen', exact: true }).click();
  await expect(page.getByText('Füllen Sie zuerst die Pflichtfelder aus: Rückfallplan.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Record editor
  await page.goto(`/records/${draft.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Begründung' })).toBeVisible();
  await expectGerman(page, 'record editor');

  // Services
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Services', level: 2 })).toBeVisible();
  await expectGerman(page, 'services');
  await page.goto(`/services/${service.id}`);
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Kundenportal');
  await expectGerman(page, 'service detail');

  // Credentials, reports, monitors, settings (incl. MCP), profile
  for (const path of ['/credentials', '/reports', '/monitors', '/monitors/new', '/settings', '/profile']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectGerman(page, path);
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
}
