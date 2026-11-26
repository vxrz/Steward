import { beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, ADMIN, type TestServer } from './helpers.js';

/**
 * A new installation's default (ADR 0042): `newItemVisibility` is "owningTeams" when nobody changed it. Every other test
 * file sets "everyone" through `setup()`; this one does not, so it sees what a fresh database really starts with.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  await s.api('POST', '/auth/setup', { passphrase: 'correct horse battery', username: ADMIN.username, displayName: 'Admin', password: ADMIN.password });
});

describe('the default of a fresh database', () => {
  it('is "owningTeams", and nothing is stored for it', async () => {
    expect(((await s.api('GET', '/settings/instance')) as { newItemVisibility: string }).newItemVisibility).toBe('owningTeams');
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM settings WHERE key = 'newItemVisibility'")).toBeUndefined();
  });

  it('asks the first administrator, who has no team, for an owning team', async () => {
    await expect(s.api('POST', '/services', { name: 'Invented first service', owners: [] })).rejects.toMatchObject({
      status: 400,
      body: { code: 'ACCESS_OWNING_TEAM_REQUIRED' },
    });
  });
});
