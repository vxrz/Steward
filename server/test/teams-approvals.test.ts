import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Approvals from Microsoft Teams, stage 1 (ADR 0013): decision cards with Approve / Reject links that open Steward,
 * no bodies or values in a card, a follow-up card with the outcome where the card went, and the exactly-once claim on
 * decision steps.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const PW = 'Teams-password-123';
let s: TestServer;
let alma: Client;
let receiver: http.Server;
let receiverUrl = '';
const received: { path: string; body: any }[] = [];
let approval = '';
let dbm: typeof import('../src/db.js');
let svc: typeof import('../src/notifications/service.js');
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 120));
    await svc.flushNotifications();
  }
};
const cardText = (b: any) => JSON.stringify(b);
const actions = (b: any): { title: string; url: string }[] => b.attachments[0].content.actions;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  dbm = await import('../src/db.js');
  svc = await import('../src/notifications/service.js');
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'alma', roles: ['approver'], password: PW, displayName: 'Alma Approver', mustChangePassword: false });
  alma = await s.as('alma', PW);
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
  const notif = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...notif,
    teams: { enabled: true, webhookUrl: `${receiverUrl}/instance` },
    routes: { ...notif.routes, 'task.assigned': ['inApp', 'teams'], 'mcp.request': ['inApp', 'teams'] },
    baseUrl: 'https://sm.example.com/',
  });
  approval = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Firewall opening',
        inputs: [{ name: 'ticket', type: 'string', label: 'Ticket' }],
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'userTask', mode: 'approve', title: 'Open port 443', assignees: ['role:approver'], x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});
beforeEach(() => {
  received.length = 0;
});

async function startRun(): Promise<{ runId: string; taskId: string }> {
  const { id } = await s.api('POST', '/runs', { processId: approval, inputs: { ticket: 'SECRET-TICKET-4711' } });
  const run = await s.waitRun(id, ['waiting']);
  await settle();
  return { runId: id, taskId: run.tasks[0].id };
}

describe('stage 1: decision cards', () => {
  it('lead to the decision with Approve / Reject links, show no input values, and remember where they went', async () => {
    const { runId, taskId } = await startRun();
    const card = received.find((r) => cardText(r.body).includes('Open port 443'));
    expect(card?.path).toBe('/instance');
    const a = actions(card!.body);
    expect(a.map((x) => x.title)).toEqual(['Approve', 'Reject', 'Open in Steward']);
    expect(a[0]!.url).toBe(`https://sm.example.com/runs/${runId}?task=${taskId}&decide=approve`);
    expect(a[1]!.url).toBe(`https://sm.example.com/runs/${runId}?task=${taskId}&decide=reject`);
    expect(cardText(card!.body)).toContain('Firewall opening');
    // never the run inputs or values
    expect(cardText(card!.body)).not.toContain('SECRET-TICKET-4711');
    expect(dbm.db().all('SELECT target FROM approval_posts WHERE item_kind = ? AND item_id = ?', 'task', taskId)).toEqual([{ target: 'teams:instance' }]);
  });

  it('a link never decides: opening it changes nothing', async () => {
    const { taskId } = await startRun();
    // the link is a page of the web app; the API decides only on POST in a signed-in session
    expect((await alma('GET', `/tasks/${taskId}`)).status).toBe('open');
  });

  it('get a follow-up card with the outcome, once', async () => {
    const { taskId } = await startRun();
    received.length = 0;
    await alma('POST', `/tasks/${taskId}/complete`, { approved: true, comment: 'ok' });
    await settle();
    const follow = received.filter((r) => cardText(r.body).includes('Decided: Open port 443'));
    expect(follow).toHaveLength(1);
    expect(cardText(follow[0]!.body)).toContain('Approved by Alma Approver');
    expect(
      dbm.db().get<{ followed_up_at: string | null }>('SELECT followed_up_at FROM approval_posts WHERE item_id = ?', taskId)!.followed_up_at,
    ).not.toBeNull();
  });

  it('a cancelled run follows up too', async () => {
    const { runId, taskId } = await startRun();
    received.length = 0;
    await s.api('POST', `/runs/${runId}/cancel`, {});
    await settle();
    expect(received.some((r) => cardText(r.body).includes('No longer needed: the run was cancelled'))).toBe(true);
    expect((await s.api('GET', `/tasks/${taskId}`)).status).toBe('cancelled');
  });
});

