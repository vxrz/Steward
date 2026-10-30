/** Snowflake (#115): what Steward reads for a database component, from the ACCOUNT_USAGE views. */

export const SNOWFLAKE_KIND = 'snowflake';

export const SNOWFLAKE_LIMITS = {
  /** A database component is read again after this many hours (or on "Read now") */
  refreshHours: 6,
  /** Tables per database in the readout at most (the stalest and largest first) */
  tables: 500,
  /** Failing tasks are looked for in this many hours */
  taskHours: 24,
  /** Credits per warehouse over this many days */
  creditDays: 30,
} as const;

/** A database, schema or table name as Snowflake shows it (unquoted: letters, digits, _ and $). */
export const SNOWFLAKE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
/** An access review scope: empty (roles of users), DATABASE, DATABASE.SCHEMA or DATABASE.SCHEMA.TABLE */
export const SNOWFLAKE_SCOPE_RE = /^([A-Za-z_][A-Za-z0-9_$]{0,254})(\.[A-Za-z_][A-Za-z0-9_$]{0,254}){0,2}$/;

export interface SnowflakeTable {
  schema: string;
  name: string;
  /** BASE TABLE, VIEW, MATERIALIZED VIEW … */
  type: string;
  rows: number | null;
  bytes: number | null;
  lastAltered: string | null;
}

export interface SnowflakeTaskFailure {
  schema: string;
  name: string;
  scheduledAt: string;
  error: string;
}

export interface SnowflakeWarehouseCredits {
  warehouse: string;
  /** Credits over SNOWFLAKE_LIMITS.creditDays days */
  credits: number;
  /** Credits over the last 7 days */
  credits7d: number;
}

/** What Steward read for an application component of type "Snowflake database". */
export interface SnowflakeReadout {
  readAt: string;
  error: string | null;
  account: string | null;
  database: string;
  tables: SnowflakeTable[];
  tableCount: number;
  bytes: number;
  failedTasks: SnowflakeTaskFailure[];
  /** Warehouses that ran queries on this database in the last 30 days, with their credits */
  warehouses: SnowflakeWarehouseCredits[];
}
