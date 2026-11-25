import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Access changes of user groups, and the services, applications and systems a change is for (links of the entry):
 * the manual form's API, the process step and the reconciliation, which never matches groups against accounts.
 */

// the server reads its configuration when its modules load: demo mode first, the modules of the server afterwards
process.env.SM_DEMO = '1';

let s: TestServer;
let olivia: Client;
let hub: string;
let svc = '';
let app = '';
let sys = '';
let hiddenSys = '';
const PW = 'Demo-password-1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: { body?: { code?: string }; message?: string }) => e.body?.code ?? e.message ?? 'error',
  );

const entry = (over: Record<string, unknown> = {}) => ({
  platformId: hub,
  subjectId: 'mdsp_usergroup:Operators',
  subjectName: 'Operators',
  subjectType: 'group',
  kind: 'modify',
  rightsBefore: ['mdsp:core:StandardUser'],
  rightsAfter: ['mdsp:core:StandardUser', 'mdsp:core:Admin'],
  reason: 'The group runs the new line',
  performedBy: 'olivia',
  performedAt: new Date().toISOString(),
  document: true,
  ...over,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  svc = (await s.api('POST', '/services', { name: 'Invented intake service', owners: [] })).id;
  app = (await s.api('POST', '/applications', { name: 'Invented intake portal', owners: [] })).id;
  sys = (await s.api('POST', '/systems', { name: 'Invented intake database', kind: 'server', owners: [] })).id;
  // a system only the members of a team see: Olivia is no member
  const team = await s.api('POST', '/teams', { name: 'Invented back office', members: ['dana'] });
  hiddenSys = (await s.api('POST', '/systems', { name: 'Invented payroll database', kind: 'server', owners: [] })).id;
  await s.api('PUT', `/owning-teams/system/${hiddenSys}`, { teamIds: [team.id] });
}, 120_000);

describe('access change of a user group', () => {
  it('is documented like any entry: the type is kept and the rights are the group’s', async () => {
    const a = await olivia('POST', '/compliance/access-changes', entry());
    expect(a).toMatchObject({ status: 'documented', subjectType: 'group', granted: ['mdsp:core:Admin'], revoked: [], origin: 'manual' });
    expect((await olivia('GET', `/compliance/access-changes/${a.number}`)).subjectType).toBe('group');
  });

  it('refuses an unknown subject type', async () => {
    expect(await errorCode(olivia('POST', '/compliance/access-changes', entry({ subjectType: 'team' })))).toBeTruthy();
  });
});

describe('services, applications and systems of an access change', () => {
  it('are ordinary links of the entry', async () => {
    const a = await olivia('POST', '/compliance/access-changes', entry({ services: [svc], applications: [app], systems: [sys, sys] }));
    const rec = await olivia('GET', `/records/${a.recordId}`);
    const linked = rec.links.filter((l: any) => l.note === 'for').map((l: any) => `${l.kind}:${l.targetId}`);
    expect(linked.sort()).toEqual([`application:${app}`, `service:${svc}`, `system:${sys}`].sort());
    expect(rec.links.some((l: any) => l.kind === 'platform' && l.targetId === hub)).toBe(true);
    // the entry is a backlink of the service
    expect((await s.api('GET', `/backlinks?kind=service&id=${svc}`)).map((x: any) => x.id)).toContain(a.recordId);
  });

  it('are refused as a whole when the creator may not see one (and nothing is created)', async () => {
    const before = (await s.api('GET', `/compliance/access-changes?platformId=${hub}&limit=5000`)).length;
    expect(await errorCode(olivia('POST', '/compliance/access-changes', entry({ systems: [sys, hiddenSys] })))).toBe('LINK_TARGET_NOT_FOUND');
    expect(await errorCode(olivia('POST', '/compliance/access-changes', entry({ services: ['svc_does_not_exist'] })))).toBe('LINK_TARGET_NOT_FOUND');
    expect((await s.api('GET', `/compliance/access-changes?platformId=${hub}&limit=5000`)).length).toBe(before);
    // an administrator sees it
    const a = await s.api('POST', '/compliance/access-changes', entry({ systems: [hiddenSys] }));
    expect((await s.api('GET', `/records/${a.recordId}`)).links.some((l: any) => l.kind === 'system' && l.targetId === hiddenSys)).toBe(true);
  });
});

describe('the reconciliation and entries of a group', () => {
  it('a group entry neither explains nor hides a finding of an account with the same name', async () => {
    const { documentedEntries } = await import('../src/compliance/access-changes.js');
    const { asSystem } = await import('../src/compliance/access-changes.js');
    const now = Date.now();
    const found = asSystem(() => documentedEntries(hub, now - 3_600_000, now + 3_600_000));
    expect(found.some((e) => e.subjectType === 'group')).toBe(false);
    // an entry of an account on the same platform in the same window still counts
    await olivia('POST', '/compliance/access-changes', entry({ subjectType: 'user', subjectId: 'account@example.com', subjectName: 'Account' }));
    const after = asSystem(() => documentedEntries(hub, now - 3_600_000, now + 3_600_000));
    expect(after.map((e) => e.subjectId)).toContain('account@example.com');
    expect(after.some((e) => e.subjectType === 'group')).toBe(false);
  });
});

