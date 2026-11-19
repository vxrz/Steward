import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The Insights Hub user examples (0.27.0) end to end against the simulated tenant: offboarding (#13) – deleting a user
 * without touching its memberships, removing memberships without the internal OIDC scope groups, failures reported per
 * group –, adding users to several groups (#17) and deactivating and reactivating accounts (#18). The simulated tenant
 * is seeded again before each test (POST /mock/reset), so the tests do not depend on each other.
 */

let s: TestServer;
let adam: Client;
let hub = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const demo = await s.api('POST', '/demo/setup', {});
  adam = await s.as('adam', demo.password);
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub' && p.name.endsWith('(demo)')).id;
});

beforeEach(async () => {
  expect((await fetch(`${s.base}/mock/reset`, { method: 'POST' })).status).toBe(200);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drive a run to its end: open tasks are approved (or rejected) – by Adam where four-eyes keeps the admin out. */
async function finish(runId: string, approved = true): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const r = await s.api('GET', `/runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) return r;
    for (const t of r.tasks.filter((x: any) => x.status === 'open'))
      await (t.canDecide ? s.api : adam)('POST', `/tasks/${t.id}/complete`, { approved, selectedKeys: [], comment: 'automated test' });
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish`);
}
const run = async (processId: string, inputs: Record<string, unknown>, approved = true) =>
  finish((await s.api('POST', '/runs', { processId, bindings: { hub }, inputs })).id, approved);

const idm = (method: string, path: string, body?: unknown) =>
  s.api('POST', `/platforms/${hub}/request`, { method, path: `/api/identitymanagement/v3${path}`, ...(body ? { body } : {}) });
const user = async (userName: string) => (await idm('GET', `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`)).body.resources[0];
/** The writes a run sent to the platform, as "METHOD path → HTTP status" */
const writes = async (runId: string): Promise<string[]> =>
  ((await s.api('GET', `/audit?runId=${runId}&action=api.write&limit=200`)) as any[]).map((e) => e.summary.replace(/ on ".*" → /, ' → ')).reverse();
/** The rows of the run's report, as objects by column label */
const report = (r: any) => {
  const o = r.steps.find((x: any) => x.type === 'report').output;
  const labels = o.columns.map((c: any) => (typeof c === 'string' ? c : c.label));
  return { ...o, rows: o.rows.map((row: unknown[]) => Object.fromEntries(labels.map((l: string, i: number) => [l, row[i]]))) };
};
const step = (r: any, id: string) => r.steps.find((x: any) => x.stepId === id);
const task0 = (r: any) => r.tasks[0];
/** The access changes a run documented for a subject (they are written when the run ends) */
const changes = async (runId: string, subjectName: string, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    const found = ((await s.api('GET', `/compliance/access-changes?platformId=${hub}`)) as any[]).filter(
      (e) => e.subjectName === subjectName && e.runId === runId,
    );
    if (found.length) return found;
    await sleep(200);
  }
  return [];
};

