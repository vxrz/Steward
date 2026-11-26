import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Who sees a new item (0.31.0, ADR 0042) after an upgrade: the newest upgrade fixture is a database that existed before
 * the setting, so migration `access-002-new-item-visibility` stores "everyone" – the new items of an upgraded
 * installation stay open as before, until an administrator chooses "owningTeams". A new installation gets the default
 * "owningTeams" (creation-default-setting.test.ts). The fixture is a SQLite database; on PostgreSQL (SM_TEST_DATABASE_URL) the
 * migration runs against a database that has users and no setting, which is the same condition.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PG = !!process.env.SM_TEST_DATABASE_URL;
const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade', 'v0.29.0');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  admin: { username: string; password: string };
};

let s: TestServer;
let admin: Client;

beforeAll(async () => {
  if (PG) {
    // no fixture on PostgreSQL: an installation with a user, and the setting and the migration's record taken away
    s = await startTestServer();
    admin = s.api;
    await setup(s);
    const { db } = await import('../src/db.js');
    db().run("DELETE FROM settings WHERE key = 'newItemVisibility'");
    db().run("DELETE FROM schema_migrations WHERE name = 'access-002-new-item-visibility'");
    const { ACCESS_MIGRATIONS } = await import('../src/migrations/access.js');
    const m = ACCESS_MIGRATIONS.find((x) => x.name === 'access-002-new-item-visibility')!;
    db().exec(m.pg ?? m.sql);
    db().run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-visibility-upg-'));
  fs.cpSync(path.join(FIXTURE, 'datadir'), dataDir, { recursive: true });
  s = await startTestServer({ dataDir });
  admin = s.client();
  await admin('POST', '/auth/login', manifest.admin);
  await admin('POST', '/vault/unlock', { passphrase: manifest.passphrase });
}, 240_000);

const restricted = async (id: string) => {
  const { db } = await import('../src/db.js');
  return !!db().get("SELECT 1 FROM resource_restrictions WHERE kind = 'service' AND resource_id = ?", id);
};

describe('the upgrade to uniform access at creation', () => {
  it('keeps "everyone" for a database that existed before, and stores it', async () => {
    expect(((await admin('GET', '/settings/instance')) as { newItemVisibility: string }).newItemVisibility).toBe('everyone');
    const { db } = await import('../src/db.js');
    expect(db().get<{ value: string }>("SELECT value FROM settings WHERE key = 'newItemVisibility'")?.value).toBe('"everyone"');
    expect(db().get("SELECT 1 FROM schema_migrations WHERE name = 'access-002-new-item-visibility'")).toBeTruthy();
  });

  it('a new item of a team stays open until an administrator chooses "owningTeams"', async () => {
    const team = (await admin('POST', '/teams', { name: 'Invented upgrade team', members: ['admin'] })).id;
    await admin('PUT', '/me/new-resource-teams', { teamId: team });
    const open = await admin('POST', '/services', { name: 'Invented open service', owners: [] });
    expect(await restricted(open.id)).toBe(false);
    await admin('PUT', '/settings/instance', { newItemVisibility: 'owningTeams' });
    const closed = await admin('POST', '/services', { name: 'Invented closed service', owners: [] });
    expect(await restricted(closed.id)).toBe(true);
    // what existed before is not touched by the setting
    expect(await restricted(open.id)).toBe(false);
  });

  it('refuses a value that is no visibility', async () => {
    await expect(admin('PUT', '/settings/instance', { newItemVisibility: 'nobody' })).rejects.toMatchObject({ status: 400 });
  });
});
