import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Privileged identities, ADR 0009 step 4 (0.14.0) – without the PAM checkout: the flag (managers set it, never on the
 * default identity, turning it off asks for a step-up), the control point platform.privilegedIdentity on every use
 * (runs, run now, schedules, triggers, the request explorer, approving MCP requests), the start approval of a privileged
 * run (a second person, never the starter or the owner; expiry; restarts; sub-processes; the flag read when the run
 * resolves its connection), the MCP rules, monitors, the credentials register link and rotation, and the run report.
 */
let s: TestServer;
let echo: http.Server;
let echoBase = '';
const PW = 'Demo-password-1';
let olivia: Client;
let adam: Client;
let dana: Client;

/** What the echo server saw: method, path and credential of every request */
const seen: { method: string; path: string; key: string | undefined }[] = [];

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Directory', version: '1' },
  paths: {
    '/users': {
      get: { operationId: 'listUsers', responses: { 200: { description: 'ok' } } },
      post: { operationId: 'createUser', responses: { 201: { description: 'ok' } } },
    },
    '/users/{id}': {
      delete: {
        operationId: 'deleteUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 204: { description: 'ok' } },
      },
    },
  },
});

beforeAll(async () => {
  echo = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, key: req.headers['x-api-key'] as string | undefined });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path, method: req.method }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, adam, dana] = await Promise.all(['olivia', 'adam', 'dana'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
}, 600_000);

const auditOf = async (query: string): Promise<any[]> => {
  const r = await s.api('GET', `/audit?${query}`);
  return r.items ?? r;
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { status: number }).status, ...((e as { body: any }).body ?? {}) };
  }
  throw new Error('expected a refusal');
};
/** A client of `user` whose session has no fresh confirmation: the next sensitive request answers STEP_UP_REQUIRED. */
const stale = async (user: string, password = PW): Promise<Client> => {
  const c = await s.as(user, password, { autoStepUp: false });
  await c('DELETE', '/auth/step-up');
  return c;
};

async function platform(name: string): Promise<any> {
  const p = await s.api('POST', '/platforms', {
    name,
    kind: 'generic',
    baseUrl: echoBase,
    config: { http: { proxy: 'none' }, auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, testPath: '/users' },
  });
  await s.api('PUT', `/platforms/${p.id}/secrets`, { apiKey: `default-key-${p.id.slice(3, 9)}` });
  await s.api('POST', `/platforms/${p.id}/specs`, { name: 'Directory', content: SPEC });
  return s.api('GET', `/platforms/${p.id}`);
}

/** A privileged identity, open to `users`. */
async function privileged(p: any, name: string, key: string, users: string[] = ['olivia', 'adam']): Promise<any> {
  const i = await s.api('POST', `/platforms/${p.id}/identities`, { name, privileged: true });
  await s.api('PUT', `/platforms/${p.id}/identities/${i.id}/secrets`, { apiKey: key });
  return s.api('PUT', `/platforms/${p.id}/identities/${i.id}/access`, { acl: users.map((u) => ({ subject: `user:${u}`, permissions: ['use'] })) });
}

/** A process with one GET /users step on slot api; `extra`: more definition fields (privilegedFourEyes, nodes …). */
async function process(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (
    await s.api('POST', '/processes', {
      definition: {
        name,
        connections: [{ slot: 'api' }],
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'read', type: 'http', connection: 'api', method: 'GET', path: '/users', x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'read' }],
        ...extra,
      },
    })
  ).id;
}

const startTask = async (runId: string): Promise<any> => (await s.api('GET', `/runs/${runId}`)).tasks.find((t: any) => t.stepKey === '$start');

