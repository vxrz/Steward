import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { PG_TEST_URL } from './pg-env.js';

/**
 * How the plant history and the import's baselines are stored (0.15.0, docs/adr/0020-plant-change-sets.md
 * "Performance"): values compressed where that is shorter, baselines as the revision an import left (the last ones
 * per entry, equal ones not again), the retention settings (bounds, audit, the daily clean-up) and the compaction of
 * rows of 0.13. The same scenario is read in the new format and in 0.13's (plain JSON, every baseline with its values):
 * History, Revert, the merge's base, the change set's page, the baselines and the audit entries' hashes are the same.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let vera: Client;
const PW = 'Plant-password-1';
const EX = path.resolve(import.meta.dirname, '../../examples/plant');
const read = (f: string) => fs.readFileSync(path.join(EX, f), 'utf8');
const FILES = () => [
  { name: 'brightwater.plant.yaml', content: read('brightwater.plant.yaml') },
  { name: 'brightwater-data-points.plant.yaml', content: read('brightwater-data-points.plant.yaml') },
  { name: 'brightwater-ot-network.plant.yaml', content: read('brightwater-ot-network.plant.yaml') },
];
const db = async () => (await import('../src/db.js')).db();
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code, body: e.body }),
  );
const importFiles = async (files: { name: string; content: string }[]) => {
  const pre = await s.api('POST', '/plant/import/preview', { files, mode: 'update' });
  expect(pre.ok, JSON.stringify(pre.problems?.slice(0, 3))).toBe(true);
  return s.api('POST', '/plant/import', { files, mode: 'update', fingerprint: pre.fingerprint });
};

/** What the import left in each entry it wrote, read right after it (what 0.13 stored as the baseline). */
async function leftBy(importId: string): Promise<Map<string, Record<string, unknown>>> {
  const { KINDS, entryKey } = await import('../src/plant/changesets/entries.js');
  const { PLANT_ENTRY_KINDS } = await import('@sm/shared');
  const out = new Map<string, Record<string, unknown>>();
  for (const kind of PLANT_ENTRY_KINDS) {
    const d = KINDS[kind];
    for (const e of d.read((await db()).all(`SELECT * FROM ${d.table} WHERE import_id = ?`, importId))) out.set(entryKey(e), e.values);
  }
  return out;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  vera = await s.as('vera', PW);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
});

