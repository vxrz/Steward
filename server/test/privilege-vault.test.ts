import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PVAULT_KIND, pvFolderProblem, pvFolderWithin, pvPrivileged } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';
import { deniedPath, stripValues } from '../src/platforms/deniedPaths.js';
import { pvaultSpec } from '../src/platforms/pvaultSpec.js';

/**
 * IBM Security Verify Privilege Vault (#205, docs/IBM-PAM.md) against the simulated vault (mock/mockPrivilegeVault.ts):
 * the preset with sign-in and refresh, the connection test naming missing permissions, paging, the access source
 * (permissions directly, through groups and folders, roles), hygiene findings, privileged use, and that no value
 * endpoint is ever called – not by Steward's readers, not by a process step – and value keys never get stored.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let platformId: string;
let mock: typeof import('../src/mock/mockPrivilegeVault.js');
let preset: any;

const VALUES = ['db1-root-Pa55!', 'dc1-Adm1n-Pa55!', 'sql1-sa-Pa55!', 'backup-Pa55!', 'web-deploy-Pa55!', 'vpn-Pa55!'];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mock = await import('../src/mock/mockPrivilegeVault.js');
  mock.resetPvault();
  preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === PVAULT_KIND);
  const p = await s.api('POST', '/platforms', {
    name: 'Vault',
    kind: PVAULT_KIND,
    baseUrl: `${s.base}/mock/pvault/SecretServer`,
    config: { ...preset.config, http: { proxy: 'none' } },
    secrets: { username: mock.DEMO_PVAULT.username, password: mock.DEMO_PVAULT.password },
  });
  platformId = p.id;
});
/** A vault client on the test platform (as Steward's readers use it). */
async function client() {
  const { PvClient } = await import('../src/pvault/client.js');
  const { getSecrets } = await import('../src/platforms/service.js');
  return new PvClient(await s.api('GET', `/platforms/${platformId}`), getSecrets(platformId));
}

afterAll(async () => {
  mock?.resetPvault();
  await s?.app.close();
});

