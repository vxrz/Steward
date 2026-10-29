import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Owners and other subjects (#143): unknown users and teams are refused (values stored before stay), a renamed team
 * stays the owner everywhere, a deleted team leaves every entry, and administrators see where a user or team is still
 * named.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
});
afterAll(async () => {
  await s?.app.close();
});

describe('subjects', () => {
  it('refuses users and teams that do not exist; keeps what was stored before', async () => {
    expect(await code(s.api('POST', '/applications', { name: 'Typo owner', owners: ['user:dnaa'] }))).toBe('USER_UNKNOWN');
    expect(await code(s.api('POST', '/services', { name: 'Typo team', owners: ['team:opps'] }))).toBe('TEAM_UNKNOWN');
    expect(await code(s.api('POST', '/systems', { name: 'Typo sys', kind: 'server', owners: ['user:nobody'] }))).toBe('USER_UNKNOWN');
    expect(await code(s.api('POST', '/credentials', { name: 'Typo cred', type: 'token', ownerSubjects: ['team:nope'] }))).toBe('TEAM_UNKNOWN');
    const app = await s.api('POST', '/applications', { name: 'Real owners', owners: ['user:dana', 'team:service desk'] });
    expect(app.owners).toEqual(['user:dana', 'team:service desk']);
    // an owner stored before (here: written directly, like data from an older version) does not block a save
    const { db } = await import('../src/db.js');
    db().run('UPDATE applications SET owners = ? WHERE id = ?', JSON.stringify(['user:dana', 'user:left-long-ago']), app.id);
    const saved = await s.api('PUT', `/applications/${app.id}`, { name: 'Real owners', owners: ['user:dana', 'user:left-long-ago'] });
    expect(saved.owners).toContain('user:left-long-ago');
  });

  it('a renamed team stays the owner everywhere; a deleted team leaves every entry', async () => {
    const team = await s.api('POST', '/teams', { name: 'Data Platform', members: ['dana'] });
    const app = await s.api('POST', '/applications', { name: 'Team owned', owners: ['team:data platform'] });
    const svc = await s.api('POST', '/services', { name: 'Team service', owners: ['team:data platform', 'user:olivia'] });
    const cred = await s.api('POST', '/credentials', { name: 'Team cred', type: 'token', ownerSubjects: ['team:data platform'] });
    const proc = (await s.api('GET', '/processes'))[0];
    await s.api('PUT', `/processes/${proc.id}/access`, { acl: [{ subject: 'team:data platform', permissions: ['view', 'run'] }] });

    const refs = await s.api('GET', `/teams/${team.id}/references`);
    const tables = Object.fromEntries(refs.map((r: any) => [`${r.table}.${r.column}`, r]));
    expect(tables['applications.owners']).toMatchObject({ count: 1, examples: ['Team owned'] });
    expect(tables['services.owners'].count).toBe(1);
    expect(tables['credentials.owner_subjects'].count).toBe(1);
    expect(tables['processes.acl'].count).toBe(1);

    await s.api('PUT', `/teams/${team.id}`, { name: 'Data Analytics', members: ['dana'] });
    const key = 'team:data analytics';
    expect((await s.api('GET', `/applications/${app.id}`)).owners).toEqual([key]);
    expect((await s.api('GET', `/services/${svc.id}`)).owners).toEqual([key, 'user:olivia']);
    expect((await s.api('GET', `/credentials/${cred.id}`)).ownerSubjects).toEqual([key]);
    const { db } = await import('../src/db.js');
    const aclOf = () => db().get<{ acl: string }>('SELECT acl FROM processes WHERE id = ?', proc.id)!.acl;
    expect(aclOf()).toContain(key);
    const e = (await s.api('GET', `/audit?entityType=team&entityId=${team.id}&limit=5`))[0];
    expect(e.summary).toContain('renamed from "Data Platform"');

    await s.api('DELETE', `/teams/${team.id}`);
    expect((await s.api('GET', `/applications/${app.id}`)).owners).toEqual([]);
    expect((await s.api('GET', `/services/${svc.id}`)).owners).toEqual(['user:olivia']);
    expect(aclOf()).not.toContain('team:');
  });

  it('shows where a user is still named', async () => {
    const users = await s.api('GET', '/users');
    const olivia = users.find((u: any) => u.username === 'olivia');
    const refs = await s.api('GET', `/users/${olivia.id}/references`);
    expect(refs.find((r: any) => r.table === 'services' && r.column === 'owners')?.examples).toContain('Team service');
  });
});
