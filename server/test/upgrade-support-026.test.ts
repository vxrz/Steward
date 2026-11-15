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
 * The upgrade to support channels and support levels (0.26.0, ADR 0039 part 8) on the newest upgrade fixture
 * (server/test/fixtures/upgrade/v0.25.0) with data products added in the shape that version wrote them: one with a
 * `mailto:` support channel and tier 1, one with a web address and tier 3, one with only hours, one with neither. The
 * server upgrades it as a real installation does – the migration at start, the conversion when an administrator unlocks
 * the vault – and again after a restart (nothing is done twice). Every product shows the same support information
 * before and after: the deprecated `support` and `tier` read as they were stored, now derived from a channel and a level.
 * On SQLite and – with SM_TEST_DATABASE_URL – on PostgreSQL.
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upg-026s-'));
const sqlite: DatabaseTarget = { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') };
const schema = `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_upg_sup_026_${process.pid}`;
const pg: Extract<DatabaseTarget, { kind: 'postgres' }> | undefined = PG_TEST_URL ? { kind: 'postgres', url: PG_TEST_URL, schema } : undefined;
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

const OLD: { id: string; key: string; support: Record<string, string>; tier: number | null }[] = [
  { id: 'dp_sup_mail', key: 'sup-mail', support: { channel: 'Orders data desk', url: 'mailto:orders-data@shop.example', hours: 'Mo–Fr 08–17' }, tier: 1 },
  { id: 'dp_sup_web', key: 'sup-web', support: { channel: '#orders-data', url: 'https://wiki.example/orders-data', hours: '' }, tier: 3 },
  { id: 'dp_sup_hours', key: 'sup-hours', support: { channel: '', url: '', hours: '24×7' }, tier: null },
  { id: 'dp_sup_none', key: 'sup-none', support: { channel: '', url: '', hours: '' }, tier: null },
];

/** Everything the upgrade made, for comparing two starts. */
const made = () =>
  look((d) => ({
    levels: d.all('SELECT id, name_en, name_de, legacy_tier FROM support_levels ORDER BY id'),
    channels: d.all('SELECT id, kind, item_id, purpose, tool, name, address, hours, position FROM support_channels ORDER BY id'),
    products: d.all('SELECT id, support, tier, support_level_id FROM dp_products ORDER BY id'),
    audited: d.all<{ action: string; n: number }>(
      "SELECT action, COUNT(*) AS n FROM audit_log WHERE action IN ('dataproduct.support_converted', 'support.level_created') GROUP BY action ORDER BY action",
    ),
  }));

beforeAll(async () => {
  fs.cpSync(path.join(FIXTURE, 'datadir'), dataDir, { recursive: true });
  const old = new Db(sqlite, { migrate: false });
  try {
    for (const p of OLD)
      old.run(
        `INSERT INTO dp_products (id, key, name, name_norm, support, tier, lifecycle, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'admin', ?, 'admin')`,
        p.id,
        p.key,
        p.key,
        p.key,
        JSON.stringify(p.support),
        p.tier,
        AT,
        AT,
      );
  } finally {
    old.close();
  }
  if (pg) {
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

describe('upgrade of the v0.25.0 fixture to support channels and levels (ADR 0039)', () => {
  let first: ReturnType<typeof made>;
  let admin: ReturnType<typeof client>;

  it('converts once an administrator unlocks the vault – as the system, audited', async () => {
    admin = await unlock();
    await admin('PUT', '/settings/modules/dataProducts', { enabled: true });
    first = made();
    expect(first.audited).toEqual([
      { action: 'dataproduct.support_converted', n: 3 },
      { action: 'support.level_created', n: 2 },
    ]);
    const converted = (await admin('GET', '/audit?action=dataproduct.support_converted&limit=50')) as { entityId: string; actor: string }[];
    expect(converted.map((a) => a.entityId).sort()).toEqual(['dp_sup_hours', 'dp_sup_mail', 'dp_sup_web']);
    expect(converted.every((a) => a.actor === 'system')).toBe(true);
    // the old columns are emptied
    for (const p of first.products as { id: string; support: string; tier: number | null }[])
      if (p.id.startsWith('dp_sup_')) expect(p).toMatchObject({ support: '{}', tier: null });
  });

  it('makes levels only of the tiers in use – no examples where tiers were used', () => {
    // English "Tier n", German "Stufe n" (levels have names in both)
    expect(
      (first.levels as { name_en: string; name_de: string; legacy_tier: number }[]).map((l) => [l.name_en, l.name_de, Number(l.legacy_tier)]).sort(),
    ).toEqual([
      ['Tier 1', 'Stufe 1', 1],
      ['Tier 3', 'Stufe 3', 3],
    ]);
  });

  it('shows every product the same support information as before', async () => {
    for (const p of OLD) {
      const now = await admin('GET', `/data-products/${p.id}`);
      // what the API of 0.25 said: the deprecated fields, derived now
      expect(now.support, p.key).toEqual(p.support);
      expect(now.tier, p.key).toBe(p.tier);
      if (p.support.url || p.support.channel || p.support.hours)
        expect(now.supportChannels, p.key).toEqual([
          {
            id: expect.any(String),
            purpose: 'questions',
            tool: p.support.url.startsWith('mailto:') ? 'email' : 'other',
            name: p.support.channel,
            address: p.support.url,
            hours: p.support.hours,
            note: '',
          },
        ]);
      else expect(now.supportChannels, p.key).toEqual([]);
      expect(now.supportLevel?.nameEn ?? null, p.key).toBe(p.tier ? `Tier ${p.tier}` : null);
    }
  });

  it('does nothing twice: a restart and a second unlock change nothing', async () => {
    await stop();
    await start();
    await unlock();
    expect(made()).toEqual(first);
  });
});
