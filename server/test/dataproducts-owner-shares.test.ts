import { beforeAll, describe, expect, it } from 'vitest';
import type { DataProductPermission, Role } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The proof of the owner-shares conversion (0.25.1, ADR 0038 part 2): owner fields give no rights any more, and nobody
 * gains or loses a right at the upgrade.
 *
 * An instance with domains, products and data objects – owned and unowned, Restricted, with owners, domain owners,
 * data owners and stewards (users and teams, upper case and spaces, a former name, a team that does not exist, a user
 * left out of the restricted module), and shares that are lower than what the owner field gave, with an end date, or
 * already enough – is decided twice on the database the suite runs on (SQLite, or PostgreSQL with
 * SM_TEST_DATABASE_URL):
 *
 *  - **before**: the rules of 0.25.0 – what roles, owning teams, module roles and shares give, plus what the owner
 *    fields gave (product and domain owners View, Edit and Manage; a data object's owner and stewards View), only for
 *    who uses the module, Manage including Edit and any right including View (the normalisation of access.ts);
 *  - **after**: the migration's own SQL run on that data, then the policy now (owner fields give nothing).
 *
 * Every user's rights on every product, domain, data object and element must be equal. The conversion records what it
 * did, audits it once the vault is open (access family), and running it again changes nothing.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let db: typeof import('../src/db.js').db;
let access: typeof import('../src/dataproducts/access.js');
let perms: typeof import('../src/auth/permissions.js');
let users: typeof import('../src/auth/users.js');
let ctx: typeof import('../src/auth/context.js');
let moduleAccess: typeof import('../src/modules/access.js');
let shareStore: typeof import('../src/auth/share-store.js');

const USERS: [string, Role[]][] = [
  ['dana', ['designer']],
  ['olivia', ['operator']],
  ['vera', ['viewer']],
  ['tess', ['viewer']],
  ['audrey', ['auditor']],
  ['adam', ['approver']],
  ['ulla', ['operator']],
  ['neo', ['viewer']],
  ['pia', ['plant']],
  ['outsider', ['designer']],
];

type Kind = 'data_product' | 'data_domain' | 'data_object';
interface Item {
  kind: Kind;
  id: string;
  named: string[];
}
const items: Item[] = [];
const elements: string[] = [];
const at = '2026-10-01T00:00:00.000Z';
const ALL: DataProductPermission[] = ['view', 'edit', 'manage'];
const normalise = (got: Iterable<string>): string[] => {
  const has = new Set(got);
  if (has.size) has.add('view');
  if (has.has('manage')) has.add('edit');
  return ALL.filter((p) => has.has(p));
};

/** Owner fields of every shape: the subjects named (product and domain owners; a data object's owner is a user name). */
const OWNERS: string[][] = [
  [],
  ['user:vera'],
  ['user:Vera', ' user:tess '],
  ['team:ops'],
  ['team:qa', 'user:olivia'],
  ['user:formername'],
  ['team:gone'],
  ['user:outsider'],
  ['user:pia', 'user:audrey'],
  ['user:dana'],
];
const OBJECT_OWNERS: (string | null)[] = [null, 'vera', 'Tess', 'olivia', 'outsider', 'formername', 'audrey'];
const STEWARDS: string[][] = [[], ['user:vera'], ['team:ops'], ['user:adam', 'team:qa'], ['team:gone'], ['user:neo']];

const rightsOf = (u: import('../src/auth/context.js').AuthUser, it: Item): string[] =>
  it.kind === 'data_product'
    ? access.productAccess(u, { id: it.id }).permissions
    : it.kind === 'data_domain'
      ? access.domainAccess(u, { id: it.id }).permissions
      : access.objectAccess(u, { id: it.id }).permissions;

/** The rules of 0.25.0: what the policy gives without owner fields, plus what the fields gave (module users only). */
function legacy(u: import('../src/auth/context.js').AuthUser, it: Item): string[] {
  const now = rightsOf(u, it);
  if (!moduleAccess.usesModule(u, 'dataProducts')) return now;
  if (!it.named.some((x) => perms.matches(u, x))) return now;
  return normalise([...now, ...(it.kind === 'data_object' ? ['view'] : ALL)]);
}

let before = new Map<string, string>();
let people: import('../src/auth/context.js').AuthUser[] = [];
const key = (u: { username: string }, it: { kind: string; id: string }) => `${u.username}|${it.kind}|${it.id}`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  db = (await import('../src/db.js')).db;
  access = await import('../src/dataproducts/access.js');
  perms = await import('../src/auth/permissions.js');
  users = await import('../src/auth/users.js');
  ctx = await import('../src/auth/context.js');
  moduleAccess = await import('../src/modules/access.js');
  shareStore = await import('../src/auth/share-store.js');
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  for (const [username, roles] of USERS) users.createUser({ username, roles, password: PW, mustChangePassword: false });
  const ops = await s.api('POST', '/teams', { name: 'Ops', members: ['tess', 'dana'] });
  await s.api('POST', '/teams', { name: 'QA', members: ['ulla', 'olivia'] });
  await s.api('POST', '/teams', { name: 'Module users', members: ['dana', 'olivia', 'vera', 'tess', 'ulla', 'neo', 'adam', 'pia'] });
  db().run(`UPDATE team_members SET roles = '["designer"]' WHERE team_id = ? AND user_id = ?`, ops.id, users.findUserByName('tess')!.id);
  // the module restricted to a team: "outsider" (a designer) does not use it – named as an owner, they had nothing
  await s.api('PUT', '/settings/modules/dataProducts/access', { mode: 'selected', grants: [{ subject: 'team:module users' }] });
  // a granted module role (ADR 0034 phase 2): neo manages the module
  db().run(
    "INSERT INTO module_grants (id, module_id, subject, role, source, created_by, created_at) VALUES ('mg_neo', 'dataProducts', 'user:neo', 'manager', NULL, 'admin', ?)",
    at,
  );
  // a former name of ulla (a migration package): user:formername matches ulla
  db().run(
    `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
       source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
     VALUES ('imp_dp', '00000000-0000-0000-0000-000000000002', 'x', 'now', 'test', 'fp', 'key', '0.24.0', 'now', 'test', '{}', '[]', '', '{}', '{}', 0)`,
  );
  db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', 'formername', ?, 'imp_dp')", users.findUserByName('ulla')!.id);
  (await import('../src/auth/aliases.js')).invalidateAliases();
  moduleAccess.forgetModuleAccess();

  const own = (kind: string, id: string) =>
    db().run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', kind, id, ops.id, at);
  const share = (kind: string, id: string, subject: string, level: string, expires: string | null) =>
    db().run(
      `INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, '[]', ?, 'admin', ?)`,
      kind,
      id,
      subject,
      level,
      expires,
      at,
    );
  let n = 0;
  for (const owned of [false, true])
    for (const restricted of [false, true]) {
      for (const owners of OWNERS) {
        const d = `dd_${n++}`;
        db().run(
          'INSERT INTO dp_domains (id, key, name, owners, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          d,
          d,
          `Domain ${d}`,
          JSON.stringify(owners),
          at,
          'admin',
          at,
          'admin',
        );
        if (owned) own('data_domain', d);
        items.push({ kind: 'data_domain', id: d, named: owners });
        const p = `dp_${n++}`;
        db().run(
          `INSERT INTO dp_products (id, key, name, name_norm, type, domain_id, owners, lifecycle, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 'sourceAligned', ?, ?, 'active', ?, 'admin', ?, 'admin')`,
          p,
          p,
          `Product ${p}`,
          `product ${p}`,
          d,
          JSON.stringify(owners),
          at,
          at,
        );
        if (owned) own('data_product', p);
        if (restricted) db().run("INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES ('data_product', ?, 'admin', ?)", p, at);
        // shares of an owner below Manage, ending, or already Manage for good; and of someone not named
        if (owners[0] === 'user:vera') share('data_product', p, 'user:vera', restricted ? 'edit' : 'view', restricted ? '2027-01-01T00:00:00.000Z' : null);
        if (owners[0] === 'team:ops') share('data_product', p, 'team:ops', 'manage', null);
        if (owners[0] === 'user:dana') share('data_product', p, 'user:dana', 'manage', '2027-02-01T00:00:00.000Z');
        if (owners.length === 0) share('data_product', p, 'user:adam', 'edit', null);
        items.push({ kind: 'data_product', id: p, named: owners });
      }
      for (const owner of OBJECT_OWNERS)
        for (const stewards of STEWARDS) {
          const o = `do_${n++}`;
          db().run(
            `INSERT INTO dp_objects (id, key, name, name_norm, owner, stewards, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, 'admin')`,
            o,
            o,
            `Object ${o}`,
            `object ${o}`,
            owner,
            JSON.stringify(stewards),
            at,
            at,
          );
          if (owned) own('data_object', o);
          items.push({ kind: 'data_object', id: o, named: [...(owner ? [`user:${owner.toLowerCase()}`] : []), ...stewards] });
        }
    }
  for (const owned of [false, true]) {
    const e = `de_${n++}`;
    elements.push(e);
    db().run(
      `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, environment, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'pf_none', 'snowflake.table', ?, ?, 'prod', ?, 'admin', ?, 'admin')`,
      e,
      `DB.S.${e}`,
      `db.s.${e}`,
      at,
      at,
    );
    if (owned) own('data_element', e);
  }
  people = ['admin', ...USERS.map(([u]) => u)].map((u) => users.toAuthUser(users.findUserByName(u)!));
  // before: the rules of 0.25.0 (no conversion has run on this data yet)
  ctx.runAs(null, () => {
    before = new Map();
    for (const it of items) for (const u of people) before.set(key(u, it), legacy(u, it).join('/'));
    for (const e of elements) for (const u of people) before.set(key(u, { kind: 'data_element', id: e }), elementRights(u, e).join('/'));
  });
  // the migration's own conversion, on this database's dialect
  const { ownerShareConversion } = await import('../src/migrations/dataproducts-governance.js');
  db().exec(ownerShareConversion(db().dialect));
  shareStore.sharesChanged();
}, 120_000);

