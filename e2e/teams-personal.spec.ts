import type { Browser, BrowserContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { expectAccessible, settle } from './support/axe';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Personal Teams notifications (0.15.0, ADR 0025): with the Teams bot on, a person chooses in the profile which messages
 * come to their chat with the bot instead of by e-mail; the demo's mock Bot Connector (server/src/mock/demoTeamsBot.ts)
 * receives the message. On a server of its own: the bot is switched on for the whole instance.
 */

const OID = '0a1f3000-0000-4000-8000-0000000000e2';
const PROCESS = 'E2E disk check';

test.describe('personal Teams notifications (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  let processId = '';
  const contexts: BrowserContext[] = [];

  const mock = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${srv.baseURL}/mock/teams-bot/${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → HTTP ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };

  /** A session of its own (cookie and key) through the API. */
  async function signIn(username: string, password: string) {
    const r = await fetch(`${srv.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(r.ok).toBeTruthy();
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const key = r.headers.get('x-sm-session-key')!;
    return async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${srv.baseURL}/api${url}`, {
        method,
        headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    };
  }

  test.beforeAll(async () => {
    srv = await startIsolatedServer({ demo: true });
    // the demo's mock Bot Framework, an Entra provider by tid + oid, and the administrator linked to an object id
    const bot = await mock('POST', '_setup', { username: 'admin', oid: OID });
    const settings = await srv.api('GET', '/settings');
    await srv.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [...(settings.outboundAllowList ?? []), bot.connectorUrl] });
    await srv.api('PUT', '/settings/teams-bot', {
      enabled: true,
      appId: bot.appId,
      tenantIds: [bot.tenantId],
      providerId: bot.providerId,
      credential: 'secret',
      clientSecret: 'demo-bot-secret',
    });
    // switching the bot on waits for a second administrator
    const { temporaryPassword } = await srv.api('POST', '/users', { username: 'abel', roles: ['admin'] });
    await (
      await signIn('abel', temporaryPassword)
    )('POST', '/auth/password', { current: temporaryPassword, next: 'Abel-password-12' });
    const abel = await signIn('abel', 'Abel-password-12');
    const pending = (await abel('GET', '/assurance/policy')).pending;
    await abel('POST', `/assurance/policy/changes/${pending.id}/approve`, {});
    // the administrator adds the Steward app for themselves in Teams: Microsoft tells the bot
    await mock('POST', '_activity', {
      type: 'installationUpdate',
      action: 'add',
      id: 'e2e-install-1',
      locale: 'en-GB',
      from: { id: '29:admin', aadObjectId: OID },
      conversation: { id: 'a:personal-e2e-admin', tenantId: bot.tenantId, conversationType: 'personal' },
      channelData: { tenant: { id: bot.tenantId } },
    });
    processId = (await srv.api('POST', '/processes', { text: `name: ${PROCESS}\nsteps:\n  - { id: stop, type: fail, message: Disk almost full }\n` })).id;
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  async function open(browser: Browser, mobile = false) {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      storageState: sessionState(srv.baseURL, srv.adminCookie, { sessionKey: srv.sessionKey, linkKey: srv.linkKey }),
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  test('a person turns on "Run failed" in Teams (personal) and the bot posts the message to their chat', async ({ browser }) => {
    const page = await open(browser);
    await page.goto('/profile');
    await settle(page);
    const card = page.getByTestId('teams-personal-card');
    await expect(card.getByRole('heading', { name: 'Teams (personal)' })).toBeVisible();
    await expect(card.getByTestId('teams-personal-connected')).toContainText('Your chat with the Steward app is connected');
    // nothing is chosen by default; decisions are not offered (they come as cards anyway)
    const runFailed = card.getByRole('checkbox', { name: 'Run failed' });
    await expect(runFailed).not.toBeChecked();
    await expect(card.getByRole('checkbox', { name: 'Decision' })).toHaveCount(0);
    await expectAccessible(page, 'profile: Teams (personal)');
    await runFailed.check();
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Your messages in Teams saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('teams-personal-card').getByRole('checkbox', { name: 'Run failed' })).toBeChecked();

    // a run the administrator starts fails: the message goes to the chat with the bot
    await srv.api('POST', '/runs', { processId });
    await expect
      .poll(
        async () =>
          ((await mock('GET', '_sent')) as { method: string; path: string; body: unknown }[])
            .filter((x) => x.method === 'POST' && x.path.includes(encodeURIComponent('a:personal-e2e-admin')))
            .map((x) => JSON.stringify(x.body))
            .join('\n'),
        { timeout: 30_000 },
      )
      .toContain(PROCESS);
    const audit = await srv.api('GET', '/audit?action=notification.personal_channel_changed&limit=1');
    expect(audit[0].details).toMatchObject({ channel: 'teamsPersonal', to: ['run.failed'] });
  });

  test('Teams (personal) on a phone @mobile', async ({ browser }) => {
    const page = await open(browser, true);
    await page.goto('/profile');
    await settle(page);
    await expect(page.getByTestId('teams-personal-card')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, 'profile: Teams (personal) (phone)');
  });
});