describe('the value endpoints are refused for the vault kind', () => {
  const at = (p: string) => `https://pam.example.local/SecretServer${p}`;
  it('refuses a secret itself, its fields, files, restricted reads, exports and value searches', () => {
    for (const p of [
      '/api/v1/secrets/12',
      '/api/v1/secrets/12/',
      '/api/v1/secrets/12/fields/password',
      '/api/v1/Secrets/12/Fields/Password',
      '/api/v1/secrets/12/fields/private-key',
      '/api/v1/secrets/12/restricted',
      '/api/v1/secrets/12/restricted/fields/password',
      '/api/v2/secrets/12',
      '/api/v1/secrets/12/summary/../fields/password',
      '/api/v1/secrets%2F12%2Ffields%2Fpassword',
      '/api/v1/secrets/12;x=1/fields/password',
      '/api/v1//secrets//12',
      '/api/v1/secrets/export',
      '/api/v1/secrets/12/settings',
      '/api/v1/one-time-password-code/12',
      '/internals/secret-detail/12/password-status',
      '/webservices/SSWebservice.asmx',
      '/api/v1/folders/3/export',
      '/api/v1/secrets?filter.extendedFields=Password',
      '/api/v1/secrets?filter.searchField=password&filter.searchText=abc',
      '/api/v1/secrets?FILTER.SEARCHFIELDSLUG=password',
    ])
      expect(deniedPath(PVAULT_KIND, at(p)), p).not.toBeNull();
    expect(deniedPath(PVAULT_KIND, at('/api/v1/secrets/%E0%A4%A'))).toMatch(/decoded/);
  });

  it('allows the metadata endpoints – and every endpoint of the built-in API description', () => {
    for (const p of [
      '/api/v1/secrets?filter.includeRestricted=true&skip=0&take=500',
      '/api/v1/secrets/lookup',
      '/api/v1/secrets/12/summary',
      '/api/v1/secrets/12/audits?take=1',
      '/api/v1/secret-permissions?filter.secretId=12',
      '/api/v1/reports/export',
      '/oauth2/token',
    ])
      expect(deniedPath(PVAULT_KIND, at(p)), p).toBeNull();
    const spec = pvaultSpec() as { paths: Record<string, unknown> };
    for (const p of Object.keys(spec.paths)) expect(deniedPath(PVAULT_KIND, at(p.replace('{id}', '12'))), p).toBeNull();
    // other kinds are not affected
    expect(deniedPath('generic', at('/api/v1/secrets/12/fields/password'))).toBeNull();
  });

  it('strips value keys from answers', () => {
    const body = { records: [{ id: 1, name: 'x', items: [{ slug: 'password', ItemValue: 'secret!' }], extendedFields: [{ value: 'secret!' }] }] };
    expect(JSON.stringify(stripValues(PVAULT_KIND, body))).not.toContain('secret!');
    expect(stripValues(PVAULT_KIND, body).records[0]).toMatchObject({ id: 1, name: 'x', items: [{ slug: 'password' }] });
    expect(stripValues('generic', body)).toBe(body);
  });

  it('a process step cannot read a value, whatever the path looks like', async () => {
    const before = mock.pvaultCalls.valueEndpoints;
    const proc = await s.api('POST', '/processes', {
      definition: {
        name: 'Try to read a value',
        connections: [{ slot: 'vault', kind: PVAULT_KIND }],
        steps: [
          { id: 'one', type: 'http', connection: 'vault', method: 'GET', path: '/api/v1/secrets/101', onError: 'continue', saveAs: 'one' },
          { id: 'two', type: 'http', connection: 'vault', method: 'GET', path: '/api/v1/secrets/101/fields/password', onError: 'continue', saveAs: 'two' },
          { id: 'three', type: 'http', connection: 'vault', method: 'GET', path: '/api/v1/secrets/%31%30%31', onError: 'continue', saveAs: 'three' },
          { id: 'four', type: 'http', connection: 'vault', method: 'GET', path: `${s.base}/mock/pvault/SecretServer/api/v1/secrets/101`, saveAs: 'four' },
        ],
      },
    });
    const run = await s.waitRun((await s.api('POST', '/runs', { processId: proc.id, bindings: { vault: platformId } })).id, ['succeeded', 'failed']);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/never reads secret values/);
    const full = JSON.stringify(await s.api('GET', `/runs/${run.id}`));
    expect(full.match(/never reads secret values/g)!.length).toBeGreaterThanOrEqual(4);
    for (const v of VALUES) expect(full).not.toContain(v);
    expect(mock.pvaultCalls.valueEndpoints).toBe(before);
  });
});

