import type { RunStats, RunStatus } from '@sm/shared';
import { db } from '../db.js';
import { sealedProtocolHash } from '../audit.js';
import { parseJson } from '../util.js';
import { LIMITS, person, type Person, type ReportContext } from './model.js';

/** Periodic summary ("Access reviews Q3"): runs of one or more processes in a period, with totals. */
export interface SummaryReportModel extends ReportContext {
  kind: 'summary';
  title: string | null;
  from: string;
  to: string;
  processes: { id: string; name: string }[];
  totals: Totals;
  byProcess: ({ id: string; name: string } & Totals)[];
  runs: {
    id: string;
    processName: string;
    status: RunStatus;
    dryRun: boolean;
    actor: Person;
    startedAt: string;
    finishedAt: string | null;
    decisions: number;
    changes: number;
    checksFailed: number;
    protocolHash: string | null;
  }[];
  runsOmitted: number;
}

export interface Totals {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  open: number;
  dryRuns: number;
  decisions: number;
  changes: number;
  checksFailed: number;
}

const zero = (): Totals => ({ runs: 0, succeeded: 0, failed: 0, cancelled: 0, open: 0, dryRuns: 0, decisions: 0, changes: 0, checksFailed: 0 });

export function buildSummaryModel(o: { processIds: string[]; from: string; to: string; title?: string | null }, ctx: ReportContext): SummaryReportModel {
  const ids = [...new Set(o.processIds)];
  const marks = ids.map(() => '?').join(',');
  const rows = db().all<{
    id: string;
    process_id: string;
    process_name: string;
    status: RunStatus;
    dry_run: number;
    actor: string;
    started_at: string;
    finished_at: string | null;
    stats: string;
    decisions: number;
    protocol_hash: string | null;
  }>(
    `SELECT r.id, r.process_id, r.process_name, r.status, r.dry_run, r.actor, r.started_at, r.finished_at, r.stats,
       (SELECT COUNT(*) FROM run_tasks t WHERE t.run_id = r.id AND t.status = 'completed') AS decisions,
       NULL AS protocol_hash
     FROM runs r WHERE r.process_id IN (${marks}) AND r.debug IS NULL AND r.started_at >= ? AND r.started_at < ? ORDER BY r.started_at, r.rowid`,
    ...ids,
    o.from,
    o.to,
  );
  const names = new Map(
    db()
      .all<{ id: string; name: string }>(`SELECT id, name FROM processes WHERE id IN (${marks})`, ...ids)
      .map((p) => [p.id, p.name]),
  );
  for (const r of rows) if (!names.has(r.process_id)) names.set(r.process_id, r.process_name);
  const processes = ids.map((id) => ({ id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));

  const totals = zero();
  const per = new Map(processes.map((p) => [p.id, { ...p, ...zero() }]));
  const add = (tt: Totals, r: (typeof rows)[number], s: RunStats) => {
    tt.runs++;
    if (r.status === 'succeeded') tt.succeeded++;
    else if (r.status === 'failed') tt.failed++;
    else if (r.status === 'cancelled') tt.cancelled++;
    else tt.open++;
    if (r.dry_run) tt.dryRuns++;
    tt.decisions += r.decisions;
    tt.changes += s.writes ?? 0;
    tt.checksFailed += s.checksFailed ?? 0;
  };
  const runs = rows.map((r) => {
    const s = parseJson<Partial<RunStats>>(r.stats, {}) as RunStats;
    add(totals, r, s);
    add(per.get(r.process_id)!, r, s);
    return {
      id: r.id,
      processName: names.get(r.process_id) ?? r.process_name,
      status: r.status,
      dryRun: !!r.dry_run,
      actor: person(r.actor),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      decisions: r.decisions,
      changes: s.writes ?? 0,
      checksFailed: s.checksFailed ?? 0,
      // only from an authentic audit entry (HMAC and chain position checked)
      protocolHash: sealedProtocolHash(r.id),
    };
  });
  return {
    ...ctx,
    kind: 'summary',
    title: o.title?.trim() || null,
    from: o.from,
    to: o.to,
    processes,
    totals,
    byProcess: [...per.values()],
    runs: runs.slice(0, LIMITS.summaryRuns),
    runsOmitted: Math.max(0, runs.length - LIMITS.summaryRuns),
  };
}
