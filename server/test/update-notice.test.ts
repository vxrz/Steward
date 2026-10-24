import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The update notice for administrators (system/update-notice.ts). An update is simulated the way the
 * start-up records one (db.ts recordVersion → system.pendingUpgrades) and then audited as after the
 * vault unlock (upgrades.ts); upgrade-backup.test.ts covers the real start-up path with a copy.
 */
let s: TestServer;
let admin2: Client, olivia: Client, audrey: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

const upgrade = (o: { from: string | null; to: string; migrations?: string[]; backup?: string | null }) => ({
  fromSchema: { core: 30, named: 40 },
  toSchema: { core: 30, named: 40 + (o.migrations?.length ?? 0) },
  fromVersion: o.from,
  toVersion: o.to,
  migrations: o.migrations ?? [],
  backup: o.backup ?? null,
  at: new Date().toISOString(),
});

/** What a start-up on an older database records, audited as after the unlock. */
async function simulateUpdate(...list: ReturnType<typeof upgrade>[]): Promise<void> {
  const { PENDING_UPGRADES_KEY } = await import('../src/db.js');
  const { writeSetting } = await import('../src/settings.js');
  const { auditPendingUpgrades } = await import('../src/upgrades.js');
  writeSetting(PENDING_UPGRADES_KEY, list);
  expect(auditPendingUpgrades()).toBe(list.length);
}

/** A user who has set their own password (new accounts must change the one they were given). */
async function user(username: string, role: string): Promise<Client> {
  const pw = `${username}-Password-123`;
  await s.api('POST', '/users', { username, roles: [role], password: pw });
  const first = await s.as(username, pw);
  await first('POST', '/auth/password', { current: pw, next: `${pw}-new` });
  return s.as(username, `${pw}-new`);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  [admin2, olivia, audrey] = [await user('admin2', 'admin'), await user('olivia', 'operator'), await user('audrey', 'auditor')];
});
afterAll(async () => {
  await s?.app.close();
});

describe('update notice', () => {
  const BACKUP = '/srv/steward/data/backups/pre-0.1.2-2026-10-24T08-00-00Z.db';
  let first: { id: string };

  it('is empty on an installation that was never updated', async () => {
    expect(await s.api('GET', '/system/update-notice')).toEqual({ notice: null });
  });

  it('shows the update to administrators: versions, migrations, the copy', async () => {
    await simulateUpdate(upgrade({ from: '0.1.1', to: '0.1.2', migrations: ['records-005-x', 'catalogue-002-y'], backup: BACKUP }));
    const { notice } = await s.api('GET', '/system/update-notice');
    expect(notice).toMatchObject({
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      migrations: ['records-005-x', 'catalogue-002-y'],
      backups: [BACKUP],
      noBackupReason: null,
    });
    expect(notice.id).toMatch(/^upd_/);
    expect(notice).not.toHaveProperty('dismissedBy');
    first = notice;
    expect((await admin2('GET', '/system/update-notice')).notice.id).toBe(first.id);
    // the audit entry is still written
    const entries = await s.api('GET', '/audit?action=system.upgraded');
    expect(entries[0].details).toMatchObject({ toVersion: '0.1.2', backup: BACKUP });
  });

  it('is refused to everyone else (it names the path of the copy)', async () => {
    for (const c of [olivia, audrey]) {
      // signed in and allowed elsewhere (not a refusal for another reason)
      expect((await c('GET', '/auth/me')).user.mustChangePassword).toBeFalsy();
      expect(await status(c('GET', '/system/update-notice'))).toBe(403);
      expect(await status(c('POST', '/system/update-notice/dismiss', { id: first.id }))).toBe(403);
    }
    const res = await fetch(`${s.base}/api/system/update-notice`, { headers: { 'x-sm-client': '1' } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('backups');
    // the auditors' limited system status has no paths either
    expect(JSON.stringify(await audrey('GET', '/system/status'))).not.toContain(BACKUP);
  });

  it('is dismissed per administrator, on the server', async () => {
    expect(await status(s.api('POST', '/system/update-notice/dismiss', { id: 'upd_unknown' }))).toBe(404);
    expect(await status(s.api('POST', '/system/update-notice/dismiss', { id: first.id, extra: 1 }))).toBe(400);
    expect(await status(s.api('POST', '/system/update-notice/dismiss', {}))).toBe(400);
    expect(await s.api('POST', '/system/update-notice/dismiss', { id: first.id })).toEqual({ ok: true });
    expect(await s.api('GET', '/system/update-notice')).toEqual({ notice: null });
    // another browser of the same administrator: a new session
    const again = await s.as('admin', 'Admin-password-1');
    expect(await again('GET', '/system/update-notice')).toEqual({ notice: null });
    // dismissing twice is fine
    expect(await s.api('POST', '/system/update-notice/dismiss', { id: first.id })).toEqual({ ok: true });
    // the other administrator still sees it
    expect((await admin2('GET', '/system/update-notice')).notice.id).toBe(first.id);
    const audited = await s.api('GET', '/audit?action=system.update_notice_dismissed');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actor: 'admin', entityType: 'system', entityId: first.id });
  });

  it('is replaced by the next update, for everyone', async () => {
    await simulateUpdate(upgrade({ from: '0.1.2', to: '0.1.3' }));
    const { notice } = await s.api('GET', '/system/update-notice');
    expect(notice).toMatchObject({ fromVersion: '0.1.2', toVersion: '0.1.3', migrations: [], backups: [], noBackupReason: 'notNeeded' });
    expect(notice.id).not.toBe(first.id);
    expect((await admin2('GET', '/system/update-notice')).notice.id).toBe(notice.id);
    // the old notice is gone
    expect(await status(admin2('POST', '/system/update-notice/dismiss', { id: first.id }))).toBe(404);
  });

  it('sums up several updates recorded before one unlock; no copy: says why', async () => {
    const { db } = await import('../src/db.js');
    await simulateUpdate(upgrade({ from: '0.1.3', to: '0.1.4', migrations: ['a-001'] }), upgrade({ from: '0.1.4', to: '0.2.0', migrations: ['b-001'] }));
    const { notice } = await s.api('GET', '/system/update-notice');
    expect(notice).toMatchObject({
      fromVersion: '0.1.3',
      toVersion: '0.2.0',
      migrations: ['a-001', 'b-001'],
      backups: [],
      noBackupReason: db().dialect === 'postgres' ? 'postgres' : 'disabled',
    });
  });

  it('knows no version before v0.1.1 (versions were not recorded)', async () => {
    await simulateUpdate(upgrade({ from: null, to: '0.2.1', migrations: ['c-001'], backup: BACKUP }));
    expect((await s.api('GET', '/system/update-notice')).notice).toMatchObject({ fromVersion: null, toVersion: '0.2.1', backups: [BACKUP] });
  });
});
