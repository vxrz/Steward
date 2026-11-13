/**
 * Who reads the demo Snowflake account's objects (0.24.0, ADR 0036 phase 2 – declared against actual consumers): the
 * answer of `/* steward:dp-access-history *\/`, the aggregated SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY read of a port's
 * objects (dataproducts/consumers-actual.ts). Invented users and roles; like the rest of the mock it runs no SQL: it
 * takes the bound JSON arrays of object names and prefixes and answers from the rows below.
 */

type Cell = string | null;

export interface MockAccessRead {
  object: string;
  user: string;
  role: string;
  reads: number;
  /** Hours since the last read */
  hoursAgo: number;
}

const DEFAULT_READS: MockAccessRead[] = [
  { object: 'SHOP.CURATED.ORDERS', user: 'ANNA.ANALYST@INVENTED.EXAMPLE', role: 'REPORTING', reads: 214, hoursAgo: 5 },
  { object: 'SHOP.CURATED.ORDERS', user: 'SVC_FINANCE', role: 'FINANCE_ETL', reads: 60, hoursAgo: 20 },
  { object: 'SHOP.MART.SALES_DAILY', user: 'SVC_BI', role: 'BI_READER', reads: 720, hoursAgo: 1 },
  { object: 'SHOP.SALES.CUSTOMERS', user: 'SVC_CRM_SYNC', role: 'CRM_ROLE', reads: 30, hoursAgo: 3 },
];

let reads: MockAccessRead[] = [...DEFAULT_READS];
let available = true;

/** For tests: the reads ACCESS_HISTORY answers with (none: the demo's). */
export function setMockAccessHistory(rows: MockAccessRead[] | null): void {
  reads = rows ? [...rows] : [...DEFAULT_READS];
}

/** For tests: an account whose edition (Standard) or role cannot read ACCESS_HISTORY. */
export function setMockAccessHistoryAvailable(on: boolean): void {
  available = on;
}

const list = (v: string): string[] => {
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

/** The answer of a tag the data consumers read sends; null: not this tag. */
export function dataConsumerAnswer(tag: string, bindings: string[]): { names: string[]; rows: Cell[][] } | { error: string } | null {
  if (tag !== 'dp-access-history') return null;
  if (!available)
    return { error: "SQL compilation error:\nObject 'SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY' does not exist or not authorized." };
  const names = new Set(list(bindings[2] ?? '[]'));
  const prefixes = list(bindings[3] ?? '[]');
  const limit = Number(bindings[4]) || 1000;
  const now = Date.now();
  const rows = reads
    .filter((r) => names.has(r.object) || prefixes.some((p) => r.object.startsWith(p)))
    .sort((a, b) => b.reads - a.reads)
    .slice(0, limit)
    .map((r): Cell[] => [r.object, r.user, r.role, String(r.reads), new Date(now - r.hoursAgo * 3_600_000).toISOString().replace('Z', '+00:00')]);
  return { names: ['OBJECT_NAME', 'USER_NAME', 'ROLE_NAME', 'READS', 'LAST_READ'], rows };
}
