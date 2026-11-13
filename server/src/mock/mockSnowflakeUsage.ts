/**
 * The usage and storage of the demo Snowflake account (0.21.0) for the example processes "Snowflake – Cost estimate and
 * trend" and "Snowflake – Waste check": SHOW WAREHOUSES and the SELECTs of those templates from
 * SNOWFLAKE.ACCOUNT_USAGE – WAREHOUSE_METERING_HISTORY, METERING_DAILY_HISTORY, DATABASE_STORAGE_USAGE_HISTORY,
 * STORAGE_USAGE, QUERY_ATTRIBUTION_HISTORY, QUERY_HISTORY, WAREHOUSE_LOAD_HISTORY, TABLE_STORAGE_METRICS,
 * ACCESS_HISTORY, TASK_HISTORY, SERVERLESS_TASK_HISTORY, COPY_HISTORY, PIPE_USAGE_HISTORY and the serverless feature
 * histories. Like the rest of the mock it runs no SQL: it recognises a statement by its view and the aliases of its
 * SELECT list and answers from the invented data below, using the bind parameters the templates send.
 *
 * The warehouses are the four of the account hygiene example (#62): their daily credits add up to its 7 and 30 days.
 */

type Cell = string | null;
export type UsageAnswer = { names: string[]; rows: Cell[][] } | { error: string };

const H = 3_600_000;
const DAY = 24 * H;
const TB = 2 ** 40;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+00:00');
const num = (n: number, digits = 9) => n.toFixed(digits);

/** Views a test made unreadable (an edition without them, or a role without the database role that shows them). */
const unavailable = new Set<string>();
/** For tests: views that answer "does not exist or not authorized", e.g. ACCESS_HISTORY of a Standard Edition account. */
export function setSnowflakeUnavailableViews(views: string[]): void {
  unavailable.clear();
  for (const v of views) unavailable.add(v.toUpperCase());
}

/**
 * The warehouses. Daily credits by days ago (1 = yesterday): `recent` for the last 7 days, `month` for days 8–30,
 * `older` before – #62's 7 and 30 days are recent × 7 and that plus month × 23. Metered and active hours, queries and
 * load per day drive the waste check.
 */
interface DemoWarehouse {
  name: string;
  size: string;
  autoSuspend: number | null;
  recent: number;
  month: number;
  older: number;
  /** Share of the credits that are cloud services */
  cloud: number;
  meteredHours: number;
  activeHours: number;
  queries: number;
  shortShare: number;
  spilling: number;
  avgRunning: number | null;
}
const WAREHOUSES: DemoWarehouse[] = [
  // the nightly transformations: busy, long queries that spill – right-sized; grows this month
  {
    name: 'TRANSFORM_WH',
    size: 'Medium',
    autoSuspend: 300,
    recent: 31.25 / 7,
    month: 89.25 / 23,
    older: 2.6,
    cloud: 0.06,
    meteredHours: 1.2,
    activeHours: 1.1,
    queries: 40,
    shortShare: 0.2,
    spilling: 5,
    avgRunning: 1.8,
  },
  // the BI warehouse: large, many short queries, half an hour before it suspends
  {
    name: 'BI_WH',
    size: 'Large',
    autoSuspend: 1800,
    recent: 9.5 / 7,
    month: 30.5 / 23,
    older: 1.3,
    cloud: 0.14,
    meteredHours: 6,
    activeHours: 2,
    queries: 900,
    shortShare: 0.97,
    spilling: 0,
    avgRunning: 0.3,
  },
  // nobody uses it any more, but it still resumes now and then
  {
    name: 'UNUSED_WH',
    size: 'X-Small',
    autoSuspend: 600,
    recent: 0,
    month: 3 / 23,
    older: 0.2,
    cloud: 0,
    meteredHours: 0.1,
    activeHours: 0,
    queries: 0,
    shortShare: 0,
    spilling: 0,
    avgRunning: null,
  },
  // the Power BI gateway's warehouse: auto-suspend switched off, short queries
  {
    name: 'PBI_WH',
    size: 'Small',
    autoSuspend: null,
    recent: 6.5 / 7,
    month: 12.25 / 23,
    older: 0.5,
    cloud: 0.05,
    meteredHours: 4,
    activeHours: 1,
    queries: 300,
    shortShare: 0.99,
    spilling: 0,
    avgRunning: 0.2,
  },
];
/** Steward's own warehouse (docs/SNOWFLAKE.md): listed by SHOW WAREHOUSES, no credits worth naming */
const STEWARD_WH = { name: 'STEWARD_WH', size: 'X-Small', autoSuspend: 60 };

