import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AclEntry, Role } from '@sm/shared';
import { setup, startTestServer, storeAcl, type Client, type TestServer } from './helpers.js';

/**
 * The proof of the migration of access lists to shares (0.23.0, ADR 0033 "Migration", #297): nobody gains or loses a
 * right at the upgrade.
 *
 * 1. **Rights, per kind** (on the database the suite runs on – SQLite, or PostgreSQL with SM_TEST_DATABASE_URL): an
 *    instance with processes, platforms, identities, monitors and sites – owned and unowned, with and without lists,
 *    owners, `role:` subjects, a former name (alias), a team that does not exist (deleted), upper case, duplicate
 *    subjects, entries without rights and entries no level expresses – gets the migration's own SQL run on its access
 *    lists; then every user's rights on every item are decided twice: by the rules of 0.22 (kept below, reading the
 *    `acl` columns) and by the policy module now (shares, Restricted). They must be equal.
 * 2. **The upgrade fixture** (SQLite, server/test/fixtures/upgrade/v0.19.0): access lists of every kind written into a
 *    released version's database become exactly the shares and scopes the rule above was proven with.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let policy: typeof import('../src/auth/policy.js');
let perms: typeof import('../src/auth/permissions.js');
let ctx: typeof import('../src/auth/context.js');
let users: typeof import('../src/auth/users.js');
let monitorModel: typeof import('../src/monitors/model.js');
let plantAccess: typeof import('../src/plant/access.js');
let acl: typeof import('../src/auth/acl-shares.js');
let db: typeof import('../src/db.js').db;

const e = (subject: string, ...permissions: string[]) => ({ subject, permissions });

/** Access lists of every shape, per kind. */
const LISTS = {
  process: [
    [],
    [e('user:dana', 'view')],
    [e('user:tess', 'run')],
    [e('team:ops', 'edit')],
    [e(' Team:OPS ', 'view', 'run'), e('user:vera', 'approve')],
    [e('role:operator', 'view', 'run')],
    [e('user:vera', 'manage')],
    [e('user:vera', 'manage', 'run'), e('user:vera', 'approve')],
    [e('user:formername', 'edit', 'manage')],
    [e('team:gone', 'view')],
    [e('user:vera')],
    [e('user:nobody', 'view'), e('role:approver', 'approve')],
    [e('role:admin', 'view', 'edit', 'manage'), e('user:dana', 'view')],
  ],
  monitor: [
    [],
    [e('user:vera', 'view')],
    [e('user:vera', 'acknowledge')],
    [e('team:ops', 'edit')],
    [e('user:tess', 'manage')],
    [e('role:viewer', 'view', 'acknowledge')],
    [e('user:formername', 'edit')],
    [e('team:gone', 'manage')],
    [e('user:vera')],
  ],
  site: [
    [],
    [e('user:vera', 'view')],
    [e('user:vera', 'propose')],
    [e('team:ops', 'manage')],
    [e('role:operator', 'propose')],
    [e('user:vera')],
    [e('user:formername', 'view'), e('team:qa', 'propose', 'view')],
  ],
  platform: [[], [e('user:vera', 'use')], [e('team:ops', 'manage')], [e('role:approver', 'use')], [e('user:vera')], [e('user:tess', 'use', 'manage')]],
  platform_identity: [[], [e('user:vera', 'use')], [e('team:ops', 'use')], [e('role:viewer', 'use')], [e('user:formername', 'use')], [e('user:tess')]],
} as const satisfies Record<string, readonly (readonly AclEntry[])[]>;

const USERS: [string, Role[]][] = [
  ['dana', ['designer']],
  ['olivia', ['operator']],
  ['adam', ['approver']],
  ['audrey', ['auditor']],
  ['vera', ['viewer']],
  ['tess', ['viewer']],
  ['ulla', ['operator']],
  ['neo', ['viewer']],
  ['pia', ['plant']],
  ['stella', ['status']],
];

// ---------- the rules of 0.22 (before the migration), reading the access lists ----------

const LEGACY_PLATFORM: Record<Role, readonly string[]> = {
  admin: ['use', 'manage'],
  designer: ['use'],
  operator: ['use'],
  approver: [],
  auditor: [],
  viewer: [],
  status: [],
  plant: [],
};
const LEGACY_IDENTITY: Record<Role, readonly string[]> = {
  admin: ['use'],
  designer: ['use'],
  operator: ['use'],
  approver: [],
  auditor: [],
  viewer: [],
  status: [],
  plant: [],
};

