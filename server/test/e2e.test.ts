import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let hub: string;
let iem: string;

beforeAll(async () => {
  s = await startTestServer();
  await s.api('POST', '/vault/setup', { passphrase: 'correct horse battery', operator: 'tester' });
  await s.api('POST', '/demo/setup', {});
  const platforms = await s.api('GET', '/platforms');
  hub = platforms.find((p: any) => p.kind === 'insights-hub').id;
  iem = platforms.find((p: any) => p.kind === 'industrial-edge-management').id;
});
afterAll(async () => {
  await s?.app.close();
});

const run = (processId: string, bindings: Record<string, string>, inputs: Record<string, unknown> = {}, dryRun = false) =>
  s.api('POST', '/runs', { processId, bindings, inputs, dryRun }).then((r) => r.id as string);

const failedSteps = (r: any) => r.steps.filter((x: any) => x.status === 'failed' && x.type !== 'check').map((x: any) => `${x.key}: ${x.error}`);

describe('security', () => {
  it('rejects writes without the client header', async () => {
    const res = await fetch(s.base + '/api/settings', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
  });
  it('rejects foreign host headers', async () => {
    const res = await s.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });
  it('never returns secret values', async () => {
    const p = await s.api('GET', `/platforms/${hub}`);
    expect(JSON.stringify(p)).not.toContain('demo-secret');
    expect(p.secretKeys).toContain('clientSecret');
  });
});

describe('platforms', () => {
  it('tests connections (oauth2 + custom login)', async () => {
    expect((await s.api('POST', `/platforms/${hub}/test`)).ok).toBe(true);
    expect((await s.api('POST', `/platforms/${iem}/test`)).ok).toBe(true);
  });
  it('imports an OpenAPI spec', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Demo', version: '1' },
      paths: { '/Users': { get: { operationId: 'listUsers', summary: 'List users' }, post: { operationId: 'createUser', requestBody: {} } } },
    };
    await s.api('POST', `/platforms/${hub}/specs`, { content: JSON.stringify(spec) });
    const ops = await s.api('GET', `/platforms/${hub}/operations`);
    expect(ops.map((o: any) => o.operationId)).toEqual(['listUsers', 'createUser']);
  });
});

