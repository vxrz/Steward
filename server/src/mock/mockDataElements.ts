/**
 * The demo Snowflake account's answers to the statements of the data products checks (ADR 0036 part 10, WP3):
 * dynamic table refreshes, task runs, a schema's or database's tables, and columns. Called by mockSnowflake.ts for the
 * tags `dp-…`; tests change the answers with the setters.
 */

type Cell = string | null;
const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');

interface Refresh {
  /** DB.SCHEMA.NAME */
  name: string;
  /** hours since the data timestamp of the last successful refresh (null: none) */
  dataHours: number | null;
  lastState: 'SUCCEEDED' | 'FAILED' | 'UPSTREAM_FAILED';
  message?: string;
}
interface TaskRuns {
  name: string;
  /** hours since the last successful run (null: none in the history) */
  successHours: number | null;
  lastState: 'SUCCEEDED' | 'FAILED';
  error?: string;
}
interface Column {
  name: string;
  type: string;
  nullable: boolean;
  precision?: number;
  scale?: number;
  length?: number;
}

const seedRefreshes = (): Refresh[] => [
  { name: 'SHOP.SALES.ORDERS_DT', dataHours: 0.25, lastState: 'SUCCEEDED' },
  { name: 'SHOP.REPORTING.REVENUE_DT', dataHours: 30, lastState: 'FAILED', message: 'Warehouse BI_WH was suspended' },
];
const seedTasks = (): TaskRuns[] => [
  { name: 'SHOP.STAGING.LOAD_EVENTS', successHours: 26, lastState: 'FAILED', error: "SQL compilation error: Object 'SHOP.STAGING.EVENTS_EXT' does not exist" },
  { name: 'SHOP.SALES.REFRESH_ORDERS', successHours: 0.5, lastState: 'SUCCEEDED' },
];
const seedColumns = (): Map<string, Column[]> =>
  new Map([
    [
      'SHOP.SALES.ORDERS',
      [
        { name: 'ORDER_ID', type: 'NUMBER', nullable: false, precision: 38, scale: 0 },
        { name: 'CUSTOMER_ID', type: 'NUMBER', nullable: false, precision: 38, scale: 0 },
        { name: 'TOTAL', type: 'NUMBER', nullable: true, precision: 12, scale: 2 },
        { name: 'STATUS', type: 'TEXT', nullable: true, length: 20 },
        { name: 'CREATED_AT', type: 'TIMESTAMP_NTZ', nullable: false },
      ],
    ],
    [
      'SHOP.SALES.CUSTOMERS',
      [
        { name: 'CUSTOMER_ID', type: 'NUMBER', nullable: false, precision: 38, scale: 0 },
        { name: 'NAME', type: 'TEXT', nullable: false, length: 200 },
        { name: 'EMAIL', type: 'TEXT', nullable: true, length: 320 },
      ],
    ],
  ]);

/** 0.24.0: ROW_COUNT and BYTES of tables (INFORMATION_SCHEMA.TABLES) for the volume mode. */
const seedVolumes = (): Map<string, { rows: number; bytes: number }> =>
  new Map([
    ['SHOP.SALES.ORDERS', { rows: 125_000, bytes: 9_800_000 }],
    ['SHOP.SALES.CUSTOMERS', { rows: 4_200, bytes: 640_000 }],
  ]);
interface Dmf {
  /** DB.SCHEMA.METRIC */
  metric: string;
  args: string;
  value: number | null;
  hoursAgo: number;
}
/** 0.24.0: Data Metric Function results per table (SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS). */
const seedDmf = (): Map<string, Dmf[]> =>
  new Map([
    [
      'SHOP.SALES.ORDERS',
      [
        { metric: 'SNOWFLAKE.CORE.NULL_COUNT', args: 'CUSTOMER_ID', value: 0, hoursAgo: 2 },
        { metric: 'SNOWFLAKE.CORE.DUPLICATE_COUNT', args: 'ORDER_ID', value: 0, hoursAgo: 2 },
        { metric: 'SNOWFLAKE.CORE.ROW_COUNT', args: '', value: 125_000, hoursAgo: 2 },
      ],
    ],
    ['SHOP.SALES.CUSTOMERS', [{ metric: 'SNOWFLAKE.CORE.NULL_COUNT', args: 'EMAIL', value: 12, hoursAgo: 3 }]],
  ]);

let refreshes = seedRefreshes();
let volumes = seedVolumes();
let dmf = seedDmf();
let tasks = seedTasks();
let columns = seedColumns();

/** For tests: a dynamic table's last refresh. */
export function setDynamicRefresh(name: string, dataHours: number | null, lastState: Refresh['lastState'] = 'SUCCEEDED'): void {
  refreshes = [...refreshes.filter((r) => r.name !== name), { name, dataHours, lastState }];
}
/** For tests: a task's runs. */
export function setTaskRuns(name: string, successHours: number | null, lastState: TaskRuns['lastState'] = 'SUCCEEDED'): void {
  tasks = [...tasks.filter((t) => t.name !== name), { name, successHours, lastState }];
}
/** For tests: the columns of a table (DB.SCHEMA.TABLE). */
export function setColumns(name: string, cols: Column[]): void {
  columns.set(name, cols);
}
/** For tests: a table's row count and size. */
export function setTableVolume(name: string, rows: number | null, bytes: number | null = null): void {
  if (rows === null) volumes.delete(name);
  else volumes.set(name, { rows, bytes: bytes ?? rows * 80 });
}
/** For tests: a table's Data Metric Function results. */
export function setDmfResults(name: string, results: Dmf[]): void {
  dmf.set(name, results);
}
export function resetDataElementMock(): void {
  refreshes = seedRefreshes();
  volumes = seedVolumes();
  dmf = seedDmf();
  tasks = seedTasks();
  columns = seedColumns();
}

