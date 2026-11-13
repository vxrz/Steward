import {
  DATA_QUALITY_LIMITS,
  DATA_SCORECARD_PARTS,
  dataScorecardHistoryQuery,
  type DataMaturityLevel,
  type DataProductScorecard,
  type DataScorecardHistory,
  type DataScorecardHistoryPoint,
  type DataScorecardState,
} from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { me } from '../auth/access.js';
import { moduleEnabled } from '../modules/registry.js';
import { nowIso, parseJson } from '../util.js';
import { pruneQualityResults } from './quality.js';
import { scorecardsOf } from './scorecard.js';
import { sortEnvironments, visibleProduct } from './service.js';
import { chunks, environmentsOf, marks } from './store.js';

/**
 * The scorecard over time (0.24.0, ADR 0036 part 13 phase 2, docs/DATA-PRODUCTS.md#scorecard-history): once a day the
 * job `data-products-scorecard` stores each product's scorecard per environment – its maturity and the state of each
 * part and ISO/IEC 25012 dimension, no evidence, no names (`dp_scorecard_snapshots`) – and keeps 400 days. The product
 * page draws the trend from them (GET /api/data-products/:id/scorecard/history), the report section compares the
 * period's start with now. Snapshots are taken without a reader (a check the reader may not see counts by its status,
 * as on every page); they are shown only to who may see the product.
 */

const DAY = 24 * 3600_000;
const CHUNK = 200;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** The states of a scorecard as stored: parts by id, dimensions as `iso:<dimension>`. */
export const statesOf = (s: DataProductScorecard): Record<string, DataScorecardState> =>
  Object.fromEntries(s.parts.map((p) => [p.group === 'part' ? p.id : `iso:${p.id}`, p.state]));

/**
 * Takes today's snapshots (UTC day) that were not taken yet: every product that is not retired, in each of its
 * environments (a product without one: once, without an environment), in bulk – a fixed number of statements per 200
 * products and environment. What a run that stopped half-way (a crash, a restart) left out is taken by the next one; a
 * product added later in the day gets its snapshot then too. Then removes what is older than 400 days. Returns the
 * number of snapshots written (`force`: all of today's again).
 */
export function takeScorecardSnapshots(now = Date.now(), force = false): number {
  const day = dayOf(now);
  const products = db()
    .all<{ id: string }>("SELECT id FROM dp_products WHERE lifecycle <> 'retired' ORDER BY id")
    .map((r) => r.id);
  const envs = environmentsOf(products);
  const taken = force
    ? new Set<string>()
    : new Set(
        db()
          .all<{ product_id: string; environment: string }>('SELECT product_id, environment FROM dp_scorecard_snapshots WHERE day = ?', day)
          .map((r) => `${r.product_id}\u0000${r.environment}`),
      );
  const byEnv = new Map<string, string[]>();
  for (const p of products) {
    const mine = envs.filter((e) => e.product_id === p).map((e) => e.environment);
    for (const e of mine.length ? mine : [''])
      if (!taken.has(`${p}\u0000${e}`)) byEnv.set(e, [...(byEnv.get(e) ?? []), p]);
  }
  if (!byEnv.size) return 0;
  const takenAt = nowIso();
  let written = 0;
  for (const [env, ids] of byEnv)
    for (const part of chunks(ids, CHUNK)) {
      const cards = scorecardsOf(null, part, env || undefined, now);
      db().tx(() => {
        for (const c of cards.values()) {
          written += db().run(
            `INSERT INTO dp_scorecard_snapshots (product_id, environment, day, maturity, states, taken_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (product_id, environment, day) DO UPDATE SET maturity = excluded.maturity, states = excluded.states, taken_at = excluded.taken_at`,
            c.productId,
            env,
            day,
            c.maturity,
            JSON.stringify(statesOf(c)),
            takenAt,
          ).changes;
        }
      });
    }
  db().run('DELETE FROM dp_scorecard_snapshots WHERE day < ?', dayOf(now - DATA_QUALITY_LIMITS.historyDays * DAY));
  pruneQualityResults(now, true);
  return written;
}

/** The job `data-products-scorecard` (hourly; one snapshot a day). */
export async function runScorecardJob(): Promise<{ written: number }> {
  if (!moduleEnabled('dataProducts')) return { written: 0 };
  try {
    return { written: takeScorecardSnapshots() };
  } catch (err) {
    logger.warn({ err }, 'data product scorecard snapshots could not be taken');
    throw err;
  }
}

interface SnapshotRow {
  product_id: string;
  environment: string;
  day: string;
  maturity: number;
  states: string;
}

const pointOf = (r: SnapshotRow): DataScorecardHistoryPoint => {
  const states = parseJson<Record<string, DataScorecardState>>(r.states, {});
  const parts = DATA_SCORECARD_PARTS.map((p) => states[p]);
  return {
    day: r.day,
    maturity: Number(r.maturity) as DataMaturityLevel,
    met: parts.filter((s) => s === 'met').length,
    partial: parts.filter((s) => s === 'partial').length,
    notMet: parts.filter((s) => s === 'notMet').length,
    states,
  };
};

/** GET /api/data-products/:id/scorecard/history?environment=&days=: the daily snapshots of a product the caller may see. */
export function scorecardHistory(productId: string, query: unknown, now = Date.now()): DataScorecardHistory {
  const q = dataScorecardHistoryQuery.parse(query ?? {});
  const { row } = visibleProduct(productId, me());
  const envs = sortEnvironments(environmentsOf([row.id]).map((e) => e.environment));
  const env = q.environment ?? envs[0] ?? null;
  const rows = db().all<SnapshotRow>(
    'SELECT product_id, environment, day, maturity, states FROM dp_scorecard_snapshots WHERE product_id = ? AND environment = ? AND day >= ? ORDER BY day',
    row.id,
    env ?? '',
    dayOf(now - (q.days - 1) * DAY),
  );
  return { productId: row.id, environment: env, days: q.days, points: rows.map(pointOf) };
}

/** The snapshot of each product on or before `day` (the report section's start of the period), in bulk. */
export function snapshotsAt(productIds: readonly string[], environment: string, day: string): Map<string, DataScorecardHistoryPoint> {
  const out = new Map<string, DataScorecardHistoryPoint>();
  for (const part of chunks([...new Set(productIds)]))
    for (const r of db().all<SnapshotRow>(
      `SELECT s.product_id, s.environment, s.day, s.maturity, s.states FROM dp_scorecard_snapshots s WHERE s.environment = ? AND s.product_id IN (${marks(part.length)})
         AND s.day = (SELECT MAX(x.day) FROM dp_scorecard_snapshots x WHERE x.product_id = s.product_id AND x.environment = s.environment AND x.day <= ?)`,
      environment,
      ...part,
      day,
    ))
      out.set(r.product_id, pointOf(r));
  return out;
}
