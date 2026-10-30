import type { Platform } from '@sm/shared';
import { platformRequest } from '../platforms/http.js';

/**
 * The Snowflake SQL API (#115): POST /api/v2/statements with key-pair JWT sign-in (auth type jwt, #114). Values are
 * always passed as bindings (`?`), never written into the SQL. Long statements are polled; results that come in
 * several partitions are read partition by partition.
 *
 * https://docs.snowflake.com/en/developer-guide/sql-api/reference
 */

export type Row = Record<string, string | null>;

interface StatementResult {
  statementHandle?: string;
  message?: string;
  code?: string;
  resultSetMetaData?: { numRows?: number; rowType?: { name: string }[]; partitionInfo?: unknown[] };
  data?: (string | null)[][];
}

const MAX_ROWS = 50_000;
const POLL_MS = 1000;
const MAX_WAIT_MS = 120_000;

export class SnowflakeClient {
  constructor(
    readonly p: Platform,
    private readonly secrets: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: StatementResult }> {
    const r = await platformRequest(
      this.p,
      this.secrets,
      {
        method,
        url: path,
        headers: { accept: 'application/json', 'user-agent': 'Steward' },
        ...(body !== undefined ? { body, bodyType: 'json' as const } : {}),
        maxResponseBytes: 64 * 1024 * 1024,
      },
      this.signal,
    );
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as StatementResult;
    if (r.status >= 400) {
      throw Object.assign(new Error(`Snowflake answered HTTP ${r.status}${b.message ? `: ${b.message}` : ''}${b.code ? ` (${b.code})` : ''}`), {
        status: r.status,
      });
    }
    return { status: r.status, body: b };
  }

  /** Runs one statement and returns its rows as objects (column names as Snowflake reports them, upper case). */
  async query(statement: string, bindings: (string | number)[] = []): Promise<Row[]> {
    const v = this.p.config.variables ?? {};
    let r = await this.call('POST', '/api/v2/statements', {
      statement,
      timeout: 60,
      ...(v.warehouse ? { warehouse: String(v.warehouse) } : {}),
      ...(v.role ? { role: String(v.role) } : {}),
      ...(bindings.length
        ? {
            bindings: Object.fromEntries(
              bindings.map((b, i) => [String(i + 1), typeof b === 'number' ? { type: 'FIXED', value: String(b) } : { type: 'TEXT', value: b }]),
            ),
          }
        : {}),
    });
    // 202: still running – poll the handle
    const started = Date.now();
    while (r.status === 202 && r.body.statementHandle) {
      if (Date.now() - started > MAX_WAIT_MS) throw new Error(`The Snowflake statement did not finish within ${MAX_WAIT_MS / 1000} s`);
      await new Promise((res) => setTimeout(res, POLL_MS));
      r = await this.call('GET', `/api/v2/statements/${encodeURIComponent(r.body.statementHandle)}`);
    }
    const names = (r.body.resultSetMetaData?.rowType ?? []).map((c) => c.name);
    const rows: (string | null)[][] = [...(r.body.data ?? [])];
    const partitions = r.body.resultSetMetaData?.partitionInfo?.length ?? 1;
    for (let i = 1; i < partitions && rows.length < MAX_ROWS; i++) {
      const part = await this.call('GET', `/api/v2/statements/${encodeURIComponent(r.body.statementHandle ?? '')}?partition=${i}`);
      rows.push(...(part.body.data ?? []));
    }
    return rows.slice(0, MAX_ROWS).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null])));
  }
}

/** A Snowflake identifier as the views store it: unquoted names in upper case. */
export const sfName = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s.toUpperCase());

/** ISO time of an ACCOUNT_USAGE timestamp column (the statements convert with TO_VARCHAR(…, ISO)). */
export const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'`;
