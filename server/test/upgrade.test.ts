import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { PG_TEST_URL } from './pg-env.js';
import { coreMigrations, Db, listUpgradeBackups, namedMigrations, type DatabaseTarget } from '../src/db.js';
import { schemaDiff, schemaSnapshot, type SchemaSnapshot } from './schema-snapshot.js';
import { spawnTestServer } from './server-process.js';

/**
 * Upgrade test: the current version starts on a data folder written by a released version
 * (server/test/fixtures/upgrade/<version>, made by scripts/fixtures/make-upgrade-fixture.mjs).
 * A new fixture for every minor release keeps every supported upgrade path tested (docs/TESTING.md).
 * - SQLite: the fixture's database as it is.
 * - PostgreSQL (SM_TEST_DATABASE_URL): a schema brought to the fixture's version – exactly the core and named
 *   migrations its database lists (Db `upTo`) – gets the fixture's rows as they are (db:copy `asIs`); the server then
 *   runs the remaining migrations on PostgreSQL itself, with that old data, after its automatic pg_dump. This is
 *   sound because migrations are never changed once released: "replays the old version's migrations to the schema
 *   it wrote" checks that on SQLite for every fixture (the same lists build the PostgreSQL schema).
 * After the upgrade the schema must equal a new installation's on the same database (A6 of the 0.10 review).
 * The assertions use what the fixture's manifest.json lists, never exact column sets, so they
 * hold after future migrations.
 */
const SERVER = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'upgrade');
const versions = fs
  .readdirSync(FIXTURES)
  .filter((d) => fs.existsSync(path.join(FIXTURES, d, 'manifest.json')))
  .sort();

