/**
 * The demo Snowflake account as a project role sees it (0.26.2): the example processes "Snowflake – Task health
 * (project)" and "Snowflake – Dynamic tables and streams (project)" read nothing from SNOWFLAKE.ACCOUNT_USAGE, only the
 * project database's own INFORMATION_SCHEMA table functions and SHOW commands:
 *
 * - `SHOW TASKS | DYNAMIC TABLES | STREAMS IN DATABASE "<DB>"` – lower-case column names, as the SQL API sends SHOW
 *   output, timestamps as seconds since the epoch;
 * - `SELECT … FROM TABLE("<DB>".INFORMATION_SCHEMA.TASK_HISTORY(…))` and `….DYNAMIC_TABLE_REFRESH_HISTORY(…)` – the
 *   columns by the aliases of the outer SELECT list, aggregated per object from the invented runs below, with the
 *   templates' bind parameters (slow factor, minimum seconds, -hours).
 *
 * The invented objects live in PRJ_SALES_INSIGHTS_DEV; the other databases of the demo exist but have none, an unknown
 * database answers "does not exist or not authorized" like Snowflake. Like the rest of the mock it runs no SQL.
 */

type Cell = string | null;
export type ProjectAnswer = { names: string[]; rows: Cell[][] } | { error: string };

const H = 3_600_000;
const DAY = 24 * H;
const PROJECT_DB = 'PRJ_SALES_INSIGHTS_DEV';
/** Like the SQL API sends TIMESTAMP_LTZ values: seconds since the epoch with nanoseconds (negative ms: the future). */
const epoch = (msAgo: number) => `${((Date.now() - msAgo) / 1000).toFixed(3)}000000`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');

interface Run {
  hoursAgo: number;
  state: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  seconds: number;
  errorCode?: string;
  error?: string;
}
interface DemoTask {
  schema: string;
  name: string;
  state: 'started' | 'suspended';
  schedule: string;
  runs: Run[];
}

/** Hourly runs of the last 24 hours (1 = an hour ago), each given its state and duration. */
const hourly = (run: (h: number) => Omit<Run, 'hoursAgo'>): Run[] => Array.from({ length: 24 }, (_, i) => ({ hoursAgo: i + 1, ...run(i + 1) }));

const TASKS: DemoTask[] = [
  // fails since three hours: a source file with a text where a number belongs
  {
    schema: 'ETL',
    name: 'LOAD_ORDERS',
    state: 'started',
    schedule: 'USING CRON 0 * * * * UTC',
    runs: hourly((h) =>
      h <= 3
        ? { state: 'FAILED', seconds: 4, errorCode: '100038', error: "Numeric value 'n/a' is not recognized (file orders_2026-11.csv, line 1207)" }
        : { state: 'SUCCEEDED', seconds: 48 + (h % 5) },
    ),
  },
  // usually 45 s; two runs took minutes, one was skipped while the previous run went on
  {
    schema: 'ETL',
    name: 'BUILD_CUSTOMER_FACTS',
    state: 'started',
    schedule: '60 MINUTE',
    runs: hourly((h) =>
      h === 5 ? { state: 'SKIPPED', seconds: 0 } : h === 4 ? { state: 'SUCCEEDED', seconds: 420 } : { state: 'SUCCEEDED', seconds: h === 6 ? 300 : 45 },
    ),
  },
  {
    schema: 'MART',
    name: 'REFRESH_KPIS',
    state: 'started',
    schedule: 'USING CRON 30 5 * * * Europe/Berlin',
    runs: [{ hoursAgo: 10, state: 'SUCCEEDED', seconds: 120 }],
  },
  { schema: 'MART', name: 'EXPORT_FORECAST', state: 'suspended', schedule: 'USING CRON 0 6 * * 1 UTC', runs: [] },
  // started and due every 30 minutes, but nothing ran (its warehouse was dropped)
  { schema: 'ETL', name: 'ARCHIVE_EVENTS', state: 'started', schedule: '30 MINUTE', runs: [] },
];