/** Every statement the checks sent with its bindings, for the allow-list test (metadata only). */
export const dataElementStatements: { sql: string; bindings: string[] }[] = [];

const unquote = (s: string) => s.replaceAll('"', '');

const CHECK_TAGS = new Set(['dp-dynamic-refresh', 'dp-task-runs', 'dp-table-fresh', 'dp-project-fresh', 'dp-columns', 'dp-table-volume', 'dp-dmf-results']);

/** 0.24.0: the statements of the volume and quality modes with their bindings, for their allow-list test. */
export const qualityStatements: { sql: string; bindings: string[] }[] = [];

/**
 * The answer to a `dp-…` statement, or null for another tag. `tables` are the demo account's tables (catalog, schema,
 * name, type, hours since LAST_ALTERED).
 */
export function dataElementAnswer(
  tag: string,
  sql: string,
  arg: (i: number) => string,
  tables: readonly { catalog: string; schema: string; name: string; type: string; altered: number }[],
): { names: string[]; rows: Cell[][] } | null {
  // the checks' statements only (discovery's dp-… tags are answered by mockSnowflake.ts)
  if (!CHECK_TAGS.has(tag)) return null;
  const record = tag === 'dp-table-volume' || tag === 'dp-dmf-results' ? qualityStatements : dataElementStatements;
  if (record.length < 1000) record.push({ sql, bindings: [1, 2, 3, 4].map(arg).filter((x) => x !== '') });
  // the database of a table function: TABLE(<db>.INFORMATION_SCHEMA.…)
  const db = unquote(/TABLE\(\s*("?[A-Za-z0-9_$-]+"?)\.INFORMATION_SCHEMA/.exec(sql)?.[1] ?? '');
  switch (tag) {
    case 'dp-dynamic-refresh': {
      const r = refreshes.find((x) => x.name === unquote(arg(1)));
      return {
        names: ['DATA_TIMESTAMP', 'LAST_STATE', 'LAST_MESSAGE'],
        rows: [r ? [r.dataHours === null ? null : iso(r.dataHours * H), r.lastState, r.message ?? null] : [null, null, null]],
      };
    }
    case 'dp-task-runs': {
      const t = tasks.find((x) => x.name === `${db}.${arg(2)}.${arg(1)}`);
      return {
        names: ['LAST_SUCCESS', 'LAST_STATE', 'LAST_ERROR'],
        rows: [t ? [t.successHours === null ? null : iso(t.successHours * H), t.lastState, t.error ?? null] : [null, null, null]],
      };
    }
    case 'dp-table-fresh': {
      const dbName = unquote(arg(1).split('.INFORMATION_SCHEMA')[0] ?? '');
      const t = tables.find((x) => x.catalog === dbName && x.schema === arg(2) && x.name === arg(3));
      return { names: ['LAST_ALTERED', 'TABLE_TYPE'], rows: t ? [[iso(t.altered), t.type]] : [] };
    }
    case 'dp-project-fresh': {
      const dbName = unquote(arg(2).split('.INFORMATION_SCHEMA')[0] ?? '');
      const maxAge = Math.abs(Number(arg(1))) * 60_000;
      const ts = tables.filter((t) => t.catalog === dbName && t.type === 'BASE TABLE' && (!arg(3) || t.schema === arg(3)));
      if (!ts.length) return { names: ['TABLES', 'NEWEST', 'OLDEST', 'OLDEST_NAME', 'STALE'], rows: [['0', null, null, null, '0']] };
      const oldest = ts.reduce((a, b) => (b.altered > a.altered ? b : a));
      const newest = ts.reduce((a, b) => (b.altered < a.altered ? b : a));
      return {
        names: ['TABLES', 'NEWEST', 'OLDEST', 'OLDEST_NAME', 'STALE'],
        rows: [
          [String(ts.length), iso(newest.altered), iso(oldest.altered), `${oldest.schema}.${oldest.name}`, String(ts.filter((t) => t.altered > maxAge).length)],
        ],
      };
    }
    case 'dp-table-volume': {
      const dbName = unquote(arg(1).split('.INFORMATION_SCHEMA')[0] ?? '');
      const v = volumes.get(`${dbName}.${arg(2)}.${arg(3)}`);
      return { names: ['ROW_COUNT', 'BYTES'], rows: v ? [[String(v.rows), String(v.bytes)]] : [] };
    }
    case 'dp-dmf-results': {
      const within = Math.abs(Number(arg(4))) * H;
      const rs = (dmf.get(`${arg(1)}.${arg(2)}.${arg(3)}`) ?? []).filter((r) => r.hoursAgo * H <= within);
      return {
        names: ['METRIC', 'ARGS', 'VALUE', 'MEASURED'],
        rows: rs.map((r) => [r.metric, r.args, r.value === null ? null : String(r.value), iso(r.hoursAgo * H)]),
      };
    }
    case 'dp-columns': {
      const dbName = unquote(arg(1).split('.INFORMATION_SCHEMA')[0] ?? '');
      const cols = columns.get(`${dbName}.${arg(2)}.${arg(3)}`) ?? [];
      return {
        names: ['COLUMN_NAME', 'DATA_TYPE', 'IS_NULLABLE', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'CHARACTER_MAXIMUM_LENGTH', 'COMMENT'],
        rows: cols.map((c) => [
          c.name,
          c.type,
          c.nullable ? 'YES' : 'NO',
          c.precision === undefined ? null : String(c.precision),
          c.scale === undefined ? null : String(c.scale),
          c.length === undefined ? null : String(c.length),
          null,
        ]),
      };
    }
    default:
      return null;
  }
}