describe('templates against the mock platform', () => {
  it('health check passes', async () => {
    const r = await s.waitRun(await run('ih-health-check', { hub }));
    expect(failedSteps(r)).toEqual([]);
    expect(r.status).toBe('succeeded');
    expect(r.stats.checksFailed).toBe(0);
    expect(r.stats.checksPassed).toBeGreaterThanOrEqual(2);
  });

  it('access review: flag (dry run does not change anything)', async () => {
    const id = await run('ih-access-review-1-flag', { hub }, {}, true);
    const r = await s.waitRun(id);
    expect(r.status).toBe('waiting');
    const task = r.tasks[0];
    expect(task.items.length).toBeGreaterThan(3);
    await s.api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: task.items.map((i: any) => i.key) });
    const done = await s.waitRun(id, ['succeeded', 'failed']);
    expect(failedSteps(done)).toEqual([]);
    expect(done.status).toBe('succeeded');
    expect(done.stats.writes).toBe(0);
    expect(done.stats.skippedWrites).toBe(task.items.length);
  });

  let flaggedCount = 0;
  it('access review: flag for real', async () => {
    const id = await run('ih-access-review-1-flag', { hub }, { inactiveDays: 90, exempt: 'karla.lang@example.com' });
    const r = await s.waitRun(id);
    expect([r.status, r.error]).toEqual(['waiting', null]);
    const task = r.tasks[0];
    const names = task.items.map((i: any) => i.cells[0]);
    expect(names).not.toContain('karla.lang@example.com');
    expect(names).toContain('david.engel@example.com');
    expect(names).not.toContain('anna.berger@example.com');
    flaggedCount = task.items.length;
    await s.api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: task.items.map((i: any) => i.key), comment: 'quarterly review' });
    const done = await s.waitRun(id, ['succeeded', 'failed']);
    expect(failedSteps(done)).toEqual([]);
    expect(done.stats.writes).toBe(flaggedCount);
    const report = done.reports.find((x: any) => x.title.includes('flagged'));
    expect(report.rows.length).toBe(flaggedCount);
  });

  it('access review: decide – keep one, revoke the rest', async () => {
    const id = await run('ih-access-review-2-decide', { hub });
    let r = await s.waitRun(id);
    expect(r.status).toBe('waiting');
    const task = r.tasks.find((t: any) => t.status === 'open');
    expect(task.items.length).toBe(flaggedCount);
    const keep = task.items[0].key;
    await s.api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: [keep] });
    r = await s.waitRun(id, ['waiting', 'succeeded', 'failed']);
    for (let i = 0; i < 50 && r.tasks.filter((t: any) => t.status === 'open').length === 0 && r.status !== 'failed'; i++) {
      await new Promise((res) => setTimeout(res, 100));
      r = await s.api('GET', `/runs/${id}`);
    }
    const approval = r.tasks.find((t: any) => t.status === 'open');
    expect(approval.mode).toBe('approve');
    await s.api('POST', `/tasks/${approval.id}/complete`, { approved: true });
    const done = await s.waitRun(id, ['succeeded', 'failed']);
    expect(failedSteps(done)).toEqual([]);
    expect(done.status).toBe('succeeded');
    // review group is now empty
    const groups = await s.api('POST', `/platforms/${hub}/request`, {
      method: 'GET',
      path: '/api/identitymanagement/v3/Groups',
      query: { filter: 'displayName eq "mdsp_usergroup:AccessReview"' },
    });
    const gid = groups.body.resources[0].id;
    const members = await s.api('POST', `/platforms/${hub}/request`, { method: 'GET', path: `/api/identitymanagement/v3/Groups/${gid}/members` });
    expect(members.body).toEqual([]);
    // kept user still has StandardUser; revoked users have no groups
    const users = await s.api('POST', `/platforms/${hub}/request`, { method: 'GET', path: '/api/identitymanagement/v3/Users', query: { count: '100' } });
    const kept = users.body.resources.find((u: any) => u.id === keep);
    expect(kept.groups.length).toBeGreaterThan(0);
    const revoked = users.body.resources.filter((u: any) => task.items.some((i: any) => i.key === u.id) && u.id !== keep);
    expect(revoked.length).toBe(flaggedCount - 1);
    for (const u of revoked) expect(u.groups).toEqual([]);
  });

  it('onboarding creates users and assigns bundles', async () => {
    const csv = 'email;givenName;familyName;bundle\nnew.one@example.com;New;One;Engineer\nanna.berger@example.com;Anna;Berger;Viewer\n';
    const id = await run('ih-onboard-users', { hub }, { users: csv });
    const r = await s.waitRun(id);
    expect(failedSteps(r)).toEqual([]);
    expect(r.status).toBe('waiting');
    await s.api('POST', `/tasks/${r.tasks[0].id}/complete`, { approved: true });
    const done = await s.waitRun(id, ['succeeded', 'failed']);
    expect(failedSteps(done)).toEqual([]);
    expect(done.status).toBe('succeeded');
    const users = await s.api('POST', `/platforms/${hub}/request`, {
      method: 'GET',
      path: '/api/identitymanagement/v3/Users',
      query: { filter: 'userName eq "new.one@example.com"' },
    });
    const u = users.body.resources[0];
    expect(u.groups.map((g: any) => g.display).sort()).toEqual(['mdsp:core:StandardUser', 'mdsp_usergroup:Engineers', 'mdsp_usergroup:Operators']);
  });

  it('onboarding fails early for unknown bundles', async () => {
    const id = await run('ih-onboard-users', { hub }, { users: 'email,givenName,familyName,bundle\na@b.c,A,B,Nope' });
    const r = await s.waitRun(id, ['succeeded', 'failed']);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Unknown bundle');
  });

  it('asset attribute optimization finds unused variables and silent assets', async () => {
    const r = await s.waitRun(await run('ih-asset-attribute-optimization', { hub }));
    expect(failedSteps(r)).toEqual([]);
    expect(r.status).toBe('succeeded');
    const unused = r.reports.find((x: any) => x.title.startsWith('Variables without data'));
    expect(unused.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(unused.rows)).toContain('MotorData.torque');
    const silent = r.reports.find((x: any) => x.title.startsWith('Assets without data'));
    expect(silent.rows.map((x: any) => x[0])).toContain('Pump P4');
    expect(r.stats.checksFailed).toBe(2);
  });

  it('IEM device check flags offline devices', async () => {
    const r = await s.waitRun(await run('iem-device-status', { iem }));
    expect(failedSteps(r)).toEqual([]);
    const check = r.steps.find((x: any) => x.stepId === 'allOnline');
    expect(check.status).toBe('failed');
    expect(check.output.message).toContain('edge-paint-shop');
  });

  it('browser check signs in and stores a screenshot', async () => {
    const r = await s.waitRun(await run('browser-portal-check', { portal: iem }), ['succeeded', 'failed']);
    expect(failedSteps(r)).toEqual([]);
    expect(r.artifacts.length).toBe(1);
    const step = r.steps.find((x: any) => x.stepId === 'login');
    expect(step.output.status).toContain('System status');
    expect(JSON.stringify(r)).not.toContain('demo-password');
  });

  it('generic endpoint check', async () => {
    const r = await s.waitRun(await run('generic-endpoint-check', { target: hub }, { paths: '/api/identitymanagement/v3/Users\n/does-not-exist' }));
    expect(r.stats.checksPassed).toBe(1);
    expect(r.stats.checksFailed).toBe(1);
  });
});

describe('protocol and audit', () => {
  it('renders a run report with an intact fingerprint', async () => {
    const runs = await s.api('GET', '/runs?status=succeeded');
    const html = await s.api('GET', `/runs/${runs[0].id}/report.html`);
    expect(html).toContain('Run protocol');
    expect(html).toContain('✔ intact');
  });
  it('audit chain verifies and detects tampering', async () => {
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    const { db } = await import('../src/db.js');
    db().run("UPDATE audit_log SET summary = 'tampered' WHERE seq = 3");
    const r = await s.api('GET', '/audit/verify');
    expect(r.ok).toBe(false);
    expect(r.firstBadSeq).toBe(3);
  });
  it('process versions are kept', async () => {
    const p = await s.api('GET', '/processes/ih-health-check');
    p.definition.description = 'changed';
    const saved = await s.api('PUT', '/processes/ih-health-check', { definition: p.definition, comment: 'tweak' });
    expect(saved.currentVersion).toBe(2);
    const versions = await s.api('GET', '/processes/ih-health-check/versions');
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
  });
});