const elementRights = (u: import('../src/auth/context.js').AuthUser, id: string) =>
  access.elementAccess(
    u,
    db()
      .all<{ team_id: string }>("SELECT team_id FROM resource_teams WHERE kind = 'data_element' AND resource_id = ?", id)
      .map((r) => r.team_id),
  ).permissions;

describe('owner fields become shares (0.25.1): nobody gains or loses a right', () => {
  for (const kind of ['data_product', 'data_domain', 'data_object'] as const)
    it(`${kind}: every user's rights on every item are those of 0.25.0`, () => {
      const diffs: string[] = [];
      let compared = 0;
      let named = 0;
      ctx.runAs(null, () => {
        for (const it of items.filter((x) => x.kind === kind))
          for (const u of people) {
            const after = rightsOf(u, it).join('/');
            compared++;
            if (it.named.some((x) => perms.matches(u, x))) named++;
            if (before.get(key(u, it)) !== after) diffs.push(`${u.username} on ${it.id} ${JSON.stringify(it.named)}: ${before.get(key(u, it))} → ${after}`);
          }
      });
      expect(diffs).toEqual([]);
      expect(compared).toBeGreaterThan(100);
      expect(named).toBeGreaterThan(10);
    });

  it('data_element: unchanged (elements never had named people)', () => {
    const diffs: string[] = [];
    ctx.runAs(null, () => {
      for (const e of elements)
        for (const u of people) if (before.get(key(u, { kind: 'data_element', id: e })) !== elementRights(u, e).join('/')) diffs.push(`${u.username} on ${e}`);
    });
    expect(diffs).toEqual([]);
  });

  it('owner fields alone give nothing now: a new owner gets no right', () => {
    const p = items.find((x) => x.kind === 'data_product' && x.named.length === 0)!;
    db().run(`UPDATE dp_products SET owners = '["user:vera"]' WHERE id = ?`, p.id);
    const vera = users.toAuthUser(users.findUserByName('vera')!);
    ctx.runAs(null, () => expect(access.productAccess(vera, { id: p.id }).permissions).toEqual(before.get(key(vera, p))!.split('/').filter(Boolean)));
    db().run(`UPDATE dp_products SET owners = '[]' WHERE id = ?`, p.id);
  });

  it('records each share made or raised, permanent and at the level the field gave, and changes nothing when run again', async () => {
    const conv = db().all<{ kind: string; resource_id: string; subject: string; level: string; before_level: string | null; audited_at: string | null }>(
      'SELECT kind, resource_id, subject, level, before_level, audited_at FROM dp_owner_share_conversions ORDER BY kind, resource_id, subject',
    );
    expect(conv.length).toBeGreaterThan(20);
    for (const c of conv) {
      expect(c.subject).toBe(c.subject.trim().toLowerCase());
      expect(c.level).toBe(c.kind === 'data_object' ? 'view' : 'manage');
      const sh = db().get<{ level: string; expires_at: string | null }>(
        'SELECT level, expires_at FROM resource_shares WHERE kind = ? AND resource_id = ? AND subject = ?',
        c.kind,
        c.resource_id,
        c.subject,
      )!;
      expect(sh).toEqual({ level: c.level, expires_at: null });
    }
    // a lower share and a Manage share with an end date were raised; a Manage share for good needed nothing
    expect(conv.some((c) => c.subject === 'user:vera' && c.before_level === 'view')).toBe(true);
    expect(conv.some((c) => c.subject === 'user:dana' && c.before_level === 'manage')).toBe(true);
    expect(conv.some((c) => c.kind === 'data_product' && c.subject === 'team:ops')).toBe(false);
    // a share of someone not named stays as it was
    expect(db().all("SELECT 1 FROM resource_shares WHERE subject = 'user:adam' AND level = 'edit'").length).toBeGreaterThan(0);
    const shares = db().all('SELECT * FROM resource_shares ORDER BY kind, resource_id, subject');
    const { ownerShareConversion } = await import('../src/migrations/dataproducts-governance.js');
    db().exec(ownerShareConversion(db().dialect));
    expect(db().all('SELECT * FROM resource_shares ORDER BY kind, resource_id, subject')).toEqual(shares);
    expect(db().all('SELECT kind, resource_id, subject FROM dp_owner_share_conversions').length).toBe(conv.length);
  });

  it('audits each conversion once in the access family (once the vault is open)', async () => {
    const { auditOwnerShareConversions } = await import('../src/dataproducts/governance-upgrade.js');
    const n = auditOwnerShareConversions();
    const total = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_owner_share_conversions')!.n);
    expect(n).toBe(total);
    expect(auditOwnerShareConversions()).toBe(0);
    const entries = db().all<{ action: string; entity_type: string; summary: string; details: string }>(
      "SELECT action, entity_type, summary, details FROM audit_log WHERE action IN ('access.share_added', 'access.share_changed') AND actor = 'system'",
    );
    expect(entries.length).toBe(total);
    expect(entries.some((e) => e.action === 'access.share_changed' && e.summary.includes('keeps Manage'))).toBe(true);
    expect(entries.find((e) => e.entity_type === 'data_object')!.summary).toMatch(/gets View as a share – named as (its data owner|a steward)/);
    expect(JSON.parse(entries[0]!.details).upgrade).toMatchObject({ release: '0.25.1', reason: 'ownerFieldNoRights' });
    expect(db().all('SELECT 1 FROM dp_owner_share_conversions WHERE audited_at IS NULL')).toEqual([]);
  });
});

