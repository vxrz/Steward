import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let hub: string;
const PW = 'Demo-password-1';
let olivia: Client, adam: Client, dana: Client, vera: Client, audrey: Client;

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number }) => e.status);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {}); // creates dana/olivia/adam/audrey/vera + team "Service Desk" (olivia, adam)
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  [olivia, adam, dana, vera, audrey] = await Promise.all(['olivia', 'adam', 'dana', 'vera', 'audrey'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('authentication', () => {
  it('requires sign-in', async () => {
    const res = await fetch(s.base + '/api/processes');
    expect(res.status).toBe(401);
  });
  it('rejects wrong passwords and throttles', async () => {
    for (let i = 0; i < 5; i++) expect(await status(s.as('vera', 'wrong-password-1'))).toBe(401);
    expect(await status(s.as('vera', PW))).toBe(429);
  });
  it('forces a password change for new users', async () => {
    const { temporaryPassword } = await s.api('POST', '/users', { username: 'newbie', roles: ['viewer'] });
    const c = await s.as('newbie', temporaryPassword);
    expect(await status(c('GET', '/processes'))).toBe(403);
    await c('POST', '/auth/password', { current: temporaryPassword, next: 'My-new-password-9' });
    expect(await status(c('GET', '/processes'))).toBe(200);
  });
});

describe('role defaults', () => {
  it('viewer can read but not run, edit or create', async () => {
    expect((await vera('GET', '/processes')).length).toBeGreaterThan(3);
    expect(await status(vera('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } }))).toBe(403);
    expect(await status(vera('POST', '/processes', { templateId: '40-ih-health-check' }))).toBe(403);
    expect(await status(vera('GET', '/audit'))).toBe(403);
  });
  it('operator can run but not edit', async () => {
    const { id } = await olivia('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } });
    const r = await s.waitRun(id, ['succeeded', 'failed']);
    expect(r.actor).toBe('olivia');
    const p = await olivia('GET', '/processes/ih-health-check');
    expect(p.permissions).toEqual(['view', 'run']);
    expect(await status(olivia('PUT', '/processes/ih-health-check', { definition: p.definition }))).toBe(403);
  });
  it('designers own what they create', async () => {
    const p = await dana('POST', '/processes', { definition: { name: 'Dana flow', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } });
    expect(p.owner).toBe('dana');
    expect(p.permissions).toContain('manage');
    expect(await status(olivia('PUT', `/processes/${p.id}/access`, { acl: [] }))).toBe(403);
  });
  it('auditor can read the audit log; entries name the user', async () => {
    const entries = await audrey('GET', '/audit?limit=500');
    expect(entries.some((e: any) => e.actor === 'olivia' && e.action === 'run.started')).toBe(true);
    expect(entries.some((e: any) => e.action === 'auth.login_failed')).toBe(true);
    expect((await audrey('GET', '/audit/verify')).ok).toBe(true);
  });
});

describe('access lists', () => {
  it('restricts a process to a team', async () => {
    await s.api('PUT', '/processes/iem-device-status/access', { acl: [{ subject: 'team:Service Desk', permissions: ['view', 'run'] }] });
    expect(await status(vera('GET', '/processes/iem-device-status'))).toBe(404);
    expect(await status(dana('GET', '/processes/iem-device-status'))).toBe(404);
    expect((await olivia('GET', '/processes/iem-device-status')).permissions).toEqual(['view', 'run']);
    expect((await adam('GET', '/processes/iem-device-status')).permissions).toEqual(['view', 'run']);
    expect((await vera('GET', '/processes')).some((p: any) => p.id === 'iem-device-status')).toBe(false);
  });
  it('restricts the use of a platform', async () => {
    await s.api('PUT', `/platforms/${hub}/access`, { acl: [{ subject: 'role:admin', permissions: ['use'] }] });
    expect(await status(olivia('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } }))).toBe(403);
    expect(await status(olivia('POST', `/platforms/${hub}/request`, { method: 'GET', path: '/x' }))).toBe(403);
    await s.api('PUT', `/platforms/${hub}/access`, { acl: [] });
    expect(await status(olivia('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } }))).toBe(200);
  });
});

describe('decisions', () => {
  it('enforces assignees and the four-eyes principle', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Four eyes',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve', assignees: ['role:approver', 'role:operator'], fourEyes: true, x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    });
    await s.api('PUT', `/processes/${p.id}/access`, { acl: [{ subject: 'role:operator', permissions: ['run'] }, { subject: 'role:approver', permissions: ['view'] }] });
    const { id } = await olivia('POST', '/runs', { processId: p.id });
    const run = await s.waitRun(id);
    const task = run.tasks[0];
    // starter may not decide, viewer of other process may not see it
    const mine = await olivia('GET', `/tasks/${task.id}`);
    expect(mine.canDecide).toBe(false);
    expect(mine.cannotDecideReason).toContain('Four-eyes');
    expect(await status(olivia('POST', `/tasks/${task.id}/complete`, { approved: true }))).toBe(403);
    expect(await status(vera('POST', `/tasks/${task.id}/complete`, { approved: true }))).toBe(404);
    expect((await adam('GET', '/tasks?status=open&mine=1')).map((t: any) => t.id)).toContain(task.id);
    await adam('POST', `/tasks/${task.id}/complete`, { approved: true, comment: 'ok' });
    const done = await s.waitRun(id, ['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.tasks[0].decidedBy).toBe('adam');
  });
});

describe('schedules', () => {
  it('run with the rights of their owner', async () => {
    const sch = await olivia('POST', '/schedules', { name: 'hc', processId: 'ih-health-check', cron: '0 7 * * *', bindings: { hub }, enabled: false });
    expect(sch.owner).toBe('olivia');
    expect(await status(vera('DELETE', `/schedules/${sch.id}`))).toBe(403);
    const { id } = await olivia('POST', `/schedules/${sch.id}/run`, {});
    expect((await s.waitRun(id, ['succeeded', 'failed'])).actor).toBe('olivia');
  });
});
