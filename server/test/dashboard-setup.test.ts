import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** The getting-started checklist on the start page reads `setup` from GET /dashboard. */
let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s.app.close().catch(() => undefined);
});

describe('dashboard setup progress', () => {
  it('gives administrators the instance-wide counts of a fresh installation', async () => {
    const d = await s.api('GET', '/dashboard');
    expect(d.setup).toEqual({ platforms: 0, processes: 0, runs: 0, schedules: 0, monitors: 0, credentials: 0, users: 1, reportSchedules: 0 });
  });

  it('counts what was added', async () => {
    await s.api('POST', '/users', { username: 'dana', roles: ['designer'], password: 'Dana-password-123' });
    await s.api('POST', '/credentials', { name: 'Historian technical user', type: 'technicalUser' });
    const d = await s.api('GET', '/dashboard');
    expect(d.setup.users).toBe(2);
    expect(d.setup.credentials).toBe(1);
  });

  it('is left out for everybody else', async () => {
    const first = await s.as('dana', 'Dana-password-123');
    await first('POST', '/auth/password', { current: 'Dana-password-123', next: 'Dana-password-456' });
    const dana = await s.as('dana', 'Dana-password-456');
    const d = await dana('GET', '/dashboard');
    expect(d.counts).toBeDefined();
    expect(d).not.toHaveProperty('setup');
  });
});
