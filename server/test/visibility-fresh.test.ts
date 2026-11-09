import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * GET /api/me/visibility only reads. The web app asks for it on every page, also on a new instance that is about to
 * receive a migration package – which needs its content tables empty (migration/import.ts, filledTargetTables).
 */

let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  const reg = await import('../src/jobs/registry.js');
  reg.resetJobs();
  await s?.app.close();
});

describe('GET /api/me/visibility on a new instance', () => {
  it('creates nothing: the instance stays empty for a migration import', async () => {
    const { filledTargetTables } = await import('../src/migration/import.js');
    expect(filledTargetTables()).toEqual([]);
    const areas = (await s.api('GET', '/me/visibility')).areas;
    // the built-in control catalogues are always there for a signed-in person, records are not
    expect(areas.controls?.show).toBe(true);
    expect(areas.records?.show).toBe(true);
    expect(filledTargetTables()).toEqual([]);
  });
});
