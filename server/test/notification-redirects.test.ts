import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Notification webhooks and Teams channels that administrators set up (0.9.0, #243): their URL is not checked against
 * the outbound policy (as documented), but address safety applies to it and to every redirect – no cloud-metadata or
 * link-local address, not Steward's own API –, at most 5 redirects are followed and each target follows the redirect
 * rule of every other request: the same origin passes, another host must be allowed by the outbound policy.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const servers: http.Server[] = [];
let receiver = '';
let allowed = '';
let outside = '';
const got: { server: string; method: string; path: string; body: string }[] = [];
const redirects = new Map<string, [number, string]>();

function serve(name: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!;
      const r = redirects.get(`${name} ${path}`);
      if (r) {
        res.writeHead(r[0], { location: r[1] });
        return res.end();
      }
      got.push({ server: name, method: req.method ?? '', path, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  };
}

async function listen(name: string): Promise<string> {
  const srv = http.createServer(serve(name));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

/** Stores the channel URL and sends the test message on it. */
async function sendTo(channel: 'webhook' | 'teams', url: string): Promise<{ ok: boolean; error?: string }> {
  await s.api('PUT', '/settings/notifications', {
    email: { enabled: false, host: '', port: 587, secure: false, from: '' },
    teams: { enabled: channel === 'teams', webhookUrl: channel === 'teams' ? url : '' },
    webhook: { enabled: channel === 'webhook', url: channel === 'webhook' ? url : '' },
    routes: {},
  });
  return s.api('POST', '/settings/notifications/test', { channel });
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  receiver = await listen('receiver');
  allowed = await listen('allowed');
  outside = await listen('outside');
  await s.api('PUT', '/settings', { outboundAllowList: [allowed] });
  redirects.set('receiver /to-metadata', [307, 'http://169.254.169.254/latest/meta-data/']);
  redirects.set('receiver /to-outside', [307, `${outside}/hook`]);
  redirects.set('receiver /to-allowed', [308, `${allowed}/hook`]);
  redirects.set('receiver /same', [308, '/final']);
  redirects.set('receiver /upgrade-loop', [302, '/upgrade-loop']);
});
afterAll(async () => {
  for (const x of servers) x.close();
  await s?.app.close();
});
beforeEach(() => {
  got.length = 0;
});

describe.each(['webhook', 'teams'] as const)('a %s notification channel and redirects', (channel) => {
  it('a same-host redirect passes and keeps the message', async () => {
    expect(await sendTo(channel, `${receiver}/same?sig=channel-signature-123`)).toEqual({ ok: true });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ server: 'receiver', method: 'POST', path: '/final' });
    expect(got[0]!.body).toContain(channel === 'teams' ? 'AdaptiveCard' : '"event":"test"');
  });

  it('a redirect to a cloud-metadata address is refused', async () => {
    const r = await sendTo(channel, `${receiver}/to-metadata`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Blocked: request to a link-local \/ cloud metadata address/);
  });

  it('a redirect to another host follows the outbound policy', async () => {
    const r = await sendTo(channel, `${receiver}/to-outside`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(
      /Blocked by the outbound policy: http:\/\/127\.0\.0\.1:\d+ redirected to http:\/\/127\.0\.0\.1:\d+, which is not a configured platform/,
    );
    expect(got.filter((g) => g.server === 'outside')).toEqual([]);
    expect(await sendTo(channel, `${receiver}/to-allowed`)).toEqual({ ok: true });
    expect(got).toMatchObject([{ server: 'allowed', method: 'POST', path: '/hook' }]);
  });

  it('the URL itself is not checked by the policy (as before), but address safety is', async () => {
    // the receiver is no platform and not on the allow-list: an administrator set it up
    expect(await sendTo(channel, `${receiver}/direct`)).toEqual({ ok: true });
    expect((await sendTo(channel, 'http://169.254.169.254/hook')).error).toMatch(/link-local \/ cloud metadata address/);
    expect((await sendTo(channel, `${s.base}/api/settings`)).error).toMatch(/may not call the Steward server/);
  });

  it('follows at most 5 redirects', async () => {
    const r = await sendTo(channel, `${receiver}/upgrade-loop`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Too many redirects \(more than 5\)/);
  });
});
