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
 *
 * 0.27.0 – "Data volume over time" and "Newest data point":
 *
 * - `SELECT … FROM "<DB>".INFORMATION_SCHEMA.TABLES WHERE …` – the base tables of a database with ROW_COUNT, BYTES and
 *   LAST_ALTERED, filtered by the schema list of bind parameter 1 ('' = all). PRJ_SALES_INSIGHTS_DEV has the invented
 *   tables below: one that doubles with every read (ETL.ORDERS_RAW), one purged after the first read (ETL.EVENTS_RAW),
 *   an empty one and one not altered for 400 days; the other databases answer their catalogue tables (`tablesOf`).
 * - `SELECT TO_VARCHAR(MAX("<COL>")::TIMESTAMP_LTZ, …) AS NEWEST, DATEDIFF('minute', …) AS AGE_MINUTES FROM
 *   "<DB>"."<SCHEMA>"."<TABLE>"` – the newest value of a few invented timestamp columns (fresh, a day old, an empty
 *   table); an unknown table or column answers Snowflake's errors.
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

/** A base table of the project database for INFORMATION_SCHEMA.TABLES; `rows(n)`: its rows at the n-th read (0: the first). */
interface DemoTable {
  schema: string;
  name: string;
  rows: (n: number) => number;
  alteredHours: number;
  transient?: boolean;
}
const PROJECT_TABLES: DemoTable[] = [
  // a load that doubles the raw orders with every run – sudden growth from the second read on
  { schema: 'ETL', name: 'ORDERS_RAW', rows: (n) => 1_000_000 * 2 ** Math.min(n, 10), alteredHours: 0.1, transient: true },
  // purged after the first read: 70 % fewer rows – sudden shrink at the second read, then steady
  { schema: 'ETL', name: 'EVENTS_RAW', rows: (n) => (n === 0 ? 4_000_000 : 1_200_000), alteredHours: 1 },
  { schema: 'ETL', name: 'CONTACTS_RAW', rows: () => 52_000, alteredHours: 3 },
  { schema: 'MART', name: 'SALES_DAILY', rows: () => 3_650, alteredHours: 0.2 },
  // created, never filled
  { schema: 'MART', name: 'FORECAST_INPUT', rows: () => 0, alteredHours: 48 },
  // nobody wrote to it for 400 days
  { schema: 'ARCHIVE', name: 'ORDERS_2023', rows: () => 840_000, alteredHours: 400 * 24 },
];
/** Bytes of a demo table: about 96 bytes per row compressed (an empty table has none). */
const bytesOf = (rows: number) => rows * 96;
/** Reads of INFORMATION_SCHEMA.TABLES per database (the growing and the purged table change with them). */
const volumeReads = new Map<string, number>();
/** For tests: the project tables as at their first read again. */
export function resetSnowflakeProjectVolumes(): void {
  volumeReads.clear();
}

/** The newest value of the invented timestamp columns, in minutes ago (null: the table is empty). */
const NEWEST: Record<string, Record<string, number | null>> = {
  [`${PROJECT_DB}.MART.SALES_DAILY`]: { LOADED_AT: 12, SALES_DATE: 18 * 60 },
  [`${PROJECT_DB}.ETL.ORDERS_RAW`]: { ORDER_TS: 7, LOADED_AT: 5 },
  [`${PROJECT_DB}.MART.FORECAST_INPUT`]: { SNAPSHOT_TS: null },
  'SHOP.SALES.ORDERS': { CREATED_AT: 26 * 60 },
};