describe('the platform', () => {
  it('has a preset: token request with refresh, the built-in API description, and its test reads every part', async () => {
    expect(preset).toMatchObject({
      baseUrl: 'https://pam.example.local/SecretServer',
      config: {
        auth: { type: 'token_request', request: { url: '/oauth2/token', bodyType: 'form' }, refresh: { tokenPath: 'refresh_token' } },
        testPath: '/api/v1/users/current',
      },
      specCount: 1,
    });
    expect(preset.secretFields.map((f: any) => f.key)).toEqual(['username', 'password']);
    const r = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Signed in as steward-reader – every read Steward makes works/);
    expect(r.checks.every((c: any) => c.ok)).toBe(true);
    expect(r.token.expiresAt).toBeTruthy();
  });

  it('names the missing permissions in plain words', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Vault (limited)',
      kind: PVAULT_KIND,
      baseUrl: `${s.base}/mock/pvault/SecretServer`,
      config: { ...preset.config, http: { proxy: 'none' } },
      secrets: { username: mock.DEMO_PVAULT.limited, password: mock.DEMO_PVAULT.password },
    });
    const r = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/missing: Secret audit, Roles, Role assignments/);
    const bad = Object.fromEntries(r.checks.filter((c: any) => !c.ok).map((c: any) => [c.name, c.message]));
    expect(bad.Roles).toMatch(/HTTP 403 – the service account may not list roles and role assignments – the role permission "View Roles"/);
    expect(bad['Secret audit']).toMatch(/View Secret Audit/);
    // a wrong password: the test fails and says the sign-in failed
    await s.api('PUT', `/platforms/${p.id}/secrets`, { password: 'wrong' });
    const f = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(f.ok).toBe(false);
    expect(f.message).toMatch(/Login request POST .*\/oauth2\/token failed with HTTP 400/);
    expect(JSON.stringify(f)).not.toContain(mock.DEMO_PVAULT.password);
    await s.api('DELETE', `/platforms/${p.id}`);
  });

  it('sends the domain only when the variable is set', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Vault (domain)',
      kind: PVAULT_KIND,
      baseUrl: `${s.base}/mock/pvault/SecretServer`,
      config: { ...preset.config, variables: { domain: 'OTHER' }, http: { proxy: 'none' } },
      secrets: { username: mock.DEMO_PVAULT.username, password: mock.DEMO_PVAULT.password },
    });
    expect((await s.api('POST', `/platforms/${p.id}/test`, {})).ok).toBe(false);
    const cur = await s.api('GET', `/platforms/${p.id}`);
    await s.api('PUT', `/platforms/${p.id}`, { config: { ...cur.config, variables: { domain: mock.DEMO_PVAULT.domain } } });
    expect((await s.api('POST', `/platforms/${p.id}/test`, {})).ok).toBe(true);
    await s.api('DELETE', `/platforms/${p.id}`);
  });

  it('renews an expired token with the refresh token, and signs in again when the vault refuses it', async () => {
    const c = await client();
    const { renewToken } = await import('../src/platforms/http.js');
    await renewToken(c.platform, c.secrets);
    // a token that lives 29 s counts as expired at once (30 s margin): the next calls refresh it
    mock.setPvaultTokenLifetime(29);
    await renewToken(c.platform, c.secrets);
    const before = { ...mock.pvaultCalls };
    await c.currentUser();
    await c.currentUser();
    expect(mock.pvaultCalls.refresh - before.refresh).toBe(2);
    expect(mock.pvaultCalls.password - before.password).toBe(0);
    // the vault forgot the refresh tokens (a restart): the refresh fails, Steward signs in again
    mock.resetPvault();
    mock.setPvaultTokenLifetime(29);
    const b2 = { ...mock.pvaultCalls };
    await c.currentUser();
    expect(mock.pvaultCalls.password - b2.password).toBe(1);
    // an access token the vault ended early: 401, then a new sign-in
    mock.setPvaultTokenLifetime(1200);
    await renewToken(c.platform, c.secrets);
    mock.expirePvaultTokens();
    const b3 = { ...mock.pvaultCalls };
    expect((await c.currentUser()).userName).toBe('steward-reader');
    expect(mock.pvaultCalls.password - b3.password).toBe(1);
  });

  it('reads every page (skip/take, hasNext)', async () => {
    const c = await client();
    mock.setPvaultPageCap(2);
    try {
      const before = mock.pvaultCalls.requests;
      const list = await c.searchSecrets();
      expect(list.map((x) => x.id)).toEqual([101, 102, 103, 104, 105, 106]);
      expect(mock.pvaultCalls.requests - before).toBe(3);
      expect((await c.secretsIn('\\Privileged')).map((x) => x.name)).toEqual(['Administrator@dc1', 'sa@sql1']);
      expect((await c.users()).length).toBe(7);
    } finally {
      mock.setPvaultPageCap(1000);
    }
  });
});

describe('shared helpers', () => {
  it('match folders and privileged scope', () => {
    expect(pvFolderWithin('\\IT\\Servers', '\\IT')).toBe(true);
    expect(pvFolderWithin('\\ITX', '\\IT')).toBe(false);
    expect(pvFolderWithin('\\it', '\\IT\\')).toBe(true);
    expect(pvPrivileged({ folderPath: '\\Privileged\\Domain', templateName: 'x' }, { folders: ['\\Privileged'], templates: [] })).toBe(true);
    expect(pvPrivileged({ folderPath: '\\Shared', templateName: 'Windows Account' }, { folders: [], templates: ['windows account'] })).toBe(true);
    expect(pvFolderProblem('IT')).toMatch(/starts with/);
    expect(pvFolderProblem('\\IT\u0000')).toMatch(/control/);
    expect(pvFolderProblem('')).toBeNull();
  });
});