describe('the privileged flag', () => {
  it('is set by managers, never on the default identity; turning it off is a loosening (step-up)', async () => {
    const p = await platform('Directory flag');
    const i = await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Admin', privileged: true });
    expect(i).toMatchObject({ privileged: true, default: false, mcp: { mode: 'off' }, registerEntries: 0 });
    expect((await auditOf(`entityId=${p.id}&action=platform.identity_created`))[0].details).toMatchObject({ privileged: true });
    const def = p.identities.find((x: any) => x.default);
    // the default identity: everyone with "use" – and Steward's own readers – use it
    expect(await refusal(s.api('PUT', `/platforms/${p.id}/identities/${def.id}`, { privileged: true }))).toMatchObject({
      status: 400,
      code: 'IDENTITY_DEFAULT_PRIVILEGED',
    });
    expect(await refusal(s.api('POST', `/platforms/${p.id}/identities/${i.id}/default`))).toMatchObject({ code: 'IDENTITY_DEFAULT_PRIVILEGED' });
    // turning it off asks for a confirmation (like read-only off); keeping it on does not
    const c = await stale('admin', 'Admin-password-1');
    expect(await refusal(c('PUT', `/platforms/${p.id}/identities/${i.id}`, { privileged: false }))).toMatchObject({
      status: 403,
      code: 'STEP_UP_REQUIRED',
      stepUp: { action: 'grantAccess' },
    });
    expect((await c('PUT', `/platforms/${p.id}/identities/${i.id}`, { description: 'Directory administrator', privileged: true })).privileged).toBe(true);
    await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    expect((await c('PUT', `/platforms/${p.id}/identities/${i.id}`, { privileged: false })).privileged).toBe(false);
    const changed = (await auditOf(`entityId=${p.id}&action=platform.identity_updated`))[0];
    expect(changed.details).toMatchObject({ changed: ['privileged'], privileged: false });
    // a tightening needs no confirmation
    const c2 = await stale('admin', 'Admin-password-1');
    expect((await c2('PUT', `/platforms/${p.id}/identities/${i.id}`, { privileged: true })).privileged).toBe(true);
    // the seal covers the flag
    const { db } = await import('../src/db.js');
    db().run('UPDATE platform_identities SET privileged = 0 WHERE id = ?', i.id);
    expect((await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.id === i.id).integrity).toBe('mismatch');
    db().run('UPDATE platform_identities SET privileged = 1 WHERE id = ?', i.id);
    expect((await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.id === i.id).integrity).toBe('ok');
  });

  it('tightens the MCP mode when set: no reads, changing calls only with a second person', async () => {
    const p = await platform('Directory MCP flag');
    const ops = await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Operations' });
    await s.api('PUT', `/platforms/${p.id}/identities/${ops.id}/mcp`, { mode: 'writes', writes: 'confirm' });
    expect((await s.api('PUT', `/platforms/${p.id}/identities/${ops.id}`, { privileged: true })).mcp).toEqual({ mode: 'writes', writes: 'fourEyes' });
    const mcpChanged = (await auditOf(`entityId=${p.id}&action=platform.identity_mcp_changed`))[0];
    expect(mcpChanged.details).toMatchObject({ reason: 'privileged', previous: { mode: 'writes', writes: 'confirm' } });
    const reader = await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Reader' });
    await s.api('PUT', `/platforms/${p.id}/identities/${reader.id}/mcp`, { mode: 'read' });
    expect((await s.api('PUT', `/platforms/${p.id}/identities/${reader.id}`, { privileged: true })).mcp.mode).toBe('off');
    for (const body of [{ mode: 'read' }, { mode: 'writes', writes: 'confirm' }])
      expect(await refusal(s.api('PUT', `/platforms/${p.id}/identities/${ops.id}/mcp`, body))).toMatchObject({ code: 'IDENTITY_PRIVILEGED_MCP' });
    expect((await s.api('PUT', `/platforms/${p.id}/identities/${ops.id}/mcp`, { mode: 'off' })).mcp.mode).toBe('off');
  });
});

