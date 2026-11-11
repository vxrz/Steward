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