describe('access reviews of the vault', () => {
  let checkId: string;
  it('needs a vault platform and a folder path', async () => {
    const base = { name: 'Vault access', platformId, source: 'privilege-vault', cron: '0 6 * * *' };
    await expect(s.api('POST', '/compliance/access-checks', { ...base, scope: 'IT' })).rejects.toThrow(/starts with/);
    const other = await s.api('POST', '/platforms', { name: 'Other', kind: 'generic', baseUrl: 'https://api.example.com', config: { auth: { type: 'none' } } });
    await expect(s.api('POST', '/compliance/access-checks', { ...base, platformId: other.id })).rejects.toMatchObject({
      body: { code: 'ACCESS_CHECK_PVAULT_SOURCE' },
    });
    const c = await s.api('POST', '/compliance/access-checks', base);
    expect(c).toMatchObject({ source: 'privilege-vault', scope: null, platformKind: PVAULT_KIND });
    checkId = c.id;
  });

  it('snapshots who reaches which secret and folder – directly, through groups, inherited – and the roles', async () => {
    const before = mock.pvaultCalls.valueEndpoints;
    const r = await s.api('POST', `/compliance/access-checks/${checkId}/run`, {});
    expect(r.baseline).toBe(true);
    const snap = await s.api('GET', `/compliance/access-checks/${checkId}/snapshots/${r.snapshot.id}`);
    const by = Object.fromEntries(snap.data.map((x: any) => [x.id, x]));
    expect(Object.keys(by).sort()).toEqual(['alice', 'corp\\bob', 'corp\\erika', 'group:hidden', 'limited-reader', 'steward-reader', 'svc-backup']);
    expect(by.alice.rights).toEqual([
      'Folder \\Privileged: Owner (secrets: Owner)',
      'Role Administrator',
      'Secret \\Privileged\\Domain\\Administrator@dc1 (#102): Owner from folder \\Privileged',
    ]);
    expect(by['corp\\bob'].rights).toEqual([
      'Folder \\IT: Owner (secrets: Owner) via group Domain Admins',
      'Folder \\Shared: Edit (secrets: Edit)',
      'Role User',
      'Secret \\IT\\Servers\\root@db1 (#101): Owner from folder \\IT via group Domain Admins',
      'Secret \\IT\\Servers\\web-deploy (#105): Owner',
      'Secret \\Shared\\backup-svc (#104): Edit from folder \\Shared',
    ]);
    expect(by['corp\\erika'].rights).toEqual([
      'Folder \\IT: Owner (secrets: Owner) via group Domain Admins',
      'Folder \\Privileged: View (secrets: View) via group DB Admins',
      'Role User via group Domain Admins',
      'Secret \\IT\\Servers\\root@db1 (#101): Owner from folder \\IT via group Domain Admins',
      'Secret \\Privileged\\Domain\\Administrator@dc1 (#102): View from folder \\Privileged via group DB Admins',
      'Secret \\Privileged\\sa@sql1 (#103): Edit via group DB Admins',
      'Secret \\Shared\\vpn-shared (#106): Owner',
    ]);
    // members the account may not read: the group stays a subject
    expect(by['group:hidden']).toMatchObject({ type: 'group', rights: ['Secret \\IT\\Servers\\web-deploy (#105): View'] });
    expect(by['svc-backup']).toMatchObject({ type: 'technical', rights: ['Role User'] });
    // e-mail address and plain user name as aliases (person reviews); the disabled user's group rights are not given to it
    expect(by['corp\\erika'].aliases).toEqual(expect.arrayContaining(['erika', 'erika.mustermann@example.com']));
    expect(by['corp\\gone']).toBeUndefined();
    expect(mock.pvaultCalls.valueEndpoints).toBe(before);
  });

  it('a new folder permission is an undocumented change', async () => {
    mock.addPvaultFolderPermission(5, 10, null, 'Owner');
    const r = await s.api('POST', `/compliance/access-checks/${checkId}/run`, {});
    expect(r.findings.map((f: any) => [f.subjectId, f.granted])).toEqual([
      ['alice', ['Folder \\Shared: Owner (secrets: Owner)', 'Secret \\Shared\\backup-svc (#104): Owner from folder \\Shared']],
    ]);
  });

  it('is part of person reviews across sources: the vault and Confluent find Erika by e-mail address', async () => {
    const cm = await import('../src/mock/mockConfluent.js');
    const ccPreset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'confluent-cloud');
    const confluent = await s.api('POST', '/platforms', {
      name: 'Confluent Cloud',
      kind: 'confluent-cloud',
      baseUrl: `${s.base}/mock/confluent`,
      config: { ...ccPreset.config, http: { proxy: 'none' } },
      secrets: { username: cm.DEMO_CONFLUENT.cloudKey, password: cm.DEMO_CONFLUENT.cloudSecret },
    });
    const cc = await s.api('POST', '/compliance/access-checks', {
      name: 'Confluent env',
      platformId: confluent.id,
      source: 'confluent',
      scope: 'crn://confluent.cloud/organization=org-demo/environment=env-demo1',
      cron: '0 6 * * *',
    });
    const r = await s.api('POST', '/compliance/person-reviews', {
      title: 'Mover: Erika',
      personName: 'Erika Mustermann',
      identifiers: ['erika.mustermann@example.com'],
      checkIds: [checkId, cc.id],
      fourEyes: true,
    });
    expect(r.sources.map((x: any) => [x.source, x.origin, x.matched])).toEqual([
      ['privilege-vault', 'live', 1],
      ['confluent', 'live', 1],
    ]);
    const vault = r.items.filter((i: any) => i.checkId === checkId);
    expect(vault.map((i: any) => i.right)).toContain('Secret \\Privileged\\sa@sql1 (#103): Edit via group DB Admins');
    expect(vault[0].matchedAliases).toEqual(['erika.mustermann@example.com']);
    expect(vault[0].subjectActivity).toMatch(/last login/);
    expect(r.items.filter((i: any) => i.checkId === cc.id).map((i: any) => i.right)).toEqual([
      'CloudClusterAdmin on environment=env-demo1/cloud-cluster=lkc-demo1',
    ]);
  });
});

