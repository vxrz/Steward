import { isDeepStrictEqual } from 'node:util';
import { PLANT_HISTORY_RETENTION, type PlantHistorySettings, type PlantHistorySettingsInput, type PlantHistoryUsage } from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { me } from '../../auth/access.js';
import { readSetting, writeSetting } from '../../settings.js';
import { nowIso } from '../../util.js';
import { KINDS, readEntry } from './entries.js';
import { historyValues, isCompressed, storedValues } from './values.js';

/**
 * How long the plant history and its bookkeeping are kept (0.15.0, ADR 0020; Settings → Data & retention → Plant registry history):
 * the history of removed entries, closed change sets and the import's baselines per entry – plant settings of
 * administrators, audited – and what they take in the database. The daily job `plant-changes` deletes what is older
 * and compacts rows written before 0.15.0 (a bounded number per run).
 */

const KEY = 'plant.historyRetention';

const within = (v: unknown, b: { min: number; max: number; default: number }) =>
  typeof v === 'number' && Number.isInteger(v) ? Math.min(b.max, Math.max(b.min, v)) : b.default;

export function historyRetention(): PlantHistorySettings {
  const s = readSetting<Partial<PlantHistorySettings>>(KEY, {});
  return {
    removedHistoryDays: within(s.removedHistoryDays, PLANT_HISTORY_RETENTION.removedHistoryDays),
    closedDays: within(s.closedDays, PLANT_HISTORY_RETENTION.closedDays),
    baselinesPerEntry: within(s.baselinesPerEntry, PLANT_HISTORY_RETENTION.baselinesPerEntry),
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null,
  };
}

const FIELDS = ['removedHistoryDays', 'closedDays', 'baselinesPerEntry'] as const;

export function setHistoryRetention(input: PlantHistorySettingsInput): PlantHistorySettings {
  const before = historyRetention();
  const changed = FIELDS.filter((k) => before[k] !== input[k]);
  if (!changed.length) return before;
  const next: PlantHistorySettings = { ...input, updatedAt: nowIso(), updatedBy: me().username };
  writeSetting(KEY, next);
  audit({
    action: 'plant.history_retention_changed',
    entityType: 'settings',
    entityId: 'plant',
    summary: `Plant registry history retention changed (${changed.join(', ')})`,
    details: Object.fromEntries(changed.map((k) => [k, { old: before[k], new: input[k] }])),
  });
  return next;
}

// ---------- what it takes ----------

/** Bytes of tables with their indexes (-1 where the database cannot say: SQLite without its dbstat table). */
function tableBytes(table: string): number {
  const d = db();
  try {
    if (d.dialect === 'postgres') return Number(d.get<{ n: number }>('SELECT pg_total_relation_size(to_regclass(?)) AS n', table)?.n ?? 0);
    return Number(
      d.get<{ n: number }>(
        `SELECT COALESCE(SUM(s.pgsize), 0) AS n FROM dbstat s JOIN sqlite_master m ON m.name = s.name WHERE m.tbl_name = ? AND m.type IN ('table', 'index')`,
        table,
      )?.n ?? 0,
    );
  } catch {
    return -1;
  }
}

const count = (sql: string, ...params: unknown[]) => Number(db().get<{ n: number }>(sql, ...params)?.n ?? 0);
const sumBytes = (tables: string[]) => {
  const xs = tables.map(tableBytes);
  return xs.some((x) => x < 0) ? -1 : xs.reduce((a, b) => a + b, 0);
};

export function historyUsage(): PlantHistoryUsage {
  return {
    history: {
      rows: count('SELECT COUNT(*) AS n FROM plant_entry_history'),
      bytes: tableBytes('plant_entry_history'),
      removedRows: count('SELECT COUNT(*) AS n FROM plant_entry_history WHERE removed_at IS NOT NULL'),
    },
    baselines: {
      rows: count('SELECT COUNT(*) AS n FROM plant_entry_baselines') + count('SELECT COUNT(*) AS n FROM plant_import_baselines'),
      bytes: sumBytes(['plant_entry_baselines', 'plant_import_baselines']),
    },
    changeSets: {
      rows: count('SELECT COUNT(*) AS n FROM plant_change_sets'),
      bytes: sumBytes(['plant_change_sets', 'plant_change_ops', 'plant_change_sources']),
      closedRows: count("SELECT COUNT(*) AS n FROM plant_change_sets WHERE state IN ('rejected', 'withdrawn', 'expired')"),
    },
    databaseBytes: db().sizeBytes(),
  };
}

// ---------- the import's baselines: the last ones per entry ----------