const whCredits = (w: DemoWarehouse, daysAgo: number) => (daysAgo < 1 ? 0 : daysAgo <= 7 ? w.recent : daysAgo <= 30 ? w.month : w.older);

/** Serverless credits per day of METERING_DAILY_HISTORY's other service types (the objects below spend them) */
const SERVERLESS: Record<string, number> = {
  SERVERLESS_TASK: 0.3,
  PIPE: 0.45,
  AUTO_CLUSTERING: 1.6,
  MATERIALIZED_VIEW: 0.35,
  SEARCH_OPTIMIZATION: 0.5,
};
/** Cloud services outside the warehouses (metadata, logins) per day */
const OTHER_CLOUD = 0.3;

function serviceDay(type: string, daysAgo: number): { compute: number; cloud: number; adjustment: number; billed: number } {
  if (daysAgo < 1) return { compute: 0, cloud: 0, adjustment: 0, billed: 0 };
  if (type === 'WAREHOUSE_METERING') {
    let compute = 0;
    let cloud = OTHER_CLOUD;
    for (const w of WAREHOUSES) {
      const c = whCredits(w, daysAgo);
      compute += c * (1 - w.cloud);
      cloud += c * w.cloud;
    }
    // cloud services are free up to 10 % of the day's compute
    const adjustment = -Math.min(cloud, compute * 0.1);
    return { compute, cloud, adjustment, billed: compute + cloud + adjustment };
  }
  const c = SERVERLESS[type] ?? 0;
  return { compute: c, cloud: 0, adjustment: 0, billed: c };
}

/** Databases (bytes in TB, shrinking a little into the past) and the stages */
const DATABASES = [
  { name: 'SHOP', tb: 2.4, failsafe: 0.3 },
  { name: 'CRM', tb: 0.35, failsafe: 0.02 },
  { name: 'PRD_SDC_OPQ_PBI_DEV', tb: 0.8, failsafe: 0.1 },
];
const STAGE_TB = 0.15;
const grown = (tb: number, daysAgo: number) => tb * TB * (1 - daysAgo * 0.002);

/** Who spends the warehouses' query credits (QUERY_ATTRIBUTION_HISTORY): a share of a warehouse's compute */
const ATTRIBUTION = [
  { tag: 'dbt_nightly', user: 'ETL_SVC', warehouse: 'TRANSFORM_WH', share: 0.55, queries: 35 },
  { tag: 'powerbi', user: 'SVC_PBI_GATEWAY', warehouse: 'PBI_WH', share: 0.6, queries: 250 },
  { tag: 'powerbi', user: 'SVC_PBI_ETL', warehouse: 'PBI_WH', share: 0.2, queries: 40 },
  { tag: '', user: 'ALICE', warehouse: 'BI_WH', share: 0.3, queries: 600 },
  { tag: 'adhoc', user: 'Z007QRST', warehouse: 'BI_WH', share: 0.2, queries: 250 },
];

