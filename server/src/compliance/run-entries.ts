import fs from 'node:fs';
import type { AccessChangeKind } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { runRow } from '../engine/store.js';
import { getReport, generateRunReport, listRunReports } from '../reports/service.js';
import { getProcess } from '../processes/service.js';
import { newId, nowIso, parseJson } from '../util.js';
import { asSystem, createAccessChange, minus, uniqueRights } from './access-changes.js';

/**
 * Automatic access change entries: an "accessChange" step records what a run changed
 * (run_access_changes); when the run has ended and its PDF protocol is archived, Steward creates one
 * documented entry per platform and subject, linked to the run, with the protocol attached.
 */

export interface AccessChangeInput {
  platformId: string;
  subjectId: string;
  subjectName: string;
  kind: AccessChangeKind;
  /** The changed rights (granted or removed, by kind) */
  rights: string[];
  rightsBefore: string[] | null;
  rightsAfter: string[] | null;
  reason: string;
  requestRef: string;
  approvedBy: string;
  performedAt: string;
}

/** Upper limit of entries one run creates (more subjects are merged into the log only). */
export const MAX_ENTRIES_PER_RUN = 500;

export function recordStepAccessChanges(runId: string, stepKey: string, platformId: string, entries: AccessChangeInput[]): void {
  if (!entries.length) return;
  db().tx(() => {
    for (const e of entries) {
      db().run(
        'INSERT INTO run_access_changes (id, run_id, step_key, platform_id, data, record_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
        newId('rac_'),
        runId,
        stepKey,
        platformId,
        JSON.stringify(e),
        nowIso(),
      );
    }
  });
}

/** Rights before/after of one reported change. */
function beforeAfter(e: AccessChangeInput): { before: string[]; after: string[] } {
  const removes = e.kind === 'revoke' || e.kind === 'offboarding';
  let before = e.rightsBefore ? uniqueRights(e.rightsBefore) : null;
  let after = e.rightsAfter ? uniqueRights(e.rightsAfter) : null;
  if (!before) before = removes ? uniqueRights([...(after ?? []), ...e.rights]) : minus(after ?? [], e.rights);
  if (!after) after = removes ? minus(before, e.rights) : uniqueRights([...before, ...e.rights]);
  return { before, after };
}

interface Merged {
  platformId: string;
  subjectId: string;
  subjectName: string;
  kinds: Set<AccessChangeKind>;
  before: string[];
  granted: string[];
  revoked: string[];
  reasons: Set<string>;
  refs: Set<string>;
  approvers: Set<string>;
  performedAt: string;
  rows: string[];
}

/** One entry per platform and subject: the first "before", all grants and removals of the run. */
function merge(rows: { id: string; data: string }[]): Merged[] {
  const out = new Map<string, Merged>();
  for (const row of rows) {
    const e = parseJson<AccessChangeInput | null>(row.data, null);
    if (!e?.subjectId) continue;
    const { before, after } = beforeAfter(e);
    const key = `${e.platformId}|${e.subjectId.toLowerCase()}`;
    let m = out.get(key);
    if (!m) {
      m = {
        platformId: e.platformId,
        subjectId: e.subjectId,
        subjectName: e.subjectName,
        kinds: new Set(),
        before,
        granted: [],
        revoked: [],
        reasons: new Set(),
        refs: new Set(),
        approvers: new Set(),
        performedAt: e.performedAt,
        rows: [],
      };
      out.set(key, m);
    } else m.before = uniqueRights([...m.before, ...minus(before, m.granted)]);
    m.kinds.add(e.kind);
    m.granted = uniqueRights([...minus(m.granted, minus(before, after)), ...minus(after, before)]);
    m.revoked = uniqueRights([...minus(m.revoked, minus(after, before)), ...minus(before, after)]);
    if (e.reason) m.reasons.add(e.reason);
    if (e.requestRef) m.refs.add(e.requestRef);
    if (e.approvedBy) m.approvers.add(e.approvedBy);
    if (e.performedAt > m.performedAt) m.performedAt = e.performedAt;
    if (!m.subjectName && e.subjectName) m.subjectName = e.subjectName;
    m.rows.push(row.id);
  }
  return [...out.values()];
}

