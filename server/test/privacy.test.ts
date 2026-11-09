import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * A person's data (0.11.0, security review 0.10.0 S4; GDPR Art. 15, 17 and 20, docs/PRIVACY.md): the JSON export for
 * oneself and by administrators, and the pseudonymisation of a deactivated account – the audit chain still verifies.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Erika-password-123';
let s: TestServer;
let erika: Client;
let erikaId = '';
let erikaToken = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const created = await s.api('POST', '/users', {
    username: 'erika.m',
    displayName: 'Erika Mustermann',
    firstName: 'Erika',
    lastName: 'Mustermann',
    email: 'erika@example.com',
    roles: ['designer'],
    password: PW,
  });
  erikaId = created.user.id;
  // the first sign-in asks for a new password
  const first = await s.as('erika.m', PW);
  await first('POST', '/auth/password', { current: PW, next: `${PW}-2` });
  erika = await s.as('erika.m', `${PW}-2`);
  const team = await s.api('POST', '/teams', { name: 'Privacy team', members: ['erika.m'] });
  expect(team.members).toEqual(['erika.m']);
  erikaToken = (await erika('POST', '/me/tokens', { name: 'Erika laptop', scope: 'read' })).token;
  await erika('PATCH', '/me', { locale: 'de' });
  // something she did and something she owns
  await erika('POST', '/processes', { text: 'name: Privacy process\nsteps:\n  - { id: note, type: log, message: hello }\n' });
});
afterAll(async () => {
  await s?.app.close();
});

const download = async (c: Client, path: string) => c('GET', path);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status?: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

describe('the export of a person’s data', () => {
  it('gives a person everything Steward holds about them, without secrets, and audits it', async () => {
    const data = await download(erika, '/me/data-export');
    expect(data).toMatchObject({
      format: 'steward-personal-data-v1',
      account: {
        id: erikaId,
        username: 'erika.m',
        displayName: 'Erika Mustermann',
        firstName: 'Erika',
        lastName: 'Mustermann',
        email: 'erika@example.com',
        locale: 'de',
        roles: ['designer'],
        active: true,
        pseudonymisedAt: null,
      },
      teams: [{ name: 'Privacy team', roles: [] }],
      apiTokens: [expect.objectContaining({ name: 'Erika laptop', scope: 'read' })],
    });
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.sessions[0]).toHaveProperty('ip');
    // the audit entries about her: her sign-ins, her password change, the account entries an administrator wrote
    const actions = data.audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'auth.login', 'user.password_changed', 'user.profile_updated']));
    // where she is named: the process she created (history) and owns (now)
    expect(data.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'process_versions', column: 'author', kind: 'history', total: 1 }),
        expect.objectContaining({
          table: 'processes',
          column: 'owner',
          kind: 'current',
          total: 1,
          rows: [expect.objectContaining({ label: 'Privacy process' })],
        }),
      ]),
    );
    expect(data.audit.total).toBe(data.audit.entries.length);
    expect(data.audit.next).toBeNull();
    // never a secret: no token, hash, session key or password hash
    const text = JSON.stringify(data);
    expect(erikaToken).toMatch(/^smt_/);
    expect(text).not.toContain(erikaToken);
    expect(text).not.toMatch(/scrypt\$|password_hash|"binding"/);
    const audited = await s.api('GET', '/audit?action=user.data_exported&limit=5');
    expect(audited[0]).toMatchObject({ actor: 'erika.m', entityId: erikaId, summary: 'erika.m exported their own data' });
  });

  it('pages the audit entries when there are many', async () => {
    const { PERSONAL_DATA_LIMITS } = await import('@sm/shared');
    const { db } = await import('../src/db.js');
    const { audit } = await import('../src/audit.js');
    const { runAs } = await import('../src/auth/context.js');
    const users = await import('../src/auth/users.js');
    db().tx(() => {
      runAs(users.toAuthUser(users.getUser(erikaId)), () => {
        for (let i = 0; i < PERSONAL_DATA_LIMITS.auditPerPage + 5; i++) audit({ action: 'test.privacy', entityType: 'test', summary: `entry ${i}` });
      });
    });
    const first = await download(erika, '/me/data-export');
    expect(first.audit.entries.length).toBe(PERSONAL_DATA_LIMITS.auditPerPage);
    expect(first.audit.next).toMatch(/^auditAfter=\d+$/);
    const rest = await download(erika, `/me/data-export?${first.audit.next}`);
    expect(rest.audit.entries[0].seq).toBeGreaterThan(first.audit.entries.at(-1).seq);
    // (the first download wrote an entry of its own, which the second one finds)
    expect(first.audit.entries.length + rest.audit.entries.length).toBe(rest.audit.total);
    // a page of audit entries only: the rest of the export is in the first file
    expect(rest.activity).toEqual([]);
  });

  it('lets administrators export anyone’s data (with a step-up), never other people', async () => {
    const data = await download(s.api, `/users/${erikaId}/data-export`);
    expect(data.account.username).toBe('erika.m');
    expect((await s.api('GET', '/audit?action=user.data_exported&limit=1'))[0].summary).toBe('admin exported the data of "erika.m"');
    const adminId = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'admin').id;
    expect(await refusal(erika('GET', `/users/${adminId}/data-export`))).toMatchObject({ status: 403 });
    // an API token is no session: a leaked one cannot take the data
    const token = (await erika('POST', '/me/tokens', { name: 'export test', scope: 'full' })).token;
    const r = await fetch(`${s.base}/api/me/data-export`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
  });
});