/** Tables (TABLE_STORAGE_METRICS) with the days since a query last read them (null: not within a year) */
const TABLES = [
  { db: 'SHOP', schema: 'SALES', name: 'ORDERS', active: 0.4, timeTravel: 0.02, failsafe: 0.05, transient: false, createdDays: 400, readDays: 0.1 },
  { db: 'SHOP', schema: 'STAGING', name: 'RAW_EVENTS', active: 1.2, timeTravel: 0.9, failsafe: 0.6, transient: false, createdDays: 600, readDays: 1 },
  { db: 'SHOP', schema: 'STAGING', name: 'RAW_EVENTS_2024', active: 0.45, timeTravel: 0, failsafe: 0.03, transient: false, createdDays: 500, readDays: null },
  { db: 'SHOP', schema: 'REPORTING', name: 'ORDER_FACTS', active: 0.25, timeTravel: 0.01, failsafe: 0.02, transient: false, createdDays: 300, readDays: 3 },
  { db: 'CRM', schema: 'CORE', name: 'CONTACTS', active: 0.01, timeTravel: 0, failsafe: 0.001, transient: false, createdDays: 900, readDays: 0.5 },
  { db: 'CRM', schema: 'CORE', name: 'CONTACTS_BACKUP_2025', active: 0.08, timeTravel: 0, failsafe: 0.004, transient: false, createdDays: 200, readDays: 140 },
  {
    db: 'PRD_SDC_OPQ_PBI_DEV',
    schema: 'REPORTING',
    name: 'SALES_CUBE',
    active: 0.3,
    timeTravel: 0.01,
    failsafe: 0.02,
    transient: true,
    createdDays: 120,
    readDays: 1,
  },
];
/** Objects with a serverless feature, its credits per day and the queries reading them per day */
const FEATURES = [
  { feature: 'clustering', db: 'SHOP', schema: 'REPORTING', name: 'ORDER_FACTS', credits: SERVERLESS.AUTO_CLUSTERING!, readsPerDay: 2 / 30 },
  { feature: 'materialised view', db: 'SHOP', schema: 'REPORTING', name: 'DAILY_REVENUE_MV', credits: SERVERLESS.MATERIALIZED_VIEW!, readsPerDay: 0 },
  { feature: 'search optimisation', db: 'SHOP', schema: 'SALES', name: 'ORDERS', credits: SERVERLESS.SEARCH_OPTIMIZATION!, readsPerDay: 130 },
];
/** Tasks: runs and failures per day; serverless credits per day (0: runs on a warehouse) */
const TASKS = [
  {
    db: 'SHOP',
    schema: 'STAGING',
    name: 'LOAD_EVENTS',
    runs: 24,
    failures: 24,
    credits: SERVERLESS.SERVERLESS_TASK!,
    error: "SQL compilation error: Object 'SHOP.STAGING.EVENTS_EXT' does not exist",
  },
  {
    db: 'CRM',
    schema: 'CORE',
    name: 'SYNC_CONTACTS',
    runs: 24,
    failures: 2,
    credits: 0,
    error: 'Statement reached its statement or warehouse timeout of 600 second(s)',
  },
  { db: 'SHOP', schema: 'SALES', name: 'REFRESH_TOTALS', runs: 4, failures: 0, credits: 0, error: '' },
];
/** Snowpipes: files and failed files per day, credits per day */
const PIPES = [
  {
    db: 'SHOP',
    schema: 'STAGING',
    name: 'EVENTS_PIPE',
    files: 1200,
    failed: 300,
    credits: SERVERLESS.PIPE!,
    error: "Field delimiter ',' found while expecting record delimiter '\\n'",
  },
  { db: 'CRM', schema: 'CORE', name: 'CONTACTS_PIPE', files: 50, failed: 0, credits: 0, error: '' },
];
/** Queries that ran long and then failed or were cancelled, per 30 days */
const LONG_FAILED = [
  { user: 'Z004EFGH', warehouse: 'BI_WH', size: 'Large', queries: 6, cancelled: 4, hours: 3.5, error: 'SQL execution canceled' },
  {
    user: 'ETL_SVC',
    warehouse: 'TRANSFORM_WH',
    size: 'Medium',
    queries: 3,
    cancelled: 0,
    hours: 1.2,
    error: 'Max LOB size (16777216) exceeded, actual size of parsed column is 17894012.',
  },
];

// ---------- the periods of the cost estimate ----------

const dayStart = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const todayStart = () => dayStart(new Date().toISOString());

/**
 * The days of the cost estimate's bind parameters: 1 the month's first day, 2 today, 3 the first day of the run rate,
 * 4 the previous month's first day, 5 the first day read. A sum over [from, to) adds the value of every day.
 */
function periods(arg: (i: number) => string) {
  const [month, today, rate, prev, from] = [1, 2, 3, 4, 5].map((i) => dayStart(arg(i)));
  const ok = [month, today, rate, prev, from].every((x) => Number.isFinite(x));
  const now = todayStart();
  const sum = (fn: (daysAgo: number) => number, a: number, b: number) => {
    let s = 0;
    for (let t = Math.max(a, from!); t < Math.min(b, today!); t += DAY) s += fn(Math.round((now - t) / DAY));
    return s;
  };
  const count = (a: number, b: number) => Math.max(0, Math.round((Math.min(b, today!) - Math.max(a, from!)) / DAY));
  return ok ? { month: month!, today: today!, rate: rate!, prev: prev!, sum, count } : null;
}

