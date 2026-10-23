import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
const PW = 'Demo-password-1';
let olivia: Client, adam: Client;
let receiver: http.Server;
let receiverUrl: string;
const received: { path: string; body: any }[] = [];

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const notifications = async (c: Client) => (await c('GET', '/notifications?limit=100')) as { items: any[]; unread: number };
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const sqlite = async () => (await import('../src/db.js')).db();

let approvalProcess: string;
let failingProcess: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, adam] = await Promise.all(['olivia', 'adam'].map((u) => s.as(u, PW)));
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

  approvalProcess = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Needs approval',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve cleanup', x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    })
  ).id;
  failingProcess = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Always fails',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'chk', type: 'check', name: 'Users exist', condition: 'false', message: 'No users found', failRun: true, x: 1, y: 0 },
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

describe('security headers', () => {
  it('sets CSP and related headers on API and pages', async () => {
    for (const url of ['/api/health', '/']) {
      const res = await fetch(s.base + url);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('strict-transport-security')).toBeNull(); // no TLS in tests
    }
  });
  it('leaves the demo mock pages alone', async () => {
    const res = await fetch(s.base + '/mock/portal/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('in-app notifications', () => {
  it('tells approvers about a new task, not the starter', async () => {
    const { id } = await olivia('POST', '/runs', { processId: approvalProcess });
    await s.waitRun(id, ['waiting']);
    const n = await waitFor(
      async () => (await notifications(adam)).items.find((x) => x.event === 'task.assigned' && x.link === `/runs/${id}`),
      'task notification',
    );
    expect(n.title).toContain('Approve cleanup');
    expect(n.read).toBe(false);
    expect((await notifications(s.api)).items.some((x) => x.link === `/runs/${id}`)).toBe(true); // admin may approve too
    await flush();
    expect((await notifications(olivia)).items.some((x) => x.event === 'task.assigned')).toBe(false);
  });

  it('follows assignees and the four-eyes principle', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Four eyes notify',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'userTask', mode: 'approve', title: 'Check twice', assignees: ['role:operator', 'role:approver'], fourEyes: true, x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    });
    const { id } = await olivia('POST', '/runs', { processId: p.id });
    await s.waitRun(id, ['waiting']);
    await waitFor(async () => (await notifications(adam)).items.find((x) => x.link === `/runs/${id}`), 'assignee notification');
    await flush();
    expect((await notifications(olivia)).items.some((x) => x.link === `/runs/${id}`)).toBe(false);
    expect((await notifications(s.api)).items.some((x) => x.link === `/runs/${id}`)).toBe(false); // admin is not an assignee
  });

  it('notifies the starter of a failed run and the owner of a failed check', async () => {
    const { id } = await olivia('POST', '/runs', { processId: failingProcess });
    expect((await s.waitRun(id, ['succeeded', 'failed'])).status).toBe('failed');
    const mine = await waitFor(async () => {
      const list = (await notifications(olivia)).items.filter((x) => x.link === `/runs/${id}`);
      return list.length >= 2 && list;
    }, 'run notifications');
    expect(mine.map((x: any) => x.event).sort()).toEqual(['check.failed', 'run.failed']);
    expect(mine.find((x: any) => x.event === 'check.failed').title).toContain('Users exist');
    const ownerList = (await notifications(s.api)).items.filter((x) => x.link === `/runs/${id}`);
    expect(ownerList.map((x: any) => x.event)).toEqual(['check.failed']); // admin created (owns) the process
  });

  it('marks notifications as read', async () => {
    // deliveries from earlier tests are asynchronous: let them land first so the unread count is stable
    await flush();
    const before = await notifications(olivia);
    expect(before.unread).toBeGreaterThan(0);
    await olivia('POST', `/notifications/${before.items[0].id}/read`, {});
    expect((await notifications(olivia)).unread).toBe(before.unread - 1);
    expect(await status(adam('POST', `/notifications/${before.items[0].id}/read`, {}))).toBe(404);
    await olivia('POST', '/notifications/read-all', {});
    expect((await notifications(olivia)).unread).toBe(0);
  });

  it('reports stale dashboard data once per stale period', async () => {
    const d = await sqlite();
    const old = new Date(Date.now() - 3 * 3600000).toISOString();
    d.run(
      `INSERT INTO datasets (key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, stale_after_minutes)
       VALUES ('test.stale', 'Stale data', ?, 'Always fails', 'run_x', 0, ?, 0, '[]', '[]', '{}', '{}', 60)`,
      failingProcess,
      old,
    );
    const { checkStaleDatasets } = await import('../src/notifications/service.js');
    expect(checkStaleDatasets()).toBeGreaterThanOrEqual(1);
    expect(checkStaleDatasets()).toBe(0);
    await flush();
    expect((await notifications(s.api)).items.some((x) => x.event === 'dataset.stale' && x.title.includes('Stale data'))).toBe(true);
  });
});

describe('profile', () => {
  it('lets users change their e-mail settings', async () => {
    const u = await olivia('PATCH', '/me', { email: 'olivia@example.com', emailNotifications: false, displayName: 'Olivia O.' });
    expect(u).toMatchObject({ email: 'olivia@example.com', emailNotifications: false, displayName: 'Olivia O.' });
    expect((await olivia('GET', '/auth/me')).user.emailNotifications).toBe(false);
    expect(await status(olivia('PATCH', '/me', { email: 'not-an-address' }))).toBe(400);
  });
});

describe('external channels', () => {
  it('stores channel secrets without returning them', async () => {
    const saved = await s.api('PUT', '/settings/notifications', {
      email: { enabled: false, host: '', port: 587, secure: false, from: '' },
      teams: { enabled: true, webhookUrl: `${receiverUrl}/teams` },
      webhook: { enabled: true, url: `${receiverUrl}/hook?key=secret-123` },
      routes: { 'run.failed': ['inApp', 'webhook', 'teams'] },
      baseUrl: 'https://sm.example.com/',
    });
    expect(saved.webhook).toEqual({ enabled: true, hasUrl: true });
    expect(saved.teams).toEqual({ enabled: true, hasWebhookUrl: true });
    expect(saved.routes['run.failed']).toEqual(['inApp', 'teams', 'webhook']);
    expect(saved.routes['task.assigned']).toEqual(['inApp', 'email']);
    expect(saved.baseUrl).toBe('https://sm.example.com');
    expect(JSON.stringify(await s.api('GET', '/settings/notifications'))).not.toContain('secret-123');
    expect(JSON.stringify(await s.api('GET', '/settings'))).not.toContain('notifications');
    expect(await status(olivia('GET', '/settings/notifications'))).toBe(403);
    const audit = await s.api('GET', '/audit?action=notification.settings_changed');
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit)).not.toContain('secret-123');
  });

  it('sends a test message', async () => {
    received.length = 0;
    expect(await s.api('POST', '/settings/notifications/test', { channel: 'webhook' })).toEqual({ ok: true });
    expect(received[0]).toMatchObject({ path: '/hook?key=secret-123', body: { event: 'test', title: 'Test notification' } });
    expect((await s.api('POST', '/settings/notifications/test', { channel: 'email' })).ok).toBe(false);
  });

  it('posts failed runs to the webhook and Teams once per hour and process', async () => {
    received.length = 0;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { id } = await olivia('POST', '/runs', { processId: failingProcess });
      await s.waitRun(id, ['failed']);
      ids.push(id);
    }
    await waitFor(
      async () => (await notifications(olivia)).items.filter((x) => x.event === 'run.failed' && ids.includes(x.link.slice(6))).length === 2,
      'in-app',
    );
    await flush();
    const hooks = received.filter((r) => r.path.startsWith('/hook'));
    const teams = received.filter((r) => r.path === '/teams');
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.body).toMatchObject({
      event: 'run.failed',
      link: `https://sm.example.com/runs/${ids[0]}`,
      data: { processId: failingProcess, actor: 'olivia' },
    });
    expect(hooks[0]!.body.title).toContain('Always fails');
    expect(teams.length).toBe(1);
    const card = teams[0]!.body.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.actions[0].url).toBe(`https://sm.example.com/runs/${ids[0]}`);
  });
});