describe('a step-up on every use (platform.privilegedIdentity)', () => {
  let p: any;
  let priv: any;
  let proc: string;
  beforeAll(async () => {
    p = await platform('Directory step-up');
    priv = await privileged(p, 'Admin', 'priv-key-step-up');
    proc = await process('Read with step-up');
  });

  it('asks before a run, a schedule, a trigger and a request explorer call – nothing is sent before', async () => {
    const c = await stale('olivia');
    const before = seen.length;
    const start = { processId: proc, bindings: { api: p.id }, identities: { api: priv.id } };
    for (const [method, path, body] of [
      ['POST', '/runs', start],
      ['POST', '/schedules', { name: 'Privileged nightly', processId: proc, cron: '0 3 * * *', bindings: { api: p.id }, identities: { api: priv.id } }],
      ['POST', '/triggers', { name: 'Privileged hook', processId: proc, bindings: { api: p.id }, identities: { api: priv.id } }],
      ['POST', `/platforms/${p.id}/request`, { method: 'GET', path: '/users', identityId: priv.id }],
    ] as const)
      expect(await refusal(c(method, path, body)), path).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED', stepUp: { action: 'usePrivilegedIdentity' } });
    expect(seen.length).toBe(before);
    // the default identity asks nothing
    expect((await s.waitRun((await c('POST', '/runs', { processId: proc, bindings: { api: p.id } })).id)).status).toBe('succeeded');
    await c('POST', '/auth/step-up', { password: PW });
    const run = await s.waitRun((await c('POST', '/runs', start)).id);
    // without four-eyes (the default policy, no process setting) it runs at once
    expect(run.status).toBe('succeeded');
    expect(run.bindings.api).toMatchObject({ identityId: priv.id, identityName: 'Admin', privileged: true });
    expect([...seen].reverse().find((x) => x.path === '/users')?.key).toBe('priv-key-step-up');
    const started = (await auditOf(`runId=${run.id}&action=run.started`))[0];
    expect(started.details.bindings.api).toMatchObject({ privileged: true });
    expect(started.details.assurance).toEqual([
      expect.objectContaining({ point: 'platform.privilegedIdentity', actor: 'olivia', stepUp: expect.objectContaining({ method: 'password' }) }),
    ]);
    const explored = await c('POST', `/platforms/${p.id}/request`, { method: 'GET', path: '/users', identityId: priv.id });
    expect(explored.status).toBe(200);
    expect((await auditOf(`entityId=${p.id}&action=api.adhoc_read`))[0].details).toMatchObject({ identityId: priv.id, privileged: true });
    const sched = await c('POST', '/schedules', {
      name: 'Privileged nightly',
      processId: proc,
      cron: '0 3 * * *',
      bindings: { api: p.id },
      identities: { api: priv.id },
      enabled: false,
    });
    const trig = await c('POST', '/triggers', { name: 'Privileged hook', processId: proc, bindings: { api: p.id }, identities: { api: priv.id } });
    // "Run now" of a schedule asks again, like any start
    const c2 = await stale('olivia');
    expect(await refusal(c2('POST', `/schedules/${sched.id}/run`))).toMatchObject({ code: 'STEP_UP_REQUIRED', stepUp: { action: 'usePrivilegedIdentity' } });
    // changing a schedule that uses one asks too
    expect(await refusal(c2('PUT', `/schedules/${sched.id}`, { ...sched, name: 'Renamed' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await olivia('DELETE', `/schedules/${sched.id}`);
    await olivia('DELETE', `/triggers/${trig.trigger.id}`);
  });

  it('cannot be confirmed with an API token: scripts do not start privileged runs', async () => {
    const token = (await olivia('POST', '/me/tokens', { name: 'privileged script', scope: 'full' })).token;
    const res = await fetch(`${s.base}/api/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ processId: proc, bindings: { api: p.id }, identities: { api: priv.id } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('SESSION_REQUIRED');
  });

  it('refuses an identity marked privileged between the step-up check and the start (no unconfirmed use)', async () => {
    const { assertPrivilegedConfirmed, privilegedSlots } = await import('../src/platforms/privileged.js');
    const uses = privilegedSlots({ api: p.id, other: 'nope' }, { api: priv.id });
    expect(uses).toEqual([expect.objectContaining({ slot: 'api', identityId: priv.id, identityName: 'Admin', platformName: 'Directory step-up' })]);
    expect(() => assertPrivilegedConfirmed(uses)).toThrow(/privileged/);
    expect(() => assertPrivilegedConfirmed([])).not.toThrow();
  });
});

describe('the start approval (four-eyes before the run)', () => {
  let p: any;
  let priv: any;
  let proc: string;
  beforeAll(async () => {
    p = await platform('Directory four-eyes');
    priv = await privileged(p, 'Admin', 'priv-key-four-eyes');
    proc = await process('Privileged read', { privilegedFourEyes: true });
  });
  const start = (c: Client, extra: Record<string, unknown> = {}) =>
    c('POST', '/runs', { processId: proc, bindings: { api: p.id }, identities: { api: priv.id }, ...extra }).then((r: any) => r.id as string);

  it('waits before the first step for a second person with the approve right; the starter cannot approve', async () => {
    const before = seen.filter((x) => x.key === 'priv-key-four-eyes').length;
    const id = await start(olivia);
    const run = await s.waitRun(id);
    expect(run.status).toBe('waiting');
    expect(run.steps.filter((x: any) => x.nodeId !== 'start' && x.status !== 'skipped')).toEqual([]);
    const task = await startTask(id);
    expect(task).toMatchObject({
      mode: 'approve',
      status: 'open',
      fourEyes: true,
      startApproval: {
        reason: 'process',
        requesters: ['olivia'],
        identities: [{ slot: 'api', platformId: p.id, platformName: 'Directory four-eyes', identityId: priv.id, identityName: 'Admin' }],
      },
    });
    expect(Date.parse(task.startApproval.expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect((await auditOf(`runId=${id}&action=run.start_approval_requested`))[0].details).toMatchObject({ reason: 'process', requesters: ['olivia'] });
    // nothing was sent with the privileged credentials yet
    expect(seen.filter((x) => x.key === 'priv-key-four-eyes').length).toBe(before);
    // the starter: never; a designer without the approve right: no
    expect((await olivia('GET', `/tasks/${task.id}`)).cannotDecideCode).toBe('FOUR_EYES_START');
    expect(await refusal(olivia('POST', `/tasks/${task.id}/complete`, { approved: true }))).toMatchObject({ status: 403, code: 'FOUR_EYES_START' });
    expect((await dana('GET', `/tasks/${task.id}`)).cannotDecideCode).toBe('START_APPROVAL_RIGHTS');
    // the approver confirms it is them (step-up), then the run starts
    const a = await stale('adam');
    expect(await refusal(a('POST', `/tasks/${task.id}/complete`, { approved: true }))).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      stepUp: { action: 'usePrivilegedIdentity' },
    });
    await a('POST', '/auth/step-up', { password: PW });
    await a('POST', `/tasks/${task.id}/complete`, { approved: true, comment: 'Expected maintenance' });
    const done = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(done.status).toBe('succeeded');
    expect(seen.filter((x) => x.key === 'priv-key-four-eyes').length).toBe(before + 1);
    const decided = (await auditOf(`runId=${id}&action=task.completed`))[0];
    expect(decided.actor).toBe('adam');
    expect(decided.details.assurance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          point: 'platform.privilegedIdentity',
          rule: expect.objectContaining({ fourEyes: true }),
          fourEyes: expect.objectContaining({ required: true, requesters: ['olivia'], approver: 'adam' }),
          stepUp: expect.objectContaining({ method: 'password' }),
        }),
      ]),
    );
  });

  it('cancels the run when the approver rejects it (no step-up to reject)', async () => {
    const id = await start(olivia);
    const task = await startTask(id);
    const a = await stale('adam');
    await a('POST', `/tasks/${task.id}/complete`, { approved: false, comment: 'Not now' });
    const done = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(done.status).toBe('cancelled');
    expect((await auditOf(`runId=${id}&action=run.cancelled`))[0].summary).toMatch(/start was rejected by adam: Not now/);
  });

  it('expires after 24 hours: the run is cancelled and audited', async () => {
    const id = await start(olivia);
    await s.waitRun(id);
    const { expireStartApprovals } = await import('../src/engine/index.js');
    expect(await expireStartApprovals(new Date(Date.now() + 23 * 3_600_000).toISOString())).toBe(0);
    expect(await expireStartApprovals(new Date(Date.now() + 25 * 3_600_000).toISOString())).toBeGreaterThanOrEqual(1);
    expect((await s.waitRun(id, ['cancelled', 'succeeded', 'failed'])).status).toBe('cancelled');
    expect((await auditOf(`runId=${id}&action=run.start_approval_expired`))[0]).toMatchObject({ actor: 'system' });
    expect((await startTask(id)).status).toBe('cancelled');
  });

  it('survives a restart: the decision resumes the run from its record', async () => {
    const id = await start(olivia);
    await s.waitRun(id);
    const { forgetRunForTests } = await import('../src/engine/runner.js');
    await forgetRunForTests(id);
    await adam('POST', `/tasks/${(await startTask(id)).id}/complete`, { approved: true });
    expect((await s.waitRun(id, ['succeeded', 'failed', 'cancelled'])).status).toBe('succeeded');
  });

  it('never asks for test runs, which send nothing', async () => {
    const id = await start(olivia, { recorded: true });
    const r = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(r.status).not.toBe('waiting');
    expect(await startTask(id)).toBeUndefined();
  });

  it('waits the same way for scheduled and triggered runs: neither the owner nor the person who ran it now approves', async () => {
    const sched = await olivia('POST', '/schedules', {
      name: 'Privileged nightly',
      processId: proc,
      cron: '0 3 * * *',
      bindings: { api: p.id },
      identities: { api: priv.id },
      enabled: false,
      allowOverlap: true,
    });
    const { fire } = await import('../src/scheduler.js');
    const fired = (await fire(sched.id))!;
    expect((await s.waitRun(fired)).status).toBe('waiting');
    expect((await startTask(fired)).startApproval.requesters).toEqual(['olivia']);
    // "Run now" by the administrator: the administrator and the owner asked
    const now = (await s.api('POST', `/schedules/${sched.id}/run`)).id;
    const t = await startTask(now);
    expect(t.startApproval.requesters.sort()).toEqual(['admin', 'olivia']);
    expect((await s.api('GET', `/tasks/${t.id}`)).cannotDecideCode).toBe('FOUR_EYES_START');
    expect((await olivia('GET', `/tasks/${t.id}`)).cannotDecideCode).toBe('FOUR_EYES_START');
    expect((await adam('GET', `/tasks/${t.id}`)).canDecide).toBe(true);
    for (const r of [fired, now]) await s.api('POST', `/runs/${r}/cancel`, {});
    const trig = await olivia('POST', '/triggers', { name: 'Privileged hook', processId: proc, bindings: { api: p.id }, identities: { api: priv.id } });
    const res = await fetch(`${s.base}/api/hooks/${trig.trigger.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trig.secret}` },
      body: '{}',
    });
    const hooked = ((await res.json()) as any).runId as string;
    expect((await s.waitRun(hooked)).status).toBe('waiting');
    expect((await startTask(hooked)).startApproval.requesters).toEqual(['olivia']);
    await s.api('POST', `/runs/${hooked}/cancel`, {});
    await olivia('DELETE', `/schedules/${sched.id}`);
    await olivia('DELETE', `/triggers/${trig.trigger.id}`);
  });

  it('reads the flag when the run resolves its connection: a run that started before it was set does not wait mid-way', async () => {
    const plain = await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Later privileged' });
    await s.api('PUT', `/platforms/${p.id}/identities/${plain.id}/secrets`, { apiKey: 'later-key-123456' });
    await s.api('PUT', `/platforms/${p.id}/identities/${plain.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    const waits = await process('Asks first', {
      privilegedFourEyes: true,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ok', type: 'userTask', mode: 'approve', title: 'Go on?', x: 1, y: 0 },
        { id: 'read', type: 'http', connection: 'api', method: 'GET', path: '/users', x: 2, y: 0 },
      ],
      wires: [
        { from: 'start', port: 'out', to: 'ok' },
        { from: 'ok', port: 'approved', to: 'read' },
      ],
    });
    const id = (await olivia('POST', '/runs', { processId: waits, bindings: { api: p.id }, identities: { api: plain.id } })).id;
    expect((await s.waitRun(id)).status).toBe('waiting');
    await s.api('PUT', `/platforms/${p.id}/identities/${plain.id}`, { privileged: true });
    const { forgetRunForTests } = await import('../src/engine/runner.js');
    await forgetRunForTests(id);
    const ask = (await s.api('GET', `/runs/${id}`)).tasks.find((t: any) => t.stepKey === 'ok');
    await adam('POST', `/tasks/${ask.id}/complete`, { approved: true });
    const done = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(done.status).toBe('succeeded');
    expect(await startTask(id)).toBeUndefined();
    // the record keeps what was resolved at the start
    expect(done.bindings.api.privileged).toBeUndefined();
    // a new run reads it now: it waits
    const next = (await olivia('POST', '/runs', { processId: waits, bindings: { api: p.id }, identities: { api: plain.id } })).id;
    expect((await startTask(next))?.startApproval).toBeTruthy();
    await s.api('POST', `/runs/${next}/cancel`, {});
  });

  it('a sub-process of an approved run does not ask again', async () => {
    const child = await process('Privileged child', { privilegedFourEyes: true });
    const parent = (
      await s.api('POST', '/processes', {
        definition: {
          name: 'Privileged parent',
          privilegedFourEyes: true,
          connections: [{ slot: 'api' }],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'sub', type: 'subprocess', process: child, x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'sub' }],
        },
      })
    ).id;
    const id = (await olivia('POST', '/runs', { processId: parent, bindings: { api: p.id }, identities: { api: priv.id } })).id;
    await adam('POST', `/tasks/${(await startTask(id)).id}/complete`, { approved: true });
    expect((await s.waitRun(id, ['succeeded', 'failed', 'cancelled'])).status).toBe('succeeded');
    const kids = (await s.api('GET', `/runs/${id}`)).children;
    expect(kids).toHaveLength(1);
    expect(await startTask(kids[0].id)).toBeUndefined();
  });

  it('names the identity and marks it privileged in the run report (PDF and HTML)', async () => {
    const id = await start(olivia);
    await adam('POST', `/tasks/${(await startTask(id)).id}/complete`, { approved: true });
    await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    const { generateRunReport } = await import('../src/reports/service.js');
    const en = (await generateRunReport(id, { lang: 'en', actor: 'admin', timeZone: 'UTC' })).texts.join('\n');
    expect(en).toContain('Identity');
    expect(en).toContain('Admin (privileged)');
    expect(en).toContain('Start with a privileged identity');
    const de = (await generateRunReport(id, { lang: 'de', actor: 'admin', timeZone: 'UTC' })).texts.join('\n');
    expect(de).toContain('Admin (privilegiert)');
    const html = await s.api('GET', `/runs/${id}/report.html`);
    expect(html).toContain('<strong>(privileged)</strong>');
  });
});

describe('MCP with a privileged identity', () => {
  it('never reads with it; changing calls need a second person, who confirms in Steward – never in Teams', async () => {
    const p = await platform('Directory MCP privileged');
    const priv = await privileged(p, 'Admin', 'priv-key-mcp');
    // the approver may use the platform (a second person must be allowed to use the identity)
    await s.api('PUT', `/platforms/${p.id}/access`, {
      acl: ['olivia', 'adam'].map((u) => ({ subject: `user:${u}`, permissions: ['use'] })),
    });
    await s.api('PUT', `/platforms/${p.id}/identities/${priv.id}/mcp`, { mode: 'writes', writes: 'fourEyes' });
    const token = (await olivia('POST', '/me/tokens', { name: 'mcp privileged', scope: 'mcp' })).token;
    let n = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { isError: !!body.result?.isError, data: body.result?.isError ? body.result.content[0].text : body.result?.structuredContent };
    };
    const listed = (await call('list_platforms', {})).data.items.find((x: any) => x.id === p.id);
    expect(listed.mcpIdentities).toEqual([expect.objectContaining({ name: 'Admin', privileged: true, mode: 'writes (fourEyes)' })]);
    const before = seen.length;
    const read = await call('platform_call_operation', { platformId: p.id, identity: 'Admin', operation: 'listUsers' });
    expect(read.isError).toBe(true);
    expect(read.data).toMatch(/privileged/);
    expect(seen.length).toBe(before);
    expect((await auditOf(`entityId=${p.id}&action=mcp.gateway_refused`))[0].details).toMatchObject({ outcome: 'privileged_refused', privileged: true });
    const found = (await call('platform_find_operations', { platformId: p.id, identity: 'Admin' })).data.items.map((o: any) => o.method);
    expect(found.length).toBeGreaterThan(0);
    expect(found).not.toContain('GET');
    const asked = await call('platform_call_operation', {
      platformId: p.id,
      identity: 'Admin',
      operation: 'deleteUser',
      pathParams: { id: '7' },
      reason: 'Remove the departed account',
    });
    expect(asked.isError).toBe(false);
    const requestId = asked.data.requestId;
    const r = await adam('GET', `/mcp-requests/${requestId}`);
    expect(r).toMatchObject({ mode: 'fourEyes', privileged: true, identityName: 'Admin', canApprove: true });
    // the token owner never approves it
    expect((await olivia('GET', `/mcp-requests/${requestId}`)).canApprove).toBe(false);
    // Teams cannot show a step-up: the card sends the approver to Steward
    const { teamsDecidable } = await import('../src/msteams/decide.js');
    const { findUserByName } = await import('../src/auth/users.js');
    expect(teamsDecidable(findUserByName('adam')!, 'mcp_request', requestId, { fresh: true })).toEqual({ ok: false, reason: 'needsSteward' });
    const a = await stale('adam');
    expect(await refusal(a('POST', `/mcp-requests/${requestId}/decision`, { approve: true }))).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      stepUp: { action: 'usePrivilegedIdentity' },
    });
    await a('POST', '/auth/step-up', { password: PW });
    const done = await a('POST', `/mcp-requests/${requestId}/decision`, { approve: true, comment: 'Checked' });
    expect(done.status).toBe('done');
    expect([...seen].reverse().find((x) => x.method === 'DELETE')?.key).toBe('priv-key-mcp');
    const approved = (await auditOf(`entityId=${requestId}&action=mcp.request_approved`))[0];
    expect(approved.details.assurance).toEqual(
      expect.arrayContaining([expect.objectContaining({ point: 'platform.privilegedIdentity', stepUp: expect.objectContaining({ method: 'password' }) })]),
    );
  });
});

