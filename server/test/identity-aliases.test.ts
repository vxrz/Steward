import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Former names of imported accounts (server/src/auth/aliases.ts): imported content keeps the source's names,
 * and they still mean the same people – for access lists and for the four-eyes rules.
 */
let s: TestServer;
let oliviaId = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const { db } = await import('../src/db.js');
  const { invalidateAliases } = await import('../src/auth/aliases.js');
  const users = await s.api('GET', '/users');
  oliviaId = users.find((u: { username: string }) => u.username === 'olivia').id;
  const team = (await s.api('GET', '/teams')).find((t: { name: string }) => t.name === 'Service Desk');
  db().run(
    `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
       source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
     VALUES ('imp_test', '00000000-0000-0000-0000-000000000000', 'x', 'now', 'test', 'fp', 'key', '0.1.2', 'now', 'test', '{}', '[]', '', '{}', '{}', 0)`,
  );
  db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', 'laptop-olivia', ?, 'imp_test')", oliviaId);
  db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('team', 'old desk', ?, 'imp_test')", team.id);
  invalidateAliases();
});
afterAll(async () => {
  await s?.app.close();
});

describe('identity aliases of imported accounts', () => {
  it('adds the former user and team names to the subjects of the account', async () => {
    const { subjectsOf } = await import('../src/auth/permissions.js');
    const { getUser, toAuthUser } = await import('../src/auth/users.js');
    const subjects = subjectsOf(toAuthUser(getUser(oliviaId)));
    expect(subjects.has('user:olivia')).toBe(true);
    expect(subjects.has('user:laptop-olivia')).toBe(true);
    expect(subjects.has('team:old desk')).toBe(true);
  });

  it('grants what an imported access list gave the former name', async () => {
    const { db } = await import('../src/db.js');
    const p = (await s.api('GET', '/processes'))[0];
    db().run('UPDATE processes SET acl = ? WHERE id = ?', JSON.stringify([{ subject: 'user:laptop-olivia', permissions: ['view', 'run'] }]), p.id);
    const olivia = await s.as('olivia', 'Demo-password-1');
    expect((await olivia('GET', `/processes/${p.id}`)).id).toBe(p.id);
    const vera = await s.as('vera', 'Demo-password-1');
    await expect(vera('GET', `/processes/${p.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it('applies the four-eyes rules to the former name', async () => {
    const { decisionCheck } = await import('../src/auth/permissions.js');
    const { PROCESS_PERMISSIONS } = await import('@sm/shared');
    const { fourEyesReason } = await import('../src/records/access.js');
    const { getUser, toAuthUser } = await import('../src/auth/users.js');
    const olivia = toAuthUser(getUser(oliviaId));
    const task = { assignees: [], fourEyes: true, status: 'open' };
    expect(decisionCheck(olivia, task, { actor: 'laptop-olivia' }, [...PROCESS_PERMISSIONS]).code).toBe('FOUR_EYES_RUN');
    expect(decisionCheck(olivia, task, { actor: 'someone-else' }, [...PROCESS_PERMISSIONS]).ok).toBe(true);
    expect(fourEyesReason(olivia, { owner: 'x', created_by: 'laptop-olivia', submitted_by: null }, [])?.code).toBe('FOUR_EYES_AUTHOR');
    expect(fourEyesReason(olivia, { owner: 'x', created_by: 'y', submitted_by: null }, ['LAPTOP-OLIVIA'])?.code).toBe('FOUR_EYES_CONTENT_AUTHOR');
  });

  it('keeps a former name from becoming a new account', async () => {
    const e = await s.api('POST', '/users', { username: 'laptop-olivia', roles: ['viewer'] }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.message).toContain('USERNAME_IS_ALIAS');
  });
});