describe('pseudonymising a deactivated person', () => {
  it('needs a deactivated account and the user name typed', async () => {
    expect(await refusal(s.api('POST', `/users/${erikaId}/pseudonymise`, { confirm: 'erika.m' }))).toMatchObject({ status: 409, code: 'USER_ACTIVE' });
    await s.api('PUT', `/users/${erikaId}`, { active: false });
    expect(await refusal(s.api('POST', `/users/${erikaId}/pseudonymise`, { confirm: 'erika' }))).toMatchObject({ status: 400, code: 'CONFIRMATION_MISMATCH' });
    expect(await refusal(s.api('POST', `/users/${erikaId}/pseudonymise`, {}))).toMatchObject({ status: 400 });
  });

  it('replaces the personal data, keeps the id and the user name, and the audit chain still verifies', async () => {
    const { db } = await import('../src/db.js');
    const users = await import('../src/auth/users.js');
    const { pseudonymOf } = await import('../src/auth/personal-data.js');
    const before = (await s.api('GET', '/audit/verify')) as { ok: boolean };
    expect(before.ok).toBe(true);
    const after = await s.api('POST', `/users/${erikaId}/pseudonymise`, { confirm: 'Erika.M' });
    const pseudonym = pseudonymOf(erikaId);
    expect(pseudonym).toMatch(/^former-user-[0-9a-f]{6}$/);
    expect(after).toMatchObject({ id: erikaId, username: 'erika.m', displayName: pseudonym, active: false, teams: [], profile: [] });
    expect(after.email).toBeUndefined();
    expect(after.firstName).toBeUndefined();
    expect(after.pseudonymisedAt).toBeTruthy();
    const row = db().get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', erikaId)!;
    expect(row).toMatchObject({
      email: null,
      first_name: null,
      last_name: null,
      profile: null,
      external_id: null,
      external_sub: null,
      locale: null,
      password_hash: '!none',
    });
    for (const table of ['sessions', 'api_tokens', 'team_members', 'notification_prefs', 'daily_summary_prefs', 'notifications', 'notification_outbox'])
      expect(Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, erikaId)!.n), table).toBe(0);
    // the name and e-mail are gone from the account, but not from the audit log: its entries cannot change
    const entry = (await s.api('GET', '/audit?action=user.pseudonymised&limit=1'))[0];
    expect(entry.summary).toBe(
      `The personal data of "erika.m" was replaced by the pseudonym "${pseudonym}" (cannot be undone; the user name stays for the audit log)`,
    );
    expect(JSON.stringify(entry)).not.toMatch(/Mustermann|erika@example\.com/);
    expect(((await s.api('GET', '/audit/verify')) as { ok: boolean }).ok).toBe(true);
    // the export now shows the pseudonym, and still the entries the user name wrote
    const data = await s.api('GET', `/users/${erikaId}/data-export`);
    expect(data.account).toMatchObject({ username: 'erika.m', displayName: pseudonym, email: null, firstName: null, pseudonymisedAt: after.pseudonymisedAt });
    expect(data.audit.entries.some((e: { actor: string }) => e.actor === 'erika.m')).toBe(true);
    // nothing brings the account back or changes it
    expect(await refusal(s.api('PUT', `/users/${erikaId}`, { active: true }))).toMatchObject({ status: 409, code: 'USER_PSEUDONYMISED' });
    expect(await refusal(s.api('PUT', `/users/${erikaId}`, { displayName: 'Erika' }))).toMatchObject({ code: 'USER_PSEUDONYMISED' });
    expect(await refusal(s.api('POST', `/users/${erikaId}/reset-password`))).toMatchObject({ code: 'USER_PSEUDONYMISED' });
    expect(() => users.recoverAccount(erikaId, { actor: 'cli', activate: true })).toThrow(expect.objectContaining({ code: 'USER_PSEUDONYMISED' }));
    expect(await refusal(s.api('POST', `/users/${erikaId}/pseudonymise`, { confirm: 'erika.m' }))).toMatchObject({ code: 'USER_PSEUDONYMISED' });
    // the user name stays taken: nobody else gets it
    expect(await refusal(s.api('POST', '/users', { username: 'erika.m', roles: [], password: 'Another-person-1' }))).toMatchObject({ status: 409 });
    const login = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: 'erika.m', password: `${PW}-2` }),
    });
    expect(login.status).toBe(401);
  });

  it('asks for a step-up and is for administrators only', async () => {
    const plain = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    // a new session's sign-in counts as a fresh confirmation; an old one does not
    const { db } = await import('../src/db.js');
    db().run("UPDATE sessions SET step_up_at = '2000-01-01T00:00:00.000Z'");
    expect(await refusal(plain('POST', `/users/${erikaId}/pseudonymise`, { confirm: 'erika.m' }))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(await refusal(plain('GET', `/users/${erikaId}/data-export`))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
  });
});