describe('hygiene', () => {
  const ALL = { folders: ['\\Privileged'], templates: ['Windows Account'], maxAgeDays: 90 };
  it('finds failed heartbeats, old and expired passwords, automatic changing off, missing owners and privileged secrets without checkout or approval', async () => {
    const { vaultHygiene } = await import('../src/pvault/hygiene.js');
    const { getSecrets } = await import('../src/platforms/service.js');
    mock.resetPvault();
    const h = await vaultHygiene(await s.api('GET', `/platforms/${platformId}`), getSecrets(platformId), ALL);
    expect(h).toMatchObject({ secrets: 6, privileged: 2 });
    const by = (id: number) => h.findings.filter((f) => f.secretId === id).map((f) => f.kind);
    expect(by(101)).toEqual([]);
    expect(by(102)).toEqual([]);
    expect(by(103)).toEqual(['heartbeat', 'notRotated', 'expired', 'autoChangeOff', 'noOwner', 'noCheckout', 'noApproval']);
    expect(by(104)).toEqual(['heartbeat', 'notRotated', 'autoChangeOff', 'noOwner']);
    expect(by(105)).toEqual([]);
    expect(by(106)).toEqual(['notRotated', 'autoChangeOff']);
    expect(h.counts).toEqual({ heartbeat: 2, notRotated: 3, expired: 1, autoChangeOff: 3, noOwner: 2, noCheckout: 1, noApproval: 1 });
    // privileged first
    expect(h.findings[0]).toMatchObject({ secretId: 103, privileged: true });
    expect(h.findings.find((f) => f.secretId === 104 && f.kind === 'notRotated')!.detail).toMatch(/out of sync/);
    // a folder only, some kinds only
    const only = await vaultHygiene(await s.api('GET', `/platforms/${platformId}`), getSecrets(platformId), { ...ALL, folder: '\\Shared', kinds: ['noOwner'] });
    expect(only.findings.map((f) => f.secret)).toEqual(['backup-svc']);
  });

  it('the monitor check: degraded with the findings', async () => {
    const check = {
      id: 'v',
      name: 'Vault',
      type: 'privilege-vault',
      platform: platformId,
      privilegedFolders: ['\\Privileged'],
      privilegedTemplates: ['Windows Account'],
    };
    const r = await s.api('POST', '/monitors/check-preview', { check });
    expect(r).toMatchObject({ status: 'degraded' });
    expect(r.message).toMatch(/^Vault: 13 finding\(s\) in 6 secrets, 7 on privileged secrets – 2 failed heartbeat, 3 not rotated, 1 expired/);
    // only automatic changing in \\Shared, with enough allowed: up
    const up = await s.api('POST', '/monitors/check-preview', {
      check: { id: 'v', name: 'Vault', type: 'privilege-vault', platform: platformId, kinds: ['autoChangeOff'], folder: '\\Shared', maxFindings: 5 },
    });
    expect(up).toMatchObject({ status: 'up' });
    expect(up.message).toMatch(/2 finding\(s\), at most 5 allowed/);
  });

  it('the hygiene template publishes the same findings (pv.hygiene)', async () => {
    const before = mock.pvaultCalls.valueEndpoints;
    mock.setPvaultPageCap(2);
    try {
      const proc = await s.api('POST', '/processes', { templateId: '93-privilege-vault-hygiene' });
      const run = await s.waitRun(
        (await s.api('POST', '/runs', { processId: proc.id, bindings: { vault: platformId }, inputs: { privilegedTemplates: 'Windows Account' } })).id,
        ['succeeded', 'failed'],
      );
      expect([run.status, run.error]).toEqual(['succeeded', null]);
      const d = await s.api('GET', '/datasets/pv.hygiene');
      const by = Object.fromEntries(d.rows.map((r: any) => [r.Secret, r]));
      expect(Object.keys(by).sort()).toEqual(['Administrator@dc1', 'backup-svc', 'root@db1', 'sa@sql1', 'vpn-shared', 'web-deploy']);
      expect(by['sa@sql1']).toMatchObject({
        Privileged: 'yes',
        _status: 'critical',
        Findings: 'heartbeat Failed, not rotated for 200 days, expired 20 days ago, automatic changing off, no owner, no checkout, no approval',
      });
      expect(by['backup-svc'].Findings).toBe('heartbeat AccountLockedOut, last password change failed, automatic changing off, no owner');
      expect(by['root@db1']).toMatchObject({ Findings: '', _status: 'good' });
      expect(d.metrics).toMatchObject({
        secrets: 6,
        privileged: 2,
        findings: 13,
        heartbeat: 2,
        notRotated: 3,
        expired: 1,
        autoChangeOff: 3,
        noOwner: 2,
        noCheckout: 1,
        noApproval: 1,
      });
      expect(mock.pvaultCalls.valueEndpoints).toBe(before);
    } finally {
      mock.setPvaultPageCap(1000);
    }
  });
});