describe('Insights Hub – offboarding (#13)', () => {
  it('lists the internal OIDC scope groups as DIRECT memberships of the leaver; the tenant refuses to remove them', async () => {
    const karla = await user('karla.lang@example.com');
    expect(karla.groups.map((g: any) => `${g.display} ${g.type}`).sort()).toEqual([
      'email DIRECT',
      'mdsp:core:StandardUser DIRECT',
      'mdsp_usergroup:Engineers DIRECT',
      'openid DIRECT',
      'profile DIRECT',
    ]);
    const email = karla.groups.find((g: any) => g.display === 'email');
    const refused = await idm('DELETE', `/Groups/${email.value}/members/${karla.id}`);
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0].message).toContain('cannot be removed from the group email');
  });

  it('mode delete deletes the account directly – no membership is removed first – and keeps the memberships as evidence', async () => {
    const karla = await user('karla.lang@example.com');
    const r = await run('ih-offboard-users', { users: 'karla.lang@example.com\nsomeone.unknown@example.com', mode: 'delete' });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'unknownCheck').status).toBe('failed');
    expect(step(r, 'failuresCheck').status).toBe('succeeded');
    expect(r.steps.some((x: any) => x.stepId === 'removeMembership')).toBe(false);
    // exactly one write: the deletion of the account
    expect(await writes(r.id)).toEqual([`DELETE /api/identitymanagement/v3/Users/${karla.id} → HTTP 200`]);
    expect(await user('karla.lang@example.com')).toBeUndefined();
    // the evidence: the approval listed every membership as it was, the report and the access change keep them
    const task = r.tasks[0];
    expect(task.instructions).toContain('**karla.lang@example.com** – mdsp:core:StandardUser (DIRECT), mdsp_usergroup:Engineers (DIRECT), openid (DIRECT)');
    expect(report(r).rows).toEqual([
      { User: 'someone.unknown@example.com', Group: '–', Result: 'not found', HTTP: '', Message: '' },
      { User: 'karla.lang@example.com', Group: '(account)', Result: 'deleted', HTTP: '200', Message: '' },
    ]);
    const [entry] = await changes(r.id, 'karla.lang@example.com');
    expect(entry).toMatchObject({ kind: 'offboarding', subjectId: karla.id });
    expect(entry.rightsAfter).toEqual([]);
    expect([...entry.rightsBefore].sort()).toEqual(['email', 'mdsp:core:StandardUser', 'mdsp_usergroup:Engineers', 'openid', 'profile']);
  });

  it('mode removeGroupsOnly removes the direct memberships, never the OIDC scope groups, and keeps the account', async () => {
    const karla = await user('karla.lang@example.com');
    const r = await run('ih-offboard-users', { users: 'karla.lang@example.com', mode: 'removeGroupsOnly' });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'failuresCheck').status).toBe('succeeded');
    const groupId = (name: string) => karla.groups.find((g: any) => g.display === name).value;
    expect((await writes(r.id)).sort()).toEqual(
      ['mdsp:core:StandardUser', 'mdsp_usergroup:Engineers']
        .map((g) => `DELETE /api/identitymanagement/v3/Groups/${groupId(g)}/members/${karla.id} → HTTP 200`)
        .sort(),
    );
    const after = await user('karla.lang@example.com');
    expect(after.groups.map((g: any) => g.display).sort()).toEqual(['email', 'openid', 'profile']);
    expect(task0(r).instructions).toContain('remove: mdsp:core:StandardUser, mdsp_usergroup:Engineers; kept: openid (internal scope group)');
    expect(
      report(r)
        .rows.map((x: any) => `${x.Group}: ${x.Result}`)
        .sort(),
    ).toEqual([
      'email (internal scope group): kept (never removed)',
      'mdsp:core:StandardUser: removed',
      'mdsp_usergroup:Engineers: removed',
      'openid (internal scope group): kept (never removed)',
      'profile (internal scope group): kept (never removed)',
    ]);
    // the access change names what was removed, and every membership before
    const [entry] = await changes(r.id, 'karla.lang@example.com');
    expect(entry.kind).toBe('offboarding');
    expect([...entry.rightsBefore].sort()).toEqual(['email', 'mdsp:core:StandardUser', 'mdsp_usergroup:Engineers', 'openid', 'profile']);
    expect([...entry.rightsAfter].sort()).toEqual(['email', 'openid', 'profile']);
  });

  it('a removal the tenant refuses is reported per group and does not stop the others', async () => {
    // without the list of groups never to touch, the scope groups are tried as well – and refused
    const r = await run('ih-offboard-users', { users: 'karla.lang@example.com', mode: 'removeGroupsOnly', neverTouch: [] });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const check = step(r, 'failuresCheck');
    expect(check.status).toBe('failed');
    expect(check.summary).toContain('karla.lang@example.com / email: HTTP 400 – Member ');
    expect(check.summary).toContain('cannot be removed from the group email: it is a default group of the identity zone');
    const rows = Object.fromEntries(report(r).rows.map((x: any) => [x.Group, x]));
    expect(rows['mdsp_usergroup:Engineers']).toMatchObject({ Result: 'removed', HTTP: '200' });
    expect(rows['mdsp:core:StandardUser']).toMatchObject({ Result: 'removed', HTTP: '200' });
    for (const g of ['openid', 'profile', 'email']) expect(rows[g]).toMatchObject({ Result: 'failed', HTTP: '400' });
    // what was removed is documented all the same
    const [entry] = await changes(r.id, 'karla.lang@example.com');
    expect([...entry.rightsAfter].sort()).toEqual(['email', 'openid', 'profile']);
  });

  it('nothing changes when the offboarding is not confirmed', async () => {
    const r = await run('ih-offboard-users', { users: 'karla.lang@example.com', mode: 'delete' }, false);
    expect(r.status).toBe('succeeded');
    expect(await writes(r.id)).toEqual([]);
    expect(report(r).rows).toEqual([{ User: 'karla.lang@example.com', Group: '–', Result: 'not confirmed', HTTP: '', Message: '' }]);
    expect(await user('karla.lang@example.com')).toBeTruthy();
  });
});