describe('exactly once', () => {
  it('a task is decided once: the claim refuses a second write, and the routes never decide twice', async () => {
    const { taskId } = await startRun();
    const store = await import('../src/engine/store.js');
    const results = await Promise.all([
      status(alma('POST', `/tasks/${taskId}/complete`, { approved: true })),
      status(s.api('POST', `/tasks/${taskId}/complete`, { approved: false })),
    ]);
    // the second request finds the step decided (no longer decidable, or the claim's 409)
    expect(results.filter((x) => x === 200)).toHaveLength(1);
    expect(results.find((x) => x !== 200)).toBeOneOf([403, 409]);
    // the claim itself: a write after the decision changes nothing
    const before = await s.api('GET', `/tasks/${taskId}`);
    expect(() => store.decideTask(taskId, 'completed', { approved: true, selectedKeys: [] }, 'mallory')).toThrow(/decided already/);
    expect(() => store.decideTask(taskId, 'cancelled', null, 'mallory')).toThrow(/decided already/);
    const after = await s.api('GET', `/tasks/${taskId}`);
    expect([after.status, after.decidedBy, after.decision]).toEqual([before.status, before.decidedBy, before.decision]);
    const audits = await s.api('GET', `/audit?action=task.completed&entityId=${taskId}`);
    expect(audits).toHaveLength(1);
  });
});

describe('MCP requests', () => {
  it('cards show the change as METHOD path_template, never the body; proposals only open Steward', async () => {
    const { mcpCardParts } = await import('../src/msteams/cards.js');
    const base = {
      id: 'mrq_x',
      kind: 'gateway',
      requested_by: 'alma',
      created_at: '2026-11-07T10:00:00Z',
      expires_at: '2026-11-08T10:00:00Z',
      method: 'POST',
      path_template: '/api/v2/rules/{id}',
      process_name: null,
      platformName: 'Edge firewall',
    };
    const p = mcpCardParts('en', { ...base, mode: 'fourEyes' });
    expect(p.facts).toEqual(
      expect.arrayContaining([
        { label: 'Change', value: 'POST /api/v2/rules/{id}' },
        { label: 'Platform', value: 'Edge firewall' },
      ]),
    );
    expect(p.actions?.map((a) => a.href)).toEqual([
      'https://sm.example.com/mcp-requests/mrq_x?decide=approve',
      'https://sm.example.com/mcp-requests/mrq_x?decide=reject',
    ]);
    expect(mcpCardParts('en', { ...base, mode: 'review' }).actions).toBeUndefined();
  });

  it('an expired request follows up where its card went', async () => {
    const id = `mrq_exp${Date.now()}`;
    const past = new Date(Date.now() - 60_000).toISOString();
    dbm.db().run(
      `INSERT INTO mcp_requests (id, kind, status, mode, requested_by, token_id, token_name, reason, created_at, expires_at, method, path, path_template, query, inputs, dry_run)
         VALUES (?, 'gateway', 'pending', 'fourEyes', 'alma', 'tok', 'tok', 'x', ?, ?, 'DELETE', '/x/1', '/x/{id}', '{}', '{}', 0)`,
      id,
      past,
      past,
    );
    dbm.db().run("INSERT INTO approval_posts (item_kind, item_id, target, posted_at) VALUES ('mcp_request', ?, 'teams:instance', ?)", id, past);
    const { expireRequests } = await import('../src/mcp/requests.js');
    expireRequests();
    await settle();
    const follow = received.find((r) => cardText(r.body).includes('Decided: DELETE /x/{id}'));
    expect(cardText(follow?.body)).toContain('Expired without a decision');
  });
});
