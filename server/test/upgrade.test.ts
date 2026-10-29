import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { PG_TEST_URL } from './pg-env.js';
import { coreMigrations, Db, listUpgradeBackups, namedMigrations, type DatabaseTarget } from '../src/db.js';

/**
 * Upgrade test: the current version starts on a data folder written by a released version
 * (server/test/fixtures/upgrade/<version>, made by scripts/fixtures/make-upgrade-fixture.mjs) –
 * on SQLite as it is, on PostgreSQL (SM_TEST_DATABASE_URL) after `db:copy`. A new fixture for
 * every minor release keeps every supported upgrade path tested (docs/TESTING.md).
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
  /** The operations of every API spec as the old version stored them, with the path each request went to then. */
  let oldOperations: { platformId: string; ops: { method: string; path: string }[] }[] = [];
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
    const old = new Db(sqlite, { migrate: false });
    try {
      // before 0.2.1 the stored paths were the full request paths; from 0.2.1 on they are relative to path_prefix
      oldOperations = old.all<{ platform_id: string; operations: string; path_prefix?: string | null }>('SELECT * FROM platform_specs').map((r) => ({
        platformId: r.platform_id,
        ops: (JSON.parse(r.operations) as { method: string; path: string }[]).map((o) => ({ method: o.method, path: (r.path_prefix ?? '') + o.path })),
      }));
    } finally {
      old.close();
    }
    if (pg) {
      // the way an installation moves to PostgreSQL: npm run db:copy (it migrates both databases first)
      const { copyDatabase } = await import('../src/cli/db-copy.js');
      copyDatabase({ from: sqlite, to: pg });
    }
    const env: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: '0', SM_DEMO: '1' };
    for (const k of ['SM_DATABASE_URL', 'SM_DATABASE_SCHEMA', 'SM_MASTER_PASSPHRASE', 'SM_MASTER_PASSPHRASE_FILE', 'SM_UPGRADE_BACKUPS']) delete env[k];
    if (pg) Object.assign(env, { SM_DATABASE_URL: PG_TEST_URL, SM_DATABASE_SCHEMA: schema });
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  it('makes a backup exactly when there was something to migrate (SQLite)', () => {
    const backups = listUpgradeBackups(path.join(dataDir, 'backups'));
    // with PostgreSQL the SQLite copy was migrated by db:copy, which keeps its copy in the same place
    expect(backups).toHaveLength(pending.length ? 1 : 0);
    if (pending.length) expect(path.basename(backups[0]!)).toMatch(/^pre-\d+\.\d+\.\d+.*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/);
    if (pending.length && !pg) expect(stdout).toContain('database backed up before migrating');
  });

  it('unlocks the vault with the fixture passphrase', async () => {
    await admin('POST', '/auth/login', m.admin);
    expect((await admin('GET', '/auth/status')).unlocked).toBe(false);
    await expect(admin('POST', '/vault/unlock', { passphrase: 'not-the-passphrase' })).rejects.toMatchObject({ status: 401 });
    await admin('POST', '/vault/unlock', { passphrase: m.passphrase });
    expect((await admin('GET', '/auth/status')).unlocked).toBe(true);
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

  it('writes one system.upgraded entry when the database was migrated', async () => {
    const entries = await admin('GET', '/audit?action=system.upgraded&limit=10');
    expect(entries).toHaveLength(pending.length ? 1 : 0);
    if (pending.length) expect(entries[0].details.migrations).toEqual(pending);
  });

  it('keeps runs forever when the old version never limited them (default 400 days only for new installations, 0.2.4)', async () => {
    expect((await admin('GET', '/settings')).retentionRunDays).toBe(0);
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

  it('keeps the audit log valid after working on the upgraded data', async () => {
    expect((await admin('GET', '/audit/verify')).ok).toBe(true);
  });
});
