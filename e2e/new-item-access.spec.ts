import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { USERS } from './support/env';
import { chooseOption, settingsSave, uniq } from './support/helpers';
import { ISOLATED_SETUP_MS, sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Uniform access at creation (0.31.0, ADR 0042): the create dialog of every kind with access control has the folded
 * Access section, with the owning team required and Restricted preselected while the instance setting "Who sees new
 * items" is "Owning teams only"; a restricted new item is invisible – answered like an unknown id – to a person outside
 * its team. Changing the setting to "everyone" asks for the step-up. It runs on a server of its own (the setting is
 * instance-wide), serially.
 */
test.describe.configure({ mode: 'serial' });

let srv: IsolatedServer;
let ctx: BrowserContext;
let page: Page;
let team = { id: '', name: '' };
let dana: IsolatedServer['api'];

async function signIn(browser: Browser, base: string, cookie: string, keys: { sessionKey: string; linkKey: string }) {
  return browser.newContext({ baseURL: base, serviceWorkers: 'block', storageState: sessionState(base, cookie, keys), locale: 'en-GB' });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ISOLATED_SETUP_MS);
  srv = await startIsolatedServer({ newItemVisibility: 'owningTeams' });
  for (const m of ['plant', 'dataProducts', 'costs', 'dataContracts']) await srv.api('PUT', `/settings/modules/${m}`, { enabled: true });
  await srv.api('POST', '/users', { username: 'dana', roles: ['designer'], password: 'Temp-password-123' });
  team = { id: '', name: uniq('Invented creators') };
  team.id = (await srv.api('POST', '/teams', { name: team.name, members: ['admin'] })).id;
  ctx = await signIn(browser, srv.baseURL, srv.adminCookie, srv);
  page = await ctx.newPage();
  // a second person, outside the team, for the 404 checks
  const signInDana = (password: string) =>
    fetch(`${srv.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dana', password }),
    });
  // a new account must choose its own password first
  const first = await signInDana('Temp-password-123');
  const changed = await fetch(`${srv.baseURL}/api/auth/password`, {
    method: 'POST',
    headers: {
      'x-sm-client': '1',
      'content-type': 'application/json',
      cookie: first.headers.get('set-cookie')!.split(';')[0]!,
      'x-sm-session': first.headers.get('x-sm-session-key') ?? '',
    },
    body: JSON.stringify({ current: 'Temp-password-123', next: 'Dana-password-123' }),
  });
  expect(changed.ok).toBeTruthy();
  const login = await signInDana('Dana-password-123');
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const key = login.headers.get('x-sm-session-key') ?? '';
  dana = async (method, url) => {
    const r = await fetch(`${srv.baseURL}/api${url}`, { method, headers: { 'x-sm-client': '1', cookie, ...(key ? { 'x-sm-session': key } : {}) } });
    return { status: r.status, text: await r.text() } as any;
  };
});
test.afterAll(async () => {
  await ctx?.close();
  await srv?.stop();
});

interface Case {
  /** the kind of the owning-teams route */
  kind: string;
  /** the id in the response of the create request */
  idOf: (body: any) => string;
  /** the request that creates it */
  post: RegExp;
  /** opens the dialog (or page), fills the required fields, and returns the scope that holds the Access section */
  fill: (page: Page, name: string) => Promise<Locator>;
  /** sends the form */
  submit: (scope: Locator) => Promise<void>;
  /** the kind has no create dialog of its own: it is a whole page */
  restrictable?: boolean;
  /** a catalogue kind: the team is optional, so the section stays folded */
  catalogue?: boolean;
}

const dialog = (page: Page) => page.getByRole('dialog').last();
const saveButton = (scope: Locator) => scope.getByRole('button', { name: /^(Save|Create|Create draft)$/ });

const CASES: Record<string, Case> = {
  service: {
    kind: 'service',
    idOf: (b) => b.id,
    post: /\/api\/services$/,
    fill: async (page, name) => {
      await page.goto('/services');
      await page.getByRole('main').getByRole('button', { name: 'New service' }).click();
      const d = dialog(page);
      await d.getByRole('textbox', { name: 'Name' }).fill(name);
      return d;
    },
    submit: (d) => saveButton(d).click(),
  },
  record: {
    kind: 'record',
    idOf: (b) => b.id,
    post: /\/api\/records$/,
    fill: async (page, name) => {
      await page.goto('/records?new=1');
      const d = dialog(page);
      await d.getByRole('combobox', { name: 'Type' }).click();
      await page.getByRole('option').first().click();
      await d.getByRole('textbox', { name: 'Title' }).fill(name);
      return d;
    },
    submit: (d) => saveButton(d).click(),
  },
  site: {
    kind: 'site',
    idOf: (b) => b.id,
    post: /\/api\/plant\/sites$/,
    fill: async (page, name) => {
      await page.goto('/plant/sites?new=1');
      const d = dialog(page);
      await d.getByRole('textbox', { name: 'Name' }).first().fill(name);
      return d;
    },
    submit: (d) => saveButton(d).click(),
  },
  credential: {
    kind: 'credential',
    idOf: (b) => b.id,
    post: /\/api\/credentials$/,
    fill: async (page, name) => {
      await page.goto('/credentials?new=1');
      const d = dialog(page);
      await d.getByRole('textbox', { name: 'Name' }).first().fill(name);
      return d;
    },
    submit: (d) => saveButton(d).click(),
  },
  'data contract': {
    kind: 'contract',
    idOf: (b) => b.id,
    post: /\/api\/data-contracts$/,
    fill: async (page) => {
      await page.goto('/data-contracts/new');
      await expect(page.getByTestId('contract-lint-ok')).toBeVisible();
      return page.getByRole('main');
    },
    submit: (main) => main.getByTestId('contract-create').click(),
  },
  'price book': {
    kind: 'cost_price_book',
    idOf: (b) => b.id,
    post: /\/api\/costs\/price-books$/,
    fill: async (page, name) => {
      await page.goto('/costs/price-books');
      await page.getByTestId('price-book-add').click();
      const d = dialog(page);
      await d.getByTestId('book-name').fill(name);
      await d.getByTestId('book-provider').fill('Invented Cloud AG');
      return d;
    },
    submit: (d) => d.getByTestId('book-save').click(),
  },
  blueprint: {
    kind: 'blueprint',
    catalogue: true,
    idOf: (b) => b.id,
    post: /\/api\/plant\/blueprints$/,
    fill: async (page, name) => {
      await page.goto('/plant/blueprints?new=1');
      const d = dialog(page);
      await d.getByTestId('blueprint-name').fill(name);
      return d;
    },
    submit: (d) => saveButton(d).click(),
  },
};

/** Opens the folded section, picks the team and returns the Restricted switch. */
async function pickTeam(page: Page, scope: Locator, team: string): Promise<Locator> {
  // the section is open already while the required team is missing; otherwise it is folded
  const box = scope.getByRole('combobox', { name: /Owning teams/ });
  if (!(await box.isVisible())) await scope.getByTestId('creation-access-toggle').click();
  await box.fill(team, { force: true });
  await page.getByRole('option', { name: team }).click();
  await scope.getByText(/^Owning teams: /).click(); // the summary: closes the dropdown
  return scope.getByRole('switch', { name: /^Restricted/ });
}

test.describe('create dialogs', () => {
  for (const [label, c] of Object.entries(CASES)) {
    test(`${label}: the access fields are there, the team is required and a restricted new item is invisible outside the team`, async () => {
      test.slow();
      const name = uniq(`Invented ${label}`);
      const scope = await c.fill(page, name);
      // the section opens by itself while the required team is missing
      await expect(scope.getByTestId('creation-access-toggle')).toBeVisible();
      if (!c.catalogue) await expect(scope.getByRole('combobox', { name: /Owning teams/ })).toBeVisible();
      const restricted = await pickTeam(page, scope, team.name);
      // "owning teams only": naming a team starts it Restricted
      await expect(restricted).toBeChecked();
      const made = page.waitForResponse((r) => r.request().method() === 'POST' && c.post.test(new URL(r.url()).pathname) && r.ok());
      await c.submit(scope);
      const id = c.idOf(await (await made).json());
      // the team and an administrator see it; a designer outside the team is answered as for an unknown id
      const mine = await srv.api('GET', `/owning-teams/${c.kind}/${id}`);
      expect(mine.teams.map((t: { id: string }) => t.id)).toEqual([team.id]);
      const seen = await dana('GET', `/owning-teams/${c.kind}/${id}`);
      expect(seen.status, seen.text).toBe(404);
    });
  }

  test('without a team the dialog says it is required and the server refuses', async () => {
    const scope = await CASES.service!.fill(page, uniq('Invented service'));
    await expect(scope.getByTestId('creation-access-teams')).toBeVisible();
    await expect(scope.getByText(/New items belong to a team/)).toBeVisible();
    const refused = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/services$/.test(new URL(r.url()).pathname));
    await CASES.service!.submit(scope);
    expect((await refused).status()).toBe(400);
    await page.keyboard.press('Escape');
  });

  test('a catalogue kind needs no team', async () => {
    const scope = await CASES.blueprint!.fill(page, uniq('Invented blueprint'));
    await scope.getByTestId('creation-access-toggle').click();
    await expect(scope.getByText(/New items belong to a team/)).toHaveCount(0);
    const made = page.waitForResponse((r) => r.request().method() === 'POST' && CASES.blueprint!.post.test(new URL(r.url()).pathname) && r.ok());
    await CASES.blueprint!.submit(scope);
    await made;
  });

  test('a kind without the Restricted scope shows the owning teams only', async () => {
    await page.goto('/data-elements?new=1');
    const d = dialog(page);
    await expect(d.getByRole('combobox', { name: /Owning teams/ })).toBeVisible();
    await expect(d.getByRole('switch', { name: /^Restricted/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});

test.describe('the setting', () => {
  test('"everyone" asks for the step-up and then starts new items open; "owning teams only" does not ask', async ({ browser }) => {
    test.slow();
    // a session of its own, not confirmed (a fresh sign-in counts as a confirmation)
    const login = await fetch(`${srv.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERS.admin.username, password: USERS.admin.password }),
    });
    expect(login.ok).toBeTruthy();
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const keys = { sessionKey: login.headers.get('x-sm-session-key')!, linkKey: login.headers.get('x-sm-link-key')! };
    const end = async () => {
      const r = await fetch(`${srv.baseURL}/api/auth/step-up`, { method: 'DELETE', headers: { 'x-sm-client': '1', cookie, 'x-sm-session': keys.sessionKey } });
      expect(r.ok).toBeTruthy();
    };
    await end();
    const own = await signIn(browser, srv.baseURL, cookie, keys);
    try {
      const p = await own.newPage();
      await p.goto('/settings/security');
      const card = p.getByTestId('new-item-visibility-card');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('new-item-visibility')).toHaveValue('Owning teams only');

      // widening: it asks, and goes on by itself once confirmed
      await chooseOption(p, 'Who sees new items', 'Everyone who may see the kind');
      await settingsSave(p).click();
      const confirm = p.getByRole('dialog', { name: 'Confirm it is you' });
      await expect(confirm).toBeVisible();
      await confirm.getByLabel('Your password').fill(USERS.admin.password);
      await confirm.getByRole('button', { name: 'Confirm' }).click();
      await expect(confirm).toBeHidden();
      await expect(p.getByText('Settings saved').first()).toBeVisible();
      expect((await srv.api('GET', '/settings/instance')).newItemVisibility).toBe('everyone');

      // with "everyone" the create dialog needs no team and does not preselect Restricted
      await page.goto('/services');
      await page.getByRole('main').getByRole('button', { name: 'New service' }).click();
      await dialog(page).getByTestId('creation-access-toggle').click();
      await expect(dialog(page).getByText(/New items belong to a team/)).toHaveCount(0);
      await page.keyboard.press('Escape');

      // narrowing: no confirmation, even though the last one has ended
      await end();
      await chooseOption(p, 'Who sees new items', 'Owning teams only');
      await settingsSave(p).click();
      await expect(p.getByText('Settings saved').first()).toBeVisible();
      await expect(confirm).toBeHidden();
      expect((await srv.api('GET', '/settings/instance')).newItemVisibility).toBe('owningTeams');

      // both changes are in the audit log's access family
      const audit = await srv.api('GET', '/audit?action=access.new_item_visibility_changed&limit=10');
      expect(audit.length).toBeGreaterThanOrEqual(2);
    } finally {
      await own.close();
    }
  });
});
