import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_KIND } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Database schemas through the API (#222): the read of the demo database platform, tbls imports for a platform and a
 * system (preview, SHA-256 in the audit log, lint findings as checks, limits), snapshots with their changes,
 * retention, exports, rights (a platform or system the caller may not see reads like a missing one), the public API
 * (read endpoints only) and the monitor check. The push tokens of CI: dbschema-push.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, 'fixtures', 'tbls', 'schema.json'), 'utf8');
const LINT = fs.readFileSync(path.join(here, 'fixtures', 'tbls', 'lint.txt'), 'utf8');
const PW = 'Demo-password-1';

/** The fixture with the column loaves.kind removed and customers.email narrowed: two breaking changes. */
function changed(): string {
  const s = JSON.parse(SCHEMA);
  const loaves = s.tables.find((t: { name: string }) => t.name === 'public.loaves');
  loaves.columns = loaves.columns.filter((c: { name: string }) => c.name !== 'kind');
  s.tables[0].columns[1].type = 'varchar(60)';
  s.tables[0].columns.push({ name: 'phone', type: 'text', nullable: true });
  return JSON.stringify(s, null, 2);
}

let s: TestServer;
let db: { id: string; name: string };
let olivia: Client;
let vera: Client;
let systemId: string;
const tokens: Record<string, string> = {};