describe('monitors', () => {
  it('never use a privileged identity: refused when saved, and at use', async () => {
    const p = await platform('Directory monitored privileged');
    const priv = await privileged(p, 'Admin', 'priv-key-monitor', ['admin']);
    const check = { id: 'users', name: 'Users', type: 'platform', platform: p.id, identity: 'Admin', method: 'GET', path: '/users' };
    expect(await refusal(s.api('POST', '/monitors', { definition: { name: 'Privileged monitor', checks: [check] } }))).toMatchObject({
      status: 400,
      code: 'IDENTITY_PRIVILEGED_BACKGROUND',
    });
    const { ownerProblem, clearPlatformAccessCache } = await import('../src/monitors/platforms.js');
    clearPlatformAccessCache();
    expect(ownerProblem('admin', p.id, priv.id)).toMatch(/privileged/);
  });
});

describe('the credentials register', () => {
  it('links an entry to an identity, counts it on the identity, and records a rotation of its credentials', async () => {
    const p = await platform('Directory register');
    const priv = await privileged(p, 'Admin', 'priv-key-register-1');
    const other = await platform('Directory register other');
    expect((await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.id === priv.id).registerEntries).toBe(0);
    // an identity of another platform is refused
    expect(
      await refusal(s.api('POST', '/credentials', { name: 'Directory admin key', type: 'token', platformId: other.id, identityId: priv.id })),
    ).toMatchObject({ status: 400, code: 'CREDENTIAL_IDENTITY' });
    const entry = await s.api('POST', '/credentials', {
      name: 'Directory admin key',
      type: 'token',
      platformId: p.id,
      identityId: priv.id,
      rotationIntervalDays: 90,
      lastRotatedAt: '2026-01-01',
    });
    expect(entry).toMatchObject({ identityId: priv.id, identityName: 'Admin', identityPrivileged: true });
    expect((await s.api('GET', `/credentials?identity=${priv.id}`)).items.map((c: any) => c.id)).toEqual([entry.id]);
    expect((await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.id === priv.id).registerEntries).toBe(1);
    // without "This is a rotation": nothing recorded
    await s.api('PUT', `/platforms/${p.id}/identities/${priv.id}/secrets`, { apiKey: 'priv-key-register-2' });
    expect((await s.api('GET', `/credentials/${entry.id}`)).lastRotatedAt).toBe('2026-01-01T00:00:00.000Z');
    // with it: the date, a history event and credential.rotated with the identity – never the secret
    await s.api('PUT', `/platforms/${p.id}/identities/${priv.id}/secrets?rotation=1`, { apiKey: 'priv-key-register-3' });
    const after = await s.api('GET', `/credentials/${entry.id}`);
    expect(Date.now() - Date.parse(after.lastRotatedAt)).toBeLessThan(60_000);
    const rotated = (await auditOf(`entityId=${entry.id}&action=credential.rotated`))[0];
    expect(rotated.details).toMatchObject({ identityId: priv.id, identityName: 'Admin', source: 'identity' });
    expect(JSON.stringify(rotated)).not.toContain('priv-key-register');
    // only removing a credential is no rotation
    const n = (await auditOf(`entityId=${entry.id}&action=credential.rotated`)).length;
    await s.api('PUT', `/platforms/${p.id}/identities/${priv.id}/secrets?rotation=1`, { extra: 'x' });
    await s.api('PUT', `/platforms/${p.id}/identities/${priv.id}/secrets?rotation=1`, { extra: null });
    expect((await auditOf(`entityId=${entry.id}&action=credential.rotated`)).length).toBe(n + 1);
    // another platform drops a kept identity; naming none removes the link
    const moved = await s.api('PUT', `/credentials/${entry.id}`, {
      name: 'Directory admin key',
      type: 'token',
      platformId: other.id,
      version: after.version + 1,
    });
    expect(moved.identityId).toBeNull();
  });
});