interface Refresh {
  hoursAgo: number;
  state: 'SUCCEEDED' | 'FAILED' | 'UPSTREAM_FAILED';
  /** seconds from the data timestamp to the end of the refresh */
  lagSeconds: number;
  code?: string;
  message?: string;
}
interface DemoDynamicTable {
  schema: string;
  name: string;
  targetLag: string;
  targetSeconds: number;
  state: 'RUNNING' | 'SUSPENDED';
  /** hours since the data timestamp */
  dataHoursAgo: number;
  refreshes: Refresh[];
}
const DYNAMIC_TABLES: DemoDynamicTable[] = [
  {
    schema: 'MART',
    name: 'SALES_DAILY_DT',
    targetLag: '1 hour',
    targetSeconds: 3600,
    state: 'RUNNING',
    dataHoursAgo: 1 / 3,
    refreshes: Array.from({ length: 24 }, (_, i) => ({ hoursAgo: i + 0.5, state: 'SUCCEEDED' as const, lagSeconds: 2400 + (i % 4) * 150 })),
  },
  // its source view was dropped: the last five refreshes failed and the data is five hours old
  {
    schema: 'MART',
    name: 'CUSTOMER_SEGMENTS_DT',
    targetLag: '30 minutes',
    targetSeconds: 1800,
    state: 'RUNNING',
    dataHoursAgo: 5,
    refreshes: Array.from({ length: 12 }, (_, i): Refresh => {
      const hoursAgo = (i + 1) / 2;
      return hoursAgo <= 2.5
        ? {
            hoursAgo,
            state: 'FAILED',
            lagSeconds: 0,
            code: '002003',
            message: `SQL compilation error:\nObject '${PROJECT_DB}.ETL.CRM_CONTACTS_V' does not exist or not authorized.`,
          }
        : { hoursAgo, state: 'SUCCEEDED', lagSeconds: 1200 };
    }),
  },
  { schema: 'ETL', name: 'ORDERS_ENRICHED_DT', targetLag: '1 day', targetSeconds: 86_400, state: 'SUSPENDED', dataHoursAgo: 9 * 24, refreshes: [] },
];

const STREAMS = [
  { schema: 'ETL', name: 'ORDERS_CHANGES', table: `${PROJECT_DB}.ETL.ORDERS_RAW`, stale: false, staleAfterDays: 12 },
  { schema: 'ETL', name: 'CONTACTS_CHANGES', table: `${PROJECT_DB}.ETL.CONTACTS_RAW`, stale: true, staleAfterDays: -3 },
  { schema: 'ETL', name: 'EVENTS_CHANGES', table: `${PROJECT_DB}.ETL.EVENTS_RAW`, stale: false, staleAfterDays: 2 },
];

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const num = (n: number | null | undefined) => (n === null || n === undefined ? null : String(n));
/** The newest of some rows (smallest hoursAgo) that match. */
const newest = <T extends { hoursAgo: number }>(xs: T[], keep: (x: T) => boolean = () => true): T | undefined =>
  xs.filter(keep).sort((a, b) => a.hoursAgo - b.hoursAgo)[0];

/**
 * The answer to a statement of the two project templates; null: not one of theirs. `aliases` are the output columns of
 * the SELECT list, `known` says whether the demo account has a database.
 */
