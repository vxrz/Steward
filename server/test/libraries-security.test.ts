import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { EXCEPTION_TYPE, NOTIFY_OWNER, signedRelease, testKey, uploadBody, type LibrarySpec, type TestKey } from './library-helpers.js';

/**
 * Regressions of the 0.10.0 security review of shared libraries (ADR 0014):
 *  1. a Hold ends only by lifting it – not by uninstalling the library, not by switching its paused items on again;
 *  2. four-eyes: the approver sees the stored decisions, approves exactly those (hash) with their own rights;
 *  3. "what it can do" counts writes by method, whatever `mutating` says, and shows `mutating: false` separately;
 *  4. an expired key stops installs and updates (a rollback to the release installed before stays possible);
 *  5. the review shows a connector type's HTTP settings and a monitor's outputs.
 */

let s: TestServer;
let dana: Client;
let graphId = '';
let n = 0;

const fail = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: '', context: '' }),
    (e: { status: number; body?: { code?: string; params?: { context?: string } } }) => ({
      status: e.status,
      code: e.body?.code ?? '',
      context: e.body?.params?.context ?? '',
    }),
  );

/** A publisher of its own per test, so the tests do not depend on each other. */
async function publisher(): Promise<{ id: string; key: TestKey; keyId: string }> {
  const id = `sec-pub-${n++}`;
  const key = testKey();
  await s.api('POST', '/library-publishers', { id, name: `Publisher ${id}` });
  const k = (await s.api('POST', `/library-publishers/${id}/keys`, { key: key.line })) as { id: string };
  return { id, key, keyId: k.id };
}
const upload = async (c: Client, key: TestKey, spec: LibrarySpec) =>
  (await c('POST', '/library-releases/upload', await uploadBody(await signedRelease(key, spec)))) as { id: string };
const proc = (id: string) => NOTIFY_OWNER.replace('id: notify-owner', `id: ${id}`).replace('Notify the owner (library)', `Process ${id}`);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', 'Demo-password-1');
  graphId = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'microsoft-graph')!.id;
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('1. a Hold ends only by lifting it', () => {
  it('refuses uninstalling a held library and switching its paused schedules, triggers and monitors on again', async () => {
    const p = await publisher();
    const monitor = `kind: monitor
key: held-monitor
name: Held monitor
intervalSeconds: 3600
checks:
  - id: c
    name: Secrets
    type: entra
    platform: idp
    mode: app-credentials
    withinDays: 30
`;
    const rel = await upload(dana, p.key, {
      library: 'held-library',
      publisher: p.id,
      items: { 'processes/held.yaml': proc('held-proc'), 'monitors/m.yaml': monitor },
    });
    await dana('POST', `/library-releases/${rel.id}/install`, { platforms: { idp: graphId } });
    const mons = (await s.api('GET', '/monitors')) as any;
    const mon = (mons.items ?? mons).find((m: { key: string }) => m.key === 'held-monitor');
    await dana('POST', `/monitors/${mon.id}/enabled`, { enabled: true });
    const sched = (await dana('POST', '/schedules', { name: 'Held schedule', processId: 'held-proc', cron: '0 3 * * *', enabled: true })) as { id: string };
    await s.api('POST', '/libraries/held-library/hold', { held: true, reason: 'suspect' });
    // the designer can neither end the hold by uninstalling …
    const un = await fail(dana('POST', '/libraries/held-library/uninstall', {}));
    expect(un).toMatchObject({ status: 409, code: 'LIBRARY_HELD', context: 'uninstall' });
    // … nor switch on again what it paused
    expect(await fail(dana('POST', `/monitors/${mon.id}/enabled`, { enabled: true }))).toMatchObject({ status: 409, code: 'LIBRARY_HELD', context: 'resume' });
    expect(
      await fail(dana('PUT', `/schedules/${sched.id}`, { name: 'Held schedule', processId: 'held-proc', cron: '0 3 * * *', enabled: true })),
    ).toMatchObject({
      code: 'LIBRARY_HELD',
    });
    expect(await fail(dana('POST', '/schedules', { name: 'New schedule while held', processId: 'held-proc', cron: '0 4 * * *', enabled: true }))).toMatchObject(
      { code: 'LIBRARY_HELD' },
    );
    expect(await fail(dana('POST', '/triggers', { name: 'Held trigger', processId: 'held-proc', enabled: true, authMode: 'hmac' }))).toMatchObject({
      code: 'LIBRARY_HELD',
    });
    // an administrator, too, lifts the hold first – audited, and it turns on exactly what it paused
    expect((await fail(s.api('POST', '/libraries/held-library/uninstall', {}))).code).toBe('LIBRARY_HELD');
    await s.api('POST', '/libraries/held-library/hold', { held: false });
    expect(((await s.api('GET', `/monitors/${mon.id}`)) as { enabled: boolean }).enabled).toBe(true);
    expect(((await s.api('GET', '/audit?action=library.hold_lifted&limit=1')) as unknown[]).length).toBe(1);
    await dana('POST', '/libraries/held-library/uninstall', {});
    await s.api('DELETE', `/schedules/${sched.id}`);
  });
});

