import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Team settings (#136): a team's own channel for messages about its resources. Without one the team uses the instance
 * channel; with "instead" the instance channel is left out for resources that belong only to such teams.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders
let dave: Client; // designer, not a member
let orders: string;
let failing: string;
let receiver: http.Server;
let receiverUrl = '';
const received: { path: string; body: any }[] = [];
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );

async function failRun(): Promise<string> {
  const { id } = await s.api('POST', '/runs', { processId: failing });
  await s.waitRun(id, ['failed']);
  await new Promise((r) => setTimeout(r, 300));
  await flush();
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'dave', roles: ['designer'], password: PW, mustChangePassword: false });
  [tara, dave] = await Promise.all(['tara', 'dave'].map((u) => s.as(u, PW)));
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara'] })).id;
  receiver = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data || 'null') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  await s.api('PUT', '/settings/notifications', {
    email: { enabled: false, host: '', port: 587, secure: false, from: '' },
    teams: { enabled: true, webhookUrl: `${receiverUrl}/instance` },
    webhook: { enabled: false },
    routes: { 'run.failed': ['inApp', 'teams'] },
    baseUrl: 'https://sm.example.com/',
  });
  failing = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Orders import',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'chk', type: 'check', name: 'Orders arrived', condition: 'false', message: 'No orders', failRun: true, x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'chk' }],
      },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});

describe('team settings', () => {
  it('start with the instance channel, readable by members and administrators', async () => {
    const mine = await tara('GET', `/teams/${orders}/settings`);
    expect(mine).toMatchObject({ teamName: 'Orders', channel: null, instance: { teamsEnabled: true }, canChange: false });
    expect(await status(dave('GET', `/teams/${orders}/settings`))).toBe(404);
    expect((await s.api('GET', `/teams/${orders}/settings`)).canChange).toBe(true);
  });

  it('are changed by administrators only, audited without the URL', async () => {
    const body = { channel: { enabled: true, format: 'json', mode: 'instead', url: `${receiverUrl}/orders?key=team-secret` } };
    expect(await status(tara('PUT', `/teams/${orders}/settings`, body))).toBe(403);
    await expect(s.api('PUT', `/teams/${orders}/settings`, { channel: { enabled: true, format: 'json', mode: 'also' } })).rejects.toThrow(/URL/);
    const saved = await s.api('PUT', `/teams/${orders}/settings`, body);
    expect(saved.channel).toEqual({ enabled: true, format: 'json', mode: 'instead', hasUrl: true });
    expect(JSON.stringify(saved)).not.toContain('team-secret');
    const audit = (await s.api('GET', '/audit?action=team.settings_changed&limit=1'))[0];
    expect(audit).toMatchObject({ entityType: 'team', entityId: orders, details: { scope: 'team:Orders' } });
    expect(JSON.stringify(audit)).not.toContain('team-secret');
    // the test message goes to the team's channel
    received.length = 0;
    expect(await s.api('POST', `/teams/${orders}/settings/test`)).toEqual({ ok: true });
    expect(received[0]).toMatchObject({ path: '/orders?key=team-secret', body: { event: 'test' } });
  });

  it('keep the channel URL readable after a rotation of the data key', async () => {
    const r = await s.api('POST', '/vault/passphrase', { current: 'correct horse battery', next: 'a new passphrase 2026', rotateDataKey: true });
    expect(r.rotated).toBe(true);
    received.length = 0;
    expect(await s.api('POST', `/teams/${orders}/settings/test`)).toEqual({ ok: true });
    expect(received[0]?.path).toBe('/orders?key=team-secret');
    await s.api('POST', '/vault/passphrase', { current: 'a new passphrase 2026', next: 'correct horse battery', rotateDataKey: false });
  });

  it('send messages about a team-owned resource to the team channel – instead of the instance channel when it says so', async () => {
    // not owned by the team yet: the instance channel, as before
    received.length = 0;
    await failRun();
    expect(received.map((r) => r.path)).toEqual(['/instance']);

    await s.api('PUT', `/owning-teams/process/${failing}`, { teamIds: [orders] });
    received.length = 0;
    const id = await failRun();
    expect(received.map((r) => r.path)).toEqual(['/orders?key=team-secret']);
    expect(received[0]!.body).toMatchObject({ event: 'run.failed', link: `https://sm.example.com/runs/${id}` });
  });

  it('post to both with "also", and fall back to the instance channel when reset', async () => {
    await s.api('PUT', `/teams/${orders}/settings`, { channel: { enabled: true, format: 'json', mode: 'also' } });
    received.length = 0;
    // a new process of the team (a run of the same process within the hour is not posted twice)
    const again = await s.api('POST', '/processes', { definition: (await s.api('GET', `/processes/${failing}`)).definition });
    await s.api('PUT', `/owning-teams/process/${again.id}`, { teamIds: [orders] });
    failing = again.id;
    await failRun();
    expect(received.map((r) => r.path).sort()).toEqual(['/instance', '/orders?key=team-secret']);

    const reset = await s.api('PUT', `/teams/${orders}/settings`, { channel: null });
    expect(reset.channel).toBeNull();
    expect((await s.api('GET', '/audit?action=team.settings_changed&limit=1'))[0].summary).toContain('uses the instance channel again');
  });

  it('are removed with their team', async () => {
    const t = (await s.api('POST', '/teams', { name: 'Short-lived', members: [] })).id;
    await s.api('PUT', `/teams/${t}/settings`, { channel: { enabled: false, format: 'teams', mode: 'also', url: `${receiverUrl}/x` } });
    await s.api('DELETE', `/teams/${t}`);
    const { db } = await import('../src/db.js');
    expect(db().get('SELECT 1 FROM team_settings WHERE team_id = ?', t)).toBeUndefined();
  });
});