describe('privileged use', () => {
  it('reads views, checkouts and access requests of the privileged secrets in the period', async () => {
    const { privilegedUse } = await import('../src/pvault/service.js');
    const { getSecrets } = await import('../src/platforms/service.js');
    const now = Date.now();
    const r = await privilegedUse(await s.api('GET', `/platforms/${platformId}`), getSecrets(platformId), {
      from: new Date(now - 30 * 86_400_000).toISOString(),
      to: new Date(now).toISOString(),
      folders: ['\\Privileged'],
      templates: [],
    });
    expect(r.secrets).toBe(2);
    expect(r.events.map((e) => [e.secret, e.action, e.user])).toEqual([
      ['sa@sql1', 'ACCESS REQUEST DENIED', 'erika'],
      ['sa@sql1', 'EDIT', 'Alice Admin'],
      ['Administrator@dc1', 'ACCESS REQUEST APPROVED', 'bob'],
      ['Administrator@dc1', 'VIEW', 'Alice Admin'],
      ['Administrator@dc1', 'CHECKOUT', 'Erika Mustermann'],
      ['Administrator@dc1', 'CHECKIN', 'Erika Mustermann'],
      ['sa@sql1', 'PASSWORDDISPLAYED', 'Bob Builder'],
    ]);
    expect(r.events.find((e) => e.action === 'CHECKOUT')!.ticket).toBe('CHG-1234');
    await expect(
      privilegedUse(await s.api('GET', `/platforms/${platformId}`), getSecrets(platformId), {
        from: '2026-01-02',
        to: '2026-01-01',
        folders: [],
        templates: [],
      }),
    ).rejects.toThrow(/ends before/);
  });

  it('the privileged-use template publishes the uses (pv.privileged-use)', async () => {
    const proc = await s.api('POST', '/processes', { templateId: '94-privilege-vault-privileged-use' });
    const run = await s.waitRun((await s.api('POST', '/runs', { processId: proc.id, bindings: { vault: platformId }, inputs: { days: 30 } })).id, [
      'succeeded',
      'failed',
    ]);
    expect([run.status, run.error]).toEqual(['succeeded', null]);
    const d = await s.api('GET', '/datasets/pv.privileged-use');
    expect(d.rows.map((r: any) => r.Action)).toEqual([
      'ACCESS REQUEST DENIED',
      'EDIT',
      'ACCESS REQUEST APPROVED',
      'VIEW',
      'CHECKOUT',
      'CHECKIN',
      'PASSWORDDISPLAYED',
    ]);
    expect(d.metrics).toMatchObject({ uses: 7, checkouts: 1, requests: 2, secrets: 2 });
    expect(d.rows[0]).toMatchObject({ Secret: 'sa@sql1', Folder: '\\Privileged', User: 'erika' });
  });
});