describe('the assurance policy', () => {
  it('lists the process setting as an override, and can require a second person for every privileged run', async () => {
    const p = await platform('Directory policy');
    const priv = await privileged(p, 'Admin', 'priv-key-policy');
    const own = await process('Asks itself', { privilegedFourEyes: true });
    const plain = await process('Asks nothing');
    const view = await s.api('GET', '/assurance/policy');
    expect(view.rules['platform.privilegedIdentity']).toMatchObject({ instance: { fourEyes: 'off', stepUp: true } });
    expect(view.overrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ point: 'platform.privilegedIdentity', kind: 'process', label: 'Asks itself', value: 'privilegedFourEyes' }),
      ]),
    );
    expect(own).toBeTruthy();
    // without the policy: a process without the setting does not wait
    const free = await s.waitRun((await olivia('POST', '/runs', { processId: plain, bindings: { api: p.id }, identities: { api: priv.id } })).id);
    expect(free.status).toBe('succeeded');
    // required by the policy (a tightening applies at once): every privileged run waits
    await s.api('PUT', '/assurance/policy', { points: { 'platform.privilegedIdentity': { fourEyes: 'required' } } });
    const id = (await olivia('POST', '/runs', { processId: plain, bindings: { api: p.id }, identities: { api: priv.id } })).id;
    expect((await s.waitRun(id)).status).toBe('waiting');
    expect((await startTask(id)).startApproval.reason).toBe('policy');
    // the default identity still asks nothing
    expect((await s.waitRun((await olivia('POST', '/runs', { processId: plain, bindings: { api: p.id } })).id)).status).toBe('succeeded');
    await s.api('POST', `/runs/${id}/cancel`, {});
  });
});
