import { DB_DIALECT_INFO, type DbQueryResult, type NodeOf, type Platform } from '@sm/shared';
import { findRecording, missingRecording } from '../platforms/recordings.js';
import { databaseSettings, runQuery } from './service.js';

/**
 * The step "Query a database" (0.7.0, #203, ADR 0008): one read-only statement on the bound database platform. It
 * runs in dry runs too (it only reads); a test run answers with the platform's recorded response POST /sql/<step id>
 * and never connects. What was asked is the step's input (the statement as sent, the parameters), the rows its output
 * – like an HTTP answer, so run reports, evidence and later steps see them.
 */

export interface QueryStepContext {
  platform: Platform;
  secrets: Record<string, string>;
  /** Parameters rendered from their templates */
  params: unknown[];
  dryRun: boolean;
  /** Test run: recorded responses only */
  recorded: boolean;
  setInput: (input: unknown) => void;
  log: (level: 'info' | 'warn', message: string) => void;
  signal: AbortSignal;
}

/** The rows of a recorded response: a list of rows, or { rows: [...] }. */
function recordedResult(body: unknown): DbQueryResult {
  const rows = (Array.isArray(body) ? body : Array.isArray((body as { rows?: unknown })?.rows) ? (body as { rows: unknown[] }).rows : []).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
  );
  const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
  return { columns, rows, rowCount: rows.length, truncated: false, durationMs: 0 };
}

export async function runQueryStep(step: NodeOf<'query'>, ctx: QueryStepContext): Promise<{ output: DbQueryResult; summary: string }> {
  const what = step.catalog ? `catalog query "${step.catalog}"` : 'query';
  const base = {
    platform: ctx.platform.name,
    ...(step.catalog ? { catalog: step.catalog } : { sql: step.sql }),
    params: ctx.params,
    ...(step.dialect ? { dialect: step.dialect } : {}),
  };
  if (ctx.recorded) {
    ctx.setInput({ ...base, testRun: true });
    const path = `/sql/${step.id}`;
    const hit = findRecording(ctx.platform.id, { method: 'POST', url: path, body: { params: ctx.params } });
    if (!hit) throw missingRecording(ctx.platform.name, 'POST', path);
    ctx.log('info', `TEST RUN – recorded response for the ${what} (POST ${path})`);
    const output = recordedResult(hit.result.body);
    return { output, summary: `${what} on "${ctx.platform.name}" → ${output.rowCount} row(s) (recorded)` };
  }
  const s = databaseSettings(ctx.platform);
  ctx.setInput({ ...base, database: `${DB_DIALECT_INFO[s.dialect].label} ${s.host}/${s.database}` });
  if (ctx.dryRun) ctx.log('info', `DRY RUN – the ${what} runs: it only reads, in a transaction that is rolled back`);
  const out = await runQuery(
    ctx.platform,
    ctx.secrets,
    {
      sql: step.sql,
      catalog: step.catalog,
      params: ctx.params,
      dialect: step.dialect,
      limits: { maxRows: step.maxRows, maxMb: step.maxMb, timeoutSeconds: step.timeoutSeconds, onLimit: step.onLimit },
    },
    ctx.signal,
  );
  ctx.setInput({
    ...base,
    database: `${DB_DIALECT_INFO[s.dialect].label} ${out.server.version} ${s.host}/${s.database}`.replace(/\s+/g, ' '),
    statement: out.statement,
    limits: out.limits,
  });
  if (out.result.truncated) ctx.log('warn', `The result was cut at ${out.result.rowCount} row(s) (onLimit: truncate)`);
  return {
    output: out.result,
    summary: `${what} on "${ctx.platform.name}" → ${out.result.rowCount} row(s)${out.result.truncated ? ' (truncated)' : ''} (${out.result.durationMs} ms)`,
  };
}
