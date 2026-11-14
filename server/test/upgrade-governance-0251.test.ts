import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { Db, type DatabaseTarget } from '../src/db.js';
import { PG_TEST_URL } from './pg-env.js';
import { spawnTestServer } from './server-process.js';

/**
 * The upgrade of a 0.25.0 installation to documented governance and the contacts directory (0.25.1, ADR 0038), on the
 * v0.25.0 upgrade fixture (server/test/fixtures/upgrade/v0.25.0, written by 0.25.0) with data products added in the
 * shape 0.25.0 wrote them: a domain owned by a team, a product with two owners (one holding a View share until a date),
 * a data object with a data owner and a steward, a registration made by hand, one made by an approved access request,
 * a pending request, an endorsement and a semantic model sign-off. The server upgrades it as a real installation does –
 * migrations at start, then the conversions when an administrator unlocks the vault – and again after a restart
 * (nothing is done twice). On SQLite (the fixture's database) and – with SM_TEST_DATABASE_URL – on PostgreSQL: a schema
 * brought to the fixture's version gets its rows as they are (as upgrade.test.ts does), and the server migrates and
 * converts them there.
 */
const SERVER = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade', 'v0.25.0');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  admin: { username: string; password: string };
  demoPassword: string;
  ids: Record<string, string>;
};
const AT = '2026-11-01T08:00:00.000Z';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upg-0251-'));
const sqlite: DatabaseTarget = { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') };
const schema = `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_upg_gov_0251_${process.pid}`;
const pg: DatabaseTarget | undefined = PG_TEST_URL ? { kind: 'postgres', url: PG_TEST_URL, schema } : undefined;
let proc: ChildProcess | undefined;
let base = '';

function client() {
  let cookie = '';
  let sessionKey = '';
  return async (method: string, url: string, body?: unknown): Promise<any> => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: {
        'x-sm-client': '1',
        ...(cookie ? { cookie } : {}),
        ...(sessionKey ? { 'x-sm-session': sessionKey } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const key = res.headers.get('x-sm-session-key');
    if (key !== null) sessionKey = key;
    const t = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${t}`), { status: res.status });
    return t && res.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t;
  };
}

async function start(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: '0' };
  for (const k of ['SM_DATABASE_URL', 'SM_DATABASE_SCHEMA', 'SM_MASTER_PASSPHRASE', 'SM_MASTER_PASSPHRASE_FILE', 'SM_DEMO']) delete env[k];
  if (pg) Object.assign(env, { SM_DATABASE_URL: PG_TEST_URL, SM_DATABASE_SCHEMA: schema });
  Object.assign(env, { SM_GATUS_AUTOSTART: '0', SM_MONITOR_AUTOSTART: '0', SM_MONITOR_DEMO_SIMULATOR: '0', SM_UPGRADE_BACKUPS: '0' });
  let out = '';
  base = '';
  proc = await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawnTestServer({ cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('server start timeout: ' + out)), 60_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const url = startedUrl(out);
      if (url && !base) {
        base = url;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
}

async function stop(): Promise<void> {
  const p = proc;
  proc = undefined;
  if (!p || p.exitCode !== null) return;
  await new Promise((r) => {
    p.once('exit', r);
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 10_000).unref();
  });
}

/** An administrator signs in and unlocks the vault: the conversions run in that request (as the system). */
async function unlock() {
  const admin = client();
  await admin('POST', '/auth/login', manifest.admin);
  await admin('POST', '/vault/unlock', { passphrase: manifest.passphrase });
  return admin;
}

/** A read-only look at the database while the server runs. */
function look<T>(fn: (d: Db) => T): T {
  const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

/** The audit entries of the conversions. */
const CONVERSIONS = [
  'access.share_added',
  'access.share_changed',
  'contact.created',
  'dataproduct.contacts_converted',
  'datadomain.contacts_converted',
  'dataobject.contacts_converted',
  'dataproduct.access_request_converted',
  'dataproduct.access_documented',
  'dataproduct.endorsement_documented',
  'dataproduct.semantic_model_documented',
];

/** Everything the upgrade made, for comparing two starts. */
const made = () =>
  look((d) => ({
    contacts: d.all('SELECT id, kind, name, email, user_id, created_by FROM contacts ORDER BY id'),
    links: d.all('SELECT kind, item_id, role, contact_id FROM contact_links ORDER BY kind, item_id, role, contact_id'),
    shares: d.all("SELECT kind, resource_id, subject, level, expires_at FROM resource_shares WHERE kind LIKE 'data_%' ORDER BY kind, resource_id, subject"),
    consumers: d.all('SELECT id, approval, decision, request_id FROM dp_consumers ORDER BY id'),
    audited: d.all<{ action: string; n: number }>(
      `SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN (${CONVERSIONS.map(() => '?').join(', ')}) GROUP BY action ORDER BY action`,
      ...CONVERSIONS,
    ),
  }));

beforeAll(async () => {
  fs.cpSync(path.join(FIXTURE, 'datadir'), dataDir, { recursive: true });
  // data products as 0.25.0 wrote them (its schema: the fixture's database before any migration of 0.25.1)
  const old = new Db(sqlite, { migrate: false });
  try {
    const run = (sql: string, ...args: unknown[]) => old.run(sql, ...args);
    run("UPDATE users SET email = 'dana@invented.example' WHERE username = 'dana'");
    run(
      `INSERT INTO dp_domains (id, key, name, owners, created_at, created_by, updated_at, updated_by) VALUES ('dd_upg', 'sales', 'Sales', '["team:service desk"]', ?, 'admin', ?, 'admin')`,
      AT,
      AT,
    );
    run(
      `INSERT INTO dp_products (id, key, name, name_norm, domain_id, owners, lifecycle, created_at, created_by, updated_at, updated_by)
       VALUES ('dp_upg', 'orders', 'Orders', 'orders', 'dd_upg', '["user:dana","user:vera"]', 'active', ?, 'admin', ?, 'admin')`,
      AT,
      AT,
    );
    // vera held a View share until a date beside her ownership (Manage): the share is raised and keeps no end date
    run(
      `INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at) VALUES ('data_product', 'dp_upg', 'user:vera', 'view', '[]', '2027-01-31T00:00:00.000Z', 'admin', ?)`,
      AT,
    );
    run(
      `INSERT INTO dp_objects (id, key, name, name_norm, owner, stewards, created_at, created_by, updated_at, updated_by)
       VALUES ('do_upg', 'customer', 'Customer', 'customer', 'olivia', '["user:vera"]', ?, 'admin', ?, 'admin')`,
      AT,
      AT,
    );
    run(
      `INSERT INTO dp_ports (id, product_id, direction, name, lifecycle, created_at, created_by, updated_at, updated_by) VALUES ('dpp_upg', 'dp_upg', 'output', 'orders', 'active', ?, 'admin', ?, 'admin')`,
      AT,
      AT,
    );
    // a registration made by hand, and one an approved access request made
    for (const [id, text, contacts] of [
      ['dpc_hand', 'Invented finance reports', '["user:olivia"]'],
      ['dpc_appr', 'Invented BI', '[]'],
    ] as const)
      run(
        `INSERT INTO dp_consumers (id, port_id, consumer_kind, consumer_text, purpose, contacts, created_at, created_by, updated_at, updated_by)
         VALUES (?, 'dpp_upg', 'text', ?, 'Monthly close', ?, ?, 'dana', ?, 'dana')`,
        id,
        text,
        contacts,
        AT,
        AT,
      );
    run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, consumer_text, purpose, status, four_eyes, approvals, decided_by, decided_at, decision_comment, consumer_id, created_at, updated_at)
       VALUES ('dpx_appr', 'dp_upg', 'dpp_upg', 'prod', 'olivia', 'text', 'Invented BI', 'Dashboards', 'approved', 0, '[{"by":"adam","at":"2026-10-15T09:00:00.000Z"}]', 'adam', '2026-10-15T09:00:00.000Z', 'Agreed in the steering board', 'dpc_appr', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, consumer_text, purpose, until_date, identities, status, created_at, updated_at)
       VALUES ('dpx_pend', 'dp_upg', 'dpp_upg', 'prod', 'olivia', 'text', 'Invented forecast', 'Planning', '2027-06-30', '["role:PLANNING"]', 'pending', ?, ?)`,
      AT,
      AT,
    );
    run(
      "INSERT INTO dp_endorsements (product_id, endorsed_by, endorsed_at, review_date, note) VALUES ('dp_upg', 'adam', '2026-10-20T10:00:00.000Z', '2027-10-20', 'Good owners')",
    );
    run(
      `INSERT INTO dp_semantic_versions (id, product_id, version, format, document, sha256, size, created_by, created_at) VALUES ('dsv_upg', 'dp_upg', 1, 'yaml', 'version: 1', 'abc123', 10, 'dana', ?)`,
      AT,
    );
    run(
      "INSERT INTO dp_semantic_signoffs (id, product_id, version_id, version, sha256, valid_from, note, signed_by, signed_at) VALUES ('dss_upg', 'dp_upg', 'dsv_upg', 1, 'abc123', '2026-11-02', '', 'adam', '2026-11-02T10:00:00.000Z')",
    );
  } finally {
    old.close();
  }
  if (pg) {
    // PostgreSQL at the fixture's version, with its rows: the server migrates and converts them on PostgreSQL
    const d = new Db(sqlite, { migrate: false });
    const state = {
      core: Number(d.get<{ version: number }>('SELECT version FROM schema_version')!.version),
      named: d
        .all<{ name: string }>('SELECT name FROM schema_migrations')
        .map((r) => r.name)
        .sort(),
    };
    d.close();
    new Db(pg, { upTo: state, quiet: true, appVersion: '0.25.0' }).close();
    const { copyDatabase } = await import('../src/cli/db-copy.js');
    copyDatabase({ from: sqlite, to: pg, asIs: true, force: true });
  }
  await start();
}, 180_000);