describe('storage of the history and the baselines', () => {
  /** What the import of each step left (the 0.13 baselines), and the change sets applied */
  const left: Map<string, Record<string, unknown>>[] = [];
  const imports: string[] = [];

  it('compresses large values, keeps small ones as JSON, stores baselines as revisions and writes equal ones only once', async () => {
    const first = await importFiles(FILES());
    imports.push(first.import.id);
    left.push(await leftBy(first.import.id));
    const d = await db();
    const rows = d.all<{ op: string; before_values: string; after_values: string }>('SELECT op, before_values, after_values FROM plant_entry_history');
    // (the demo loaded the example plant without history: what the files add to it)
    expect(rows.filter((r) => r.op === 'add').length).toBeGreaterThan(5);
    // an addition keeps the whole entry: compressed; the removal side is null
    expect(rows.filter((r) => r.op === 'add').every((r) => r.after_values.startsWith('z1:') && r.before_values === 'null')).toBe(true);
    const n = left[0]!.size;
    expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_entry_baselines WHERE revision IS NOT NULL AND field_values IS NULL')!.n).toBe(n);
    // the same files again: every entry's baseline equals its last one – nothing written
    const again = await importFiles(FILES());
    expect(again.counts.change).toBe(0);
    expect(Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_entry_baselines')!.n)).toBe(n);
    // a changed model: a set row with the changed field only (short: plain JSON)
    const changed = await importFiles(FILES().map((f) => ({ ...f, content: f.content.replace('model: VMC 800', 'model: VMC 900') })));
    expect(changed.counts.change).toBeGreaterThan(0);
    imports.push(changed.import.id);
    left.push(await leftBy(changed.import.id));
    const set = d.get<{ before_values: string; after_values: string }>(
      "SELECT before_values, after_values FROM plant_entry_history WHERE kind = 'asset' AND entry_id = 'rvs-mill-01' AND op = 'set'",
    )!;
    expect([set.before_values, set.after_values]).toEqual(['{"model":"VMC 800"}', '{"model":"VMC 900"}']);
    const mill = d.all<{ import_id: string }>("SELECT import_id FROM plant_entry_baselines WHERE kind = 'asset' AND entry_id = 'rvs-mill-01' ORDER BY seq");
    expect(mill.map((r) => r.import_id)).toEqual([first.import.id, changed.import.id]);
  });

  it('reads the baselines as 0.13 stored them: what each import left, also after later edits in Steward', async () => {
    const { baselineOf, baselinesOf } = await import('../src/plant/changesets/track.js');
    // later edits in Steward: a form's save, a bulk change
    const a = await s.api('GET', '/plant/assets/rvs-mill-01');
    await s.api('PUT', '/plant/assets/rvs-mill-01', {
      siteId: a.siteId,
      areaId: a.location.area?.id ?? null,
      workCenterId: a.location.workCenter?.id ?? null,
      workUnitId: a.location.workUnit?.id ?? null,
      buildingId: a.location.buildingId,
      name: a.name,
      manufacturer: a.manufacturer,
      model: a.model,
      status: a.status,
      parentId: a.parentId,
      domain: a.domain,
      processArea: a.processArea,
      role: a.role,
      tags: a.tags,
      commissioned: a.commissioned,
      endOfSupport: a.endOfSupport,
      description: 'Edited in Steward',
      capabilities: a.capabilities,
      imageName: a.imageName,
      refs: a.refs,
      fields: a.fields,
      revision: a.revision,
    });
    const items = ['rvs-mill-01', 'rvs-mill-02', 'rvs-press-01'].map((id) => ({ scope: '', id }));
    const body = { kind: 'asset', action: 'edit', items, set: { addTags: ['checked'] } };
    const p = await s.api('POST', '/plant/bulk/preview', body);
    await s.api('POST', '/plant/bulk', { ...body, fingerprint: p.fingerprint });
    const { entryKey } = await import('../src/plant/changesets/entries.js');
    // the last import's values for every entry it wrote; the one before for the others
    const last = new Map([...left[0]!, ...left[1]!]);
    let compared = 0;
    for (const [k, values] of last) {
      const [kind, scope, id] = k.split('\u0000') as [any, string, string];
      if (entryKey({ kind, scope, id }) !== k) continue;
      expect(baselineOf(kind, scope, id)?.values, k).toEqual(values);
      compared++;
    }
    expect(compared).toBe(last.size);
    expect(baselineOf('asset', '', 'rvs-mill-01')).toMatchObject({
      importId: imports[1],
      values: { model: 'VMC 900', description: left[1]!.get(entryKey({ kind: 'asset', scope: '', id: 'rvs-mill-01' }))!.description },
    });
    // the last ones, newest first
    expect(baselinesOf('asset', '', 'rvs-mill-01').map((b) => [b.importId, b.values.model])).toEqual([
      [imports[1], 'VMC 900'],
      [imports[0], 'VMC 800'],
    ]);
  });

  it('History, Revert, the merge base, the change set page and the hashes read the same as in the format of 0.13', async () => {
    const d = await db();
    const { historySha256Of } = await import('../src/plant/changesets/track.js');
    const { historyText } = await import('../src/plant/changesets/values.js');
    // a removal (its snapshot) and a rename, too
    await s.api('DELETE', '/plant/assets/rvs-test-bench-01');
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', id: 'rvs-compressor-01', newId: 'rvs-compressor-1' });
    const applied = d.all<{ id: string; history_sha256: string }>(
      "SELECT id, history_sha256 FROM plant_change_sets WHERE state = 'applied' ORDER BY created_at",
    );
    expect(applied.length).toBeGreaterThanOrEqual(5);
    const read = async () => {
      const out: Record<string, unknown> = {};
      for (const [kind, id, children] of [
        ['asset', 'rvs-mill-01', '1'],
        ['asset', 'rvs-mill-02', '0'],
        ['asset', 'rvs-compressor-1', '1'],
        ['site', 'riverside', '1'],
        ['profile', 'example-controls-c80', '0'],
      ] as const)
        out[`history ${kind} ${id}`] = await s.api('GET', `/plant/history?kind=${kind}&id=${id}&children=${children}`);
      for (const c of applied) {
        const { applied: entries, operations } = await s.api('GET', `/plant/change-sets/${c.id}`);
        out[`change set ${c.id}`] = { entries, operations };
        out[`hash ${c.id}`] = historySha256Of(c.id);
      }
      // Revert of every applied change set: a draft with the inverse operations (withdrawn again)
      for (const c of applied) {
        const r = await status(s.api('POST', `/plant/change-sets/${c.id}/revert`));
        if (r.status !== 200) {
          out[`revert ${c.id}`] = r.code;
          continue;
        }
        const draft = (await s.api('GET', '/plant/change-sets?box=drafts')).items[0];
        out[`revert ${c.id}`] = (await s.api('GET', `/plant/change-sets/${draft.id}`)).operations.map((o: any) => ({ ...o, updatedAt: undefined }));
        await s.api('POST', `/plant/change-sets/${draft.id}/withdraw`);
      }
      // the merge's base: a save on an older revision (read back from the history)
      const a = await s.api('GET', '/plant/assets/rvs-mill-01');
      const stale = await status(s.api('PUT', '/plant/assets/rvs-mill-01', { ...(await bodyOf(a)), description: 'Mine', revision: 1 }));
      out.stale = { ...stale.body, requestId: undefined };
      // the baselines
      const { baselinesOf } = await import('../src/plant/changesets/track.js');
      out.baselines = ['rvs-mill-01', 'rvs-mill-02', 'rvs-compressor-1'].map((id) => baselinesOf('asset', '', id).map((b) => [b.importId, b.values]));
      return out;
    };
    const now = await read();
    for (const c of applied) expect(now[`hash ${c.id}`], c.id).toBe(c.history_sha256);
    // the same database in the format of 0.13: plain JSON, every baseline with its values
    const { baselinesOf } = await import('../src/plant/changesets/track.js');
    d.tx(() => {
      for (const r of d.all<{ id: string; before_values: string; after_values: string }>('SELECT id, before_values, after_values FROM plant_entry_history'))
        d.run(
          'UPDATE plant_entry_history SET before_values = ?, after_values = ? WHERE id = ?',
          historyText(r.before_values),
          historyText(r.after_values),
          r.id,
        );
      for (const b of d.all<{ kind: any; scope: string; entry_id: string }>('SELECT DISTINCT kind, scope, entry_id FROM plant_entry_baselines'))
        for (const x of baselinesOf(b.kind, b.scope, b.entry_id))
          d.run(
            'UPDATE plant_entry_baselines SET revision = NULL, field_values = ? WHERE kind = ? AND scope = ? AND entry_id = ? AND import_id = ?',
            JSON.stringify(x.values),
            b.kind,
            b.scope,
            b.entry_id,
            x.importId,
          );
    });
    expect(Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_entry_history WHERE after_values LIKE 'z1:%'")!.n)).toBe(0);
    expect(await read()).toEqual(now);
    // the compaction brings it back: compressed again, baselines whose entry still has the values become revisions
    const { compactBatch, compactHistory } = await import('../src/plant/changesets/retention.js');
    expect(compactBatch().rows).toBeGreaterThan(0);
    await compactHistory();
    expect(compactBatch().rows).toBe(0);
    expect(Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_entry_history WHERE after_values LIKE 'z1:%'")!.n)).toBeGreaterThan(5);
    expect(Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_entry_baselines WHERE revision IS NOT NULL')!.n)).toBeGreaterThan(10);
    expect(await read()).toEqual(now);
  });

  it('an import followed by other operations in one change set keeps what the import left as values', async () => {
    const { baselineOf } = await import('../src/plant/changesets/track.js');
    const files = FILES().map((f) => ({ ...f, content: f.content.replaceAll('model: VMC 800', 'model: VMC 950') }));
    await s.api('POST', '/plant/change-sets/current/operations', { op: 'import', value: { files: files.slice(0, 1), mode: 'update' } });
    const a = await s.api('GET', '/plant/assets/rvs-mill-02');
    await s.api('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'asset',
      id: 'rvs-mill-02',
      value: { ...(await bodyOf(a)), model: 'Own model' },
    });
    const draft = (await s.api('GET', '/plant/change-sets?box=drafts')).items[0];
    const pre = await s.api('POST', `/plant/change-sets/${draft.id}/preview`);
    await s.api('POST', `/plant/change-sets/${draft.id}/apply`, { fingerprint: pre.fingerprint });
    expect((await s.api('GET', '/plant/assets/rvs-mill-02')).model).toBe('Own model');
    const b = baselineOf('asset', '', 'rvs-mill-02');
    expect(b?.values.model).toBe('VMC 950');
    const row = (await db()).get<{ revision: number | null; field_values: string | null }>(
      "SELECT revision, field_values FROM plant_entry_baselines WHERE kind = 'asset' AND entry_id = 'rvs-mill-02' ORDER BY seq DESC LIMIT 1",
    )!;
    expect(row.revision).toBeNull();
    expect(row.field_values).toMatch(/^z1:/);
  });
});

/** A PUT body of an asset from its GET answer. */
async function bodyOf(a: any): Promise<Record<string, unknown>> {
  return {
    siteId: a.siteId,
    areaId: a.location.area?.id ?? null,
    workCenterId: a.location.workCenter?.id ?? null,
    workUnitId: a.location.workUnit?.id ?? null,
    buildingId: a.location.buildingId,
    name: a.name,
    manufacturer: a.manufacturer,
    model: a.model,
    status: a.status,
    parentId: a.parentId,
    domain: a.domain,
    processArea: a.processArea,
    role: a.role,
    tags: a.tags,
    commissioned: a.commissioned,
    endOfSupport: a.endOfSupport,
    description: a.description,
    capabilities: a.capabilities,
    imageName: a.imageName,
    refs: a.refs,
    fields: a.fields,
  };
}

describe('retention settings', () => {
  it('administrators set them within bounds, audited; the page shows what the history takes', async () => {
    const v = await s.api('GET', '/settings/plant/history');
    expect(v.settings).toMatchObject({ removedHistoryDays: 1095, closedDays: 90, baselinesPerEntry: 3, updatedAt: null });
    expect(v.usage.history.rows).toBeGreaterThan(10);
    expect(v.usage.history.bytes).toBeGreaterThan(0);
    expect(v.usage.baselines.rows).toBeGreaterThan(10);
    expect(v.usage.databaseBytes).toBeGreaterThan(0);
    expect(await status(vera('GET', '/settings/plant/history'))).toMatchObject({ status: 403 });
    expect(await status(vera('PUT', '/settings/plant/history', { removedHistoryDays: 400, closedDays: 30, baselinesPerEntry: 2 }))).toMatchObject({
      status: 403,
    });
    for (const bad of [
      { removedHistoryDays: 29, closedDays: 90, baselinesPerEntry: 3 },
      { removedHistoryDays: 3651, closedDays: 90, baselinesPerEntry: 3 },
      { removedHistoryDays: 1095, closedDays: 6, baselinesPerEntry: 3 },
      { removedHistoryDays: 1095, closedDays: 90, baselinesPerEntry: 0 },
      { removedHistoryDays: 1095, closedDays: 90, baselinesPerEntry: 11 },
      { removedHistoryDays: 1095.5, closedDays: 90, baselinesPerEntry: 3 },
      { removedHistoryDays: 1095, closedDays: 90 },
      { removedHistoryDays: 1095, closedDays: 90, baselinesPerEntry: 3, other: 1 },
    ])
      expect(await status(s.api('PUT', '/settings/plant/history', bad)), JSON.stringify(bad)).toMatchObject({ status: 400 });
    const next = await s.api('PUT', '/settings/plant/history', { removedHistoryDays: 400, closedDays: 30, baselinesPerEntry: 1 });
    expect(next.settings).toMatchObject({ removedHistoryDays: 400, closedDays: 30, baselinesPerEntry: 1, updatedBy: 'admin' });
    const [entry] = await s.api('GET', '/audit?action=plant.history_retention_changed&limit=1');
    expect(entry.details).toEqual({
      removedHistoryDays: { old: 1095, new: 400 },
      closedDays: { old: 90, new: 30 },
      baselinesPerEntry: { old: 3, new: 1 },
    });
    // the same again: nothing audited
    await s.api('PUT', '/settings/plant/history', { removedHistoryDays: 400, closedDays: 30, baselinesPerEntry: 1 });
    expect(await s.api('GET', '/audit?action=plant.history_retention_changed')).toHaveLength(1);
  });

  it('the daily clean-up follows them: removed entries’ history, closed change sets, baselines beyond the last ones', async () => {
    const d = await db();
    const { cleanUpChangeSets } = await import('../src/plant/changesets/core.js');
    // (the test bench removed above came back with the import of the change set)
    await s.api('DELETE', '/plant/assets/rvs-test-bench-01');
    const removed = d.get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_entry_history WHERE removed_at IS NOT NULL')!;
    expect(Number(removed.n)).toBeGreaterThan(0);
    const over = () =>
      Number(
        d.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT kind FROM plant_entry_baselines GROUP BY kind, scope, entry_id HAVING COUNT(*) > 1) x')!.n,
      );
    expect(over()).toBeGreaterThan(0);
    const day = 86_400_000;
    const closed = Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_change_sets WHERE state IN ('rejected', 'withdrawn', 'expired')")!.n);
    expect(closed).toBeGreaterThan(0);
    const { baselineOf } = await import('../src/plant/changesets/track.js');
    const lastImport = baselineOf('asset', '', 'rvs-mill-01')!.importId;
    // the baselines beyond the last one go at once; closed change sets after 30 days, the removal's history after 400
    expect(cleanUpChangeSets(new Date(Date.now() + 29 * day))).toMatchObject({ changeSets: 0, history: 0, baselines: expect.any(Number) });
    expect(over()).toBe(0);
    expect(cleanUpChangeSets(new Date(Date.now() + 399 * day))).toMatchObject({ changeSets: closed, history: 0, baselines: 0 });
    expect(cleanUpChangeSets(new Date(Date.now() + 401 * day))).toMatchObject({ changeSets: 0, history: Number(removed.n) });
    // the baseline kept is the last one
    expect(baselineOf('asset', '', 'rvs-mill-01')?.importId).toBe(lastImport);
  });
});

describe('migration plant-030-entry-baselines', () => {
  const targets = (): { name: string; target: any }[] => [
    { name: 'SQLite', target: { kind: 'sqlite', file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pb-')), 'db.sqlite') } },
    ...(PG_TEST_URL
      ? [{ name: 'PostgreSQL', target: { kind: 'postgres', url: PG_TEST_URL, schema: `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_pb${process.pid}` } }]
      : []),
  ];
  it('moves the baselines of 0.13 with their values into the table per entry and import', async () => {
    const { Db, coreMigrations, namedMigrations } = await import('../src/db.js');
    for (const { name, target } of targets()) {
      const dialect = target.kind === 'sqlite' ? 'sqlite' : 'postgres';
      const before = namedMigrations(dialect)
        .map((m) => m.name)
        .filter((n) => n !== 'plant-030-entry-baselines');
      const old = new Db(target, { upTo: { core: coreMigrations(dialect).length, named: before }, quiet: true });
      old.run(
        "INSERT INTO plant_import_baselines (kind, scope, entry_id, field_values, import_id, updated_at) VALUES ('asset', '', 'a-1', '{\"model\":\"M\"}', 'imp_1', '2026-11-01T00:00:00.000Z')",
      );
      old.close();
      const now = new Db(target, { quiet: true });
      try {
        expect(now.all('SELECT kind, scope, entry_id, import_id, revision, field_values, recorded_at FROM plant_entry_baselines'), name).toEqual([
          {
            kind: 'asset',
            scope: '',
            entry_id: 'a-1',
            import_id: 'imp_1',
            revision: null,
            field_values: '{"model":"M"}',
            recorded_at: '2026-11-01T00:00:00.000Z',
          },
        ]);
        expect(Number(now.get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_import_baselines')!.n), name).toBe(0);
      } finally {
        now.close();
      }
    }
  });
});