async function v1(token: string, url: string, init: { method?: string; body?: string; type?: string } = {}) {
  const res = await fetch(`${s.base}/api/v1${url}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': init.type ?? 'application/json' } : {}) },
    body: init.body,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: res.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  db = (await s.api('GET', '/platforms')).find((p: { kind: string }) => p.kind === DATABASE_KIND);
  systemId = (await s.api('POST', '/systems', { name: 'Bakery database', kind: 'server' })).id;
  tokens.read = (await s.api('POST', '/me/tokens', { name: 'schema read', scope: 'read' })).token;
  tokens.full = (await s.api('POST', '/me/tokens', { name: 'schema ci', scope: 'full' })).token;
  tokens.vera = (await vera('POST', '/me/tokens', { name: 'vera', scope: 'full' })).token;
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('reading a database platform', () => {
  it('starts without snapshots, with the default settings', async () => {
    const o = await s.api('GET', `/db-schemas/platform/${db.id}`);
    expect(o).toMatchObject({
      subject: { kind: 'platform', id: db.id, name: db.name },
      settings: { retention: 30, readIntervalHours: 0 },
      canRead: true,
      canImport: true,
      snapshots: [],
    });
  });

  it('reads the schema into a snapshot, audited; an unchanged schema adds none', async () => {
    const r = await s.api('POST', `/db-schemas/platform/${db.id}/read`);
    expect(r).toMatchObject({
      created: true,
      diff: null,
      snapshot: { source: 'read', tables: 6, columns: 28, dialect: 'postgresql', product: 'PostgreSQL', database: 'shop' },
    });
    const full = await s.api('GET', `/db-schemas/platform/${db.id}/snapshots/${r.snapshot.id}`);
    const lines = full.schema.tables.find((t: { name: string }) => t.name === 'order_lines');
    expect(lines.primaryKey.columns).toEqual(['order_id', 'line']);
    expect(lines.foreignKeys).toHaveLength(2);
    const again = await olivia('POST', `/db-schemas/platform/${db.id}/read`);
    expect(again).toMatchObject({ created: false, snapshot: { id: r.snapshot.id } });
    expect(again.snapshot.checkedAt > r.snapshot.checkedAt).toBe(true);
    const audit = await s.api('GET', `/audit?action=dbschema.read&entityId=${db.id}`);
    expect(audit).toHaveLength(2);
    expect(audit.map((a: { actor: string }) => a.actor).sort()).toEqual(['admin', 'olivia']);
    const o = await s.api('GET', `/db-schemas/platform/${db.id}`);
    expect(o.snapshots).toHaveLength(1);
    expect(o.lastRead).toMatchObject({ error: null });
  });

  it('hides the platform from those who may not see it, and refuses reads without "use"', async () => {
    await expect(vera('GET', `/db-schemas/platform/${db.id}`)).rejects.toMatchObject({ status: 404, body: { code: 'PLATFORM_NOT_FOUND' } });
    await expect(vera('POST', `/db-schemas/platform/${db.id}/read`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('GET', `/db-schemas/platform/${db.id}/snapshots/latest`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('GET', `/db-schemas/platform/does-not-exist`)).rejects.toMatchObject({ status: 404, body: { code: 'PLATFORM_NOT_FOUND' } });
    // another kind of platform is not a database
    const other = (await s.api('GET', '/platforms')).find((p: { kind: string }) => p.kind !== DATABASE_KIND);
    await expect(s.api('GET', `/db-schemas/platform/${other.id}`)).rejects.toMatchObject({ status: 400, body: { code: 'DB_NOT_A_DATABASE' } });
    await expect(s.api('GET', `/db-schemas/table/${db.id}`)).rejects.toMatchObject({ status: 400 });
  });
});

describe('tbls import', () => {
  it('previews the changes against the latest snapshot without storing anything', async () => {
    const p = await s.api('POST', `/db-schemas/platform/${db.id}/import/preview`, { schema: SCHEMA, lint: LINT });
    expect(p).toMatchObject({ tables: 3, columns: 9, checks: 3, unchanged: false, sha256: crypto.createHash('sha256').update(SCHEMA).digest('hex') });
    // the demo tables are gone in the file: breaking
    expect(p.diff.breaking).toBeGreaterThan(0);
    expect((await s.api('GET', `/db-schemas/platform/${db.id}`)).snapshots).toHaveLength(1);
  });

  it('needs the manage right of the platform', async () => {
    await expect(olivia('POST', `/db-schemas/platform/${db.id}/import`, { schema: SCHEMA })).rejects.toMatchObject({
      status: 403,
      body: { code: 'FORBIDDEN' },
    });
    await expect(olivia('PUT', `/db-schemas/platform/${db.id}/settings`, { retention: 5, readIntervalHours: 0 })).rejects.toMatchObject({ status: 403 });
  });

  it('imports for a platform, with lint findings as checks, audited with the SHA-256', async () => {
    const r = await s.api('POST', `/db-schemas/platform/${db.id}/import`, { schema: SCHEMA, lint: LINT, fileName: 'schema.json' });
    expect(r).toMatchObject({ created: true, snapshot: { source: 'tbls', tables: 3, checks: 3, fileName: 'schema.json' } });
    const sha = crypto.createHash('sha256').update(SCHEMA).digest('hex');
    expect(r.snapshot.sha256).toBe(sha);
    const snap = await s.api('GET', `/db-schemas/platform/${db.id}/snapshots/latest`);
    expect(snap.lint.map((c: { rule: string }) => c.rule)).toEqual(['requireTableComment', 'requireColumnComment', 'columnCount']);
    expect(snap.diff.breaking).toBeGreaterThan(0);
    const [entry] = await s.api('GET', `/audit?action=dbschema.imported&entityId=${db.id}`);
    expect(entry.details).toMatchObject({ sha256: sha, fileName: 'schema.json', via: 'ui', tables: 3, checks: 3, created: true });
  });

  it('refuses files that are not tbls schemas', async () => {
    await expect(s.api('POST', `/db-schemas/platform/${db.id}/import`, { schema: '{"name": "x"}' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'DB_SCHEMA_TBLS_INVALID' },
    });
    await expect(s.api('POST', `/db-schemas/platform/${db.id}/import`, { schema: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(s.api('POST', `/db-schemas/platform/${db.id}/import`, { schema: SCHEMA, extra: 1 })).rejects.toMatchObject({ status: 400 });
  });

  it('imports for a system without a platform; who may not change the system may not import', async () => {
    const r = await s.api('POST', `/db-schemas/system/${systemId}/import`, { schema: SCHEMA });
    expect(r).toMatchObject({ created: true, snapshot: { source: 'tbls', tables: 3 } });
    const o = await vera('GET', `/db-schemas/system/${systemId}`);
    expect(o).toMatchObject({ canRead: false, canImport: false, importBlocked: null, snapshots: [{ id: r.snapshot.id }] });
    await expect(vera('POST', `/db-schemas/system/${systemId}/import`, { schema: SCHEMA })).rejects.toMatchObject({ status: 403 });
    await expect(s.api('POST', `/db-schemas/system/${systemId}/read`)).rejects.toMatchObject({ status: 400, body: { code: 'DB_SCHEMA_NO_READ' } });
    await expect(s.api('PUT', `/db-schemas/system/${systemId}/settings`, { retention: 5, readIntervalHours: 4 })).rejects.toMatchObject({ status: 400 });
  });

  it('keeps the schema of a system that is a database platform on the platform', async () => {
    const sys = await s.api('POST', '/systems', { name: 'Shop server', kind: 'server', platformId: db.id });
    const o = await s.api('GET', `/db-schemas/system/${sys.id}`);
    expect(o.importBlocked).toBe('systemIsPlatform');
    await expect(s.api('POST', `/db-schemas/system/${sys.id}/import`, { schema: SCHEMA })).rejects.toMatchObject({
      status: 409,
      body: { code: 'DB_SCHEMA_ON_PLATFORM' },
    });
    // who may not see that platform sees a system like any other: nothing tells that the platform exists, or its kind
    await s.api('PUT', `/systems/${sys.id}`, { name: 'Shop server', kind: 'server', owners: ['user:vera'] });
    const neutral = await vera('GET', `/db-schemas/system/${sys.id}`);
    expect(neutral).toMatchObject({ canImport: true, importBlocked: null, snapshots: [] });
    expect(JSON.stringify(neutral)).not.toMatch(/platform|database|DB_/i);
    await expect(vera('POST', `/db-schemas/system/${sys.id}/import/preview`, { schema: SCHEMA })).resolves.toMatchObject({ tables: 3 });
  });
});

describe('snapshots, changes, retention and exports', () => {
  it('lists the changes of a new import and compares any two snapshots', async () => {
    const r = await s.api('POST', `/db-schemas/system/${systemId}/import`, { schema: changed() });
    expect(r.diff).toMatchObject({ breaking: 2, incomplete: false });
    const kinds = r.diff.changes.map((c: { kind: string; column?: string; breaking: boolean }) => `${c.kind}:${c.column}:${c.breaking}`);
    expect(kinds).toEqual(['column-added:phone:false', 'column-type:email:true', 'column-removed:kind:true']);
    const o = await s.api('GET', `/db-schemas/system/${systemId}`);
    const [newest, oldest] = o.snapshots;
    const back = await s.api('GET', `/db-schemas/system/${systemId}/compare?from=${newest.id}&to=${oldest.id}`);
    expect(back).toMatchObject({ from: newest.id, to: oldest.id, breaking: 1 });
    await expect(s.api('GET', `/db-schemas/system/${systemId}/compare?from=${newest.id}&to=nope`)).rejects.toMatchObject({ status: 404 });
    // a snapshot of another database is not found here
    const platformSnap = (await s.api('GET', `/db-schemas/platform/${db.id}`)).snapshots[0].id;
    await expect(s.api('GET', `/db-schemas/system/${systemId}/snapshots/${platformSnap}`)).rejects.toMatchObject({ status: 404 });
  });

  it('exports DBML, SQL and JSON as files', async () => {
    const dl = async (format: string) => {
      const res = await fetch(`${s.base}/api/db-schemas/system/${systemId}/snapshots/latest/export?format=${format}`, {
        headers: { authorization: `Bearer ${tokens.full}` },
      });
      return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), text: await res.text() };
    };
    const dbml = await dl('dbml');
    expect(dbml).toMatchObject({ status: 200, type: expect.stringContaining('text/plain') });
    expect(dbml.disposition).toMatch(/attachment; filename="bakery-\d{4}-\d{2}-\d{2}\.dbml"/);
    expect(dbml.text).toContain('Table "public"."loaves"');
    const sql = await dl('sql');
    expect(sql.type).toContain('application/sql');
    expect(sql.text).toContain('CREATE TABLE "public"."customers"');
    const json = await dl('json');
    expect(JSON.parse(json.text)).toMatchObject({ format: 'steward-db-schema', database: 'bakery' });
    expect((await dl('xml')).status).toBe(400);
  });

  it('keeps the newest snapshots by the retention setting, audited', async () => {
    const st = await s.api('PUT', `/db-schemas/system/${systemId}/settings`, { retention: 2, readIntervalHours: 0 });
    expect(st).toEqual({ retention: 2, readIntervalHours: 0 });
    await s.api('POST', `/db-schemas/system/${systemId}/import`, { schema: SCHEMA });
    await s.api('POST', `/db-schemas/system/${systemId}/import`, { schema: changed() });
    const o = await s.api('GET', `/db-schemas/system/${systemId}`);
    expect(o.snapshots).toHaveLength(2);
    expect(o.snapshots[0].changes).toBeGreaterThan(0);
    const [entry] = await s.api('GET', `/audit?action=dbschema.settings_changed&entityId=${systemId}`);
    expect(entry.details).toMatchObject({ settings: { retention: 2 } });
  });
});

describe('public API', () => {
  it('lists snapshots and changes, and returns a snapshot and its export', async () => {
    const list = await v1(tokens.read!, `/systems/${systemId}/schema/snapshots?limit=1`);
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.nextCursor).toBeTruthy();
    expect(list.headers.get('link')).toContain('rel="next"');
    const next = await v1(tokens.read!, `/systems/${systemId}/schema/snapshots?limit=1&cursor=${list.json.nextCursor}`);
    expect(next.json.items[0].id).not.toBe(list.json.items[0].id);
    const latest = await v1(tokens.read!, `/systems/${systemId}/schema/snapshots/latest`);
    expect(latest.json).toMatchObject({ source: 'tbls', schema: { format: 'steward-db-schema', tables: expect.any(Array) }, lint: [], diff: { breaking: 2 } });
    const changes = await v1(tokens.read!, `/systems/${systemId}/schema/changes?breaking=true`);
    expect(changes.json.items[0]).toMatchObject({ snapshot: { id: latest.json.id }, diff: { breaking: 2 } });
    const cmp = await v1(tokens.read!, `/systems/${systemId}/schema/compare?from=${next.json.items[0].id}&to=${latest.json.id}`);
    expect(cmp.status).toBe(200);
    const dbml = await v1(tokens.read!, `/platforms/${db.id}/schema/snapshots/latest/export?format=dbml`);
    expect(dbml.status).toBe(200);
    expect(dbml.text).toContain('Project "bakery"');
  });

  it('answers 404 for a platform the token owner may not see', async () => {
    const r = await v1(tokens.vera!, `/platforms/${db.id}/schema/snapshots`);
    expect(r.status).toBe(404);
    expect(r.json.type).toMatch(/#not-found$/);
    expect(r.text).not.toContain(db.name);
  });

  it('documents the endpoints in the OpenAPI document', async () => {
    const doc = (await v1(tokens.read!, '/openapi.json')).json;
    const paths = Object.keys(doc.paths).filter((p) => p.includes('/schema/'));
    expect(paths).toEqual(expect.arrayContaining(['/platforms/{platformId}/schema/snapshots', '/systems/{systemId}/schema/changes']));
    // read-only: the push from CI has its own endpoint and token (dbschema-push.test.ts)
    expect(paths.every((p) => Object.keys(doc.paths[p]).join() === 'get')).toBe(true);
    expect((await v1(tokens.full!, `/systems/${systemId}/schema/tbls`, { method: 'POST', body: SCHEMA })).status).toBe(405);
  });
});

describe('monitor check', () => {
  const preview = (check: Record<string, unknown>) => s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'c', type: 'db-schema', ...check } });

  it('fails on a breaking change within the window', async () => {
    const r = await preview({ system: systemId, mode: 'breaking', withinHours: 24 });
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/breaking schema change/);
    expect((await preview({ system: systemId, mode: 'changed', withinHours: 24 })).status).toBe('degraded');
    expect((await preview({ system: systemId, mode: 'breaking', failAs: 'degraded' })).status).toBe('degraded');
  });

  it('reads the platform first when asked, and says when there is no snapshot', async () => {
    const r = await preview({ platform: db.id, mode: 'changed', withinHours: 24, read: true });
    expect(r.message).toMatch(/read: new snapshot/);
    const sys = await s.api('POST', '/systems', { name: 'Empty database', kind: 'server' });
    expect(await preview({ system: sys.id })).toMatchObject({ status: 'unknown', message: expect.stringMatching(/no schema snapshot yet/) });
    expect((await preview({ system: sys.id, noData: 'up' })).status).toBe('up');
  });

  it('saving or trying a check needs the editor to see its system or platform (security review of #222)', async () => {
    const dana = await s.as('dana', PW);
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: { status: number; body: Record<string, unknown> }) => e,
      );
    /** The answer without the reference it names */
    const answer = (e: { status: number; body: Record<string, unknown> }, ref: string) => ({
      status: e.status,
      code: e.body.code,
      text: String(e.body.detail ?? e.body.error).replaceAll(ref, 'REF'),
    });
    const team = (await s.api('POST', '/teams', { name: 'Schema owners', members: ['olivia'] })).id;
    const hidden = (await s.api('POST', '/systems', { name: 'Hidden database', kind: 'server' })).id;
    await s.api('PUT', `/owning-teams/system/${hidden}`, { teamIds: [team] });
    const check = (x: Record<string, unknown>) => ({ id: 'c', name: 'Schema', type: 'db-schema', ...x });
    const save = (x: Record<string, unknown>) => dana('POST', '/monitors', { definition: { name: 'Schema watch', checks: [check(x)] } });
    const tryIt = (x: Record<string, unknown>, monitorId?: string) => dana('POST', '/monitors/check-preview', { check: check(x), monitorId });

    // a system: missing and hidden alike, when saving and in "Check now"
    const missing = answer(await failure(save({ system: 'sys_missing' })), 'sys_missing');
    expect(missing).toMatchObject({ status: 400, code: 'SYSTEM_NOT_FOUND' });
    expect(answer(await failure(save({ system: hidden })), hidden)).toEqual(missing);
    expect(answer(await failure(tryIt({ system: hidden })), hidden)).toEqual(answer(await failure(tryIt({ system: 'sys_missing' })), 'sys_missing'));
    // someone else's monitor dana may edit: "Check now" runs as its owner, but dana must see the system herself
    const { monitor } = await s.api('POST', '/monitors', { definition: { name: 'Admin schema watch', checks: [check({ system: hidden })] } });
    await s.api('PUT', `/monitors/${monitor.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view', 'edit'] }] });
    expect(answer(await failure(tryIt({ system: hidden }, monitor.id)), hidden)).toEqual(missing);
    expect((await s.api('POST', '/monitors/check-preview', { check: check({ system: hidden }), monitorId: monitor.id })).status).toBeTruthy();

    // a database platform dana may not see: like a missing one, no name – also with read: true on someone else's monitor
    await s.api('PUT', `/platforms/${db.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    try {
      const gone = answer(await failure(save({ platform: 'plat_missing' })), 'plat_missing');
      expect(gone).toMatchObject({ status: 400, code: 'PLATFORM_NOT_FOUND' });
      const refused = await failure(save({ platform: db.id }));
      expect(answer(refused, db.id)).toEqual(gone);
      expect(JSON.stringify(refused.body)).not.toContain(db.name);
      const own = await s.api('POST', '/monitors', { definition: { name: 'Admin reads', checks: [check({ platform: db.id, read: true })] } });
      await s.api('PUT', `/monitors/${own.monitor.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view', 'edit'] }] });
      const before = (await s.api('GET', `/db-schemas/platform/${db.id}`)).lastRead?.at ?? null;
      const read = await failure(tryIt({ platform: db.id, read: true }, own.monitor.id));
      const goneThere = answer(await failure(tryIt({ platform: 'plat_missing', read: true }, own.monitor.id)), 'plat_missing');
      expect(goneThere).toMatchObject({ status: 400, code: 'PLATFORM_NOT_FOUND' });
      expect(answer(read, db.id)).toEqual(goneThere);
      // nothing was read
      expect((await s.api('GET', `/db-schemas/platform/${db.id}`)).lastRead?.at ?? null).toBe(before);
    } finally {
      await s.api('PUT', `/platforms/${db.id}/access`, { acl: [] });
    }
    // with the right, it works again
    expect((await tryIt({ platform: db.id, read: true })).status).toBeTruthy();
  });

  it('validates the check', async () => {
    expect(await preview({ mode: 'breaking' })).toMatchObject({ status: 'unknown', message: expect.stringMatching(/a database platform or a system/) });
    const { definitionIssues, monitorDefinitionSchema } = await import('@sm/shared');
    const def = (check: Record<string, unknown>) =>
      definitionIssues(monitorDefinitionSchema.parse({ name: 'm', checks: [{ id: 'c', name: 'c', type: 'db-schema', ...check }] })).map((i) => i.path);
    expect(def({})).toEqual(['checks.0.platform']);
    expect(def({ platform: db.id, system: systemId })).toEqual(['checks.0.platform']);
    expect(def({ system: systemId, read: true })).toEqual(['checks.0.read']);
    expect(def({ platform: db.id, read: true })).toEqual([]);
  });
});

