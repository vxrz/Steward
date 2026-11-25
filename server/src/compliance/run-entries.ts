import fs from 'node:fs';
import type { AccessChangeKind, AccessChangeLinkKind, AccessSubjectType } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { addLog, runRow } from '../engine/store.js';
import { getReport, generateRunReport, listRunReports } from '../reports/service.js';
import { getProcess } from '../processes/service.js';
import { newId, nowIso, parseJson } from '../util.js';
import { MAX_LINKS_PER_ITEM, targetVisible } from '../records/links.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
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
  /** Missing: a user (as before groups existed) */
  subjectType?: AccessSubjectType;
  /** Ids of the items the change is for (checked when the step ran) */
  services?: string[];
  applications?: string[];
  systems?: string[];
  /** The changed rights (granted or removed, by kind) */
  rights: string[];
  rightsBefore: string[] | null;
  rightsAfter: string[] | null;
  reason: string;
  requestRef: string;
  approvedBy: string;
  performedAt: string;
}

/** A reader without roles and teams: sees no catalogue item at all. */
const NOBODY: AuthUser = { id: '', username: '', displayName: '', roles: [], teams: [] };

/**
 * Whose rights decide what a run may link: the person behind the run (its actor; schedules and webhook triggers run as
 * their owner), or, when the actor is no active user (system, deactivated), the author of the run's pinned process version.
 * Null: nobody is left – then no item is linked.
 */
export function linkActor(runId: string): AuthUser | null {
  const run = runRow(runId);
  const active = (name: string | null | undefined) => {
    const u = name ? findUserByName(name) : undefined;
    return u?.active ? toAuthUser(u) : null;
  };
  const author = db().get<{ author: string }>('SELECT author FROM process_versions WHERE process_id = ? AND version = ?', run.process_id, run.process_version);
  return active(run.actor) ?? active(author?.author);
}

/** The ids of one kind the run's actor (see linkActor) may see, and those that are unknown or invisible (for the step's warning). */
export function visibleLinkIds(kind: AccessChangeLinkKind, ids: string[], actor: AuthUser | null): { visible: string[]; skipped: string[] } {
  const visible: string[] = [];
  const skipped: string[] = [];
  // without any person nothing is linked: an unattended run never widens what a team limits
  const seen = (id: string) => (actor ? runAs(actor, () => targetVisible(kind, id)) : runAs(NOBODY, () => targetVisible(kind, id)));
  for (const id of ids) (seen(id) ? visible : skipped).push(id);
  return { visible, skipped };
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
  subjectType: AccessSubjectType | undefined;
  items: Record<AccessChangeLinkKind, Set<string>>;
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
    const subjectType = e.subjectType;
    const key = `${e.platformId}|${subjectType ?? 'user'}|${e.subjectId.toLowerCase()}`;
    let m = out.get(key);
    if (!m) {
      m = {
        platformId: e.platformId,
        subjectId: e.subjectId,
        subjectName: e.subjectName,
        subjectType,
        items: { service: new Set(), application: new Set(), system: new Set() },
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
    for (const id of e.services ?? []) m.items.service.add(id);
    for (const id of e.applications ?? []) m.items.application.add(id);
    for (const id of e.systems ?? []) m.items.system.add(id);
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
    // run and platform come first; links of several steps may exceed the limit of an item: the rest is dropped and logged
    const itemLinks = (['service', 'application', 'system'] as const).flatMap((kind) => [...m.items[kind]].map((id) => ({ kind, id, note: 'for' })));
    const room = Math.max(0, MAX_LINKS_PER_ITEM - 2);
    if (itemLinks.length > room)
      addLog(
        runId,
        'warn',
        `${itemLinks.length - room} link(s) of the access change for "${m.subjectId}" were dropped: an entry has at most ${MAX_LINKS_PER_ITEM} links`,
      );
    const entry = asSystem(() =>
      createAccessChange(
        {
          platformId: m.platformId,
          subjectId: m.subjectId,
          subjectName: m.subjectName || undefined,
          subjectType: m.subjectType,
          kind,
          rightsBefore: m.before,
          rightsAfter: after,
          reason: `${[...m.reasons].join(' / ') || `Changed by the process "${run.process_name}"`}${statusNote}`.slice(0, 4000),
          requestedBy: run.actor,
          requestRef: [...m.refs].join(', ').slice(0, 500) || undefined,
          approvedBy: ([...m.approvers].join(', ') || approvers.join(', ')).slice(0, 200) || undefined,
          // the person who started the run (the run is in runId): four-eyes compares it with the verifier
          performedBy: (run.actor || 'system').slice(0, 200),
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
            // the entry is created as the system user: a link to an item that is gone since is left out by createAccessChange
            ...itemLinks.slice(0, room),
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
