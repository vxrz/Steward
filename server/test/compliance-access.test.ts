import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Access governance: access change entries (a record type), automatic entries from runs and the
 * access reconciliation (snapshots, undocumented changes, documenting after the fact).
 */

let s: TestServer;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
let hub: string;
let check: any;
const PW = 'Demo-password-1';
const IDM = '/api/identitymanagement/v3';

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A call to the simulated Insights Hub through the platform (as the admin) – i.e. a change outside any process. */
const idm = (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  s.api('POST', `/platforms/${hub}/request`, { method, path: `${IDM}${path}`, ...(body ? { body } : {}), ...(query ? { query } : {}) });
async function userByName(userName: string): Promise<any> {
  return (await idm('GET', '/Users', undefined, { filter: `userName eq "${userName}"` })).body.resources[0];
}
async function groupByName(name: string): Promise<any> {
  return (await idm('GET', '/Groups', undefined, { filter: `displayName eq "${name}"` })).body.resources[0];
}
const runCheck = (c: Client = s.api) => c('POST', `/compliance/access-checks/${check.id}/run`, {});
const openFindings = async () => (await s.api('GET', `/compliance/findings?checkId=${check.id}&status=open`)) as any[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  check = (await s.api('GET', '/compliance/access-checks')).find((c: any) => c.platformId === hub);
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('access change entries', () => {
  it('are a built-in record type with the access workflow', async () => {
    const types = await vera('GET', '/record-types');
    const ac = types.find((t: any) => t.key === 'AC');
    expect(ac).toMatchObject({ id: 'rty_ac', workflow: 'access', builtin: true, name: 'Access change' });
    expect(ac.fields.map((f: any) => f.key)).toEqual(
      expect.arrayContaining(['platform', 'subjectId', 'changeKind', 'rightsBefore', 'rightsAfter', 'performedAt']),
    );
    // its structured fields cannot be removed (the reconciliation reads them)
    const { recordCount: _c, builtin: _b, id: _i, createdAt: _x, updatedAt: _y, ...input } = ac;
    expect(await status(s.api('PUT', `/record-types/${ac.id}`, { ...input, fields: ac.fields.filter((f: any) => f.key !== 'subjectId') }))).toBe(409);
  });

  it('are documented by operators and verified by someone else (four-eyes)', async () => {
    const entry = {
      platformId: hub,
      subjectId: 'service-account@example.com',
      subjectName: 'Service account',
      subjectType: 'technical',
      kind: 'grant',
      rightsBefore: ['mdsp:core:StandardUser'],
      rightsAfter: ['mdsp:core:StandardUser', 'mdsp_usergroup:Operators'],
      reason: 'Needs to read machine data',
      requestRef: 'RITM0012345',
      requestUrl: 'https://servicenow.example.com/RITM0012345',
      approvedBy: 'Peter Plant',
      performedBy: 'adam',
      performedAt: new Date().toISOString(),
      document: true,
    };
    expect(await status(vera('POST', '/compliance/access-changes', entry))).toBe(403);
    expect(await status(audrey('POST', '/compliance/access-changes', entry))).toBe(403);
    const a = await olivia('POST', '/compliance/access-changes', entry);
    expect(a).toMatchObject({ status: 'documented', granted: ['mdsp_usergroup:Operators'], revoked: [], origin: 'manual', afterTheFact: false });
    expect(a.number).toMatch(/^AC-\d{4}-\d{4}$/);
    expect(a.frozenHash).toMatch(/^[0-9a-f]{64}$/);
    const rec = await audrey('GET', `/records/${a.recordId}`);
    expect(rec.frozen).toBe(true);
    expect(rec.links.map((l: any) => l.note)).toEqual(expect.arrayContaining(['platform', 'request']));
    // the performer cannot verify the entry; operators are no approvers
    expect(await errorOf(adam('POST', `/records/${a.recordId}/transition`, { action: 'verify' }))).toContain('Four-eyes');
    expect(await status(olivia('POST', `/records/${a.recordId}/transition`, { action: 'verify' }))).toBe(403);
    expect((await s.api('POST', `/records/${a.recordId}/transition`, { action: 'verify' })).status).toBe('verified');
    // auditors, approvers and who may use the platform read them; viewers do not (they name people and their rights)
    const list = await adam('GET', `/compliance/access-changes?platformId=${hub}&subject=service-account`);
    expect(list.map((x: any) => x.recordId)).toContain(a.recordId);
    expect((await audrey('GET', `/compliance/access-changes/${a.number}`)).status).toBe('verified');
    expect(await vera('GET', `/compliance/access-changes?platformId=${hub}`)).toEqual([]);
    expect(await status(vera('GET', `/records/${a.recordId}`))).toBe(404);
  });

  it('reject incomplete input', async () => {
    expect(await status(olivia('POST', '/compliance/access-changes', { platformId: hub, subjectId: 'x', kind: 'grant', reason: 'r', performedBy: 'o' }))).toBe(
      400,
    );
    expect(
      await status(
        olivia('POST', '/compliance/access-changes', {
          platformId: 'plt_none',
          subjectId: 'x',
          kind: 'grant',
          reason: 'r',
          performedBy: 'o',
          performedAt: new Date().toISOString(),
        }),
      ),
    ).toBe(400);
  });
});

describe('access reconciliation', () => {
  it('the demo has a check of the simulated Insights Hub with a baseline snapshot', async () => {
    expect(check).toMatchObject({ source: 'insights-hub', enabled: true, lastStatus: 'ok', snapshotCount: 1 });
    const snaps = await s.api('GET', `/compliance/access-checks/${check.id}/snapshots`);
    expect(snaps[0]).toMatchObject({ subjects: 15, prevChainHash: null });
    const snap = await s.api('GET', `/compliance/access-checks/${check.id}/snapshots/${snaps[0].id}`);
    expect(snap.data.find((x: any) => x.name === 'anna.berger@example.com').rights).toContain('mdsp:core:TenantAdmin');
  });

  it('only administrators, auditors, the owner and platform users read checks; designers and admins set them up', async () => {
    expect(await vera('GET', '/compliance/access-checks')).toEqual([]);
    expect(await status(vera('GET', `/compliance/access-checks/${check.id}`))).toBe(404);
    expect(await status(vera('GET', `/compliance/access-checks/${check.id}/snapshots`))).toBe(404);
    expect((await audrey('GET', '/compliance/access-checks')).map((c: any) => c.id)).toContain(check.id);
    expect((await olivia('GET', '/compliance/access-checks')).map((c: any) => c.id)).toContain(check.id);
    expect(await status(audrey('POST', `/compliance/access-checks/${check.id}/run`, {}))).toBe(403);
    expect(await status(olivia('POST', `/compliance/access-checks/${check.id}/run`, {}))).toBe(403);
    const input = { name: 'Dana check', platformId: hub, source: 'insights-hub', cron: '0 5 * * *', timezone: 'Europe/Berlin' };
    expect(await status(olivia('POST', '/compliance/access-checks', input))).toBe(403);
    expect(await status(dana('POST', '/compliance/access-checks', { ...input, cron: '* * * * *' }))).toBe(400);
    const mine = await dana('POST', '/compliance/access-checks', input);
    expect(mine).toMatchObject({ owner: 'dana', canEdit: true });
    expect(await status(dana('PUT', `/compliance/access-checks/${check.id}`, input))).toBe(403);
    expect(await status(dana('DELETE', `/compliance/access-checks/${mine.id}`))).toBe(200);
    // a check with snapshots is evidence: it can be disabled, not deleted
    expect(await status(s.api('DELETE', `/compliance/access-checks/${check.id}`))).toBe(409);
  });

  it('reports an administrator role granted outside Steward as undocumented, and notifies', async () => {
    const r = await s.api('POST', '/compliance/demo/simulate-change', { accessCheckId: check.id });
    expect(r.granted).toMatchObject({ userName: 'bernd.christ@example.com', role: 'mdsp:core:TenantAdmin' });
    expect(r.result.findings).toHaveLength(1);
    expect(r.result.findings[0]).toMatchObject({
      subjectName: 'bernd.christ@example.com',
      kind: 'grant',
      granted: ['mdsp:core:TenantAdmin'],
      revoked: [],
      status: 'open',
    });
    expect((await s.api('GET', `/compliance/access-checks/${check.id}`)).lastStatus).toBe('findings');
    const notes = await s.api('GET', '/notifications');
    expect(JSON.stringify(notes)).toContain('Undocumented access changes');
  });

  it('detects grants, removals and changes, and matches documented entries', async () => {
    const operators = await groupByName('mdsp_usergroup:Operators');
    const viewers = await groupByName('mdsp_usergroup:Viewers');
    const engineers = await groupByName('mdsp_usergroup:Engineers');
    const clara = await userByName('clara.dietz@example.com'); // Operators
    const greta = await userByName('greta.hahn@example.com'); // Operators
    const olga = await userByName('olga.peters@example.com'); // Viewers, QualityAudit
    // undocumented revoke (Clara loses Operators)
    await idm('DELETE', `/Groups/${operators.id}/members/${clara.id}`);
    // undocumented modify (Greta: Operators → Engineers)
    await idm('DELETE', `/Groups/${operators.id}/members/${greta.id}`);
    await idm('POST', `/Groups/${engineers.id}/members`, { type: 'USER', value: greta.id });
    // documented grant (Olga gets Operators, with an entry by user name)
    await idm('POST', `/Groups/${operators.id}/members`, { type: 'USER', value: olga.id });
    await olivia('POST', '/compliance/access-changes', {
      platformId: hub,
      subjectId: 'olga.peters@example.com',
      kind: 'grant',
      rightsBefore: ['mdsp:core:StandardUser', 'mdsp_usergroup:QualityAudit', 'mdsp_usergroup:Viewers'],
      rightsAfter: ['mdsp:core:StandardUser', 'mdsp_usergroup:QualityAudit', 'mdsp_usergroup:Viewers', 'mdsp_usergroup:Operators'],
      reason: 'Shift lead',
      performedBy: 'olivia',
      performedAt: new Date().toISOString(),
      document: true,
    });
    // a draft entry does not count: Olga's Viewers removal stays undocumented until it is documented
    await idm('DELETE', `/Groups/${viewers.id}/members/${olga.id}`);
    const draft = await olivia('POST', '/compliance/access-changes', {
      platformId: hub,
      subjectId: olga.id,
      kind: 'revoke',
      rightsBefore: ['mdsp_usergroup:Viewers'],
      rightsAfter: [],
      reason: 'Not needed any more',
      performedBy: 'olivia',
      performedAt: new Date().toISOString(),
    });
    expect(draft.status).toBe('draft');
    // a new user appears (onboarding outside Steward)
    await idm('POST', '/Users', { userName: 'new.contractor@example.com', name: { givenName: 'New', familyName: 'Contractor' } });

    const r = await runCheck();
    const by = Object.fromEntries(r.findings.map((f: any) => [f.subjectName, f]));
    expect(by['clara.dietz@example.com']).toMatchObject({ kind: 'revoke', revoked: ['mdsp_usergroup:Operators'], granted: [] });
    expect(by['greta.hahn@example.com']).toMatchObject({ kind: 'modify', granted: ['mdsp_usergroup:Engineers'], revoked: ['mdsp_usergroup:Operators'] });
    expect(by['olga.peters@example.com']).toMatchObject({ kind: 'revoke', granted: [], revoked: ['mdsp_usergroup:Viewers'] });
    expect(by['new.contractor@example.com']).toMatchObject({ kind: 'onboarding', granted: ['mdsp:core:StandardUser'] });
    expect(Object.keys(by)).toHaveLength(4);

    // documenting the draft later resolves Olga's finding (matched by the later entry)
    await olivia('POST', `/records/${draft.recordId}/transition`, { action: 'document' });
    const olgaFinding = (await s.api('GET', `/compliance/findings?checkId=${check.id}`)).find((f: any) => f.id === by['olga.peters@example.com'].id);
    expect(olgaFinding).toMatchObject({ status: 'documented', recordId: draft.recordId });
    // an unchanged tenant: no findings, the data is stored once
    const again = await runCheck();
    expect(again.findings).toEqual([]);
    expect(again.snapshot.sameAs).toBe(r.snapshot.id);
  });

  it('documents a change after the fact with one click; the finding is no longer open', async () => {
    const open = await openFindings();
    const bernd = open.find((f: any) => f.subjectName === 'bernd.christ@example.com');
    expect(bernd.canDocument).toBe(true);
    expect((await audrey('GET', `/compliance/findings?checkId=${check.id}`)).find((f: any) => f.id === bernd.id).canDocument).toBe(false);
    expect(await status(audrey('POST', `/compliance/findings/${bernd.id}/document`, { reason: 'x' }))).toBe(403);
    expect(await status(vera('POST', `/compliance/findings/${bernd.id}/document`, { reason: 'x' }))).toBe(404);
    expect(await status(olivia('POST', `/compliance/findings/${bernd.id}/document`, {}))).toBe(400);
    const done = await olivia('POST', `/compliance/findings/${bernd.id}/document`, {
      reason: 'Emergency access during the outage (INC0042)',
      requestRef: 'INC0042',
      performedBy: 'IH tenant admin (UI)',
    });
    expect(done).toMatchObject({ status: 'documented', canDocument: false });
    const entry = await olivia('GET', `/compliance/access-changes/${done.recordId}`);
    expect(entry).toMatchObject({
      status: 'documented',
      origin: 'reconciliation',
      afterTheFact: true,
      findingId: bernd.id,
      granted: ['mdsp:core:TenantAdmin'],
    });
    expect((await openFindings()).map((f: any) => f.id)).not.toContain(bernd.id);
    expect(await status(olivia('POST', `/compliance/findings/${bernd.id}/document`, { reason: 'again' }))).toBe(409);
    // a new revision of the entry (back to draft) re-opens the finding
    await olivia('POST', `/records/${done.recordId}/revise`, { comment: 'wrong ticket' });
    expect((await openFindings()).map((f: any) => f.id)).toContain(bernd.id);
    await olivia('POST', `/records/${done.recordId}/transition`, { action: 'document' });
    expect((await openFindings()).map((f: any) => f.id)).not.toContain(bernd.id);
  });

  it('dismisses findings only with a reason, by the owner or an administrator', async () => {
    const f = (await openFindings()).find((x: any) => x.subjectName === 'new.contractor@example.com');
    expect(await status(olivia('POST', `/compliance/findings/${f.id}/dismiss`, { comment: 'x' }))).toBe(403);
    expect(await status(s.api('POST', `/compliance/findings/${f.id}/dismiss`, { comment: ' ' }))).toBe(400);
    expect((await s.api('POST', `/compliance/findings/${f.id}/dismiss`, { comment: 'Test account of the vendor, removed again' })).status).toBe('dismissed');
  });

  it('leaves out rights the check ignores (the review marker group of the demo)', async () => {
    expect(check.ignoreRights).toEqual(['mdsp_usergroup:AccessReview']);
    const review = await groupByName('mdsp_usergroup:AccessReview');
    const ida = await userByName('ida.jung@example.com');
    await idm('POST', `/Groups/${review.id}/members`, { type: 'USER', value: ida.id });
    const r = await runCheck();
    expect(r.findings).toEqual([]);
    expect(r.snapshot.sameAs).not.toBeNull();
  });

  it('keeps a provable, hash-chained history', async () => {
    const v = await audrey('GET', `/compliance/access-checks/${check.id}/verify`);
    expect(v).toMatchObject({ ok: true, problems: [] });
    expect(v.checked).toBeGreaterThanOrEqual(4);
    const { db } = await import('../src/db.js');
    expect(() => db().run("UPDATE access_snapshots SET hash = 'x' WHERE check_id = ?", check.id)).toThrow(/immutable/);
    const audit = await s.api('GET', `/audit?entityType=access_check&entityId=${check.id}`);
    expect(audit.filter((e: any) => e.action === 'access_check.snapshot').length).toBe(v.checked);
  });

  it('reads a dataset in the access snapshot shape (generic platforms)', async () => {
    const procId = 'ih-access-snapshot'; // imported with the demo data
    const ds = await s.api('POST', '/compliance/access-checks', {
      name: 'Dataset check',
      platformId: hub,
      source: 'dataset',
      datasetKey: 'ih.access-snapshot',
      cron: '0 4 * * *',
      timezone: 'UTC',
    });
    expect(await status(s.api('POST', `/compliance/access-checks/${ds.id}/run`, {}))).toBe(409); // no data yet
    const run = await s.api('POST', '/runs', { processId: procId, bindings: { hub } });
    expect((await s.waitRun(run.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    const base = await s.api('POST', `/compliance/access-checks/${ds.id}/run`, {});
    expect(base.baseline).toBe(true);
    expect(base.snapshot.subjects).toBe(16);
    const anna = await userByName('anna.berger@example.com');
    const tenantAdmins = await groupByName('mdsp:core:TenantAdmin');
    await idm('DELETE', `/Groups/${tenantAdmins.id}/members/${anna.id}`);
    await s.waitRun((await s.api('POST', '/runs', { processId: procId, bindings: { hub } })).id, ['succeeded']);
    const r = await s.api('POST', `/compliance/access-checks/${ds.id}/run`, {});
    expect(r.findings).toEqual([expect.objectContaining({ subjectName: 'anna.berger@example.com', kind: 'revoke', revoked: ['mdsp:core:TenantAdmin'] })]);
  });
});

describe('automatic entries from runs', () => {
  const PROC = {
    name: 'Grant access (test)',
    connections: [{ slot: 'hub', kind: 'insights-hub' }],
    steps: [
      {
        id: 'list',
        type: 'set',
        values: {
          users: [
            { id: 'u-1', userName: 'one@example.com' },
            { id: 'u-2', userName: 'two@example.com' },
          ],
        },
      },
      {
        id: 'doc',
        type: 'accessChange',
        connection: 'hub',
        kind: 'grant',
        items: 'vars.users',
        subjectId: 'id',
        subjectName: 'userName',
        rights: "['mdsp_usergroup:Engineers']",
        reason: 'Project Phoenix',
        requestRef: 'RITM0099',
      },
    ],
  };

  it('a process that documents access changes creates documented entries linked to the run and its PDF', async () => {
    const p = await s.api('POST', '/processes', { definition: PROC });
    const dry = await s.api('POST', '/runs', { processId: p.id, bindings: { hub }, dryRun: true });
    expect((await s.waitRun(dry.id, ['succeeded'])).status).toBe('succeeded');
    const run = await s.api('POST', '/runs', { processId: p.id, bindings: { hub } });
    await s.waitRun(run.id, ['succeeded']);
    let entries: any[] = [];
    for (let i = 0; i < 100 && entries.length < 2; i++) {
      entries = (await s.api('GET', `/compliance/access-changes?platformId=${hub}`)).filter((e: any) => e.runId === run.id);
      await sleep(100);
    }
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      status: 'documented',
      origin: 'run',
      kind: 'grant',
      granted: ['mdsp_usergroup:Engineers'],
      reason: 'Project Phoenix',
      requestRef: 'RITM0099',
    });
    expect(entries.map((e) => e.subjectName).sort()).toEqual(['one@example.com', 'two@example.com']);
    const rec = await s.api('GET', `/records/${entries[0].recordId}`);
    expect(rec.createdBy).toBe('system');
    expect(rec.links.find((l: any) => l.kind === 'run').targetId).toBe(run.id);
    const pdf = rec.attachments.find((a: any) => a.kind === 'file');
    expect(pdf.mime).toBe('application/pdf');
    const report = (await s.api('GET', `/runs/${run.id}/reports`))[0];
    expect(pdf.sha256).toBe(report.sha256);
    // the dry run documented nothing
    expect((await s.api('GET', `/compliance/access-changes?platformId=${hub}`)).filter((e: any) => e.runId === dry.id)).toEqual([]);
  });
});

describe('public API', () => {
  it('lists access changes and findings for token owners', async () => {
    const token = (await audrey('POST', '/me/tokens', { name: 'compliance', scope: 'read' })).token;
    const get = async (url: string) => (await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const changes = await get('/access-changes?limit=200');
    expect(changes.items.length).toBeGreaterThan(3);
    expect(changes.items[0]).toHaveProperty('afterTheFact');
    const findings = await get(`/access-findings?checkId=${check.id}`);
    expect(findings.items.some((f: any) => f.status === 'documented')).toBe(true);
    expect(findings.items[0]).not.toHaveProperty('canDocument');
    const vtoken = (await vera('POST', '/me/tokens', { name: 'compliance', scope: 'read' })).token;
    const vf = await (await fetch(`${s.base}/api/v1/access-findings`, { headers: { authorization: `Bearer ${vtoken}` } })).json();
    expect(vf.items).toEqual([]);
  });
});