describe('the step "Document access change"', () => {
  const proc = (extra: Record<string, unknown>) => ({
    name: 'Change a group (test)',
    connections: [{ slot: 'hub', kind: 'insights-hub' }],
    steps: [
      { id: 'vars', type: 'set', values: { serviceId: svc } },
      {
        id: 'doc',
        type: 'accessChange',
        connection: 'hub',
        kind: 'grant',
        subjectId: "'mdsp_usergroup:Engineers'",
        subjectName: "'Engineers'",
        rights: "['mdsp:core:Admin']",
        reason: 'Project Phoenix',
        ...extra,
      },
    ],
  });
  const run = async (definition: unknown, dryRun = false) => {
    const p = await s.api('POST', '/processes', { definition });
    const r = await s.api('POST', '/runs', { processId: p.id, bindings: { hub }, dryRun });
    return s.waitRun(r.id, ['succeeded', 'failed']);
  };
  const entriesOf = async (runId: string) => {
    let found: any[] = [];
    for (let i = 0; i < 100 && !found.length; i++) {
      found = (await s.api('GET', `/compliance/access-changes?platformId=${hub}`)).filter((e: any) => e.runId === runId);
      await sleep(100);
    }
    return found;
  };

  it('writes the subject type and the links, and skips an unknown id with a warning', async () => {
    const r = await run(
      proc({ subjectType: 'group', services: ['{{ vars.serviceId }}', 'svc_unknown'], applications: [app], systems: [`{{ ['${sys}', '${hiddenSys}'] }}`] }),
    );
    expect(r.status).toBe('succeeded');
    expect(JSON.stringify(r.logs)).toContain('svc_unknown');
    const [e] = await entriesOf(r.id);
    expect(e).toMatchObject({ subjectType: 'group', origin: 'run', granted: ['mdsp:core:Admin'] });
    const rec = await s.api('GET', `/records/${e.recordId}`);
    const linked = rec.links.filter((l: any) => l.note === 'for').map((l: any) => `${l.kind}:${l.targetId}`);
    expect(linked).toEqual(expect.arrayContaining([`service:${svc}`, `application:${app}`, `system:${sys}`]));
    expect(linked).not.toContain('service:svc_unknown');
  });

  it('keeps today’s behaviour without the new fields: no subject type, no links but run and platform', async () => {
    const r = await run(proc({}));
    const [e] = await entriesOf(r.id);
    expect(e.subjectType).toBe('');
    const rec = await s.api('GET', `/records/${e.recordId}`);
    expect(rec.links.map((l: any) => l.kind).sort()).toEqual(['platform', 'run']);
  });

  it('rejects an unknown subject type in the definition', async () => {
    expect(await errorCode(s.api('POST', '/processes', { definition: proc({ subjectType: 'team' }) }))).toBeTruthy();
  });

  const linkedOf = async (runId: string) => {
    const [e] = await entriesOf(runId);
    const rec = await s.api('GET', `/records/${e.recordId}`);
    return rec.links.filter((l: any) => l.note === 'for').map((l: any) => `${l.kind}:${l.targetId}`);
  };
  const runAsClient = async (c: Client, definition: unknown) => {
    const p = await s.api('POST', '/processes', { definition });
    const r = await c('POST', '/runs', { processId: p.id, bindings: { hub } });
    return s.waitRun(r.id, ['succeeded', 'failed']);
  };

  it('links nothing of a team’s system when the person who started the run is no member (warning logged)', async () => {
    const r = await runAsClient(olivia, proc({ systems: [sys, hiddenSys] }));
    expect(r.status).toBe('succeeded');
    expect(JSON.stringify(r.logs)).toContain(hiddenSys);
    const linked = await linkedOf(r.id);
    expect(linked).toContain(`system:${sys}`);
    expect(linked).not.toContain(`system:${hiddenSys}`);
  });

  it('links it when an administrator started the run', async () => {
    const r = await run(proc({ systems: [sys, hiddenSys] }));
    expect(await linkedOf(r.id)).toEqual(expect.arrayContaining([`system:${sys}`, `system:${hiddenSys}`]));
  });

  it('an unattended run follows the author of its process version; without any person nothing is linked', async () => {
    const p = await s.api('POST', '/processes', { definition: proc({}) });
    const r = await s.api('POST', '/runs', { processId: p.id, bindings: { hub } });
    await s.waitRun(r.id, ['succeeded', 'failed']);
    expect((await import('../src/compliance/run-entries.js')).linkActor(r.id)?.username).toBe('admin');
    (await import('../src/db.js')).db().run("UPDATE runs SET actor = 'system' WHERE id = ?", r.id);
    expect((await import('../src/compliance/run-entries.js')).linkActor(r.id)?.username).toBe('admin');
    (await import('../src/db.js')).db().run("UPDATE process_versions SET author = 'nobody-here' WHERE process_id = ?", p.id);
    expect((await import('../src/compliance/run-entries.js')).linkActor(r.id)).toBeNull();
    (await import('../src/db.js')).db().run("UPDATE process_versions SET author = 'olivia' WHERE process_id = ?", p.id);
    expect((await import('../src/compliance/run-entries.js')).linkActor(r.id)?.username).toBe('olivia');
  });

  it('drops links above the limit of an entry and says so in the run log', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 199; i++) ids.push((await s.api('POST', '/systems', { name: `Invented cap system ${i}`, kind: 'server', owners: [] })).id);
    const chunk = (n: number) => ids.slice(n * 50, n * 50 + 50);
    const step = (n: number) => ({ ...proc({ systems: chunk(n) }).steps[1], id: `doc${n}` });
    const def = { ...proc({}), steps: [0, 1, 2, 3].map(step) };
    const r = await run(def);
    expect(r.status).toBe('succeeded');
    const [e] = await entriesOf(r.id);
    expect(e).toBeTruthy();
    const linked = await linkedOf(r.id);
    expect(linked).toHaveLength(198);
    const log = (await s.api('GET', `/runs/${r.id}`)).logs.map((l: any) => l.message).join('\n');
    expect(log).toMatch(/1 link\(s\) of the access change .* were dropped/);
  }, 120_000);
});
