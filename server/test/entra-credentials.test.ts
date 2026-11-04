import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestServer } from './helpers.js';
import { startEntra, type EntraEnv } from './entra-setup.js';

/**
 * Entra ID app secrets and certificates (v0.5.0, docs/ENTRA.md), against the simulated tenant: the monitor check of
 * expiring app credentials and Microsoft 365 service health, and the import into the credentials register.
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

describe('Entra ID monitor check', () => {
  it('reports app credentials that expire, counting rotated ones as replaced', async () => {
    const { appCredentials, entraCheck, expiringApps } = await import('../src/entra/service.js');
    const { getSecrets } = await import('../src/platforms/service.js');
    const p = await s.api('GET', `/platforms/${platformId}`);
    const sec = getSecrets(platformId);
    const { items } = await appCredentials(p, sec);
    expect(items.map((c) => `${c.appName} ${c.type} ${c.name} ${c.daysLeft}`)).toEqual([
      'HR Sync secret old -6',
      'Legacy Reports certificate CN=legacy-reports 2',
      'Payroll secret prod 11',
      'Steward reader secret steward 79',
      'Payroll certificate CN=payroll.example.com 199',
      'HR Sync secret rotation 2026 299',
    ]);
    expect(JSON.stringify(items)).not.toMatch(/hint|dmo/);
    // HR Sync's old secret was replaced by a newer one
    expect(expiringApps(items, 30).map((x) => x.appName)).toEqual(['Legacy Reports', 'Payroll']);
    expect(await entraCheck(p, sec, { mode: 'app-credentials', withinDays: 30, downWithinDays: 7 })).toMatchObject({
      status: 'down',
      message: 'Entra ID: 2 app credential(s) expire within 30 days – Legacy Reports certificate expires in 2 day(s), Payroll secret expires in 11 day(s)',
    });
    expect((await entraCheck(p, sec, { mode: 'app-credentials', apps: ['payroll'] })).status).toBe('degraded');
    expect((await entraCheck(p, sec, { mode: 'app-credentials', apps: ['HR Sync'] })).status).toBe('up');
    expect((await entraCheck(p, sec, { mode: 'app-credentials', apps: ['nope'] })).status).toBe('unknown');
    expect(await entraCheck(p, sec, { mode: 'service-health' })).toMatchObject({
      status: 'degraded',
      message: 'Microsoft 365: Exchange Online serviceDegradation',
    });
    expect((await entraCheck(p, sec, { mode: 'service-health', services: ['Microsoft Teams'] })).status).toBe('up');
  });

  it('runs in a monitor', async () => {
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Entra app credentials',
        failuresBeforeDown: 1,
        checks: [{ id: 'creds', name: 'App credentials', type: 'entra', platform: 'Entra ID', mode: 'app-credentials', apps: ['Payroll'] }],
      },
    });
    const eng = await import('../src/monitors/engine.js');
    await eng.evaluateMonitorNow(monitor.id);
    const st = await s.api('GET', `/monitors/${monitor.id}`);
    expect(st.status).toBe('degraded');
    expect(st.checks[0].last.message).toMatch(/Payroll secret expires in 11 day/);
  });
});

describe('app credentials in the credentials register', () => {
  it('imports secrets and certificates as entries with their expiry, and updates the expiry later', async () => {
    const dry = await s.api('POST', '/credentials/import/entra', { platformId, dryRun: true });
    // HR Sync's old secret ended 6 days ago: within the 30 days kept
    expect(dry).toMatchObject({ dryRun: true, read: 6, created: 6, updated: 0 });
    expect((await s.api('GET', '/credentials?q=Payroll')).items).toHaveLength(0);
    const soon = await s.api('POST', '/credentials/import/entra', { platformId, withinDays: 30 });
    expect(soon.items.map((x: any) => `${x.appName} ${x.type} ${x.action}`)).toEqual([
      'HR Sync secret create',
      'Legacy Reports certificate create',
      'Payroll secret create',
    ]);
    const entry = await s.api('GET', `/credentials/${soon.items[2].credentialId}`);
    expect(entry).toMatchObject({
      name: 'Payroll – client secret “prod”',
      type: 'apiClient',
      platformId,
      tags: ['entra-id'],
      location: {
        text: expect.stringMatching(/^Entra ID: App registrations → Payroll → Certificates & secrets → client secret “prod” \(key id [0-9a-f-]{36}\)$/),
        url: expect.stringMatching(/^https:\/\/entra\.microsoft\.com\/#view\/Microsoft_AAD_RegisteredApps\/ApplicationMenuBlade\/~\/Credentials\/appId\//),
      },
    });
    expect(entry.expiresAt.slice(0, 10)).toBe(soon.items[2].endDateTime.slice(0, 10));
    const all = await s.api('POST', '/credentials/import/entra', { platformId });
    expect(all).toMatchObject({ created: 3, unchanged: 3, updated: 0 });
    // the secret was renewed in Entra ID: the next import moves the expiry, with history and audit entry
    const { db } = await import('../src/db.js');
    db().run('UPDATE credentials SET expires_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', entry.id);
    const again = await s.api('POST', '/credentials/import/entra', { platformId });
    expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 5 });
    const history = await s.api('GET', `/credentials/${entry.id}/history`);
    expect(history[0]).toMatchObject({ kind: 'expiryImported', actor: 'admin', details: { from: '2020-01-01T00:00:00.000Z' } });
    const log = await s.api('GET', `/audit?entityId=${platformId}&limit=10`);
    expect(log.map((e: any) => e.action)).toContain('credential.imported');
    // a viewer may not import; a platform of another kind is refused
    const users = await import('../src/auth/users.js');
    users.createUser({ username: 'vic', roles: ['viewer'], password: 'Own-password-123', mustChangePassword: false });
    const vic = await s.as('vic', 'Own-password-123');
    await expect(vic('POST', '/credentials/import/entra', { platformId })).rejects.toThrow(/403/);
    const gitlab = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gitlab').id;
    await expect(s.api('POST', '/credentials/import/entra', { platformId: gitlab })).rejects.toMatchObject({ body: { code: 'ENTRA_PLATFORM_REQUIRED' } });
  });
});