const rowsOf = (names: string[], objects: Record<string, string | number | null>[]): Cell[][] =>
  objects.map((o) => names.map((c) => (o[c] === undefined || o[c] === null ? null : String(o[c]))));

/** Days back from a binding like "-30" */
const back = (v: string, dflt = 30) => Math.min(400, Math.abs(Number(v)) || dflt);

/** SHOW WAREHOUSES, as the SQL API answers it: lower-case column names, auto_suspend empty when it is off */
export function showWarehouses(): { names: string[]; rows: Cell[][] } {
  const names = ['name', 'state', 'type', 'size', 'min_cluster_count', 'max_cluster_count', 'auto_suspend', 'auto_resume', 'owner', 'comment'];
  const all = [...WAREHOUSES, { ...STEWARD_WH }];
  return {
    names,
    rows: all.map((w) => [w.name, 'SUSPENDED', 'STANDARD', w.size, '1', '1', w.autoSuspend === null ? null : String(w.autoSuspend), 'true', 'SYSADMIN', '']),
  };
}

/** The answer to a SELECT of the cost estimate or the waste check; null: not one of theirs. */
export function usageAnswer(sql: string, view: string | undefined, names: string[], arg: (i: number) => string): UsageAnswer | null {
  for (const m of sql.matchAll(/ACCOUNT_USAGE\.([A-Z_]+)/gi)) {
    const v = m[1]!.toUpperCase();
    if (unavailable.has(v)) return { error: `SQL compilation error:\nObject 'SNOWFLAKE.ACCOUNT_USAGE.${v}' does not exist or not authorized.` };
  }
  const has = (c: string) => names.includes(c);
  switch (view) {
    case 'WAREHOUSE_METERING_HISTORY': {
      if (has('MTD_CREDITS')) {
        const p = periods(arg);
        if (!p) return { error: 'SQL compilation error: invalid date' };
        return {
          names,
          rows: rowsOf(
            names,
            WAREHOUSES.map((w) => {
              const c = (d: number) => whCredits(w, d);
              return {
                WAREHOUSE_NAME: w.name,
                MTD_COMPUTE: num(p.sum((d) => c(d) * (1 - w.cloud), p.month, p.today)),
                MTD_CLOUD: num(p.sum((d) => c(d) * w.cloud, p.month, p.today)),
                MTD_CREDITS: num(p.sum(c, p.month, p.today)),
                RATE_CREDITS: num(p.sum(c, p.rate, p.today)),
                PREV_CREDITS: num(p.sum(c, p.prev, p.month)),
              };
            }).filter((r) => Number(r.MTD_CREDITS) + Number(r.RATE_CREDITS) + Number(r.PREV_CREDITS) > 0),
          ),
        };
      }
      if (has('METERED_HOURS')) {
        const days = back(arg(1));
        return {
          names,
          rows: rowsOf(
            names,
            WAREHOUSES.map((w) => {
              let credits = 0;
              for (let d = 1; d <= days; d++) credits += whCredits(w, d);
              return { WAREHOUSE_NAME: w.name, CREDITS: num(credits), METERED_HOURS: String(Math.round(w.meteredHours * days)) };
            }),
          ),
        };
      }
      return null;
    }
    case 'METERING_DAILY_HISTORY': {
      const p = periods(arg);
      if (!p || !has('MTD_BILLED')) return null;
      return {
        names,
        rows: rowsOf(
          names,
          ['WAREHOUSE_METERING', ...Object.keys(SERVERLESS)].map((type) => {
            const f = (k: 'compute' | 'cloud' | 'adjustment' | 'billed') => (d: number) => serviceDay(type, d)[k];
            return {
              SERVICE_TYPE: type,
              MTD_COMPUTE: num(p.sum(f('compute'), p.month, p.today)),
              MTD_CLOUD: num(p.sum(f('cloud'), p.month, p.today)),
              MTD_ADJUSTMENT: num(p.sum(f('adjustment'), p.month, p.today)),
              MTD_BILLED: num(p.sum(f('billed'), p.month, p.today)),
              RATE_BILLED: num(p.sum(f('billed'), p.rate, p.today)),
              PREV_BILLED: num(p.sum(f('billed'), p.prev, p.month)),
            };
          }),
        ),
      };
    }
    case 'DATABASE_STORAGE_USAGE_HISTORY':
    case 'STORAGE_USAGE': {
      const p = periods(arg);
      if (!p || !has('MTD_BYTE_DAYS')) return null;
      const objects = view === 'STORAGE_USAGE' ? [{ name: '(stages)', tb: STAGE_TB, failsafe: 0 }] : DATABASES;
      return {
        names,
        rows: rowsOf(
          names,
          objects.map((o) => {
            const bytes = (d: number) => grown(o.tb, d) + grown(o.failsafe, d);
            return {
              DATABASE_NAME: o.name,
              LATEST_BYTES: Math.round(grown(o.tb, 1)),
              LATEST_FAILSAFE_BYTES: Math.round(grown(o.failsafe, 1)),
              MTD_BYTE_DAYS: Math.round(p.sum(bytes, p.month, p.today)),
              MTD_DAYS: p.count(p.month, p.today),
              PREV_BYTE_DAYS: Math.round(p.sum(bytes, p.prev, p.month)),
            };
          }),
        ),
      };
    }
    case 'QUERY_ATTRIBUTION_HISTORY': {
      const p = periods(arg);
      if (!p || !has('MTD_CREDITS')) return null;
      return {
        names,
        rows: rowsOf(
          names,
          ATTRIBUTION.map((a) => {
            const w = WAREHOUSES.find((x) => x.name === a.warehouse)!;
            const c = (d: number) => whCredits(w, d) * (1 - w.cloud) * a.share;
            return {
              QUERY_TAG: a.tag || '(no tag)',
              USER_NAME: a.user,
              QUERIES: a.queries * p.count(p.month, p.today),
              MTD_CREDITS: num(p.sum(c, p.month, p.today)),
              RATE_CREDITS: num(p.sum(c, p.rate, p.today)),
              PREV_CREDITS: num(p.sum(c, p.prev, p.month)),
            };
          }).sort((x, y) => Number(y.MTD_CREDITS) - Number(x.MTD_CREDITS)),
        ),
      };
    }
    case 'QUERY_HISTORY': {
      if (has('SHORT_QUERIES')) {
        const days = back(arg(2));
        return {
          names,
          rows: rowsOf(
            names,
            WAREHOUSES.filter((w) => w.queries > 0).map((w) => ({
              WAREHOUSE_NAME: w.name,
              QUERIES: w.queries * days,
              SHORT_QUERIES: Math.round(w.queries * w.shortShare * days),
              SPILLING_QUERIES: w.spilling * days,
              QUEUED_QUERIES: 0,
              ACTIVE_HOURS: Math.round(w.activeHours * days),
            })),
          ),
        };
      }
      if (has('ELAPSED_HOURS')) {
        const f = back(arg(2)) / 30;
        return {
          names,
          rows: rowsOf(
            names,
            LONG_FAILED.map((q) => ({
              USER_NAME: q.user,
              WAREHOUSE_NAME: q.warehouse,
              WAREHOUSE_SIZE: q.size,
              QUERIES: Math.round(q.queries * f),
              CANCELLED: Math.round(q.cancelled * f),
              ELAPSED_HOURS: num(q.hours * f, 3),
              LAST_ERROR: q.error,
            })),
          ),
        };
      }
      return null;
    }
    case 'WAREHOUSE_LOAD_HISTORY':
      return {
        names,
        rows: rowsOf(
          names,
          WAREHOUSES.filter((w) => w.avgRunning !== null).map((w) => ({ WAREHOUSE_NAME: w.name, AVG_RUNNING: num(w.avgRunning!, 3), AVG_QUEUED: '0.000' })),
        ),
      };
    case 'TABLE_STORAGE_METRICS': {
      const minBytes = Number(arg(1)) || 0;
      const bytes = (tb: number) => Math.round(tb * TB);
      if (/ACCESS_HISTORY/i.test(sql)) {
        // tables created before the window and not read within it
        const days = back(arg(2), 90);
        return {
          names,
          rows: rowsOf(
            names,
            TABLES.filter((t) => t.active * TB >= minBytes && t.createdDays > days && (t.readDays === null || t.readDays > days))
              .sort((a, b) => b.active - a.active)
              .map((t) => ({
                TABLE_CATALOG: t.db,
                TABLE_SCHEMA: t.schema,
                TABLE_NAME: t.name,
                ACTIVE_BYTES: bytes(t.active),
                TIME_TRAVEL_BYTES: bytes(t.timeTravel),
                FAILSAFE_BYTES: bytes(t.failsafe),
                TABLE_CREATED: iso(t.createdDays * DAY),
              })),
          ),
        };
      }
      return {
        names,
        rows: rowsOf(
          names,
          TABLES.filter((t) => (t.timeTravel + t.failsafe) * TB >= minBytes)
            .sort((a, b) => b.timeTravel + b.failsafe - (a.timeTravel + a.failsafe))
            .map((t) => ({
              TABLE_CATALOG: t.db,
              TABLE_SCHEMA: t.schema,
              TABLE_NAME: t.name,
              ACTIVE_BYTES: bytes(t.active),
              TIME_TRAVEL_BYTES: bytes(t.timeTravel),
              FAILSAFE_BYTES: bytes(t.failsafe),
              IS_TRANSIENT: t.transient ? 'YES' : 'NO',
            })),
        ),
      };
    }
    case 'ACCESS_HISTORY': {
      if (has('ACCESS_ROWS')) return { names, rows: [names.map(() => '48211')] };
      if (has('READS')) {
        const days = back(arg(1));
        const wanted = new Set(arg(2).split(','));
        return {
          names,
          rows: rowsOf(
            names,
            FEATURES.map((f) => ({ OBJECT_NAME: `${f.db}.${f.schema}.${f.name}`, READS: Math.round(f.readsPerDay * days) })).filter(
              (r) => wanted.has(r.OBJECT_NAME) && r.READS > 0,
            ),
          ),
        };
      }
      return null;
    }
    case 'TASK_HISTORY': {
      if (!has('RUNS')) return null;
      const days = back(arg(1));
      const min = Number(arg(2)) || 1;
      return {
        names,
        rows: rowsOf(
          names,
          TASKS.filter((t) => t.failures * days >= min).map((t) => ({
            DATABASE_NAME: t.db,
            SCHEMA_NAME: t.schema,
            NAME: t.name,
            RUNS: t.runs * days,
            FAILURES: t.failures * days,
            LAST_ERROR: t.error,
          })),
        ),
      };
    }
    case 'SERVERLESS_TASK_HISTORY': {
      const days = back(arg(1));
      return {
        names,
        rows: rowsOf(
          names,
          TASKS.filter((t) => t.credits > 0).map((t) => ({ DATABASE_NAME: t.db, SCHEMA_NAME: t.schema, TASK_NAME: t.name, CREDITS: num(t.credits * days) })),
        ),
      };
    }
    case 'COPY_HISTORY': {
      const days = back(arg(1));
      const min = Number(arg(2)) || 1;
      return {
        names,
        rows: rowsOf(
          names,
          PIPES.filter((p) => p.failed * days >= min).map((p) => ({
            PIPE_CATALOG_NAME: p.db,
            PIPE_SCHEMA_NAME: p.schema,
            PIPE_NAME: p.name,
            FILES: p.files * days,
            FAILED_FILES: p.failed * days,
            LAST_ERROR: p.error,
          })),
        ),
      };
    }
    case 'PIPE_USAGE_HISTORY': {
      const days = back(arg(1));
      return {
        names,
        rows: rowsOf(
          names,
          PIPES.filter((p) => p.credits > 0).map((p) => ({ PIPE_NAME: p.name, CREDITS: num(p.credits * days) })),
        ),
      };
    }
    case 'AUTOMATIC_CLUSTERING_HISTORY': {
      if (!has('FEATURE')) return null;
      const days = back(arg(1));
      return {
        names,
        rows: rowsOf(
          names,
          FEATURES.map((f) => ({ FEATURE: f.feature, DATABASE_NAME: f.db, SCHEMA_NAME: f.schema, TABLE_NAME: f.name, CREDITS: num(f.credits * days) })),
        ),
      };
    }
    default:
      return null;
  }
}