interface Manifest {
  version: string;
  passphrase: string;
  admin: { username: string; password: string };
  demoPassword: string;
  approver: string;
  counts: Record<string, number>;
  ids: Record<string, string>;
  checkpoint: { seq: number; hash: string };
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Migrations the current version still has to apply to a database (names, "core n"). */
function pendingMigrations(target: DatabaseTarget): string[] {
  const d = new Db(target, { migrate: false });
  try {
    const version = Number(d.get<{ version: number }>('SELECT version FROM schema_version')?.version ?? 0);
    const done = new Set(d.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const core = coreMigrations(d.dialect).map((_, i) => `core ${i + 1}`);
    return [...core.slice(version), ...namedMigrations(d.dialect).flatMap((m) => (done.has(m.name) ? [] : [m.name]))];
  } finally {
    d.close();
  }
}

/**
 * Intentional differences between an upgraded and a new schema, as the start of a schemaDiff() line, each with its
 * reason. Empty: every upgrade path ends at exactly the schema of a new installation.
 */
const SCHEMA_DIFFERENCES_ALLOWED: readonly string[] = [];

/** The schema of a new installation, once per database kind. */
const freshSchemas = new Map<string, SchemaSnapshot>();
function freshSchema(kind: 'sqlite' | 'postgres'): SchemaSnapshot {
  let snap = freshSchemas.get(kind);
  if (!snap) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fresh-'));
    const target: DatabaseTarget =
      kind === 'sqlite'
        ? { kind, file: path.join(dir, 'fresh.db') }
        : { kind, url: PG_TEST_URL!, schema: `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_upg_fresh_${process.pid}`, lock: false };
    const d = new Db(target, { quiet: true });
    try {
      snap = schemaSnapshot(d);
    } finally {
      d.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    freshSchemas.set(kind, snap);
  }
  return snap;
}

/** The schema state a database records: its core version and the named migrations applied. */
function schemaState(target: DatabaseTarget): { core: number; named: string[] } {
  const d = new Db(target, { migrate: false });
  try {
    return {
      core: Number(d.get<{ version: number }>('SELECT version FROM schema_version')?.version ?? 0),
      named: d
        .all<{ name: string }>('SELECT name FROM schema_migrations')
        .map((r) => r.name)
        .sort(),
    };
  } finally {
    d.close();
  }
}

it('has at least one fixture', () => {
  expect(versions).toContain('v0.1.0');
});

describe.each(versions)('upgrade from %s', (version) => {
  const fixture = path.join(FIXTURES, version);
  const m = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8')) as Manifest;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upgrade-'));
  const sqlite: DatabaseTarget = { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') };
  const schema = `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_upg_${version.replace(/\W/g, '')}_${process.pid}`;
  const pg: DatabaseTarget | undefined = PG_TEST_URL ? { kind: 'postgres', url: PG_TEST_URL, schema } : undefined;
  let pending: string[] = [];
  /** The fixture's schema against today's migrations replayed to the fixture's version (SQLite) */
  let replayDiff: string[] = [];
  /** The operations of every API spec as the old version stored them, with the path each request went to then. */
  let oldOperations: { platformId: string; ops: { method: string; path: string }[] }[] = [];
  /** The datasets as the old version stored them (0.4.0 keeps their rows in the partitions only) */
  let oldDatasets: { key: string; rows: number }[] = [];
  /** Monitor windows of the old version (monitor_maintenance) added to the fixture's data before the upgrade (0.11) */
  let oldMonitorWindows: { id: string; monitorId: string; reason: string }[] = [];
  /** The free-text vendors of the old version (0.17, ADR 0029: they become suppliers to confirm) */
  const oldVendors: { table: string; vendor: string }[] = [];
  /**
   * Supplier contracts of 0.17 (ADR 0031, the upgrade to 0.18): added to the fixture's data before the upgrade, with
   * the contracts each demo user could see then (every contract of a supplier they saw).
   */
  let oldContracts: { teamSupplier: string; userSupplier: string; teamContract: string; userContract: string; teamService: string } | null = null;
  /** The platforms as the old version stored them: credentials (ciphertext) and MCP gateway on the platform row */
  let oldPlatforms: { id: string; name: string; secrets: string | null; config: string }[] = [];
  let proc: ChildProcess | undefined;
  let stdout = '';
  let base = '';

  const client = () => {
    let cookie = '';
    let sessionKey = '';
    const raw = async (method: string, url: string, body?: unknown): Promise<Response> => {
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
      return res;
    };
    const call = async (method: string, url: string, body?: unknown): Promise<any> => {
      const res = await raw(method, url, body);
      const t = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${t}`), { status: res.status });
      return t && res.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t;
    };
    const download = async (url: string) => {
      const res = await raw('GET', url);
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    };
    return Object.assign(call, { download });
  };
  const admin = client();
  const waitRun = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 300; i++) {
      const r = await admin('GET', `/runs/${id}`);
      if (statuses.includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`run ${id} did not reach ${statuses.join('/')}`);
  };

  beforeAll(async () => {
    fs.cpSync(path.join(fixture, 'datadir'), dataDir, { recursive: true });
    pending = pendingMigrations(sqlite);
    const state = schemaState(sqlite);
    {
      const file = path.join(os.tmpdir(), `sm-replay-${version}-${process.pid}.db`);
      const replay = new Db({ kind: 'sqlite', file }, { upTo: state, quiet: true });
      const old = new Db(sqlite, { migrate: false });
      try {
        replayDiff = schemaDiff(schemaSnapshot(old), schemaSnapshot(replay));
      } finally {
        old.close();
        replay.close();
        fs.rmSync(file, { force: true });
      }
    }
    const old = new Db(sqlite, { migrate: false });
    try {
      // before 0.2.1 the stored paths were the full request paths; from 0.2.1 on they are relative to path_prefix
      oldOperations = old.all<{ platform_id: string; operations: string; path_prefix?: string | null }>('SELECT * FROM platform_specs').map((r) => ({
        platformId: r.platform_id,
        ops: (JSON.parse(r.operations) as { method: string; path: string }[]).map((o) => ({ method: o.method, path: (r.path_prefix ?? '') + o.path })),
      }));
      oldPlatforms = old.all<{ id: string; name: string; secrets: string | null; config: string }>('SELECT id, name, secrets, config FROM platforms');
      for (const table of ['applications', 'systems', 'ticket_refs', 'cd_watches', 'cost_plan_lines']) {
        try {
          for (const r of old.all<{ vendor: string }>(`SELECT vendor FROM ${table} WHERE vendor <> ''`)) oldVendors.push({ table, vendor: r.vendor });
        } catch {
          // the table (or its vendor column) came later than this fixture's version
        }
      }
      // 0.17 supplier contracts (ADR 0031): one of a supplier owned by a team, one of a supplier owned by a user; a plan
      // line and a matrix row of a team's service name the first one
      const team = old.all<{ name: string; id: string }>('SELECT id, name FROM teams').find((t) => t.name === 'Service Desk');
      let hasContracts = false;
      try {
        old.get('SELECT id FROM supplier_contracts LIMIT 1');
        // only a fixture from before 0.18: from then on the contracts already have their owners and services
        const scoped = old.all<{ name: string }>('SELECT name FROM schema_migrations').some((r) => r.name === 'suppliers-003-contract-scope');
        hasContracts = !!team && !scoped;
      } catch {
        // suppliers came with 0.17
      }
      if (hasContracts) {
        const at = '2026-11-01T08:00:00.000Z';
        oldContracts = {
          teamSupplier: 'sup_upg_team',
          userSupplier: 'sup_upg_user',
          teamContract: 'sct_upg_team',
          userContract: 'sct_upg_user',
          teamService: 'svc_upg_team',
        };
        const o = oldContracts;
        for (const [id, name, owners] of [
          [o.teamSupplier, 'Upgrade Platform Invented AG', '["team:service desk"]'],
          [o.userSupplier, 'Upgrade Licensing Invented GmbH', '["user:dana"]'],
        ] as const)
          old.run(
            `INSERT INTO suppliers (id, name, norm_name, owners, status, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 'active', ?, 'admin', ?, 'admin')`,
            id,
            name,
            name.toLowerCase().replace(/[^a-z0-9]/g, ''),
            owners,
            at,
            at,
          );
        old.run(
          'INSERT INTO supplier_contracts (id, supplier_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          o.teamContract,
          o.teamSupplier,
          'Platform hosting',
          at,
          at,
        );
        old.run(
          'INSERT INTO supplier_contracts (id, supplier_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          o.userContract,
          o.userSupplier,
          'Licences',
          at,
          at,
        );
        for (const [id, name] of [[o.teamService, 'Upgrade team service']] as const)
          old.run(
            "INSERT INTO services (id, name, owners, created_at, created_by, updated_at, updated_by) VALUES (?, ?, '[]', ?, 'admin', ?, 'admin')",
            id,
            name,
            at,
            at,
          );
        old.run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", o.teamService, team!.id, at);
        old.run(
          `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, amount, currency, cadence, supplier_id, supplier_contract_id, created_at, created_by, updated_at, updated_by)
           VALUES ('cpl_upg_1', ?, 2026, 'Hosting', 'support', 1000000000, 'EUR', 'yearly', ?, ?, ?, 'admin', ?, 'admin')`,
          o.teamService,
          o.teamSupplier,
          o.teamContract,
          at,
          at,
        );
        old.run(
          `INSERT INTO service_responsibilities (service_id, area, party, supplier_id, contract_id, updated_at, updated_by) VALUES (?, 'backup', 'supplier', ?, ?, ?, 'admin')`,
          o.teamService,
          o.teamSupplier,
          o.teamContract,
          at,
        );
      }
      oldDatasets = old.all<{ key: string; row_count: number }>('SELECT key, row_count FROM datasets').map((r) => ({ key: r.key, rows: Number(r.row_count) }));
      // evidence packs expire a week after they were made (SM_EVIDENCE_RETENTION_DAYS): the fixture's pack would turn
      // "expired" as the fixture ages. This test checks that it still verifies after the upgrade, not the expiry.
      old.run("UPDATE evidence_packs SET expires_at = '2999-01-01T00:00:00.000Z' WHERE status = 'ready'");
      // a monitor's own maintenance windows, as every version before 0.11 kept them: one going on, one in the past
      const mon = old.get<{ id: string }>('SELECT id FROM monitors WHERE is_template = 0 ORDER BY id LIMIT 1');
      if (mon) {
        const now = Date.now();
        oldMonitorWindows = [
          { id: 'mw_upgrade_now', monitorId: mon.id, reason: 'Switch replacement' },
          { id: 'mw_upgrade_past', monitorId: mon.id, reason: 'Firmware update' },
        ];
        for (const [w, start, end] of [
          [oldMonitorWindows[0]!, now - 3600000, now + 3600000],
          [oldMonitorWindows[1]!, now - 3 * 86400000, now - 3 * 86400000 + 3600000],
        ] as const)
          old.run(
            'INSERT INTO monitor_maintenance (id, monitor_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            w.id,
            w.monitorId,
            new Date(start).toISOString(),
            new Date(end).toISOString(),
            w.reason,
            m.admin.username,
            new Date(start - 60000).toISOString(),
          );
      }
    } finally {
      old.close();
    }
    if (pg) {
      // PostgreSQL at the old version, with the old version's rows: the server migrates them on PostgreSQL
      new Db(pg, { upTo: state, quiet: true, appVersion: m.version }).close();
      const { copyDatabase } = await import('../src/cli/db-copy.js');
      copyDatabase({ from: sqlite, to: pg, asIs: true, force: true });
      expect(schemaState(pg)).toEqual(state);
    }
    const env: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: '0', SM_DEMO: '1' };
    for (const k of [
      'SM_DATABASE_URL',
      'SM_DATABASE_SCHEMA',
      'SM_MASTER_PASSPHRASE',
      'SM_MASTER_PASSPHRASE_FILE',
      'SM_UPGRADE_BACKUPS',
      'SM_UPGRADE_BACKUP_DIR',
      'SM_UPGRADE_BACKUP_REQUIRED',
      'SM_UPGRADE_BACKUP_TIMEOUT_SECONDS',
    ])
      delete env[k];
    if (pg) Object.assign(env, { SM_DATABASE_URL: PG_TEST_URL, SM_DATABASE_SCHEMA: schema });
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawnTestServer({ cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => reject(new Error('server start timeout: ' + stdout)), 45000);
      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString();
        const url = startedUrl(stdout);
        if (url && !base) {
          base = url;
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.stderr!.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${stdout}`)));
    });
  }, 120_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const p = proc;
      await new Promise((r) => {
        p.once('exit', r);
        p.kill('SIGTERM');
        setTimeout(() => p.kill('SIGKILL'), 10000).unref();
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('brings the database to the current schema', () => {
    // read-only look while the server runs (it holds the schema lock on PostgreSQL)
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      expect(Number(d.get<{ version: number }>('SELECT version FROM schema_version')!.version)).toBe(coreMigrations(d.dialect).length);
      const done = d.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name);
      expect(done).toEqual(expect.arrayContaining(namedMigrations(d.dialect).map((x) => x.name)));
    } finally {
      d.close();
    }
  });

  it("replays the old version's migrations to the schema it wrote (what the PostgreSQL path relies on)", () => {
    expect(replayDiff).toEqual([]);
  });

  it('has the same schema as a new installation after the upgrade', () => {
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      expect(schemaDiff(schemaSnapshot(d), freshSchema(d.dialect), SCHEMA_DIFFERENCES_ALLOWED)).toEqual([]);
    } finally {
      d.close();
    }
  });

  it('makes a backup exactly when there was something to migrate (a SQLite copy or a pg_dump)', () => {
    const backups = listUpgradeBackups(path.join(dataDir, 'backups'));
    expect(backups).toHaveLength(pending.length ? 1 : 0);
    if (!pending.length) return;
    expect(path.basename(backups[0]!)).toMatch(new RegExp(`^pre-\\d+\\.\\d+\\.\\d+.*-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.${pg ? 'pgdump' : 'db'}$`));
    expect(stdout).toContain('database backed up before migrating');
    // the dump is of the schema before the migrations (pg_dump's custom format starts with PGDMP)
    if (pg) expect(fs.readFileSync(backups[0]!).subarray(0, 5).toString()).toBe('PGDMP');
    expect(fs.statSync(backups[0]!).mode & 0o077).toBe(0);
  });

  it('unlocks the vault with the fixture passphrase', async () => {
    await admin('POST', '/auth/login', m.admin);
    expect((await admin('GET', '/auth/status')).unlocked).toBe(false);
    await expect(admin('POST', '/vault/unlock', { passphrase: 'not-the-passphrase' })).rejects.toMatchObject({ status: 401 });
    await admin('POST', '/vault/unlock', { passphrase: m.passphrase });
    expect((await admin('GET', '/auth/status')).unlocked).toBe(true);
  });

  it("moves every platform's credentials and MCP mode to its sealed default identity, once (0.9.0, ADR 0009)", async () => {
    const { mcpFromGateway, parseMcp } = await import('../src/platforms/identities.js');
    expect(oldPlatforms.length).toBeGreaterThan(0);
    if (!pending.includes('platforms-005-identities')) {
      // written by 0.9.0 or later: the identities are already there and stay as they were
      const now = await admin('GET', '/platforms');
      expect(now.map((p: any) => p.id).sort()).toEqual(oldPlatforms.map((p) => p.id).sort());
      for (const x of now) {
        expect(x.integrity, x.name).toBe('ok');
        expect(
          x.identities.filter((i: any) => i.default),
          x.name,
        ).toHaveLength(1);
      }
      expect(await admin('GET', '/audit?action=platform.identities_created&limit=10')).toEqual([]);
      return;
    }
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      expect(d.all('SELECT id FROM platforms WHERE secrets IS NOT NULL')).toEqual([]);
      for (const p of oldPlatforms) {
        const rows = d.all<{ id: string; secrets: string | null; mcp: string; config_mac: string | null; is_default: number }>(
          'SELECT id, secrets, mcp, config_mac, is_default FROM platform_identities WHERE platform_id = ?',
          p.id,
        );
        expect(rows, p.name).toHaveLength(1);
        expect(rows[0]!.id).toBe(p.id.startsWith('pf_') ? `pi_${p.id.slice(3)}` : `pi_${p.id}`);
        expect(Number(rows[0]!.is_default)).toBe(1);
        // the ciphertext is copied unchanged (the vault encrypts without context)
        expect(rows[0]!.secrets, p.name).toBe(p.secrets);
        expect(rows[0]!.config_mac, p.name).toBeTruthy();
        expect(parseMcp(rows[0]!.mcp), p.name).toEqual(mcpFromGateway(JSON.parse(p.config).mcpGateway));
      }
    } finally {
      d.close();
    }
    const now = new Map((await admin('GET', '/platforms')).map((p: any) => [p.id, p]));
    for (const p of oldPlatforms) {
      const x = now.get(p.id) as any;
      expect(x.integrity, p.name).toBe('ok');
      expect(x.identities.map((i: any) => i.default)).toEqual([true]);
      expect(!!x.config.mcpGateway?.enabled, p.name).toBe(JSON.parse(p.config).mcpGateway?.enabled === true);
    }
    const entries = await admin('GET', '/audit?action=platform.identities_created&limit=10');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'system', details: { count: oldPlatforms.length } });
  });

  it("copies the monitors' own maintenance windows into catalogue windows that list the monitor, once (0.11, ADR 0018)", async () => {
    expect(oldMonitorWindows.length, 'the fixture has a monitor').toBeGreaterThan(0);
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    let copies: string[];
    try {
      const rows = d.all<{ id: string; migrated_to: string | null; migrated_at: string | null }>(
        "SELECT id, migrated_to, migrated_at FROM monitor_maintenance WHERE id IN ('mw_upgrade_now', 'mw_upgrade_past') ORDER BY id",
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.migrated_at, r.id).toBeTruthy();
        expect(r.migrated_to, r.id).toMatch(/^mtw_/);
      }
      copies = rows.map((r) => r.migrated_to!);
      for (const id of copies)
        expect(d.all('SELECT kind, target_id FROM maintenance_targets WHERE window_id = ?', id)).toEqual([
          { kind: 'monitor', target_id: oldMonitorWindows[0]!.monitorId },
        ]);
    } finally {
      d.close();
    }
    const now = copies[0]!;
    const w = await admin('GET', `/maintenance-windows/${now}`);
    expect(w).toMatchObject({ title: 'Switch replacement', current: { active: true }, quietMonitors: true });
    const mon = await admin('GET', `/monitors/${oldMonitorWindows[0]!.monitorId}`);
    expect(mon.maintenance).toMatchObject({ id: now, reason: 'Switch replacement' });
    const audit = await admin('GET', '/audit?action=maintenance.migrated&limit=10');
    expect(audit.map((a: any) => a.entityId).sort()).toEqual([...copies].sort());
  });

  it('turns the free-text vendors into suppliers to confirm, once (0.17, ADR 0029)', async () => {
    const { normVendor } = await import('../src/plant/advisories/match.js');
    const texts = oldVendors.filter((v) => normVendor(v.vendor));
    const suppliers = (await admin('GET', '/suppliers?status=unconfirmed')) as { id: string; name: string; aliases: string[] }[];
    const norms = new Map(texts.map((v) => [normVendor(v.vendor), v.vendor]));
    expect(suppliers.length).toBe(norms.size);
    for (const [norm, text] of norms) {
      const sup = suppliers.find((x) => normVendor(x.name) === norm);
      expect(sup, text).toBeTruthy();
      expect([sup!.name, ...sup!.aliases]).toContain(text.trim().replace(/\s+/g, ' '));
    }
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      for (const v of texts)
        expect(
          Number(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${v.table} WHERE vendor = ? AND supplier_id IS NULL`, v.vendor)!.n),
          `${v.table}: ${v.vendor}`,
        ).toBe(0);
      expect(Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_text_migrations')!.n)).toBe(
        new Set(oldVendors.map((v) => `${v.table}\u0000${normVendor(v.vendor)}`)).size,
      );
    } finally {
      d.close();
    }
    const audit = await admin('GET', '/audit?action=supplier.migrated&limit=100');
    expect(audit.length).toBe(new Set(texts.map((v) => `${v.table}\u0000${normVendor(v.vendor)}`)).size);
    expect(audit.every((a: any) => a.actor === 'system')).toBe(true);
  });

  it('gives contracts the owners of their supplier and proposes the services that named them, never widening (0.18, ADR 0031)', async () => {
    if (!oldContracts) return;
    const o = oldContracts;
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      const owners = (id: string) => JSON.parse(d.get<{ owners: string }>('SELECT owners FROM supplier_contracts WHERE id = ?', id)!.owners);
      expect(owners(o.teamContract)).toEqual(['team:service desk']);
      expect(owners(o.userContract)).toEqual(['user:dana']);
      const cover = d
        .all<{ service_id: string; status: string; proposed_from: string }>(
          'SELECT service_id, status, proposed_from FROM supplier_contract_services WHERE contract_id = ? ORDER BY service_id',
          o.teamContract,
        )
        .map((r) => ({ service: r.service_id, status: r.status, from: JSON.parse(r.proposed_from) }));
      expect(cover).toEqual([{ service: o.teamService, status: 'proposed', from: ['costPlanLine', 'responsibility'] }]);
      // contacts stay company-wide, personal data and DPA of contracts stay "as the supplier"
      expect(Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_contact_scopes')!.n)).toBe(0);
      expect(
        d.get<{ p: number | null; s: string | null }>('SELECT personal_data AS p, dpa_status AS s FROM supplier_contracts WHERE id = ?', o.teamContract),
      ).toEqual({ p: null, s: null });
    } finally {
      d.close();
    }
    // for every user the contracts visible after are a subset of those visible before (all of a supplier they saw)
    for (const name of ['dana', 'olivia', 'adam', 'audrey', 'vera']) {
      const u = client();
      await u('POST', '/auth/login', { username: name, password: m.demoPassword });
      for (const [sid, before] of [
        [o.teamSupplier, ['Platform hosting']],
        [o.userSupplier, ['Licences']],
      ] as const) {
        const titles = ((await u('GET', `/suppliers/${sid}`)).contracts as { title: string }[]).map((c) => c.title);
        expect(
          titles.every((t) => (before as readonly string[]).includes(t)),
          `${name} ${sid}`,
        ).toBe(true);
      }
    }
    // the team's contract is now seen by its members (and the readers of the service, proposed services count for
    // reading), administrators and auditors – no longer by a viewer outside the team; the user's stays open
    const seen = async (name: string) => {
      const u = client();
      await u('POST', '/auth/login', { username: name, password: m.demoPassword });
      return ((await u('GET', `/suppliers/${o.teamSupplier}`)).contracts as unknown[]).length;
    };
    expect(await seen('olivia')).toBe(1);
    expect(await seen('audrey')).toBe(1);
    expect(await seen('vera')).toBe(0);
    // audited once, and the administrators' notice is open
    await admin('GET', '/suppliers');
    const scoped = await admin('GET', '/audit?action=supplier.contracts_scoped&limit=10');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].actor).toBe('system');
    expect(scoped[0].details.contractsWithOwners).toBeGreaterThanOrEqual(2);
    expect(scoped[0].details.teamOwned).toBeGreaterThanOrEqual(1);
    expect(scoped[0].details.servicesProposed).toBeGreaterThanOrEqual(1);
    expect((await admin('GET', '/suppliers/scope-notice')).notice.narrowed).toBeGreaterThanOrEqual(1);
    // the service of this check goes back to the whole instance (#131 below checks that nothing is owned by a team)
    await admin('PUT', `/owning-teams/service/${o.teamService}`, { teamIds: [] });
  });

  it('returns the data of the old version', async () => {
    const runs = await admin('GET', '/runs?limit=1000');
    expect(runs.length).toBeGreaterThanOrEqual(m.counts.runs!);
    const byId = new Map(runs.map((r: any) => [r.id, r]));
    expect(byId.get(m.ids.approvedRun)).toMatchObject({ status: 'succeeded' });
    expect(byId.get(m.ids.failedRun)).toMatchObject({ status: 'failed' });
    expect(byId.get(m.ids.reviewRun)).toMatchObject({ status: 'succeeded' });
    const review = await admin('GET', `/runs/${m.ids.reviewRun}`);
    expect(review.steps.length).toBeGreaterThan(0);
    expect(review.tasks[0]).toMatchObject({ status: 'completed', decidedBy: m.approver });

    expect((await admin('GET', '/processes')).length).toBeGreaterThanOrEqual(m.counts.processes!);
    expect((await admin('GET', '/platforms')).map((p: any) => p.id)).toContain(m.ids.hub);
    expect((await admin('GET', '/schedules')).map((x: any) => x.id)).toContain(m.ids.schedule);
    expect((await admin('GET', '/dashboards')).map((x: any) => x.id)).toContain(m.ids.dashboard);

    const records = await admin('GET', '/records');
    const list = Array.isArray(records) ? records : records.items;
    expect(list.length).toBeGreaterThanOrEqual(m.counts.records!);
    const cr = await admin('GET', `/records/${m.ids.record}`);
    expect(cr).toMatchObject({ number: m.ids.recordNumber, status: 'approved' });
    expect(cr.attachments.map((a: any) => a.id)).toContain(m.ids.attachment);
    expect((await admin('GET', `/records/${m.ids.draftRecord}`)).status).toBe('draft');
    expect((await admin('GET', `/compliance/access-changes/${m.ids.acRecord}`)).number).toBe(m.ids.acNumber);

    const monitors = await admin('GET', '/monitors');
    expect(monitors.length).toBeGreaterThanOrEqual(m.counts.monitors!);
    const history = await admin('GET', `/monitors/${m.ids.monitor}/history`);
    expect(JSON.stringify(history).length).toBeGreaterThan(50);

    expect((await admin('GET', `/services/${m.ids.service}`)).name).toBeTruthy();
    expect((await admin('GET', `/credentials/${m.ids.credential}`)).name).toBeTruthy();
    expect((await admin('GET', `/ticket-references/${m.ids.ticket}`)).title).toBeTruthy();
  });

  it('still verifies the audit log: hash chain and signed checkpoints', async () => {
    const latest = (await admin('GET', '/audit?limit=1'))[0];
    expect(latest.seq).toBeGreaterThanOrEqual(m.counts.auditEntries!);
    // the signed checkpoint entries of the old version, checked against the instance key from the vault
    const checkpoints = await admin('GET', '/audit?action=audit.checkpoint&limit=100');
    const old = checkpoints.find((c: any) => c.details.seq === m.checkpoint.seq);
    expect(old.details.hash).toBe(m.checkpoint.hash);
    const r = await admin('POST', '/audit/verify', { anchor: JSON.stringify(old.details) });
    expect(r).toMatchObject({ ok: true });
    expect(r.checked).toBeGreaterThanOrEqual(m.counts.auditEntries!);
    // the local anchor file (signed) and the checkpoint given here both match
    expect(r.anchors.map((a: any) => a.source)).toEqual(expect.arrayContaining(['local anchor file', 'checkpoint you entered']));
    expect(r.anchors.every((a: any) => a.ok)).toBe(true);
    expect(r.checkpoint.signature).toBeTruthy();
  });

  it('keeps every dataset readable with all its rows, and frees their combined copy (0.4.0)', async () => {
    for (const ds of oldDatasets) {
      const d = await admin('GET', `/datasets/${encodeURIComponent(ds.key)}`);
      expect(d.rows, ds.key).toHaveLength(ds.rows);
    }
    const d = new Db(pg ? { ...pg, lock: false } : sqlite, { migrate: false });
    try {
      // (read above: every dataset has a partition now)
      expect(d.all<{ key: string }>("SELECT key FROM datasets WHERE rows <> '[]'")).toEqual([]);
    } finally {
      d.close();
    }
  });

  it('writes one system.upgraded entry when the database was migrated', async () => {
    const entries = await admin('GET', '/audit?action=system.upgraded&limit=10');
    expect(entries).toHaveLength(pending.length ? 1 : 0);
    if (pending.length) expect(entries[0].details.migrations).toEqual(pending);
  });

  it('keeps runs forever when the old version never limited them (default 400 days only for new installations, 0.2.4)', async () => {
    // installations from 0.2.4 on started with 400 days and keep them; older ones never limited runs
    const [major, minor, patch] = version.slice(1).split('.').map(Number) as [number, number, number];
    const since024 = major > 0 || minor > 2 || (minor === 2 && patch >= 4);
    expect((await admin('GET', '/settings')).retentionRunDays).toBe(since024 ? 400 : 0);
  });

  it('keeps the request paths of API specs imported before path prefixes existed (0.2.1)', async () => {
    expect(oldOperations.length).toBeGreaterThan(0);
    for (const { platformId, ops } of oldOperations) {
      const specs = await admin('GET', `/platforms/${platformId}/specs`);
      for (const spec of specs) expect(typeof spec.pathPrefix).toBe('string');
      // every request still goes to the same path: no prefix lost and none added twice
      const now = new Set((await admin('GET', `/platforms/${platformId}/operations`)).map((o: any) => `${o.method} ${o.path}`));
      for (const o of ops) expect(now, `${platformId}: ${o.method} ${o.path}`).toContain(`${o.method} ${o.path}`);
    }
  });

  it("adds Steward's example library as a disabled Git sync source, once (0.2.1)", async () => {
    const sources = await admin('GET', '/sync-sources');
    const examples = sources.filter((x: any) => x.builtIn);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ id: 'gsr_steward-examples', enabled: false, hasToken: false, refType: 'tag', branch: 'v{version}', lastFetchAt: null });
    const created = await admin('GET', '/audit?action=sync.source_created&entityId=gsr_steward-examples&limit=10');
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe('system');
  });

  it('resumes the run that waited for an approval', async () => {
    const before = await admin('GET', `/runs/${m.ids.waitingRun}`);
    expect(before.status).toBe('waiting');
    const approver = client();
    await approver('POST', '/auth/login', { username: m.approver, password: m.demoPassword });
    await approver('POST', `/tasks/${m.ids.waitingTask}/complete`, { approved: true, comment: 'Approved after the upgrade' });
    const done = await waitRun(m.ids.waitingRun, ['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.tasks[0]).toMatchObject({ status: 'completed', decidedBy: m.approver });
  });

  it('opens record attachments and the PDF report', async () => {
    const att = await admin.download(`/records/${m.ids.record}/attachments/${m.ids.attachment}/download`);
    expect(att.status).toBe(200);
    expect(sha(att.body)).toBe(m.ids.attachmentSha256);
    const pdf = await admin.download(`/reports/${m.ids.report}/download`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin('POST', '/reports/verify', { contentBase64: pdf.body.toString('base64') })).match).toBe('exact');
  });

  it('still verifies the evidence pack offline', async () => {
    expect((await admin('GET', `/compliance/evidence-packs/${m.ids.evidencePack}`)).status).toBe('ready');
    const dl = await admin.download(`/compliance/evidence-packs/${m.ids.evidencePack}/download`);
    expect(dl.status).toBe(200);
    const file = path.join(dataDir, 'pack-check.zip');
    fs.writeFileSync(file, dl.body);
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const r = await verifyPack(file);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, signatureOk: true });
  });

  it("keeps every resource the whole instance's: a demo user sees what they saw before (#131)", async () => {
    const user = client();
    await user('POST', '/auth/login', { username: m.approver, password: m.demoPassword });
    const ids = (x: any) => (Array.isArray(x) ? x : (x.items ?? [])).map((y: any) => y.id).sort();
    // visible to everyone signed in before team scopes: the same for the approver as for the administrator
    for (const url of ['/services', '/applications', '/systems', '/dashboards', '/ticket-references'])
      expect(ids(await user('GET', url)), url).toEqual(ids(await admin('GET', url)));
    const records = (x: any[]) =>
      x
        .filter((r) => r.type !== 'AC' && r.typeKey !== 'AC')
        .map((r) => r.id)
        .sort();
    expect(records(await user('GET', '/records'))).toEqual(records(await admin('GET', '/records')));
    // and nothing is owned by a team after the upgrade
    for (const id of ids(await admin('GET', '/services'))) expect((await admin('GET', `/owning-teams/service/${id}`)).teams).toEqual([]);
    expect((await admin('GET', '/teams')).every((t: any) => !Object.keys(t.memberRoles ?? {}).length)).toBe(true);
  });

  it('keeps the audit log valid after working on the upgraded data', async () => {
    expect((await admin('GET', '/audit/verify')).ok).toBe(true);
  });
});