export function projectAnswer(sql: string, arg: (i: number) => string, aliases: string[], known: (db: string) => boolean): ProjectAnswer | null {
  const flat = sql.trim().replace(/\s+/g, ' ');
  const unknown = (db: string): ProjectAnswer => ({ error: `SQL compilation error:\nDatabase '${db}' does not exist or not authorized.` });
  // the templates send the database as a quoted identifier of a plain name – nothing else is answered
  const show = /^SHOW (TASKS|DYNAMIC TABLES|STREAMS) IN DATABASE "([A-Z_][A-Z0-9_$]*)" ?;?$/.exec(flat);
  if (show) {
    const [, what, db] = show as unknown as [string, string, string];
    if (!known(db)) return unknown(db);
    const mine = db === PROJECT_DB;
    const created = epoch(120 * DAY);
    if (what === 'TASKS')
      return {
        names: ['created_on', 'name', 'id', 'database_name', 'schema_name', 'owner', 'comment', 'warehouse', 'schedule', 'predecessors', 'state', 'definition'],
        rows: (mine ? TASKS : []).map((t, i) => [
          created,
          t.name,
          `01b8e2f0-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          db,
          t.schema,
          `${PROJECT_DB}_OWNER`,
          '',
          'PRJ_SALES_INSIGHTS_WH',
          t.schedule,
          '[]',
          t.state,
          'insert into mart.kpis select …',
        ]),
      };
    if (what === 'DYNAMIC TABLES')
      return {
        names: [
          'created_on',
          'name',
          'database_name',
          'schema_name',
          'rows',
          'bytes',
          'owner',
          'target_lag',
          'refresh_mode',
          'warehouse',
          'scheduling_state',
          'data_timestamp',
        ],
        rows: (mine ? DYNAMIC_TABLES : []).map((d) => [
          created,
          d.name,
          db,
          d.schema,
          '120000',
          '5242880',
          `${PROJECT_DB}_OWNER`,
          d.targetLag,
          'INCREMENTAL',
          'PRJ_SALES_INSIGHTS_WH',
          d.state,
          epoch(d.dataHoursAgo * H),
        ]),
      };
    return {
      names: [
        'created_on',
        'name',
        'database_name',
        'schema_name',
        'owner',
        'comment',
        'table_name',
        'source_type',
        'type',
        'stale',
        'mode',
        'stale_after',
        'invalid_reason',
      ],
      rows: (mine ? STREAMS : []).map((s) => [
        created,
        s.name,
        db,
        s.schema,
        `${PROJECT_DB}_OWNER`,
        '',
        s.table,
        'Table',
        'DELTA',
        String(s.stale),
        'DEFAULT',
        epoch(-s.staleAfterDays * DAY),
        'N/A',
      ]),
    };
  }
  const fn = /FROM TABLE\("([A-Z_][A-Z0-9_$]*)"\.INFORMATION_SCHEMA\.(TASK_HISTORY|DYNAMIC_TABLE_REFRESH_HISTORY)\(/.exec(flat);
  if (!fn) return null;
  const [, db, which] = fn as unknown as [string, string, string];
  if (!known(db)) return unknown(db);
  const mine = db === PROJECT_DB;
  if (which === 'TASK_HISTORY') {
    // bindings: 1 the slow factor, 2 the minimum seconds of a slow run, 3 -hours
    const factor = Number(arg(1)) || 2;
    const minSeconds = Number(arg(2)) || 0;
    const hours = Math.min(168, Math.abs(Number(arg(3)) || 24));
    const rows = (mine ? TASKS : []).flatMap((t) => {
      const runs = t.runs.filter((r) => r.hoursAgo <= hours);
      if (!runs.length) return [];
      const ok = runs.filter((r) => r.state === 'SUCCEEDED').map((r) => r.seconds);
      const med = median(ok);
      const failed = runs.filter((r) => r.state === 'FAILED');
      const lastFailure = newest(failed);
      const cell = (c: string): Cell => {
        switch (c) {
          case 'DATABASE_NAME':
            return db;
          case 'SCHEMA_NAME':
            return t.schema;
          case 'NAME':
            return t.name;
          case 'RUNS':
            return String(runs.length);
          case 'SUCCEEDED':
            return String(ok.length);
          case 'FAILED':
            return String(failed.length);
          case 'SKIPPED':
            return String(runs.filter((r) => r.state === 'SKIPPED').length);
          case 'CANCELLED':
            return String(runs.filter((r) => r.state === 'CANCELLED').length);
          case 'LAST_STATE':
            return newest(runs)!.state;
          case 'LAST_RUN':
            return iso(newest(runs)!.hoursAgo * H);
          case 'LAST_FAILURE':
            return lastFailure ? iso(lastFailure.hoursAgo * H) : null;
          case 'LAST_ERROR_CODE':
            return lastFailure?.errorCode ?? null;
          case 'LAST_ERROR':
            return lastFailure?.error ?? null;
          case 'MEDIAN_SECONDS':
            return num(med);
          case 'MAX_SECONDS':
            return ok.length ? String(Math.max(...ok)) : null;
          case 'SLOW_RUNS':
            return String(med === null ? 0 : ok.filter((s) => s > factor * med && s >= minSeconds).length);
          default:
            return null;
        }
      };
      return [aliases.map(cell)];
    });
    return { names: aliases, rows };
  }
  // DYNAMIC_TABLE_REFRESH_HISTORY – binding 1: -hours
  const hours = Math.min(168, Math.abs(Number(arg(1)) || 24));
  const rows = (mine ? DYNAMIC_TABLES : []).flatMap((d) => {
    const refreshes = d.refreshes.filter((r) => r.hoursAgo <= hours);
    if (!refreshes.length) return [];
    const failing = (r: Refresh) => r.state === 'FAILED' || r.state === 'UPSTREAM_FAILED';
    const lastFailure = newest(refreshes, failing);
    const cell = (c: string): Cell => {
      switch (c) {
        case 'DATABASE_NAME':
          return db;
        case 'SCHEMA_NAME':
          return d.schema;
        case 'NAME':
          return d.name;
        case 'REFRESHES':
          return String(refreshes.length);
        case 'FAILED':
          return String(refreshes.filter((r) => r.state === 'FAILED').length);
        case 'UPSTREAM_FAILED':
          return String(refreshes.filter((r) => r.state === 'UPSTREAM_FAILED').length);
        case 'LAST_STATE':
          return newest(refreshes)!.state;
        case 'LAST_FAILURE':
          return lastFailure ? iso(lastFailure.hoursAgo * H) : null;
        case 'LAST_ERROR_CODE':
          return lastFailure?.code ?? null;
        case 'LAST_ERROR':
          return lastFailure?.message ?? null;
        case 'TARGET_LAG_SEC':
          return String(d.targetSeconds);
        case 'MAX_LAG_SEC': {
          const ok = refreshes.filter((r) => r.state === 'SUCCEEDED');
          return ok.length ? String(Math.max(...ok.map((r) => r.lagSeconds))) : null;
        }
        default:
          return null;
      }
    };
    return [aliases.map(cell)];
  });
  return { names: aliases, rows };
}