describe('3. what it can do', () => {
  it('counts writes by method and shows steps marked as not changing anything', async () => {
    const p = await publisher();
    const quiet = `id: quiet-delete
name: Quiet delete
connections:
  - slot: graph
    kind: microsoft-graph
steps:
  - id: del
    type: http
    name: Remove
    connection: graph
    method: DELETE
    path: /v1.0/users/x
    mutating: false
  - id: post
    type: http
    name: Post
    connection: graph
    method: POST
    path: /v1.0/x
  - id: read
    type: http
    name: Read
    connection: graph
    method: GET
    path: /v1.0/users
  - id: getWrite
    type: http
    name: A GET that changes something
    connection: graph
    method: GET
    path: /v1.0/trigger
    mutating: true
`;
    const rel = await upload(dana, p.key, { library: 'quiet', publisher: p.id, items: { 'processes/q.yaml': quiet }, references: { platforms: [] } });
    const review = (await dana('GET', `/library-releases/${rel.id}/review`)) as any;
    expect(review.items[0].abilities).toMatchObject({ writes: 3, markedNotChanging: 1 });
  });
});

describe('4. an expired key', () => {
  it('stops installs and updates of every release it signed; a rollback to the release installed before stays possible', async () => {
    const p = await publisher();
    const spec = { library: 'expiring', publisher: p.id, items: { 'processes/e.yaml': proc('exp-proc') }, references: { platforms: [] } };
    const r1 = await upload(dana, p.key, spec);
    await dana('POST', `/library-releases/${r1.id}/install`, {});
    const r2 = await upload(dana, p.key, { ...spec, release: '1.1.0', items: { 'processes/e.yaml': proc('exp-proc').replace('done', 'finished') } });
    await dana('POST', `/library-releases/${r2.id}/install`, {});
    const r3 = await upload(dana, p.key, { ...spec, release: '1.2.0', items: { 'processes/e.yaml': proc('exp-proc').replace('done', 'complete') } });
    // the key expires after the release was staged (an earlier date needs no step-up)
    await s.api('PUT', `/library-keys/${p.keyId}`, { expiresAt: '2020-01-01' });
    const review = (await dana('GET', `/library-releases/${r3.id}/review`)) as any;
    expect(review.release.keyState).toBe('expired');
    expect(review.blockers).toContain('expiredKey');
    expect((await fail(dana('POST', `/library-releases/${r3.id}/install`, {}))).code).toBe('LIBRARY_KEY_EXPIRED');
    // new releases are refused at once
    expect((await fail(upload(dana, p.key, { ...spec, release: '1.3.0' }))).code).toBe('LIBRARY_KEY_EXPIRED');
    // a rollback to the release installed before still works
    const prev = (await dana('GET', `/library-releases/${r1.id}/review`)) as any;
    expect(prev.blockers).not.toContain('expiredKey');
    const back = (await dana('POST', '/libraries/expiring/rollback', {})) as any;
    expect(back.library.release.release).toBe('1.0.0');
    // updates signed by the expired key stay refused
    expect((await fail(dana('POST', `/library-releases/${r3.id}/install`, {}))).code).toBe('LIBRARY_KEY_EXPIRED');
  });
});