describe('Insights Hub – add users to several groups (#17)', () => {
  it('resolves the groups with the building block, skips existing memberships, adds the rest per user × group and documents them', async () => {
    const noah = await user('noah.otto@example.com');
    const greta = await user('greta.hahn@example.com');
    const r = await run('ih-add-to-groups', {
      users: 'Noah.Otto@example.com\ngreta.hahn@example.com\nnobody@example.com',
      groups: 'mdsp_usergroup:Operators\nmdsp_usergroup:Viewers',
    });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'unknownUsers').status).toBe('failed');
    expect(step(r, 'failuresCheck').status).toBe('succeeded');
    // one sub-process run per group (#90)
    expect(r.steps.filter((x: any) => x.stepId === 'resolveGroup')).toHaveLength(2);
    expect(task0(r).instructions).toContain('- **greta.hahn@example.com** → mdsp_usergroup:Operators (already a member), mdsp_usergroup:Viewers');
    const groups = (await idm('GET', '/Groups')).body.resources;
    const id = (name: string) => groups.find((g: any) => g.displayName === name).id;
    // Greta is an operator already: three additions, one POST per user and group
    expect((await writes(r.id)).sort()).toEqual(
      [
        [id('mdsp_usergroup:Operators'), noah.id],
        [id('mdsp_usergroup:Viewers'), noah.id],
        [id('mdsp_usergroup:Viewers'), greta.id],
      ]
        .map(([g]) => `POST /api/identitymanagement/v3/Groups/${g}/members → HTTP 201`)
        .sort(),
    );
    expect((await user('noah.otto@example.com')).groups.map((g: any) => g.display).sort()).toEqual([
      'mdsp:core:StandardUser',
      'mdsp_usergroup:Operators',
      'mdsp_usergroup:Viewers',
    ]);
    expect(report(r).rows.map((x: any) => `${x.User} ${x.Group}: ${x.Result}`)).toEqual([
      'noah.otto@example.com mdsp_usergroup:Operators: added',
      'noah.otto@example.com mdsp_usergroup:Viewers: added',
      'greta.hahn@example.com mdsp_usergroup:Operators: already a member (skipped)',
      'greta.hahn@example.com mdsp_usergroup:Viewers: added',
      'nobody@example.com –: unknown user',
    ]);
    const [noahEntry] = await changes(r.id, 'noah.otto@example.com');
    expect(noahEntry).toMatchObject({ kind: 'grant', subjectId: noah.id });
    expect(noahEntry).toMatchObject({ rightsBefore: ['mdsp:core:StandardUser'], granted: ['mdsp_usergroup:Operators', 'mdsp_usergroup:Viewers'] });
    expect([...noahEntry.rightsAfter].sort()).toEqual(['mdsp:core:StandardUser', 'mdsp_usergroup:Operators', 'mdsp_usergroup:Viewers']);
  });

  it('an unknown group stops the run before anything is added', async () => {
    const r = await run('ih-add-to-groups', { users: 'noah.otto@example.com', groups: 'mdsp_usergroup:Operators\nmdsp_usergroup:NoSuchGroup' });
    expect(r.status).toBe('failed');
    expect(step(r, 'groupsFound').error).toBe('Unknown group(s): mdsp_usergroup:NoSuchGroup');
    expect(r.tasks).toEqual([]);
    expect(await writes(r.id)).toEqual([]);
  });

  it('a membership the tenant refuses is reported per user and group, the others are added', async () => {
    // a user deleted between the plan and the addition: the tenant answers 400 "unknown member" for that one
    const r0 = await s.api('POST', '/runs', {
      processId: 'ih-add-to-groups',
      bindings: { hub },
      inputs: { users: 'noah.otto@example.com\nmia.neumann@example.com', groups: 'mdsp_usergroup:Viewers' },
    });
    let r = await s.waitRun(r0.id, ['waiting', 'succeeded', 'failed']);
    expect(r.status).toBe('waiting');
    await idm('DELETE', `/Users/${(await user('mia.neumann@example.com')).id}`);
    r = await finish(r0.id);
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'failuresCheck').summary).toContain('mia.neumann@example.com → mdsp_usergroup:Viewers: HTTP 400 – {"error":"unknown member"}');
    expect(report(r).rows.map((x: any) => `${x.User}: ${x.Result}`)).toEqual(['noah.otto@example.com: added', 'mia.neumann@example.com: failed']);
  });
});

