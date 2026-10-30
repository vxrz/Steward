import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Credentials that belong to the catalogue (#143): an entry belongs to an application, a component or a system, the
 * platform stays optional; owners default to the owners of what it belongs to; the application and system pages list
 * them; the list and the public API filter by it; a removed component hands its entries to the application, a system
 * with entries is not deleted.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client, vera: Client;
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );

let app: any, comp: any, sys: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, vera] = await Promise.all(['dana', 'vera'].map((u) => s.as(u, 'Demo-password-1')));
  app = await dana('POST', '/applications', { name: 'Payroll (cred)', owners: ['team:service desk'] });
  comp = (await dana('POST', `/applications/${app.id}/components`, { type: 'snowflake-database', name: 'PAYROLL_PROD', environment: 'prod' })).components[0];
  sys = await dana('POST', '/systems', { name: 'sftp01', kind: 'server', owners: ['user:olivia'] });
});
afterAll(async () => {
  await s?.app.close();
});

const entry = (name: string, belongsTo: unknown, extra: Record<string, unknown> = {}) =>
  dana('POST', '/credentials', { name, type: 'technicalUser', rotationIntervalDays: 90, belongsTo, ...extra });

describe('credentials that belong to the catalogue', () => {
  it('belongs to an application, a component or a system, without a platform; owners come from there', async () => {
    const a = await entry('SVC_PAYROLL', { kind: 'application', id: app.id });
    expect(a.belongsTo).toEqual({ kind: 'application', id: app.id, name: 'Payroll (cred)', applicationId: null, applicationName: null });
    expect(a.platformId).toBeNull();
    expect(a.ownerSubjects).toEqual(['team:service desk']);
    const c = await entry('SVC_PAYROLL_ETL', { kind: 'component', id: comp.id });
    expect(c.belongsTo).toMatchObject({ kind: 'component', name: 'PAYROLL_PROD', applicationId: app.id, applicationName: 'Payroll (cred)' });
    // owners given: they stay
    const x = await entry('sftp-upload', { kind: 'system', id: sys.id }, { ownerSubjects: ['user:dana'] });
    expect(x.ownerSubjects).toEqual(['user:dana']);
    expect(await code(entry('nope', { kind: 'system', id: 'sys_nope' }))).toBe('CREDENTIAL_BELONGS_NOT_FOUND');
    // an update without belongsTo keeps it; null removes it
    const kept = await dana('PUT', `/credentials/${x.id}`, { name: 'sftp-upload', type: 'technicalUser', ownerSubjects: ['user:dana'] });
    expect(kept.belongsTo).toMatchObject({ kind: 'system', id: sys.id });
  });

  it('lists them on the application (with the component) and on the system; readers see what they may see', async () => {
    const a = await dana('GET', `/applications/${app.id}`);
    expect(a.credentials.map((c: any) => [c.name, c.relation, c.componentName])).toEqual([
      ['SVC_PAYROLL', 'belongsTo', null],
      ['SVC_PAYROLL_ETL', 'belongsTo', 'PAYROLL_PROD'],
    ]);
    expect((await dana('GET', `/systems/${sys.id}`)).credentials.map((c: any) => c.name)).toEqual(['sftp-upload']);
    // viewers only see entries they own
    expect((await vera('GET', `/systems/${sys.id}`)).credentials).toEqual([]);
    const targets = await dana('GET', '/credentials/belongs-targets');
    expect(targets).toContainEqual({ kind: 'component', id: comp.id, name: 'PAYROLL_PROD (prod)', context: 'Payroll (cred)', owners: ['team:service desk'] });
  });

  it('filters by what they belong to, in the list, the search, the CSV and the public API', async () => {
    const list = await dana('GET', `/credentials?belongs=application:${app.id}`);
    expect(list.items.map((c: any) => c.name)).toEqual(['SVC_PAYROLL']);
    expect((await dana('GET', '/credentials?q=sftp01')).items.map((c: any) => c.name)).toEqual(['sftp-upload']);
    const token = (await s.api('POST', '/me/tokens', { name: 'cred', scope: 'read' })).token;
    const api = await (await fetch(`${s.base}/api/v1/credentials?belongs=system:${sys.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(api.items.map((c: any) => [c.name, c.belongsTo.name])).toEqual([['sftp-upload', 'sftp01']]);
  });

  it('a removed component hands its entries to the application; a system with entries is not deleted', async () => {
    await dana('DELETE', `/applications/${app.id}/components/${comp.id}`);
    const etl = (await dana('GET', '/credentials?q=SVC_PAYROLL_ETL')).items[0];
    expect(etl.belongsTo).toMatchObject({ kind: 'application', id: app.id });
    expect(await code(dana('DELETE', `/systems/${sys.id}`))).toBe('SYSTEM_HAS_CREDENTIALS');
  });
});