describe('5. the review shows everything that sends data out', () => {
  it("shows a connector type's HTTP settings and a monitor's outputs", async () => {
    const p = await publisher();
    const connector = JSON.stringify({
      format: 'steward-connector',
      version: 1,
      kind: 'sec-tool',
      label: 'Sec tool',
      baseUrl: 'https://api.tool.example.com',
      config: {
        auth: { type: 'bearer' },
        variables: {},
        http: {
          insecureTls: true,
          caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          proxy: 'https://proxy.example.com:3128',
          defaultHeaders: { 'x-tenant': 'a' },
        },
      },
      secretFields: [{ key: 'token', label: 'Token' }],
    });
    const monitor = `kind: monitor
key: sec-outputs
name: Outputs
intervalSeconds: 3600
checks:
  - id: c
    name: Secrets
    type: entra
    platform: idp
    mode: app-credentials
    withinDays: 30
outputs:
  - id: hook
    type: webhook
    url: https://hooks.example.com/steward
  - id: start
    type: process
    processId: sec-local
    dryRun: false
  - id: tell
    type: notification
    subscribers: [role:admin]
`;
    const rel = await upload(s.api, p.key, { library: 'sec-out', publisher: p.id, items: { 'connectors/tool.json': connector, 'monitors/m.yaml': monitor } });
    const review = (await s.api('GET', `/library-releases/${rel.id}/review`)) as any;
    const c = review.items.find((i: any) => i.kind === 'connector').connector;
    expect(c).toMatchObject({ insecureTls: true, customCa: true, proxy: 'https://proxy.example.com:3128', defaultHeaders: ['x-tenant'] });
    expect(c.http).toMatchObject({ insecureTls: true, proxy: 'https://proxy.example.com:3128' });
    const m = review.items.find((i: any) => i.kind === 'monitor').monitorOutputs;
    expect(m).toMatchObject({ sendsOut: 1, startsProcesses: ['sec-local'], notifications: 1 });
    expect(m.outputs).toEqual(
      expect.arrayContaining([
        { id: 'hook', type: 'webhook', target: 'https://hooks.example.com/steward' },
        { id: 'start', type: 'process', target: 'sec-local', dryRun: false },
      ]),
    );
  });
});

// last: it turns four-eyes on for the rest of the file
describe('2. four-eyes on install', () => {
  it('shows the approver the stored decisions and installs exactly those, with the approver’s rights', async () => {
    const p = await publisher();
    const policy = (await s.api('GET', '/assurance/policy')) as any;
    await s.api('PUT', '/assurance/policy', { points: { ...policy.policy.points, 'library.install': { fourEyes: 'required' } }, mfa: policy.policy.mfa });
    const items = { 'processes/a.yaml': proc('fe-a'), 'processes/b.yaml': proc('fe-b') };
    const rel = await upload(dana, p.key, { library: 'fe-sec', publisher: p.id, items, references: { platforms: [] } });
    const asked = (await dana('POST', `/library-releases/${rel.id}/install`, { skip: ['processes/b.yaml'], comment: 'only a' })) as any;
    expect(asked.status).toBe('requested');
    // the approver's review: the decisions as stored, and what they do per item
    const review = (await s.api('GET', `/library-releases/${rel.id}/review`)) as any;
    expect(review.request).toMatchObject({
      by: 'dana',
      skip: ['processes/b.yaml'],
      keepLocal: [],
      takeLibrary: [],
      comment: 'only a',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.fromEntries(review.items.map((i: any) => [i.path, i.requested]))).toEqual({ 'processes/a.yaml': 'install', 'processes/b.yaml': 'skip' });
    // approving needs the hash of what the approver saw
    expect((await fail(s.api('POST', `/library-releases/${rel.id}/approve`, {}))).code).toBe('LIBRARY_REQUEST_CHANGED');
    expect((await fail(s.api('POST', `/library-releases/${rel.id}/approve`, { hash: '0'.repeat(64) }))).code).toBe('LIBRARY_REQUEST_CHANGED');
    const done = (await s.api('POST', `/library-releases/${rel.id}/approve`, { hash: review.request.hash })) as any;
    expect(done.status).toBe('installed');
    const ids = ((await s.api('GET', '/processes')) as { id: string }[]).map((x) => x.id);
    expect(ids).toContain('fe-a');
    expect(ids).not.toContain('fe-b');
  });

  it('checks the approver’s own right for every item', async () => {
    const p = await publisher();
    // the administrator asks; a designer may not create record types, so the designer cannot approve it
    const rel = await upload(s.api, p.key, {
      library: 'fe-rights',
      publisher: p.id,
      items: { 'processes/r.yaml': proc('fe-r'), 'record-types/x.yaml': EXCEPTION_TYPE.replace('key: AEX', 'key: FER') },
      references: { platforms: [] },
    });
    await s.api('POST', `/library-releases/${rel.id}/install`, {});
    const review = (await dana('GET', `/library-releases/${rel.id}/review`)) as any;
    expect(review.request.by).toBe('admin');
    expect((await fail(dana('POST', `/library-releases/${rel.id}/approve`, { hash: review.request.hash }))).status).toBe(403);
    expect(((await s.api('GET', '/processes')) as { id: string }[]).some((x) => x.id === 'fe-r')).toBe(false);
    await s.api('POST', `/library-releases/${rel.id}/withdraw`, {});
  });
});