/** Who approved in the run (approval tasks), for entries whose step names no approver. */
function runApprovers(runId: string): string[] {
  return db()
    .all<{ decided_by: string | null; decision: string | null }>("SELECT decided_by, decision FROM run_tasks WHERE run_id = ? AND mode = 'approve'", runId)
    .filter((t) => t.decided_by && parseJson<{ approved?: boolean }>(t.decision, {}).approved !== false)
    .map((t) => t.decided_by!);
}

/**
 * Creates the access change entries of a finished run (once; called after the automatic run report).
 * The run's PDF protocol is attached to every entry, so the evidence is frozen with it.
 */
export async function createRunEntries(runId: string, reportId: string | null = null): Promise<string[]> {
  const pending = db().all<{ id: string; data: string }>(
    'SELECT id, data FROM run_access_changes WHERE run_id = ? AND record_id IS NULL ORDER BY created_at, id',
    runId,
  );
  if (!pending.length) return [];
  const run = runRow(runId);
  if (run.dry_run || !['succeeded', 'failed', 'cancelled'].includes(run.status)) return [];
  let report = reportId ? getReport(reportId) : listRunReports(runId)[0] ? getReport(listRunReports(runId)[0]!.id) : null;
  if (!report) {
    let lang: 'en' | 'de' = 'en';
    try {
      lang = getProcess(run.process_id, run.process_version).definition.report?.lang ?? 'en';
    } catch {
      /* process deleted: English */
    }
    const rec = await generateRunReport(runId, { actor: 'system', auto: true, lang });
    report = getReport(rec.id);
  }
  const pdf = fs.readFileSync(report.file);
  const approvers = runApprovers(runId);
  const merged = merge(pending);
  if (merged.length > MAX_ENTRIES_PER_RUN)
    logger.warn({ runId, subjects: merged.length }, `only the first ${MAX_ENTRIES_PER_RUN} access changes of the run are documented`);
  const created: string[] = [];
  for (const m of merged.slice(0, MAX_ENTRIES_PER_RUN)) {
    const after = uniqueRights([...minus(m.before, m.revoked), ...m.granted]);
    const kind: AccessChangeKind = m.kinds.size === 1 ? [...m.kinds][0]! : 'modify';
    const statusNote = run.status === 'succeeded' ? '' : ` The run ended with status ${run.status}; check its protocol.`;
    const entry = asSystem(() =>
      createAccessChange(
        {
          platformId: m.platformId,
          subjectId: m.subjectId,
          subjectName: m.subjectName || undefined,
          kind,
          rightsBefore: m.before,
          rightsAfter: after,
          reason: `${[...m.reasons].join(' / ') || `Changed by the process "${run.process_name}"`}${statusNote}`.slice(0, 4000),
          requestedBy: run.actor,
          requestRef: [...m.refs].join(', ').slice(0, 500) || undefined,
          approvedBy: ([...m.approvers].join(', ') || approvers.join(', ')).slice(0, 200) || undefined,
          performedBy: `${run.actor} (run ${runId})`.slice(0, 200),
          performedAt: m.performedAt,
          origin: 'run',
          runId,
          body: `Documented automatically by run [${runId}](/runs/${runId}) of the process “${run.process_name}”. The run protocol (PDF, SHA-256 ${report!.sha256}) is attached.\n`,
        },
        {
          document: true,
          comment: `Documented automatically when run ${runId} ended`,
          links: [
            { kind: 'run', id: runId, note: 'performed by this run' },
            { kind: 'platform', id: m.platformId, note: 'platform' },
          ],
          attachments: [{ filename: report!.filename, data: pdf }],
        },
      ),
    );
    db().run(`UPDATE run_access_changes SET record_id = ? WHERE id IN (${m.rows.map(() => '?').join(', ')})`, entry.recordId, ...m.rows);
    created.push(entry.recordId);
  }
  if (created.length) logger.info({ runId, entries: created.length }, 'access change entries created for the run');
  return created;
}
