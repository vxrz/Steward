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

let refreshes = seedRefreshes();
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
export function resetDataElementMock(): void {
  refreshes = seedRefreshes();
  tasks = seedTasks();
  columns = seedColumns();
}

/** Every statement the checks sent with its bindings, for the allow-list test (metadata only). */
export const dataElementStatements: { sql: string; bindings: string[] }[] = [];

const unquote = (s: string) => s.replaceAll('"', '');

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
  if (!tag.startsWith('dp-')) return null;
  if (dataElementStatements.length < 1000) dataElementStatements.push({ sql, bindings: [1, 2, 3, 4].map(arg).filter(Boolean) });
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