describe('Insights Hub – deactivate and reactivate (#18)', () => {
  it('deactivates with PUT /Users/{id} (active false, the rest as it was), reads it back, keeps the memberships; reactivates', async () => {
    const before = await user('karla.lang@example.com');
    const r = await run('ih-deactivate-users', { users: 'karla.lang@example.com\nsomeone.unknown@example.com', action: 'deactivate' });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'failuresCheck').status).toBe('succeeded');
    expect(await writes(r.id)).toEqual([`PUT /api/identitymanagement/v3/Users/${before.id} → HTTP 200`]);
    // the tenant takes a PUT only with userName, name and emails (the mock refuses one without them or with another userName)
    const after = await user('karla.lang@example.com');
    expect(after).toMatchObject({ active: false, userName: before.userName, name: before.name, emails: before.emails });
    expect(after.groups).toEqual(before.groups);
    expect(report(r).rows).toEqual([
      {
        User: 'karla.lang@example.com',
        Before: 'active',
        Result: 'deactivated',
        HTTP: '200',
        Message: '',
        'Memberships (kept)': 'mdsp:core:StandardUser, mdsp_usergroup:Engineers, openid, profile, email',
      },
      { User: 'someone.unknown@example.com', Before: '–', Result: 'not found', HTTP: '', Message: '', 'Memberships (kept)': '' },
    ]);
    const [entry] = await changes(r.id, 'karla.lang@example.com');
    expect(entry).toMatchObject({ kind: 'modify', subjectId: before.id });

    // a second deactivation finds nothing to do: no approval, no request
    const again = await run('ih-deactivate-users', { users: 'karla.lang@example.com', action: 'deactivate' });
    expect(again.tasks).toEqual([]);
    expect(await writes(again.id)).toEqual([]);
    expect(report(again).rows[0]).toMatchObject({ Before: 'deactivated', Result: 'already deactivated' });

    // reactivation: active again, with the same memberships
    const back = await run('ih-deactivate-users', { users: 'karla.lang@example.com', action: 'reactivate' });
    expect(step(back, 'failuresCheck').status).toBe('succeeded');
    expect(report(back).rows[0]).toMatchObject({ Before: 'deactivated', Result: 'reactivated' });
    expect(await user('karla.lang@example.com')).toMatchObject({ active: true, groups: before.groups });
  });

  it('a request the tenant refuses is reported with its message', async () => {
    // the account is deleted after the approval was asked for: the PUT answers 404
    const r0 = await s.api('POST', '/runs', { processId: 'ih-deactivate-users', bindings: { hub }, inputs: { users: 'mia.neumann@example.com' } });
    expect((await s.waitRun(r0.id, ['waiting', 'succeeded', 'failed'])).status).toBe('waiting');
    await idm('DELETE', `/Users/${(await user('mia.neumann@example.com')).id}`);
    const r = await finish(r0.id);
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'failuresCheck').summary).toContain('mia.neumann@example.com: HTTP 404 – failed – User not found');
    expect(await changes(r.id, 'mia.neumann@example.com', 3)).toEqual([]);
  });
});