/** A catalogue table of the other demo databases, for INFORMATION_SCHEMA.TABLES. */
export interface VolumeTable {
  schema: string;
  name: string;
  rows: number | null;
  bytes: number | null;
  alteredHours: number;
  transient?: boolean;
}

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
export function projectAnswer(
  sql: string,
  arg: (i: number) => string,
  aliases: string[],
  known: (db: string) => boolean,
  tablesOf: (db: string) => VolumeTable[] = () => [],
): ProjectAnswer | null {
  const flat = sql.trim().replace(/\s+/g, ' ');
  const unknown = (db: string): ProjectAnswer => ({ error: `SQL compilation error:\nDatabase '${db}' does not exist or not authorized.` });
  const volume = volumeAnswer(flat, arg, aliases, known, tablesOf);
  if (volume) return volume;
  const newestPoint = newestAnswer(flat, aliases, known, tablesOf);
  if (newestPoint) return newestPoint;
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

const IDENT = /^[A-Z_][A-Z0-9_$]*$/;

/** The base tables of a database (the project's invented ones, else the catalogue's) at this read. */
function volumeTables(db: string, read: number, tablesOf: (db: string) => VolumeTable[]): VolumeTable[] {
  if (db !== PROJECT_DB) return tablesOf(db);
  return PROJECT_TABLES.map((t) => {
    const rows = t.rows(read);
    return { schema: t.schema, name: t.name, rows, bytes: bytesOf(rows), alteredHours: t.alteredHours, transient: t.transient };
  });
}

/** `SELECT … FROM "<DB>".INFORMATION_SCHEMA.TABLES WHERE …` of "Data volume over time"; binding 1: the schemas ('' = all). */
function volumeAnswer(
  flat: string,
  arg: (i: number) => string,
  aliases: string[],
  known: (db: string) => boolean,
  tablesOf: (db: string) => VolumeTable[],
): ProjectAnswer | null {
  if (!flat.startsWith('SELECT ')) return null;
  const at = flat.indexOf(' FROM "');
  if (at < 0) return null;
  const from = /^ FROM "([A-Z_][A-Z0-9_$]*)"\.INFORMATION_SCHEMA\.TABLES WHERE /.exec(flat.slice(at));
  if (!from) return null;
  const db = from[1]!;
  if (!known(db)) return { error: `SQL compilation error:\nDatabase '${db}' does not exist or not authorized.` };
  const read = volumeReads.get(db) ?? 0;
  volumeReads.set(db, read + 1);
  const schemas = arg(1)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const rows = volumeTables(db, read, tablesOf)
    .filter((t) => !schemas.length || schemas.includes(t.schema))
    .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`))
    .map((t) =>
      aliases.map((c): Cell => {
        switch (c) {
          case 'TABLE_SCHEMA':
            return t.schema;
          case 'TABLE_NAME':
            return t.name;
          case 'IS_TRANSIENT':
            return t.transient ? 'YES' : 'NO';
          case 'ROW_COUNT':
            return num(t.rows);
          case 'BYTES':
            return num(t.bytes);
          case 'LAST_ALTERED':
            return iso(t.alteredHours * H);
          case 'DAYS_SINCE_ALTERED':
            return String(Math.floor(t.alteredHours / 24));
          default:
            return null;
        }
      }),
    );
  return { names: aliases, rows };
}

/** `SELECT TO_VARCHAR(MAX("<COL>")::TIMESTAMP_LTZ, …) AS NEWEST, … FROM "<DB>"."<SCHEMA>"."<TABLE>"` of "Newest data point". */
function newestAnswer(flat: string, aliases: string[], known: (db: string) => boolean, tablesOf: (db: string) => VolumeTable[]): ProjectAnswer | null {
  const col = /^SELECT TO_VARCHAR\(MAX\("([A-Z_][A-Z0-9_$]*)"\)::TIMESTAMP_LTZ, /.exec(flat)?.[1];
  if (!col) return null;
  const at = flat.lastIndexOf(' FROM "');
  const parts = at < 0 ? null : /^ FROM "([^"]+)"\."([^"]+)"\."([^"]+)" ?;?$/.exec(flat.slice(at));
  if (!parts || !parts.slice(1).every((x) => IDENT.test(x))) return null;
  const [, db, schema, table] = parts as unknown as [string, string, string, string];
  const qualified = `${db}.${schema}.${table}`;
  const exists = known(db) && volumeTables(db, 0, tablesOf).some((t) => t.schema === schema && t.name === table);
  if (!exists) return { error: `SQL compilation error:\nObject '${qualified}' does not exist or not authorized.` };
  const columns = NEWEST[qualified] ?? {};
  if (!(col in columns)) return { error: `SQL compilation error: error line 1 at position 22\ninvalid identifier '"${col}"'` };
  const minutes = columns[col];
  return {
    names: aliases,
    rows: [
      aliases.map((c): Cell => {
        if (minutes === null || minutes === undefined) return null;
        if (c === 'NEWEST') return iso(minutes * 60_000);
        if (c === 'AGE_MINUTES') return String(minutes);
        return null;
      }),
    ],
  };
}