type U = import('../src/auth/context.js').AuthUser;

/** decide() of 0.22: owner, auditor, role defaults while the list is empty (or in an owning team), list entries. */
function legacyDecide(
  u: U,
  r: { kind: string; id: string; owner?: string | null; acl: readonly AclEntry[] },
  all: readonly string[],
  defaults: Record<Role, readonly string[]>,
  auditorView?: string,
  instanceDefaults = true,
): string[] {
  if (u.roles.includes('admin')) return [...all];
  if (r.owner && r.owner.toLowerCase() === u.username.toLowerCase()) return [...all];
  const granted = new Set<string>();
  if (auditorView && u.roles.includes('auditor')) granted.add(auditorView);
  const teams = policy.owningTeams(r.kind as never, r.id);
  if (!teams.length) {
    if (!r.acl.length && instanceDefaults) for (const role of u.roles) for (const p of defaults[role] ?? []) granted.add(p);
  } else {
    const mine = policy.memberships(u);
    for (const t of teams) {
      const m = mine.get(t.id);
      if (!m) continue;
      for (const role of new Set([...u.roles, ...m.roles])) for (const p of defaults[role] ?? []) granted.add(p);
    }
  }
  for (const x of r.acl) if (perms.matches(u, x.subject)) for (const p of x.permissions) granted.add(p);
  return all.filter((p) => granted.has(p));
}

const closure = (all: readonly string[], got: string[], rules: { implies?: Record<string, string[]>; anyGives?: string }): string[] => {
  const out = new Set(got);
  for (const [p, more] of Object.entries(rules.implies ?? {})) if (out.has(p)) more.forEach((m) => out.add(m));
  if (rules.anyGives && out.size) out.add(rules.anyGives);
  return all.filter((p) => out.has(p));
};

interface Item {
  kind: keyof typeof LISTS;
  id: string;
  owner: string | null;
  acl: readonly AclEntry[];
  platformId?: string;
  isDefault?: boolean;
}
const items: Item[] = [];
const platformAcl = new Map<string, readonly AclEntry[]>();

function legacyRights(u: U, it: Item): string[] {
  switch (it.kind) {
    case 'process':
      return closure(
        ['view', 'run', 'edit', 'approve', 'manage'],
        legacyDecide(u, it, ['view', 'run', 'edit', 'approve', 'manage'], perms.DEFAULT_PROCESS, 'view'),
        {
          anyGives: 'view',
        },
      );
    case 'monitor':
      return closure(
        ['view', 'acknowledge', 'edit', 'manage'],
        legacyDecide(u, it, ['view', 'acknowledge', 'edit', 'manage'], monitorModel.MONITOR_DEFAULTS, 'view'),
        {
          implies: { manage: ['edit', 'acknowledge'] },
          anyGives: 'view',
        },
      );
    case 'site': {
      const got = legacyDecide(u, it, ['view', 'propose', 'manage'], plantAccess.DEFAULT_PLANT, 'view');
      return got.includes('manage') ? ['view', 'propose', 'manage'] : got.includes('propose') ? ['view', 'propose'] : got;
    }
    case 'platform': {
      const got = legacyDecide(u, it, ['use', 'manage'], LEGACY_PLATFORM);
      // 0.23.0 names seeing a platform: any right includes `view` (there was no other way to see one)
      return got.length ? ['view', ...closure(['use', 'manage'], got, { implies: { manage: ['use'] } })] : [];
    }
    case 'platform_identity': {
      const platform = legacyDecide(u, { kind: 'platform', id: it.platformId!, acl: platformAcl.get(it.platformId!)! }, ['use', 'manage'], LEGACY_PLATFORM);
      if (!platform.includes('use') && !platform.includes('manage')) return [];
      if (it.isDefault) return ['use'];
      return legacyDecide(u, it, ['use'], LEGACY_IDENTITY, undefined, false);
    }
  }
}