describe('scheduled reads', () => {
  it('reads the platforms whose interval has passed and removes snapshots of deleted systems', async () => {
    await s.api('PUT', `/db-schemas/platform/${db.id}/settings`, { retention: 30, readIntervalHours: 1 });
    const { runSchemaJob } = await import('../src/dbschema/service.js');
    const { db: store } = await import('../src/db.js');
    // the last read (the monitor check's) was two hours ago
    store().run(
      "UPDATE db_schema_settings SET last_read_at = ? WHERE subject_kind = 'platform' AND subject_id = ?",
      new Date(Date.now() - 7_200_000).toISOString(),
      db.id,
    );
    const first = await runSchemaJob();
    expect(first).toMatchObject({ read: 1, failed: 0 });
    // read just now: not due again
    expect((await runSchemaJob()).read).toBe(0);
    await s.api('DELETE', `/systems/${systemId}`);
    expect((await runSchemaJob()).removed).toBeGreaterThan(0);
    await expect(s.api('GET', `/db-schemas/system/${systemId}`)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the platform’s limits', () => {
  it('cut the schema read at the platform’s row limit, marked truncated (ADR 0008, security review of #222)', async () => {
    const settings = (await s.api('GET', `/platforms/${db.id}`)).config.database;
    expect(settings).toBeTruthy();
    try {
      await s.api('PUT', `/platforms/${db.id}/database`, { ...settings, limits: { ...settings.limits, maxRows: 3 } });
      const r = await s.api('POST', `/db-schemas/platform/${db.id}/read`);
      expect(r.created).toBe(true);
      expect(r.snapshot.truncated).toBe(true);
      expect(r.snapshot.columns).toBeLessThanOrEqual(3);
    } finally {
      await s.api('PUT', `/platforms/${db.id}/database`, settings);
    }
    const full = await s.api('POST', `/db-schemas/platform/${db.id}/read`);
    expect(full.snapshot.truncated).toBe(false);
    expect(full.snapshot.columns).toBeGreaterThan(3);
  });
});