describe('API tokens', () => {
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetch(s.base + '/api' + url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  it('authenticate as their owner with the chosen scope', async () => {
    const read = await olivia('POST', '/me/tokens', { name: 'reporting', scope: 'read', expiresInDays: 30 });
    expect(read.token).toMatch(/^smt_/);
    expect(read.token.startsWith(read.prefix)).toBe(true);
    expect(read.owner).toBe('olivia');
    const res = await call(read.token, 'GET', '/runs?limit=5');
    expect(res.status).toBe(200);
    expect((await (await call(read.token, 'GET', '/auth/me')).json()).user.username).toBe('olivia');
    expect((await call(read.token, 'POST', '/runs', { processId: failingProcess })).status).toBe(403);

    const full = await olivia('POST', '/me/tokens', { name: 'automation', scope: 'full' });
    const started = await call(full.token, 'POST', '/runs', { processId: approvalProcess }); // no x-sm-client header needed
    expect(started.status).toBe(200);
    expect((await call(full.token, 'POST', '/me/tokens', { name: 'x', scope: 'full' })).status).toBe(403);
    expect((await call(full.token, 'GET', '/settings/notifications')).status).toBe(403); // same rights as olivia

    const list = await olivia('GET', '/me/tokens');
    expect(list.map((t: any) => t.name).sort()).toEqual(['automation', 'reporting']);
    expect(JSON.stringify(list)).not.toContain(read.token);
    expect(list.find((t: any) => t.name === 'reporting').lastUsedAt).toBeTruthy();
    expect(await status(adam('DELETE', `/me/tokens/${read.id}`))).toBe(404);
    expect((await s.api('GET', '/tokens')).length).toBeGreaterThanOrEqual(2);

    await olivia('DELETE', `/me/tokens/${read.id}`);
    expect((await call(read.token, 'GET', '/runs')).status).toBe(401);
    await s.api('DELETE', `/tokens/${full.id}`);
    expect((await call(full.token, 'GET', '/runs')).status).toBe(401);
    expect((await call('smt_unknown', 'GET', '/runs')).status).toBe(401);
    const audit = await s.api('GET', '/audit?action=token.');
    expect(audit.filter((a: any) => a.action === 'token.created').length).toBe(2);
    expect(audit.filter((a: any) => a.action === 'token.revoked').length).toBe(2);
  });

  it('stop working when the owner is disabled', async () => {
    const t = await adam('POST', '/me/tokens', { name: 'mine', scope: 'read' });
    expect((await call(t.token, 'GET', '/runs')).status).toBe(200);
    const adamId = (await s.api('GET', '/users')).find((u: any) => u.username === 'adam').id;
    await s.api('PUT', `/users/${adamId}`, { active: false });
    expect((await call(t.token, 'GET', '/runs')).status).toBe(401);
    await s.api('PUT', `/users/${adamId}`, { active: true });
  });

  it('keep CSRF protection for cookie requests', async () => {
    const res = await fetch(s.base + '/api/notifications/read-all', { method: 'POST', headers: { authorization: 'Bearer smt_x', cookie: 'sm_session=abc' } });
    expect(res.status).toBe(403);
  });
});

describe('maintenance', () => {
  it('reports the status', async () => {
    const m = await s.api('GET', '/maintenance');
    expect(m.databaseBytes).toBeGreaterThan(0);
    expect(m.runs).toBeGreaterThan(0);
    expect(m.auditEntries).toBeGreaterThan(0);
    expect(await status(olivia('GET', '/maintenance'))).toBe(403);
  });

  it('deletes old finished runs, their artifacts and old read notifications', async () => {
    const d = await sqlite();
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const { id: oldRun } = await olivia('POST', '/runs', { processId: failingProcess });
    await s.waitRun(oldRun, ['failed']);
    const { id: waiting } = await olivia('POST', '/runs', { processId: approvalProcess });
    await s.waitRun(waiting, ['waiting']);
    d.run('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?', old, old, oldRun);
    d.run('UPDATE runs SET started_at = ? WHERE id = ?', old, waiting);
    const dir = path.join(s.dataDir, 'artifacts', oldRun);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'art_test.png');
    fs.writeFileSync(file, 'png');
    d.run(
      "INSERT INTO run_artifacts (id, run_id, step_key, kind, name, mime, path, sha256, size, created_at) VALUES ('art_test', ?, 'chk', 'screenshot', 'x', 'image/png', ?, 'abc', 3, ?)",
      oldRun,
      file,
      old,
    );
    d.run("UPDATE notifications SET ts = ? WHERE read = 1 AND user_id = (SELECT id FROM users WHERE username = 'olivia')", old);
    const readBefore = d.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE read = 1 AND ts = ?', old)!.n;
    expect(readBefore).toBeGreaterThan(0);

    await s.api('PUT', '/settings', { retentionRunDays: 30, retentionNotificationDays: 7 });
    expect(await status(s.api('PUT', '/settings', { retentionRunDays: -1 }))).toBe(400);
    const m = await s.api('POST', '/maintenance/cleanup', {});
    expect(m.lastCleanup).toMatchObject({ runsDeleted: 1, artifactsDeleted: 1, notificationsDeleted: readBefore });
    expect(await status(s.api('GET', `/runs/${oldRun}`))).toBe(404);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await s.api('GET', `/runs/${waiting}`)).status).toBe('waiting');
    expect(d.get('SELECT 1 FROM run_steps WHERE run_id = ?', oldRun)).toBeUndefined();

    const entries = await s.api('GET', '/audit?action=maintenance.cleanup');
    expect(entries[0].details).toMatchObject({ runsDeleted: 1, artifactsDeleted: 1 });
    expect((await s.api('GET', `/audit?runId=${waiting}`)).length).toBeGreaterThan(0);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE run_id = ?', oldRun)!.n).toBeGreaterThan(0); // audit is kept
  });
});