function rightsNow(u: U, it: Item): string[] {
  switch (it.kind) {
    case 'process':
      return policy.processAccess(u, { id: it.id, owner: it.owner }).permissions;
    case 'monitor':
      return monitorModel.monitorAccess(u, { id: it.id, owner: it.owner! }).permissions;
    case 'site':
      return plantAccess.siteAccess(u, { id: it.id }).permissions;
    case 'platform':
      return policy.platformAccess(u, { id: it.id }).permissions;
    case 'platform_identity':
      return policy.identityAccess(u, { id: it.platformId! }, { id: it.id, default: !!it.isDefault }).permissions;
  }
}

/** platformDataVisible of 0.22 (dataset partitions read from a platform). */
function legacyDataVisible(u: U, it: Item): boolean {
  const got = legacyRights(u, it);
  if (got.includes('use')) return true;
  const teams = policy.owningTeams('platform', it.id);
  if (!teams.length) return !it.acl.length;
  const mine = policy.memberships(u);
  return teams.some((t) => mine.has(t.id));
}

const at = '2026-10-01T00:00:00.000Z';
const counted = new Map<string, number>();

beforeAll(async () => {
  s = await startTestServer({
    routes: (a) =>
      a.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  policy = await import('../src/auth/policy.js');
  perms = await import('../src/auth/permissions.js');
  ctx = await import('../src/auth/context.js');
  users = await import('../src/auth/users.js');
  monitorModel = await import('../src/monitors/model.js');
  plantAccess = await import('../src/plant/access.js');
  acl = await import('../src/auth/acl-shares.js');
  db = (await import('../src/db.js')).db;
  for (const [username, roles] of USERS) users.createUser({ username, roles, password: PW, mustChangePassword: false });
  const ops = await s.api('POST', '/teams', { name: 'Ops', members: ['tess', 'dana'] });
  await s.api('POST', '/teams', { name: 'QA', members: ['ulla'] });
  db().run(`UPDATE team_members SET roles = '["operator"]' WHERE team_id = ? AND user_id = ?`, ops.id, users.findUserByName('tess')!.id);
  // a former name of neo (a migration package): user:formername matches neo
  db().run(
    `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
       source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
     VALUES ('imp_acl', '00000000-0000-0000-0000-000000000001', 'x', 'now', 'test', 'fp', 'key', '0.20.0', 'now', 'test', '{}', '[]', '', '{}', '{}', 0)`,
  );
  db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', 'formername', ?, 'imp_acl')", users.findUserByName('neo')!.id);
  (await import('../src/auth/aliases.js')).invalidateAliases();

  const own = (kind: string, id: string) =>
    db().run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', kind, id, ops.id, at);
  let n = 0;
  for (const owned of [false, true]) {
    for (const [i, list] of LISTS.process.entries())
      for (const owner of [null, 'vera']) {
        const id = `p_${n++}`;
        db().run(
          'INSERT INTO processes (id, name, description, current_version, created_at, updated_at, acl, owner) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
          id,
          `Process ${i}`,
          '',
          at,
          at,
          JSON.stringify(list),
          owner,
        );
        if (owned) own('process', id);
        items.push({ kind: 'process', id, owner, acl: list });
      }
    for (const [i, list] of LISTS.monitor.entries())
      for (const owner of ['admin', 'vera']) {
        const id = `m_${n++}`;
        db().run(
          'INSERT INTO monitors (id, key, name, owner, acl, definition, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          id,
          `Monitor ${i}`,
          owner,
          JSON.stringify(list),
          '{}',
          at,
          at,
          'admin',
        );
        if (owned) own('monitor', id);
        items.push({ kind: 'monitor', id, owner, acl: list });
      }
    for (const [i, list] of LISTS.site.entries()) {
      const id = `s_${n++}`;
      db().run(
        'INSERT INTO plant_sites (id, name, acl, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        `Site ${i}`,
        JSON.stringify(list),
        at,
        'admin',
        at,
        'admin',
      );
      if (owned) own('site', id);
      items.push({ kind: 'site', id, owner: null, acl: list });
    }
    for (const [i, list] of LISTS.platform.entries()) {
      const id = `pf_${n++}`;
      db().run(
        'INSERT INTO platforms (id, name, kind, base_url, config, created_at, updated_at, acl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        `Platform ${i}`,
        'http',
        'https://api.example',
        '{}',
        at,
        at,
        JSON.stringify(list),
      );
      if (owned) own('platform', id);
      platformAcl.set(id, list);
      items.push({ kind: 'platform', id, owner: null, acl: list });
      for (const [j, ilist] of [[], ...LISTS.platform_identity].entries()) {
        const iid = `pi_${n++}`;
        db().run(
          'INSERT INTO platform_identities (id, platform_id, name, is_default, acl, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          iid,
          id,
          `Identity ${j}`,
          j === 0 ? 1 : 0,
          JSON.stringify(ilist),
          at,
          'admin',
          at,
          'admin',
        );
        // owning teams of an identity: its members may use it (ADR 0009)
        if (owned && j % 2) own('platform_identity', iid);
        items.push({ kind: 'platform_identity', id: iid, owner: null, acl: ilist, platformId: id, isDefault: j === 0 });
      }
    }
  }
  // the migration's own conversion, on this database's dialect
  const { aclConversion } = await import('../src/migrations/access.js');
  db().exec(aclConversion(db().dialect));
  (await import('../src/auth/share-store.js')).sharesChanged();
});

describe('access lists become shares (0.23.0): nobody gains or loses a right', () => {
  for (const kind of ['process', 'platform', 'platform_identity', 'monitor', 'site'] as const)
    it(`${kind}: every user's rights on every item are those of 0.22`, () => {
      const people = ['admin', ...USERS.map(([n]) => n)].map((n) => users.toAuthUser(users.findUserByName(n)!));
      const diffs: string[] = [];
      let compared = 0;
      ctx.runAs(null, () => {
        for (const it of items.filter((x) => x.kind === kind))
          for (const u of people) {
            const before = legacyRights(u, it);
            const after = rightsNow(u, it);
            compared++;
            if (before.join() !== after.join()) diffs.push(`${u.username} on ${it.id} ${JSON.stringify(it.acl)}: ${before.join('/')} → ${after.join('/')}`);
            if (kind === 'platform' && legacyDataVisible(u, it) !== policy.platformDataVisible(u, { id: it.id }))
              diffs.push(`${u.username} on ${it.id}: data visible ${legacyDataVisible(u, it)} → ${!legacyDataVisible(u, it)}`);
          }
      });
      expect(diffs).toEqual([]);
      expect(compared).toBeGreaterThan(50);
    });

  it('stores one share per subject with exactly its rights, Custom where no level expresses them, and restricts listed items', () => {
    const rows = db().all<{ kind: string; resource_id: string; subject: string; level: string; actions: string; rights: string | null }>(
      'SELECT kind, resource_id, subject, level, actions, rights FROM resource_shares ORDER BY kind, resource_id, subject',
    );
    const custom = rows.filter((r) => r.rights);
    expect(custom.length).toBeGreaterThan(0);
    for (const r of custom) expect(r.kind).toBe('process');
    expect(rows.find((r) => r.subject === ' team:ops ' || r.subject === 'Team:OPS')).toBeUndefined();
    for (const it of items) {
      const expected = acl.aclToShares(it.kind, it.acl).map((x) => ({
        subject: x.subject,
        level: x.level,
        actions: x.actions,
        rights: x.rights ?? null,
      }));
      const stored = rows
        .filter((r) => r.kind === it.kind && r.resource_id === it.id)
        .map((r) => ({ subject: r.subject, level: r.level, actions: JSON.parse(r.actions), rights: r.rights ? JSON.parse(r.rights) : null }));
      expect(stored, `${it.id} ${JSON.stringify(it.acl)}`).toEqual(expected);
      const restricted = !!db().get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', it.kind, it.id);
      expect(restricted, it.id).toBe(it.kind !== 'platform_identity' && it.acl.length > 0);
    }
  });

  it('answers the deprecated routes with the access list computed from the shares (for who manages the item)', async () => {
    const p = items.find((x) => x.kind === 'process' && JSON.stringify(x.acl) === JSON.stringify(LISTS.process[4]) && !x.owner)!;
    const got = ((await s.api('GET', '/processes')) as { id: string; acl: unknown; restricted: boolean }[]).find((x) => x.id === p.id)!;
    expect(got.acl).toEqual([
      { subject: 'team:ops', permissions: ['view', 'run'] },
      { subject: 'user:vera', permissions: ['view', 'approve'] },
    ]);
    expect(got.restricted).toBe(true);
  });
});

describe('lists read shares in bulk', () => {
  /** Statements of one GET (the second call: caches of the first are warm). */
  async function statements(c: Client, url: string): Promise<number> {
    await c('GET', url);
    counted.delete(`/api${url}`);
    await c('GET', url);
    return counted.get(`/api${url}`) ?? -1;
  }
  const LIST_URLS = ['/processes', '/platforms', '/monitors', '/plant/sites'];

  it('the statements of the lists stay the same when their items get shares and are Restricted', async () => {
    const olivia = await s.as('olivia', PW);
    const count = async () => {
      const out: Record<string, number> = {};
      for (const u of LIST_URLS) out[u] = await statements(olivia, u);
      return out;
    };
    const mine = items.filter((it) => it.kind !== 'platform_identity' && !it.acl.length).slice(0, 40);
    const open = await count();
    for (const it of mine) await storeAcl(it.kind, it.id, [{ subject: 'user:olivia', permissions: it.kind === 'platform' ? ['use'] : ['view'] }]);
    const shared = await count();
    expect(shared).toEqual(open);
    for (const it of mine) await storeAcl(it.kind, it.id, []);
  });
});

describe('the upgrade fixture (v0.19.0, SQLite)', () => {
  it('turns the access lists of a released version into the shares and scopes proven above', async () => {
    const { Db } = await import('../src/db.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-acl-fx-'));
    const file = path.join(dir, 'service-manager.db');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'upgrade', 'v0.19.0', 'datadir', 'service-manager.db'), file);
    const lists: { kind: keyof typeof LISTS; table: string; id: string; acl: readonly AclEntry[] }[] = [];
    const raw = new DatabaseSync(file);
    try {
      const pick = (table: string) => raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[];
      const write = (kind: keyof typeof LISTS, table: string) => {
        const ids = pick(table);
        LISTS[kind].forEach((list, i) => {
          const id = ids[i]?.id;
          if (!id) return;
          raw.prepare(`UPDATE ${table} SET acl = ? WHERE id = ?`).run(JSON.stringify(list), id);
          lists.push({ kind, table, id, acl: list });
        });
      };
      write('process', 'processes');
      write('monitor', 'monitors');
      write('platform', 'platforms');
      // identities that are not the default (the default has no list), on a platform of the fixture
      const platform = pick('platforms')[0]!.id;
      LISTS.platform_identity.forEach((list, i) => {
        const id = `pi_fx_${i}`;
        raw
          .prepare(
            'INSERT INTO platform_identities (id, platform_id, name, is_default, acl, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
          )
          .run(id, platform, `Fixture identity ${i}`, JSON.stringify(list), at, 'admin', at, 'admin');
        lists.push({ kind: 'platform_identity', table: 'platform_identities', id, acl: list });
      });
      LISTS.site.forEach((list, i) => {
        const id = `site_fx_${i}`;
        raw
          .prepare('INSERT INTO plant_sites (id, name, acl, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, `Fixture site ${i}`, JSON.stringify(list), at, 'admin', at, 'admin');
        lists.push({ kind: 'site', table: 'plant_sites', id, acl: list });
      });
    } finally {
      raw.close();
    }
    expect(new Set(lists.map((l) => l.kind)).size).toBe(5);
    const upgraded = new Db({ kind: 'sqlite', file }, { quiet: true });
    try {
      for (const l of lists) {
        const stored = upgraded
          .all<{ subject: string; level: string; actions: string; rights: string | null; created_by: string }>(
            'SELECT subject, level, actions, rights, created_by FROM resource_shares WHERE kind = ? AND resource_id = ? ORDER BY subject',
            l.kind,
            l.id,
          )
          .map((r) => ({
            subject: r.subject,
            level: r.level,
            actions: JSON.parse(r.actions),
            rights: r.rights ? JSON.parse(r.rights) : null,
            by: r.created_by,
          }));
        const expected = acl
          .aclToShares(l.kind, l.acl)
          .map((x) => ({ subject: x.subject, level: x.level, actions: x.actions, rights: x.rights ?? null, by: 'system' }));
        expect(stored, `${l.kind} ${l.id}`).toEqual(expected);
        const restricted = !!upgraded.get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', l.kind, l.id);
        expect(restricted, `${l.kind} ${l.id}`).toBe(l.kind !== 'platform_identity' && l.acl.length > 0);
        // the access list stays as it was (no longer read)
        expect(JSON.parse(upgraded.get<{ acl: string }>(`SELECT acl FROM ${l.table} WHERE id = ?`, l.id)!.acl)).toEqual(l.acl);
      }
    } finally {
      upgraded.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
