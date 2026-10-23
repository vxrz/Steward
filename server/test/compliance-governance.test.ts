import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Access governance rules (security review round 3, GOV-1 … GOV-15): who may document access changes
 * and read the entries, four-eyes rules, reserved fields of automatic entries, dataset checks,
 * ignored rights and dismissals, tamper detection of snapshots, findings and entries.
 */

let s: TestServer;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client, oscar: Client, bernd: Client, carl: Client;
let hub: string;
let check: any;
const PW = 'Demo-password-1';
const OWN_PW = 'Governance-password-1';
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

const idm = (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  s.api('POST', `/platforms/${hub}/request`, { method, path: `${IDM}${path}`, ...(body ? { body } : {}), ...(query ? { query } : {}) });
const userByName = async (userName: string) => (await idm('GET', '/Users', undefined, { filter: `userName eq "${userName}"` })).body.resources[0];
const groupByName = async (name: string) => (await idm('GET', '/Groups', undefined, { filter: `displayName eq "${name}"` })).body.resources[0];
const findings = async (checkId = check.id) => (await s.api('GET', `/compliance/findings?checkId=${checkId}`)) as any[];
const finding = async (id: string) => (await findings()).find((f: any) => f.id === id);

/** An undocumented change of the simulated tenant (a group membership), found by the next run of the demo check. */
async function undocumentedGrant(userName: string): Promise<any> {
  const u = await userByName(userName);
  const have = new Set(((u.groups ?? []) as { display?: string }[]).map((x) => x.display));
  const group = ['mdsp_usergroup:Engineers', 'mdsp_usergroup:Viewers', 'mdsp_usergroup:QualityAudit', 'mdsp_usergroup:Operators'].find((x) => !have.has(x))!;
  const g = await groupByName(group);
  await idm('POST', `/Groups/${g.id}/members`, { type: 'USER', value: u.id });
  const r = await s.api('POST', `/compliance/access-checks/${check.id}/run`, {});
  const f = r.findings.find((x: any) => x.subjectName === userName);
  expect(f, JSON.stringify(r.findings)).toBeTruthy();
  return f;
}

const entryFor = (f: any, extra: Record<string, unknown> = {}) => ({
  platformId: hub,
  subjectId: f.subjectName,
  kind: 'grant',
  rightsBefore: f.rightsBefore,
  rightsAfter: f.rightsAfter,
  reason: 'Documented later',
  performedBy: 'someone',
  performedAt: new Date(Date.parse(f.windowTo) - 1000).toISOString(),
  document: true,
  ...extra,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'oscar', roles: ['operator'], password: OWN_PW, mustChangePassword: false });
  users.createUser({ username: 'bernd', email: 'bernd.christ@example.com', roles: ['operator'], password: OWN_PW, mustChangePassword: false });
  users.createUser({ username: 'carl', email: 'carl.subject@example.com', roles: ['approver'], password: OWN_PW, mustChangePassword: false });
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  [oscar, bernd, carl] = await Promise.all(['oscar', 'bernd', 'carl'].map((u) => s.as(u, OWN_PW)));
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  check = (await s.api('GET', '/compliance/access-checks')).find((c: any) => c.platformId === hub);
  // Oscar is an operator without any right on the Insights Hub platform
  await s.api('PUT', `/platforms/${hub}/access`, {
    acl: [
      { subject: 'role:designer', permissions: ['use'] },
      { subject: 'user:olivia', permissions: ['use'] },
      { subject: 'user:bernd', permissions: ['use'] },
    ],
  });
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('GOV-1: only people who may use the platform document its access changes, never their own', () => {
  it('an operator without rights on the platform cannot create or document entries for it', async () => {
    const f = await undocumentedGrant('clara.dietz@example.com');
    expect(await status(oscar('POST', '/compliance/access-changes', entryFor(f)))).toBe(403);
    // not through the generic records API either
    const fields = {
      platform: hub,
      subjectId: f.subjectName,
      changeKind: 'grant',
      rightsAfter: f.rightsAfter.join('\n'),
      reason: 'x',
      performedBy: 'x',
      performedAt: new Date(Date.parse(f.windowTo) - 1000).toISOString(),
    };
    expect(await status(oscar('POST', '/records', { type: 'AC', title: 'Forged', fields }))).toBe(403);
    // a draft by someone else cannot be documented by Oscar
    const draft = await olivia('POST', '/compliance/access-changes', { ...entryFor(f), document: false });
    expect(await status(oscar('POST', `/records/${draft.recordId}/transition`, { action: 'document' }))).toBe(404);
    expect((await finding(f.id)).status).toBe('open');
    // Olivia may use the platform: her entry closes the finding
    await olivia('POST', `/records/${draft.recordId}/transition`, { action: 'document' });
    expect((await finding(f.id)).status).toBe('documented');
  });

  it('the subject of a change cannot document it: their entry does not close the finding', async () => {
    const f = await undocumentedGrant('bernd.christ@example.com');
    const own = await bernd('POST', '/compliance/access-changes', entryFor(f));
    expect(own.status).toBe('documented');
    expect(own.documentedBy).toBe('bernd');
    expect((await finding(f.id)).status).toBe('open');
    expect(await errorOf(bernd('POST', `/compliance/findings/${f.id}/document`, { reason: 'Mine' }))).toContain('ACCESS_SUBJECT_SELF');
    // someone else documents it
    await olivia('POST', `/compliance/findings/${f.id}/document`, { reason: 'Approved by his manager' });
    expect((await finding(f.id)).status).toBe('documented');
  });
});

describe('GOV-2: access change entries are read by admins, auditors, approvers and who may use the platform', () => {
  it('hides entries from viewers and operators without rights on the platform, everywhere', async () => {
    const list = await olivia('GET', `/compliance/access-changes?platformId=${hub}`);
    expect(list.length).toBeGreaterThan(0);
    const a = list[0];
    for (const c of [vera, oscar]) {
      expect(await c('GET', '/compliance/access-changes')).toEqual([]);
      expect(await status(c('GET', `/compliance/access-changes/${a.recordId}`))).toBe(404);
      expect(await status(c('GET', `/records/${a.recordId}`))).toBe(404);
      expect(await status(c('GET', `/records/${a.recordId}/versions`))).toBe(404);
      expect(await status(c('GET', `/records/${a.recordId}/export`))).toBe(404);
      expect((await c('GET', '/records?type=AC')).length).toBe(0);
      expect((await c('GET', `/records?q=${encodeURIComponent(a.number)}`)).length).toBe(0);
      expect(await c('GET', `/link-targets?kind=record&q=${encodeURIComponent(a.number)}`)).toEqual([]);
      expect(await c('GET', `/compliance/tag-targets?kind=record&q=${encodeURIComponent(a.number)}`)).toEqual([]);
    }
    // a run linked from an entry: its backlinks do not show the hidden entry
    const runId = (await s.api('GET', '/runs?limit=1'))[0]?.id;
    if (runId) {
      const back = await oscar('GET', `/backlinks?kind=run&id=${runId}`).catch(() => []);
      expect(back.map((b: any) => b.id)).not.toContain(a.recordId);
    }
    const token = (await vera('POST', '/me/tokens', { name: 'gov2', scope: 'read' })).token;
    const v1 = async (url: string) => (await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect((await v1('/access-changes')).items).toEqual([]);
    expect((await v1('/records?limit=200')).items.map((r: any) => r.id)).not.toContain(a.recordId);
    // auditors, approvers and the platform's users read them
    for (const c of [audrey, adam, dana]) expect((await c('GET', `/compliance/access-changes/${a.recordId}`)).recordId).toBe(a.recordId);
  });
});

describe('GOV-3 and GOV-11: automatic entries of runs', () => {
  const PROC = {
    name: 'Grant access (governance test)',
    connections: [{ slot: 'hub', kind: 'insights-hub' }],
    steps: [
      {
        id: 'doc',
        type: 'accessChange',
        connection: 'hub',
        kind: 'grant',
        subjectId: "'u-gov'",
        subjectName: "'gov@example.com'",
        rights: "['mdsp_usergroup:Engineers']",
        reason: 'Project Phoenix',
      },
    ],
  };
  let entry: any;

  it('name the person who started the run as performer; that person cannot verify the entry', async () => {
    const p = await s.api('POST', '/processes', { definition: PROC });
    const run = await s.api('POST', '/runs', { processId: p.id, bindings: { hub } });
    await s.waitRun(run.id, ['succeeded']);
    for (let i = 0; i < 100 && !entry; i++) {
      entry = (await s.api('GET', `/compliance/access-changes?platformId=${hub}`)).find((e: any) => e.runId === run.id);
      if (!entry) await sleep(100);
    }
    expect(entry).toMatchObject({ origin: 'run', runId: run.id, performedBy: 'admin', documentedBy: 'system' });
    expect(await errorOf(s.api('POST', `/records/${entry.recordId}/transition`, { action: 'verify' }))).toContain('FOUR_EYES');
    expect((await adam('POST', `/records/${entry.recordId}/transition`, { action: 'verify' })).status).toBe('verified');
  });

  it('cannot be revised by people, and nobody sets the origin, run or finding of an entry by hand', async () => {
    const p = await s.api('POST', '/processes', { definition: { ...PROC, name: 'Grant access (governance test 2)' } });
    const run = await s.api('POST', '/runs', { processId: p.id, bindings: { hub } });
    await s.waitRun(run.id, ['succeeded']);
    let e: any;
    for (let i = 0; i < 100 && !e; i++) {
      e = (await s.api('GET', `/compliance/access-changes?platformId=${hub}`)).find((x: any) => x.runId === run.id);
      if (!e) await sleep(100);
    }
    expect(await errorOf(s.api('POST', `/records/${e.recordId}/revise`, { comment: 'edit it' }))).toContain('ACCESS_RUN_ENTRY_LOCKED');
    const fields = {
      platform: hub,
      subjectId: 'x@example.com',
      changeKind: 'grant',
      rightsAfter: 'r',
      reason: 'x',
      performedBy: 'x',
      performedAt: new Date().toISOString(),
    };
    for (const extra of [{ origin: 'run' }, { runId: run.id }, { findingId: 'afd_x' }, { origin: 'reconciliation' }])
      expect(await errorOf(olivia('POST', '/records', { type: 'AC', title: 'Forged', fields: { ...fields, ...extra } }))).toContain('ACCESS_FIELD_RESERVED');
    const ok = await olivia('POST', '/records', { type: 'AC', title: 'By hand', fields: { ...fields, origin: 'manual' } });
    expect(await errorOf(olivia('PUT', `/records/${ok.id}`, { fields: { ...fields, runId: run.id } }))).toContain('ACCESS_FIELD_RESERVED');
  });
});

describe('GOV-9: four-eyes includes the subject of the change', () => {
  it('the subject cannot verify an entry about their own access', async () => {
    const a = await olivia('POST', '/compliance/access-changes', {
      platformId: hub,
      subjectId: 'carl.subject@example.com',
      kind: 'grant',
      rightsAfter: ['mdsp:core:TenantAdmin'],
      reason: 'Needs admin',
      performedBy: 'olivia',
      performedAt: new Date().toISOString(),
      document: true,
    });
    const rec = await carl('GET', `/records/${a.recordId}`);
    expect(rec.actions.find((x: any) => x.action === 'verify')).toMatchObject({ allowed: false, reasonCode: 'FOUR_EYES_SUBJECT' });
    expect(await status(carl('POST', `/records/${a.recordId}/transition`, { action: 'verify' }))).toBe(403);
    expect((await adam('POST', `/records/${a.recordId}/transition`, { action: 'verify' })).status).toBe('verified');
  });
});

describe('GOV-13: tampered entries do not count', () => {
  it('an entry changed in the database is flagged and re-opens the finding it closed', async () => {
    const f = await undocumentedGrant('greta.hahn@example.com');
    const a = await olivia('POST', '/compliance/access-changes', entryFor(f, { subjectId: 'greta.hahn@example.com' }));
    expect((await finding(f.id)).status).toBe('documented');
    expect(a.tampered).toBe(false);
    const { db } = await import('../src/db.js');
    const row = db().get<{ fields: string }>('SELECT fields FROM records WHERE id = ?', a.recordId)!;
    db().run('UPDATE records SET fields = ? WHERE id = ?', row.fields.replace('Documented later', 'Approved by the CISO'), a.recordId);
    expect((await audrey('GET', `/compliance/access-changes/${a.recordId}`)).tampered).toBe(true);
    expect((await finding(f.id)).status).toBe('open');
  });
});

describe('GOV-4: dataset checks', () => {
  it('need the right to view the process that publishes the dataset, and keep their dataset once they have snapshots', async () => {
    const run = await s.api('POST', '/runs', { processId: 'ih-access-snapshot', bindings: { hub } });
    expect((await s.waitRun(run.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    await s.api('PUT', '/processes/ih-access-snapshot/access', { acl: [{ subject: 'user:olivia', permissions: ['view', 'run'] }] });
    try {
      const input = { name: 'Foreign dataset', platformId: hub, source: 'dataset', datasetKey: 'ih.access-snapshot', cron: '0 4 * * *', timezone: 'UTC' };
      expect(await status(dana('POST', '/compliance/access-checks', input))).toBe(403);
      const ok = await s.api('POST', '/compliance/access-checks', { ...input, name: 'Own dataset' });
      await s.api('POST', `/compliance/access-checks/${ok.id}/run`, {});
      expect(await errorOf(s.api('PUT', `/compliance/access-checks/${ok.id}`, { ...input, name: 'Own dataset', datasetKey: 'other.snapshot' }))).toContain(
        'ACCESS_CHECK_LOCKED',
      );
      // the check runs as its owner: an owner who lost the right to view the process gets no snapshot
      const mine = await dana('POST', '/compliance/access-checks', { ...input, name: 'Dana dataset', datasetKey: 'dana.snapshot' });
      const { db } = await import('../src/db.js');
      db().run("UPDATE access_checks SET dataset_key = 'ih.access-snapshot' WHERE id = ?", mine.id);
      expect(await errorOf(dana('POST', `/compliance/access-checks/${mine.id}/run`, {}))).toContain('ACCESS_CHECK_DATASET_FORBIDDEN');
    } finally {
      await s.api('PUT', '/processes/ih-access-snapshot/access', { acl: [] });
    }
  });
});

describe('GOV-5: ignored rights and dismissals', () => {
  it('only administrators set ignored rights; changes of ignored rights and recipients are audited', async () => {
    const input = { name: 'Dana check', platformId: hub, source: 'insights-hub', cron: '0 5 * * *', timezone: 'UTC' };
    expect(await status(dana('POST', '/compliance/access-checks', { ...input, ignoreRights: ['mdsp:core:TenantAdmin'] }))).toBe(403);
    const c = await dana('POST', '/compliance/access-checks', input);
    expect(await status(dana('PUT', `/compliance/access-checks/${c.id}`, { ...input, ignoreRights: ['mdsp:core:TenantAdmin'] }))).toBe(403);
    await dana('PUT', `/compliance/access-checks/${c.id}`, { ...input, notify: ['user:olivia'] });
    await s.api('PUT', `/compliance/access-checks/${c.id}`, { ...input, notify: ['user:olivia'], ignoreRights: ['mdsp_usergroup:AccessReview'] });
    const audit = (await s.api('GET', `/audit?entityType=access_check&entityId=${c.id}`)).filter((e: any) => e.action === 'access_check.updated');
    const details = audit.map((e: any) => e.details);
    expect(details).toContainEqual(expect.objectContaining({ notify: { from: [], to: ['user:olivia'] } }));
    expect(details).toContainEqual(expect.objectContaining({ ignoreRights: { from: [], to: ['mdsp_usergroup:AccessReview'] } }));
  });

  it('the subject never dismisses a finding about their own access', async () => {
    // Bernd owns a check of his own platform access; a change of his own rights shows up on it
    await s.api('PUT', '/users/' + (await s.api('GET', '/users')).find((u: any) => u.username === 'bernd').id, { roles: ['operator', 'designer'] });
    const own = await (
      await s.as('bernd', OWN_PW)
    )('POST', '/compliance/access-checks', {
      name: 'Bernd check',
      platformId: hub,
      source: 'insights-hub',
      cron: '0 5 * * *',
      timezone: 'UTC',
    });
    const bernd2 = await s.as('bernd', OWN_PW);
    await bernd2('POST', `/compliance/access-checks/${own.id}/run`, {});
    const u = await userByName('bernd.christ@example.com');
    const g = await groupByName('mdsp_usergroup:QualityAudit');
    await idm('POST', `/Groups/${g.id}/members`, { type: 'USER', value: u.id });
    const r = await bernd2('POST', `/compliance/access-checks/${own.id}/run`, {});
    const f = r.findings.find((x: any) => x.subjectName === 'bernd.christ@example.com');
    expect(f.canDismiss).toBe(false);
    expect(await errorOf(bernd2('POST', `/compliance/findings/${f.id}/dismiss`, { comment: 'my own' }))).toContain('ACCESS_SUBJECT_SELF');
  });

  it('with four-eyes dismissals, a second person confirms the dismissal', async () => {
    await s.api('PUT', '/settings', { findingDismissFourEyes: true });
    try {
      const f = await undocumentedGrant('ida.jung@example.com');
      const first = await s.api('POST', `/compliance/findings/${f.id}/dismiss`, { comment: 'Test account' });
      expect(first).toMatchObject({ status: 'open', dismissRequestedBy: 'admin' });
      expect(await errorOf(s.api('POST', `/compliance/findings/${f.id}/dismiss`, { comment: '' }))).toContain('FOUR_EYES');
      const admin2 = (await import('../src/auth/users.js')).createUser({ username: 'admin2', roles: ['admin'], password: OWN_PW, mustChangePassword: false });
      expect(admin2.user.username).toBe('admin2');
      const second = await (await s.as('admin2', OWN_PW))('POST', `/compliance/findings/${f.id}/dismiss`, { comment: '' });
      expect(second).toMatchObject({ status: 'dismissed', resolvedBy: 'admin2', comment: 'Test account' });
      const audit = await s.api('GET', `/audit?entityType=access_finding&entityId=${f.id}`);
      expect(audit.map((e: any) => e.action)).toEqual(expect.arrayContaining(['access_finding.dismiss_requested', 'access_finding.dismissed']));
    } finally {
      await s.api('PUT', '/settings', { findingDismissFourEyes: false });
    }
  });
});

describe('GOV-6: snapshots and findings changed in the database are detected', () => {
  it('a deleted newest snapshot, a deleted finding and a finding dismissed in SQL fail the verification', async () => {
    const { db } = await import('../src/db.js');
    expect((await audrey('GET', `/compliance/access-checks/${check.id}/verify`)).ok).toBe(true);
    const newest = db().get<{ id: string }>('SELECT id FROM access_snapshots WHERE check_id = ? ORDER BY seq DESC LIMIT 1', check.id)!;
    // defence in depth: rows cannot be deleted
    expect(() => db().run('DELETE FROM access_snapshots WHERE id = ?', newest.id)).toThrow(/cannot be deleted|immutable/);
    const sqlite = db().dialect === 'sqlite';
    const drop = (t: string) => db().exec(sqlite ? `DROP TRIGGER IF EXISTS ${t}_no_delete` : `DROP TRIGGER IF EXISTS ${t}_no_delete ON ${t}`);
    drop('access_snapshots');
    drop('access_findings');
    const older = (await findings()).filter((f: any) => f.snapshotId !== newest.id);
    const open = older.find((f: any) => f.status === 'open');
    expect(open).toBeTruthy();
    db().run("UPDATE access_findings SET status = 'dismissed', comment = 'x' WHERE id = ?", open.id);
    const gone = older.find((f: any) => f.status === 'documented');
    db().run('DELETE FROM access_findings WHERE id = ?', gone.id);
    db().run('DELETE FROM access_findings WHERE snapshot_id = ?', newest.id);
    db().run('DELETE FROM access_snapshots WHERE id = ?', newest.id);
    const v = await audrey('GET', `/compliance/access-checks/${check.id}/verify`);
    expect(v.ok).toBe(false);
    const text = v.problems.join('\n');
    expect(text).toMatch(/Snapshot #\d+ is in the audit log but missing/);
    expect(text).toContain(`Finding ${gone.id} is in the audit log but missing`);
    expect(text).toContain(`Finding ${open.id}: status dismissed`);
  });
});

describe('GOV-10: mapping items to controls', () => {
  it('hides the ids of items the reader may not see and does not let them remove those items', async () => {
    const iso = await s.api('GET', '/compliance/controls?catalogue=ISO27001');
    const c = iso.find((x: any) => x.ref === '5.15');
    await s.api('PUT', '/processes/ih-access-snapshot/access', { acl: [{ subject: 'user:olivia', permissions: ['view', 'run'] }] });
    try {
      await s.api('POST', `/compliance/controls/${c.id}/tags`, { kind: 'process', targetId: 'ih-access-snapshot' });
      const seen = (await dana('GET', `/compliance/controls/${c.id}`)).tags.find((t: any) => t.kind === 'process');
      expect(seen).toMatchObject({ visible: false, targetId: null, label: '' });
      expect(await status(dana('POST', `/compliance/controls/${c.id}/tags/remove`, { kind: 'process', targetId: 'ih-access-snapshot' }))).toBe(404);
      expect(await dana('GET', '/compliance/tagged?kind=process&targetId=ih-access-snapshot')).toEqual([]);
      expect((await s.api('GET', '/compliance/tagged?kind=process&targetId=ih-access-snapshot')).map((x: any) => x.id)).toContain(c.id);
      expect((await s.api('GET', `/compliance/controls/${c.id}`)).tags.some((t: any) => t.targetId === 'ih-access-snapshot')).toBe(true);
    } finally {
      await s.api('PUT', '/processes/ih-access-snapshot/access', { acl: [] });
    }
  });
});

describe('GOV-15: a hostile identity management API', () => {
  it('stops collecting at the first subject over the limit, after one page', async () => {
    let requests = 0;
    const srv = http.createServer((req, res) => {
      requests++;
      const url = new URL(req.url ?? '/', 'http://x');
      const start = Number(url.searchParams.get('startIndex') ?? 1);
      const resources = Array.from({ length: 500 }, (_, i) => ({
        id: `u-${start + i}`,
        userName: `user${start + i}@example.com`,
        groups: Array.from({ length: 1001 }, (_x, j) => ({ display: `g${j}` })),
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ totalResults: 100000, resources }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (srv.address() as AddressInfo).port;
      const p = await s.api('POST', '/platforms', {
        name: 'Hostile IH',
        kind: 'insights-hub',
        baseUrl: `http://127.0.0.1:${port}`,
        config: { auth: { type: 'none' }, variables: { idmPath: '/idm' }, http: { proxy: 'none' } },
      });
      const c = await s.api('POST', '/compliance/access-checks', {
        name: 'Hostile',
        platformId: p.id,
        source: 'insights-hub',
        cron: '0 3 * * *',
        timezone: 'UTC',
      });
      expect(await errorOf(s.api('POST', `/compliance/access-checks/${c.id}/run`, {}))).toContain('SNAPSHOT_TOO_MANY_RIGHTS');
      expect(requests).toBe(1);
    } finally {
      srv.close();
    }
  });
});