describe('owner fields and decisions become contacts (0.25.1, after the shares)', () => {
  it('links the people of owner fields as contacts – a user the contact linked to the account, a team a group – once, audited, rights unchanged', async () => {
    const { db: d } = await import('../src/db.js');
    // an approved request of before (its registration), an endorsement and a sign-off by Steward users
    const p = items.find((x) => x.kind === 'data_product' && x.named.includes('user:vera'))!;
    d().run(
      "INSERT INTO dp_ports (id, product_id, direction, name, version, lifecycle, created_at, created_by, updated_at, updated_by) VALUES ('dpp_c', ?, 'output', 'orders', 'v1', 'active', ?, 'admin', ?, 'admin')",
      p.id,
      at,
      at,
    );
    d().run(
      `INSERT INTO dp_consumers (id, port_id, consumer_kind, consumer_text, purpose, contacts, created_at, created_by, updated_at, updated_by)
       VALUES ('dpc_c', 'dpp_c', 'text', 'Invented report', 'Close', '["user:tess","team:qa"]', ?, 'admin', ?, 'admin')`,
      at,
      at,
    );
    d().run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, consumer_text, purpose, status, approvals, decided_by, decided_at, decision_comment, consumer_id, created_at, updated_at)
       VALUES ('dpx_c', ?, 'dpp_c', 'prod', 'tess', 'text', 'Invented report', 'Close', 'approved', '[{"by":"vera","at":"2026-09-01T00:00:00.000Z","comment":""}]', 'vera', '2026-09-01T00:00:00.000Z', 'Fine', 'dpc_c', ?, ?)`,
      p.id,
      at,
      at,
    );
    d().run(
      "INSERT INTO dp_endorsements (product_id, endorsed_by, endorsed_at, review_date, note) VALUES (?, 'olivia', '2026-08-01T00:00:00.000Z', '2027-08-01', 'Trusted')",
      p.id,
    );
    d().run(
      "INSERT INTO dp_semantic_versions (id, product_id, version, format, sha256, size, note, origin, lint_count, document, created_by, created_at) VALUES ('sv_c', ?, 1, 'yaml', 'abc', 3, '', 'page', 0, 'x: 1', 'dana', ?)",
      p.id,
      at,
    );
    d().run(
      "INSERT INTO dp_semantic_signoffs (id, product_id, version_id, version, sha256, valid_from, note, signed_by, signed_at) VALUES ('so_c', ?, 'sv_c', 1, 'abc', '2026-09-02', '', 'adam', '2026-09-02T00:00:00.000Z')",
      p.id,
    );
    const g = await import('../src/dataproducts/governance-upgrade.js');
    const converted = ctx.runAs(null, () => g.convertOwnerFields());
    expect(converted).toBeGreaterThan(20);
    expect(ctx.runAs(null, () => g.convertOwnerFields())).toBe(0);
    expect(ctx.runAs(null, () => g.documentApprovedRequests())).toBe(1);
    expect(ctx.runAs(null, () => g.documentApprovedRequests())).toBe(0);
    expect(ctx.runAs(null, () => g.documentApprovals())).toBe(2);
    expect(ctx.runAs(null, () => g.documentApprovals())).toBe(0);
    const { linksOf } = await import('../src/contacts/service.js');
    // a user: the person contact linked to that account; a team: a group contact; the old columns are empty
    const links = linksOf('data_product', [p.id]).get(p.id)!;
    expect(links).toEqual([expect.objectContaining({ role: 'productOwner', contact: expect.objectContaining({ kind: 'person', user: 'vera' }) })]);
    const obj = items.find((x) => x.kind === 'data_object' && x.named.includes('user:adam') && x.named.includes('team:qa'))!;
    const objLinks = linksOf('data_object', [obj.id]).get(obj.id)!;
    expect(objLinks.map((l) => [l.role, l.contact.kind])).toEqual(expect.arrayContaining([['dataSteward', 'group']]));
    expect(objLinks.find((l) => l.contact.kind === 'group')!.contact.name.toLowerCase()).toBe('qa');
    expect(d().all("SELECT id FROM dp_products WHERE owners <> '[]'")).toEqual([]);
    expect(d().all("SELECT id FROM dp_objects WHERE owner IS NOT NULL OR stewards <> '[]'")).toEqual([]);
    // one contact per person: vera is one contact wherever she was named
    const veras = d().all<{ n: number }>("SELECT COUNT(*) AS n FROM contacts c JOIN users u ON u.id = c.user_id WHERE u.username = 'vera'");
    expect(Number(veras[0]!.n)).toBe(1);
    // the registration's contacts, and its approval documented from the request
    const cLinks = linksOf('data_consumer', ['dpc_c']).get('dpc_c')!;
    expect(cLinks.map((l) => l.contact.kind).sort()).toEqual(['group', 'person']);
    const consumer = d().get<{ approval: string; decision: string }>("SELECT approval, decision FROM dp_consumers WHERE id = 'dpc_c'")!;
    expect(consumer.approval).toBe('documented');
    expect(JSON.parse(consumer.decision)).toMatchObject({ decidedBy: [{ role: 'approver' }], decidedOn: '2026-09-01', note: 'Fine', recordedBy: 'vera' });
    // endorsement and sign-off keep their users as contacts linked to them
    const e = JSON.parse(d().get<{ decision: string }>('SELECT decision FROM dp_endorsements WHERE product_id = ?', p.id)!.decision);
    expect(e).toMatchObject({ decidedBy: [{ role: 'domainOwner' }], decidedOn: '2026-08-01', recordedBy: 'olivia' });
    expect(JSON.parse(d().get<{ decision: string }>("SELECT decision FROM dp_semantic_signoffs WHERE id = 'so_c'")!.decision)).toMatchObject({
      decidedBy: [{ role: 'approver' }],
      decidedOn: '2026-09-02',
    });
    // contacts give no right: everyone's rights are still those of 0.25.0
    const diffs: string[] = [];
    ctx.runAs(null, () => {
      for (const it of items) for (const u of people) if (before.get(key(u, it)) !== rightsOf(u, it).join('/')) diffs.push(`${u.username} on ${it.id}`);
    });
    expect(diffs).toEqual([]);
    expect(
      d().all("SELECT 1 FROM audit_log WHERE action IN ('dataproduct.contacts_converted', 'datadomain.contacts_converted', 'dataobject.contacts_converted')")
        .length,
    ).toBe(converted);
  });
});