/** Deletes the baselines of each entry beyond the last `keep` (all entries; after the setting was lowered). */
export function pruneBaselines(keep = historyRetention().baselinesPerEntry): number {
  const over = db().all<{ kind: string; scope: string; entry_id: string }>(
    'SELECT kind, scope, entry_id FROM plant_entry_baselines GROUP BY kind, scope, entry_id HAVING COUNT(*) > ?',
    keep,
  );
  let n = 0;
  for (const e of over) {
    const rows = db().all<{ import_id: string }>(
      'SELECT import_id FROM plant_entry_baselines WHERE kind = ? AND scope = ? AND entry_id = ? ORDER BY seq DESC, recorded_at DESC',
      e.kind,
      e.scope,
      e.entry_id,
    );
    for (const r of rows.slice(keep))
      n += db().run(
        'DELETE FROM plant_entry_baselines WHERE kind = ? AND scope = ? AND entry_id = ? AND import_id = ?',
        e.kind,
        e.scope,
        e.entry_id,
        r.import_id,
      ).changes;
  }
  return n;
}

// ---------- compaction of rows written before 0.15.0 ----------

/** Rows per batch (one transaction each). */
const BATCH = 500;

type BaselineKey = [string, string, string, string];

/** Where a batch of the compaction starts: after this history row id and baseline key ('' and blanks: from the start; left out: that part is done). */
export interface CompactCursor {
  history?: string;
  baselines?: BaselineKey;
}

/**
 * One batch of the compaction: history rows of 0.13 with values that compress, and baselines with stored values –
 * where the entry still has those values, the baseline becomes its revision; otherwise its values are compressed.
 * Changes only how values are stored, never what they are: History, Revert, the merge and the audit entry's hash read
 * the same. Returns where the next batch starts.
 */
export function compactBatch(from: CompactCursor = { history: '', baselines: ['', '', '', ''] }): CompactCursor & { rows: number } {
  let rows = 0;
  const history =
    from.history === undefined
      ? []
      : db().all<{ id: string; before_values: string; after_values: string }>(
          `SELECT id, before_values, after_values FROM plant_entry_history
            WHERE id > ? AND ((LENGTH(before_values) >= 96 AND SUBSTR(before_values, 1, 3) <> 'z1:') OR (LENGTH(after_values) >= 96 AND SUBSTR(after_values, 1, 3) <> 'z1:'))
            ORDER BY id LIMIT ${BATCH}`,
          from.history,
        );
  const baselines =
    from.baselines === undefined
      ? []
      : db().all<{ kind: keyof typeof KINDS; scope: string; entry_id: string; import_id: string; field_values: string }>(
          `SELECT kind, scope, entry_id, import_id, field_values FROM plant_entry_baselines
            WHERE (kind, scope, entry_id, import_id) > (?, ?, ?, ?) AND revision IS NULL AND field_values IS NOT NULL AND SUBSTR(field_values, 1, 3) <> 'z1:'
            ORDER BY kind, scope, entry_id, import_id LIMIT ${BATCH}`,
          ...from.baselines,
        );
  db().tx(() => {
    for (const r of history) {
      const b = isCompressed(r.before_values) ? r.before_values : storedValues(r.before_values);
      const a = isCompressed(r.after_values) ? r.after_values : storedValues(r.after_values);
      if (b === r.before_values && a === r.after_values) continue;
      db().run('UPDATE plant_entry_history SET before_values = ?, after_values = ? WHERE id = ?', b, a, r.id);
      rows++;
    }
    for (const r of baselines) {
      const now = KINDS[r.kind] ? readEntry(r.kind, r.scope, r.entry_id) : null;
      const pointer = !!now && isDeepStrictEqual(historyValues<unknown>(r.field_values, null), now.values);
      const values = pointer ? null : storedValues(r.field_values);
      if (!pointer && values === r.field_values) continue;
      db().run(
        'UPDATE plant_entry_baselines SET revision = ?, field_values = ? WHERE kind = ? AND scope = ? AND entry_id = ? AND import_id = ?',
        pointer ? now.revision : null,
        values,
        r.kind,
        r.scope,
        r.entry_id,
        r.import_id,
      );
      rows++;
    }
  });
  const last = baselines.at(-1);
  return {
    ...(history.length === BATCH ? { history: history.at(-1)!.id } : {}),
    ...(baselines.length === BATCH && last ? { baselines: [last.kind, last.scope, last.entry_id, last.import_id] as BaselineKey } : {}),
    rows,
  };
}

/**
 * The compaction of a run of the daily job: batches until done or the budget is spent, giving the event loop back
 * between them. A later run starts from the beginning again (what is compacted is not selected again).
 */
export async function compactHistory(budget: { ms: number; rows: number } = { ms: 60_000, rows: 50_000 }): Promise<number> {
  const until = Date.now() + budget.ms;
  let cursor: CompactCursor = { history: '', baselines: ['', '', '', ''] };
  let rows = 0;
  while ((cursor.history !== undefined || cursor.baselines !== undefined) && Date.now() < until && rows < budget.rows) {
    const r = compactBatch(cursor);
    rows += r.rows;
    cursor = { ...(r.history !== undefined ? { history: r.history } : {}), ...(r.baselines ? { baselines: r.baselines } : {}) };
    await new Promise<void>((done) => setImmediate(done));
  }
  return rows;
}