describe('evidence packs', () => {
  it('a pack of the vault platform holds its privileged use of the period, signed with the rest', async () => {
    const cur = await s.api('GET', `/platforms/${platformId}`);
    await s.api('PUT', `/platforms/${platformId}`, { config: { ...cur.config, variables: { ...cur.config.variables, privilegedFolders: '\\Privileged' } } });
    const p = await s.api('POST', '/compliance/evidence-packs', {
      title: 'Vault Q4',
      scope: { platformId },
      from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    let done: any;
    for (let i = 0; i < 600 && (done = await s.api('GET', `/compliance/evidence-packs/${p.id}`)).status === 'building'; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(done).toMatchObject({ status: 'ready', error: null });
    const { loginCookie, authHeaders } = await import('./helpers.js');
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const res = await fetch(`${s.base}/api/compliance/evidence-packs/${p.id}/download`, { headers: { ...authHeaders(cookie), 'x-sm-client': '1' } });
    const file = path.join(s.dataDir, 'vault-pack.zip');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const zip = await ZipReader.open(file);
    const events = JSON.parse((await zip.read(zip.find(`privileged-use/${platformId}/events.json`)!)).toString());
    expect(events).toMatchObject({ platformId, privileged: { folders: ['\\Privileged'], templates: [] }, secrets: 2, truncated: false });
    expect(events.events.map((e: any) => e.action)).toEqual([
      'ACCESS REQUEST DENIED',
      'EDIT',
      'ACCESS REQUEST APPROVED',
      'VIEW',
      'CHECKOUT',
      'CHECKIN',
      'PASSWORDDISPLAYED',
    ]);
    expect((await zip.read(zip.find(`privileged-use/${platformId}/events.csv`)!)).toString()).toMatch(/^at,secretId,secret,folder,user,action,notes,ticket/);
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(index.privilegedUse).toMatchObject([{ platformId, events: 7, secrets: 2 }]);
    expect((await verifyPack(file)).problems).toEqual([]);
    fs.rmSync(file);
  });
});

describe('credentials register link', () => {
  const ENTRY = { name: 'SQL sa account', type: 'technicalUser', ownerSubjects: [], rotationIntervalDays: 90 };
  let id: string;
  it('links an entry to its vault secret and reads its metadata: rotation overdue, expired', async () => {
    mock.resetPvault();
    const found = await s.api('GET', `/credentials/vault-secrets?platformId=${platformId}&q=sa`);
    expect(found).toEqual([{ id: 103, name: 'sa@sql1', folderPath: '\\Privileged', templateName: 'SQL Server Account' }]);
    const other = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'generic');
    await expect(s.api('POST', '/credentials', { ...ENTRY, vault: { platformId: other.id, secretId: 103 } })).rejects.toMatchObject({
      body: { code: 'CREDENTIAL_VAULT_PLATFORM' },
    });
    const c = await s.api('POST', '/credentials', { ...ENTRY, vault: { platformId, secretId: 103 } });
    id = c.id;
    expect(c.vault).toEqual({ platformId, secretId: 103, readout: null });
    const r = await s.api('POST', `/credentials/${id}/vault/read`, {});
    expect(r.vault.readout).toMatchObject({
      error: null,
      secret: { id: 103, name: 'sa@sql1', template: 'SQL Server Account', folder: '\\Privileged', autoChangeEnabled: false, heartbeat: 'Failed' },
    });
    // the vault's last change (200 days ago) is the last rotation: overdue; its expiry (20 days ago) the entry's
    expect(r.dues.find((d: any) => d.kind === 'rotation')).toMatchObject({ status: 'overdue' });
    expect(r.dues.find((d: any) => d.kind === 'expiry')).toMatchObject({ status: 'expired' });
    expect(r.status).toBe('expired');
    // an update that does not name the link keeps it
    const u = await s.api('PUT', `/credentials/${id}`, { ...ENTRY, description: 'kept', version: r.version });
    expect(u.vault).toMatchObject({ secretId: 103, readout: { secret: { name: 'sa@sql1' } } });
  });

  it('a rotation in the vault moves the due date and is a history event', async () => {
    const c = await s.api('POST', '/credentials', { ...ENTRY, name: 'db1 root', vault: { platformId, secretId: 101 } });
    await s.api('POST', `/credentials/${c.id}/vault/read`, {});
    mock.rotatePvaultSecret(101);
    const r = await s.api('POST', `/credentials/${c.id}/vault/read`, {});
    expect(Date.parse(r.vault.readout.secret.lastChangeAt)).toBeGreaterThan(Date.now() - 86_400_000);
    expect(r.dues.find((d: any) => d.kind === 'rotation').daysLeft).toBeGreaterThanOrEqual(89);
    const h = await s.api('GET', `/credentials/${c.id}/history`);
    expect(h[0]).toMatchObject({ kind: 'rotated', actor: 'system', comment: 'Rotated in the vault' });
    const log = await s.api('GET', `/audit?entityType=credential&entityId=${c.id}&limit=5`);
    expect(log.map((e: any) => e.action)).toContain('credential.vault_rotated');
  });

  it('the job reads stale links; a failed read keeps what was read, with the error', async () => {
    const { runVaultLinkJob } = await import('../src/credentials/vault.js');
    expect(await runVaultLinkJob()).toBe(0);
    expect(await runVaultLinkJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(2);
    await s.api('PUT', `/platforms/${platformId}/secrets`, { password: 'wrong' });
    try {
      const r = await s.api('POST', `/credentials/${id}/vault/read`, {});
      expect(r.vault.readout.error).toMatch(/failed with HTTP 400/);
      expect(r.vault.readout.secret.name).toBe('sa@sql1');
    } finally {
      await s.api('PUT', `/platforms/${platformId}/secrets`, { password: mock.DEMO_PVAULT.password });
    }
  });
});

describe('values never get stored', () => {
  it('drops field values a summary carries (a later version, a proxy) before anything is stored or logged', async () => {
    mock.setPvaultLeak(true);
    try {
      const proc = await s.api('POST', '/processes', {
        definition: {
          name: 'Read summaries',
          connections: [{ slot: 'vault', kind: PVAULT_KIND }],
          steps: [
            { id: 'list', type: 'http', connection: 'vault', method: 'GET', path: '/api/v1/secrets', saveAs: 'list' },
            { id: 'one', type: 'http', connection: 'vault', method: 'GET', path: '/api/v1/secrets/103/summary', saveAs: 'one' },
            { id: 'pub', type: 'publish', dataset: 'test.vault-leak', rows: 'vars.list.body.records' },
          ],
        },
      });
      const run = await s.waitRun((await s.api('POST', '/runs', { processId: proc.id, bindings: { vault: platformId } })).id, ['succeeded', 'failed']);
      expect(run.status).toBe('succeeded');
      const cred = await s.api('POST', '/credentials', { name: 'Leak check', type: 'password', ownerSubjects: [], vault: { platformId, secretId: 103 } });
      await s.api('POST', `/credentials/${cred.id}/vault/read`, {});
      const stored = JSON.stringify([
        await s.api('GET', `/runs/${run.id}`),
        await s.api('GET', '/datasets/test.vault-leak'),
        await s.api('GET', `/credentials/${cred.id}`),
      ]);
      expect(stored).toContain('sa@sql1');
      for (const v of VALUES) expect(stored).not.toContain(v);
      // the database and the logs of the data folder hold none either
      const files = fs.readdirSync(s.dataDir, { recursive: true }) as string[];
      for (const f of files) {
        const p = path.join(s.dataDir, f);
        if (!fs.statSync(p).isFile() || fs.statSync(p).size > 50 * 1024 * 1024) continue;
        const text = fs.readFileSync(p).toString('latin1');
        for (const v of VALUES) expect(text.includes(v), `${f} contains a value`).toBe(false);
      }
    } finally {
      mock.setPvaultLeak(false);
    }
  });
});
