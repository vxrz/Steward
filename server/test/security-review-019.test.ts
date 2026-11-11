import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/** Regression tests for the low findings of the security review of 0.19.0 (the others have files of their own). */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
const PW = 'Dana-password-123';

const refused = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, body: {} as any }),
    (e: { status: number; body: any }) => ({ status: e.status, body: e.body }),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { temporaryPassword } = await s.api('POST', '/users', { username: 'dana', roles: ['designer'] });
  await (
    await s.as('dana', temporaryPassword)
  )('POST', '/auth/password', { current: temporaryPassword, next: PW });
  dana = await s.as('dana', PW);
});

describe('L4: name clashes do not confirm what the caller may not see', () => {
  it('says only that a hidden service’s or application’s name cannot be used', async () => {
    const team = await s.api('POST', '/teams', { name: 'Invented service desk', members: [] });
    const hidden = await s.api('POST', '/services', { name: 'SECRETBLUE Service' });
    await s.api('PUT', `/owning-teams/service/${hidden.id}`, { teamIds: [team.id] });
    const app = await s.api('POST', '/applications', { name: 'SECRETBLUE App' });
    await s.api('PUT', `/owning-teams/application/${app.id}`, { teamIds: [team.id] });
    expect((await refused(dana('GET', `/services/${hidden.id}`))).status).toBe(404);

    for (const [url, code] of [
      ['/services', 'SERVICE_NAME_TAKEN'],
      ['/applications', 'APPLICATION_NAME_TAKEN'],
    ] as const) {
      const r = await refused(dana('POST', url, { name: url === '/services' ? 'secretblue service' : 'SECRETBLUE APP' }));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe(code);
      expect(JSON.stringify(r.body)).not.toMatch(/secretblue/i);
    }
    // renaming one of her own to it: the same
    const own = await dana('POST', '/services', { name: 'Dana’s service' });
    const renamed = await refused(dana('PUT', `/services/${own.id}`, { name: 'SECRETBLUE Service' }));
    expect(renamed.body.code).toBe('SERVICE_NAME_TAKEN');
    // a clash she can see is named as before
    expect((await refused(dana('POST', '/services', { name: 'Dana’s service' }))).body).toMatchObject({
      code: 'SERVICE_EXISTS',
      params: { name: 'Dana’s service' },
    });
    // the administrator sees every service: named
    expect((await refused(s.api('POST', '/services', { name: 'SECRETBLUE Service' }))).body.code).toBe('SERVICE_EXISTS');
  });
});

describe('L2: single sign-on calls go through address safety', () => {
  it('refuses cloud-metadata and link-local identity providers, and Steward’s own API', async () => {
    for (const issuer of ['https://169.254.169.254/realms/x', 'https://[fd00:ec2::254]/', 'https://[::ffff:a9fe:a9fe]/']) {
      const r = await s.api('POST', '/sso/discover', { issuer });
      expect(r, issuer).toMatchObject({ ok: false, message: expect.stringMatching(/^Blocked/) });
    }
    const port = new URL(s.base).port;
    const own = await s.api('POST', '/sso/discover', { issuer: `http://127.0.0.1:${port}/api/users` });
    expect(own).toMatchObject({ ok: false, message: expect.stringMatching(/^Blocked/) });
  });

  it('still reaches an identity provider on this machine (the mock: a private address)', async () => {
    const r = await s.api('POST', '/sso/discover', { issuer: `${s.base}/mock/oidc` });
    expect(r.ok).toBe(true);
  });
});

describe('L6: clock and version', () => {
  it('shows how far the clock is from a reference it has anyway', async () => {
    const clock = await import('../src/system/clock.js');
    clock.resetClockSamples();
    const { db } = await import('../src/db.js');
    const before = (await s.api('GET', '/system/status')).clock;
    // SQLite has no clock of its own; PostgreSQL's is the same machine's here
    if (db().dialect === 'sqlite') expect(before).toEqual({ skewSeconds: null, source: null, checkedAt: null, warning: false });
    else expect(before).toMatchObject({ source: 'database', warning: false });
    // a platform answered with a Date two minutes behind Steward's clock
    const now = Date.now();
    clock.noteRemoteDate(new Date(now - 120_000).toUTCString(), now - 50, now);
    const after = (await s.api('GET', '/system/status')).clock;
    expect(after).toMatchObject({ source: 'http', warning: true });
    expect(after.skewSeconds).toBeGreaterThan(118);
    expect(after.skewSeconds).toBeLessThan(121);
    // within the Date header's resolution: no difference
    clock.noteRemoteDate(new Date(now).toUTCString(), now - 50, now);
    expect((await s.api('GET', '/system/status')).clock.warning).toBe(false);
  });

  it('names the version to signed-in callers only', async () => {
    const anonymous = await (await fetch(`${s.base}/api/auth/status`)).json();
    expect(anonymous).not.toHaveProperty('version');
    expect((await s.api('GET', '/auth/status')).version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