afterAll(async () => {
  await stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('upgrade of the v0.25.0 fixture to 0.25.1 (ADR 0038)', () => {
  let first: ReturnType<typeof made>;
  let admin: ReturnType<typeof client>;

  it('converts once an administrator unlocks the vault – as the system', async () => {
    admin = await unlock();
    await admin('PUT', '/settings/modules/dataProducts', { enabled: true });
    first = made();
    // contacts and links are the system's, not the administrator's who unlocked
    expect(first.contacts.length).toBeGreaterThan(0);
    for (const c of first.contacts as { created_by: string }[]) expect(c.created_by).toBe('system');
  });

  it('keeps everyone’s rights as explicit shares, audited in the access family', async () => {
    expect(first.shares).toEqual([
      { kind: 'data_domain', resource_id: 'dd_upg', subject: 'team:service desk', level: 'manage', expires_at: null },
      { kind: 'data_object', resource_id: 'do_upg', subject: 'user:olivia', level: 'view', expires_at: null },
      { kind: 'data_object', resource_id: 'do_upg', subject: 'user:vera', level: 'view', expires_at: null },
      { kind: 'data_product', resource_id: 'dp_upg', subject: 'user:dana', level: 'manage', expires_at: null },
      // raised from View until a date: the owner had Manage for good
      { kind: 'data_product', resource_id: 'dp_upg', subject: 'user:vera', level: 'manage', expires_at: null },
    ]);
    expect(look((d) => d.all('SELECT audited_at FROM dp_owner_share_conversions WHERE audited_at IS NULL'))).toEqual([]);
    const added = (await admin('GET', '/audit?action=access.share_added&limit=50')) as { entityId: string; actor: string }[];
    const changed = (await admin('GET', '/audit?action=access.share_changed&limit=50')) as { entityId: string; summary: string }[];
    expect(added.map((a) => a.entityId).sort()).toEqual(['dd_upg', 'do_upg', 'do_upg', 'dp_upg']);
    expect(added.every((a) => a.actor === 'system')).toBe(true);
    expect(changed).toEqual([expect.objectContaining({ entityId: 'dp_upg', summary: expect.stringContaining('user:vera keeps Manage') })]);
    // the people see what they saw: vera (a viewer) still manages the product and sees the data object; adam (team
    // Service Desk) manages the domain
    const vera = client();
    await vera('POST', '/auth/login', { username: 'vera', password: manifest.demoPassword });
    expect((await vera('GET', '/data-products/dp_upg')).permissions).toEqual(['view', 'edit', 'manage']);
    expect((await vera('GET', '/data-objects/do_upg')).permissions).toEqual(['view']);
    const adam = client();
    await adam('POST', '/auth/login', { username: 'adam', password: manifest.demoPassword });
    expect((await adam('GET', '/data-domains/dd_upg')).permissions).toEqual(['view', 'edit', 'manage']);
  });

  it('turns owner fields into contacts – a user the contact linked to the account, a team a group named as the team', () => {
    const rows = look((d) =>
      d.all<{ kind: string; item_id: string; role: string; name: string; email: string; ckind: string; username: string | null }>(
        `SELECT l.kind, l.item_id, l.role, c.name, c.email, c.kind AS ckind, u.username FROM contact_links l JOIN contacts c ON c.id = l.contact_id
           LEFT JOIN users u ON u.id = c.user_id WHERE l.kind LIKE 'data_%' ORDER BY l.kind, l.item_id, l.role, c.name`,
      ),
    );
    const byItem = (kind: string, id: string) => rows.filter((r) => r.kind === kind && r.item_id === id).map((r) => [r.role, r.name, r.ckind, r.username]);
    expect(byItem('data_domain', 'dd_upg')).toEqual([['domainOwner', 'Service Desk', 'group', null]]);
    expect(byItem('data_product', 'dp_upg')).toEqual([
      ['productOwner', 'Dana Designer', 'person', 'dana'],
      ['productOwner', 'Vera Viewer', 'person', 'vera'],
    ]);
    expect(byItem('data_object', 'do_upg')).toEqual([
      ['dataOwner', 'Olivia Operator', 'person', 'olivia'],
      ['dataSteward', 'Vera Viewer', 'person', 'vera'],
    ]);
    // the account's name and e-mail address
    expect(rows.find((r) => r.username === 'dana')!.email).toBe('dana@invented.example');
    expect(byItem('data_consumer', 'dpc_hand')).toEqual([['consumerContact', 'Olivia Operator', 'person', 'olivia']]);
    // one contact per person across items, the old fields emptied
    const linked = (first.contacts as { user_id: string | null }[]).filter((c) => c.user_id).map((c) => c.user_id);
    // dana, vera, olivia – and adam, who approved, endorsed and signed off (named in decisions only)
    expect(linked).toHaveLength(4);
    expect(new Set(linked).size).toBe(4);
    expect(look((d) => d.get("SELECT owners FROM dp_products WHERE id = 'dp_upg'"))).toEqual({ owners: '[]' });
    expect(look((d) => d.get("SELECT owner, stewards FROM dp_objects WHERE id = 'do_upg'"))).toEqual({ owner: null, stewards: '[]' });
  });

  it('documents the decisions of before: approved requests, endorsements and sign-offs; flags only the converted pending request', () => {
    const consumers = new Map(
      (first.consumers as { id: string; approval: string; decision: string | null; request_id: string | null }[]).map((c) => [c.id, c]),
    );
    // made by hand: no approval state
    expect(consumers.get('dpc_hand')).toMatchObject({ approval: 'none', decision: null, request_id: null });
    const approved = consumers.get('dpc_appr')!;
    expect(approved).toMatchObject({ approval: 'documented', request_id: 'dpx_appr' });
    expect(JSON.parse(approved.decision!)).toMatchObject({
      decidedBy: [{ name: 'Adam Approver', role: 'approver', contactId: expect.stringMatching(/^ct_/) }],
      decidedOn: '2026-10-15',
      note: 'Agreed in the steering board',
      recordedBy: 'adam',
    });
    const request = look((d) => d.get<{ status: string; consumer_id: string }>("SELECT status, consumer_id FROM dp_access_requests WHERE id = 'dpx_pend'"))!;
    expect(request.status).toBe('converted');
    expect(consumers.get(request.consumer_id)).toMatchObject({ approval: 'notDocumented', decision: null, request_id: 'dpx_pend' });
    const endorsement = look((d) => d.get<{ decision: string }>("SELECT decision FROM dp_endorsements WHERE product_id = 'dp_upg'"))!;
    expect(JSON.parse(endorsement.decision)).toMatchObject({ decidedBy: [{ name: 'Adam Approver', role: 'domainOwner' }], decidedOn: '2026-10-20' });
    const signoff = look((d) => d.get<{ decision: string; sha256: string }>("SELECT decision, sha256 FROM dp_semantic_signoffs WHERE id = 'dss_upg'"))!;
    expect(signoff.sha256).toBe('abc123');
    expect(JSON.parse(signoff.decision)).toMatchObject({ decidedBy: [{ name: 'Adam Approver', role: 'approver' }], decidedOn: '2026-11-02' });
  });

  it('moves the service’s stored contact into the directory, shown as before', async () => {
    const svc = await admin('GET', `/services/${manifest.ids.service}`);
    expect(svc.contacts).toEqual([{ role: 'business', email: 'erika@example.com', name: 'Erika' }]);
    expect(look((d) => d.get<{ contacts: string }>('SELECT contacts FROM services WHERE id = ?', manifest.ids.service))).toEqual({ contacts: '[]' });
    expect(first.links).toContainEqual(expect.objectContaining({ kind: 'service', item_id: manifest.ids.service, role: 'business' }));
  });

  it('does nothing twice: a restart and a second unlock change nothing', async () => {
    expect(first.audited.length).toBeGreaterThan(5);
    await stop();
    await start();
    await unlock();
    expect(made()).toEqual(first);
  });
});
