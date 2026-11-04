import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { startEntra, type EntraEnv } from './entra-setup.js';

/**
 * Entra ID as an access check source (v0.5.0, docs/ENTRA.md), against the simulated tenant: groups (also nested) and
 * owners, directory roles (active, eligible through PIM, through a group), app roles, guests and disabled accounts,
 * the fallbacks when a licence or permission is missing, the outbound policy, and a person review across Entra ID and
 * Confluent Cloud.
 */

let env: EntraEnv;
let s: TestServer;
let mock: EntraEnv['mock'];
let platformId: string;

beforeAll(async () => {
  env = await startEntra();
  ({ s, mock, platformId } = env);
});
beforeEach(() => mock?.resetGraph());
afterAll(async () => {
  mock?.resetGraph();
  await s?.app.close();
});

const invalidate = (id: string) => env.invalidate(id);

describe('Entra ID access checks', () => {
  let checkId: string;
  const snapshotOf = async (id: string) => {
    const r = await s.api('POST', `/compliance/access-checks/${id}/run`, {});
    const snap = await s.api('GET', `/compliance/access-checks/${id}/snapshots/${r.snapshot.id}`);
    return { r, by: Object.fromEntries(snap.data.map((x: any) => [x.id, x])) as Record<string, any> };
  };

  it('needs a Microsoft Graph platform and an empty scope or one of groups, roles, apps, guests', async () => {
    const base = { name: 'Entra ID', platformId, source: 'entra', cron: '0 6 * * *' };
    await expect(s.api('POST', '/compliance/access-checks', { ...base, scope: 'everyone' })).rejects.toThrow(/groups, roles, apps, guests/);
    const gitlab = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gitlab').id;
    await expect(s.api('POST', '/compliance/access-checks', { ...base, platformId: gitlab })).rejects.toMatchObject({
      body: { code: 'ACCESS_CHECK_ENTRA_SOURCE' },
    });
    const c = await s.api('POST', '/compliance/access-checks', base);
    expect(c).toMatchObject({ source: 'entra', scope: null, platformKind: 'microsoft-graph' });
    checkId = c.id;
  });

  it('snapshots users with groups (also nested), ownerships, roles (active, eligible, through a group), app roles, guests and disabled accounts', async () => {
    const { r, by } = await snapshotOf(checkId);
    expect(r.baseline).toBe(true);
    expect(by['alice@example.com']).toMatchObject({
      name: 'Alice Admin',
      type: 'user',
      rights: [
        'app:HR Sync',
        'group:All Staff',
        'group:IT Admins',
        'owner:group:All Staff',
        'owner:group:IT Admins',
        'role:Global Administrator',
        'role:User Administrator (via group IT Admins)',
      ],
    });
    expect(by['bob@example.com'].rights).toEqual([
      'group:All Staff',
      'group:Developers',
      'owner:group:Contractors',
      'owner:group:Developers',
      'role:Application Administrator (eligible)',
    ]);
    // the e-mail address equals the UPN but for case: no other name needed
    expect(by['erika.mustermann@example.com']).toMatchObject({
      aliases: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
      rights: [
        'app:Payroll/Approver',
        'app:Payroll/Viewer (via group Finance)',
        'group:All Staff',
        'group:Finance',
        'owner:group:Finance',
        'role:Security Reader (eligible)',
      ],
    });
    // a guest by UPN, with the e-mail address as another name; a member of Developers through Contractors
    expect(by['paula_fabrikam.example#EXT#@example.onmicrosoft.com']).toMatchObject({
      type: 'guest',
      aliases: expect.arrayContaining(['paula@fabrikam.example']),
      rights: ['group:Contractors', 'group:Developers (nested)', 'group:Partner Portal Users'],
    });
    expect(by['carl.disabled@example.com'].rights).toEqual(['account:disabled', 'group:Developers']);
    expect(by['nora.never@example.com'].rights).toEqual(['group:All Staff']);
    // groups and service principals that hold a role themselves
    expect(by['group:IT Admins']).toMatchObject({ type: 'group', rights: ['role:User Administrator'] });
    expect(by['group:Finance'].rights).toEqual(['app:Payroll/Viewer']);
    expect(by['sp:HR Sync']).toMatchObject({ type: 'service principal', rights: [expect.stringMatching(/^role:User Administrator @\/administrativeUnits\//)] });
    // the activity hint is never part of a snapshot
    expect(JSON.stringify(by)).not.toMatch(/last sign-in|activity/);
    expect(Object.keys(by)).toHaveLength(12);
  });

  it('finds an undocumented membership in the next snapshot', async () => {
    mock.addGraphMember('IT Admins', 'max.stale@example.com');
    const r = await s.api('POST', `/compliance/access-checks/${checkId}/run`, {});
    expect(r.findings.map((f: any) => [f.subjectId, f.kind, f.granted])).toEqual([
      ['max.stale@example.com', 'grant', ['group:IT Admins', 'role:User Administrator (via group IT Admins)']],
    ]);
  });

  it('leaves out what the licence does not allow – PIM, sign-in activity, MFA – and says so', async () => {
    mock.setGraphLicence('free');
    const c = await s.api('POST', '/compliance/access-checks', { name: 'Entra roles (free)', platformId, source: 'entra', scope: 'roles' });
    const { by } = await snapshotOf(c.id);
    expect(by['bob@example.com']).toBeUndefined();
    expect(by['alice@example.com'].rights).toEqual(['role:Global Administrator', 'role:User Administrator (via group IT Admins)']);
    const log = await s.api('GET', `/audit?entityId=${c.id}&limit=5`);
    const snap = log.find((e: any) => e.action === 'access_check.snapshot');
    expect(snap.details.notAvailable).toEqual([
      expect.stringMatching(/^Last sign-in not available \(licence or permission\)/),
      expect.stringMatching(/^MFA registration not available/),
      expect.stringMatching(/^Eligible role assignments \(PIM\) not available \(licence or permission\).*P2/),
    ]);
    // the person review hint says so too
    const { readCheckSource } = await import('../src/compliance/reconciliation.js');
    const live = await readCheckSource(c.id);
    expect(live.subjects.find((x) => x.id === 'alice@example.com')?.activity).toBe('last sign-in not available (licence or permission)');
  });

  it('reads only guests with the scope guests, with last sign-in and MFA as hints', async () => {
    const c = await s.api('POST', '/compliance/access-checks', { name: 'Entra guests', platformId, source: 'entra', scope: 'guests' });
    const { by } = await snapshotOf(c.id);
    expect(Object.keys(by).sort()).toEqual([
      'gary_old-partner.example#EXT#@example.onmicrosoft.com',
      'ingrid_invited.example#EXT#@example.onmicrosoft.com',
      'paula_fabrikam.example#EXT#@example.onmicrosoft.com',
    ]);
    const { readCheckSource } = await import('../src/compliance/reconciliation.js');
    const live = await readCheckSource(c.id);
    const ingrid = live.subjects.find((x) => x.id.startsWith('ingrid'))!;
    expect(ingrid.activity).toBe('never signed in, no MFA method registered, invitation not accepted');
    expect(ingrid.activityInfo).toEqual({ lastLoginAt: null, passwordWithoutMfa: true });
    expect(live.subjects.find((x) => x.id.startsWith('gary'))!.activity).toMatch(/^last sign-in \d{4}-\d\d-\d\d \(400 days ago\), no MFA/);
  });

  it('fails with the missing permission in plain words when a needed part is not readable', async () => {
    mock.setGraphConsent(['User.Read.All', 'AuditLog.Read.All']);
    await invalidate(platformId);
    const c = await s.api('POST', '/compliance/access-checks', { name: 'Entra groups', platformId, source: 'entra', scope: 'groups' });
    await expect(s.api('POST', `/compliance/access-checks/${c.id}/run`, {})).rejects.toMatchObject({
      body: { code: 'ACCESS_CHECK_ENTRA_READ', detail: expect.stringMatching(/lacks the application permission Group.Read.All/) },
    });
    expect((await s.api('GET', `/compliance/access-checks/${c.id}`)).lastStatus).toBe('failed');
    await invalidate(platformId);
  });

  it('respects the outbound policy: under allowList the host needs an entry', async () => {
    const settings = await s.api('GET', '/settings');
    try {
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
      await expect(s.api('POST', `/compliance/access-checks/${checkId}/run`, {})).rejects.toThrow(/Blocked by the outbound policy/);
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: settings.outboundPolicy, outboundAllowList: settings.outboundAllowList });
    }
  });
});

describe('a person review across Entra ID and Confluent Cloud', () => {
  it('matches the person by UPN and e-mail address on both platforms', async () => {
    const confluent = await import('../src/mock/mockConfluent.js');
    const cc = await s.api('GET', '/platform-presets').then((l: any[]) => l.find((p) => p.kind === 'confluent-cloud'));
    const cp = await s.api('POST', '/platforms', {
      name: 'Confluent for Entra',
      kind: 'confluent-cloud',
      baseUrl: `${s.base}/mock/confluent`,
      config: { ...cc.config, http: { proxy: 'none' } },
      secrets: { username: confluent.DEMO_CONFLUENT.cloudKey, password: confluent.DEMO_CONFLUENT.cloudSecret },
    });
    const cCheck = await s.api('POST', '/compliance/access-checks', {
      name: 'Confluent org',
      platformId: cp.id,
      source: 'confluent',
      scope: 'crn://confluent.cloud/organization=org-demo',
    });
    const eCheck = await s.api('POST', '/compliance/access-checks', { name: 'Entra (person review)', platformId, source: 'entra' });
    const r = await s.api('POST', '/compliance/person-reviews', {
      title: 'Mover: Erika',
      personName: 'Erika Mustermann',
      identifiers: ['Erika.Mustermann@example.com'],
      checkIds: [eCheck.id, cCheck.id],
      fourEyes: true,
    });
    expect(r.sources.map((x: any) => [x.source, x.origin, x.matched])).toEqual([
      ['entra', 'live', 1],
      ['confluent', 'live', 1],
    ]);
    const entra = r.sources[0];
    expect(entra.activity['erika.mustermann@example.com']).toMatch(/^last sign-in .* \(1 days ago\)$/);
    expect(r.items.map((i: any) => `${i.subjectId}: ${i.right}`)).toEqual(
      expect.arrayContaining([
        'erika.mustermann@example.com: app:Payroll/Approver',
        'erika.mustermann@example.com: role:Security Reader (eligible)',
        'erika.mustermann@example.com: CloudClusterAdmin on environment=env-demo1/cloud-cluster=lkc-demo1',
      ]),
    );
  });
});
