import { z } from 'zod';
import {
  INCIDENT_TYPE_ID,
  MEASURE_LIMITS,
  TIMELINE_LIMITS,
  isTicketOpen,
  type AclEntry,
  type OpenMeasure,
  type ProcessPermission,
  type RecordMeasure,
  type RecordMeasures,
  type TimelineCandidate,
  type TimelineCandidates,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, queryAudit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { capabilities, matches, processPermissions } from '../auth/permissions.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { getUser } from '../auth/users.js';
import { formatDateTime, resolveLocale, t, type MessageKey } from '../i18n/index.js';
import { getSettings } from '../settings.js';
import { monitorVisibility } from '../monitors/redact.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { instanceTimeZone, localDate } from '../duties/periods.js';
import { canReadRecordRow, me } from './access.js';
import { createRecord, getRecord, updateRecord } from './service.js';
import { addLink } from './links.js';
import { ticketVisible } from '../tickets/service.js';

/**
 * Incident reviews (#109): the measures of a review (owners, due dates, reminders, overdue on the service page), the
 * timeline candidates of a time window (what the author may see: monitor changes, failed runs, ticket events and –
 * for administrators and auditors – audit entries), copying chosen ones into the text, and starting a review from a
 * closed ticket reference or a monitor outage.
 */

const DAY = 86_400_000;
const subject = z
  .string()
  .trim()
  .regex(/^(user|team):[^\s:].{0,119}$/i)
  .transform((s) => s.toLowerCase());

export const measureInput = z
  .object({
    title: z.string().trim().min(1).max(MEASURE_LIMITS.title),
    owners: z.array(subject).min(1).max(10),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().max(MEASURE_LIMITS.note).default(''),
    done: z.boolean().optional(),
  })
  .strict();
export type MeasureInput = z.infer<typeof measureInput>;

interface MeasureRow {
  id: string;
  record_id: string;
  title: string;
  owners: string;
  due_date: string;
  note: string;
  done_at: string | null;
  done_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
interface RecordRef {
  id: string;
  number: string;
  title: string;
  type_id: string;
  fields: string;
  owner: string;
  created_by: string;
  status: string;
}

const today = (now = Date.now()) => {
  const p = localDate(now, instanceTimeZone());
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

const toMeasure = (r: MeasureRow, day = today()): RecordMeasure => ({
  id: r.id,
  recordId: r.record_id,
  title: r.title,
  owners: parseJson<string[]>(r.owners, []),
  dueDate: r.due_date,
  note: r.note,
  doneAt: r.done_at,
  doneBy: r.done_by,
  overdue: !r.done_at && r.due_date < day,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

function reviewRow(idOrNumber: string): RecordRef {
  const r = db().get<RecordRef>(
    'SELECT id, number, title, type_id, fields, owner, created_by, status FROM records WHERE id = ? OR number = ?',
    idOrNumber,
    idOrNumber,
  );
  if (!r || !canReadRecordRow(me(), r)) throw new HttpError(404, `Record ${idOrNumber} not found`, 'RECORD_NOT_FOUND', { id: idOrNumber });
  if (r.type_id !== INCIDENT_TYPE_ID) throw new HttpError(409, 'Only incident reviews have measures and a timeline', 'NOT_AN_INCIDENT_REVIEW');
  return r;
}

/** The review's author and owner, designers and administrators keep its measures – also after it was accepted. */
const canEditMeasures = (u: AuthUser, r: RecordRef) =>
  u.roles.some((x) => x === 'admin' || x === 'designer') || [r.owner, r.created_by].some((n) => n?.toLowerCase() === u.username.toLowerCase());
/** The owners of a measure may mark it done and change its note. */
const ownsMeasure = (u: AuthUser, m: MeasureRow) => parseJson<string[]>(m.owners, []).some((s) => matches(u, s));

// ---------- measures ----------

export function listMeasures(recordId: string): RecordMeasures {
  const u = me();
  const r = reviewRow(recordId);
  const day = today();
  const items = db()
    .all<MeasureRow>('SELECT * FROM record_measures WHERE record_id = ? ORDER BY due_date, created_at', r.id)
    .map((m) => toMeasure(m, day));
  return { items, canEdit: canEditMeasures(u, r) };
}

function measureRow(recordId: string, measureId: string): MeasureRow {
  const m = db().get<MeasureRow>('SELECT * FROM record_measures WHERE id = ? AND record_id = ?', measureId, recordId);
  if (!m) throw new HttpError(404, `Measure ${measureId} not found`, 'MEASURE_NOT_FOUND', { id: measureId });
  return m;
}

export function addMeasure(recordId: string, input: MeasureInput): RecordMeasures {
  const u = me();
  const r = reviewRow(recordId);
  if (!canEditMeasures(u, r)) throw new HttpError(403, 'You are not allowed to change the measures of this review', 'FORBIDDEN', { context: 'editMeasures' });
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM record_measures WHERE record_id = ?', r.id)!.n;
  if (Number(n) >= MEASURE_LIMITS.perRecord)
    throw new HttpError(400, `At most ${MEASURE_LIMITS.perRecord} measures per review`, 'MEASURE_LIMIT', { max: MEASURE_LIMITS.perRecord });
  assertKnownSubjects(input.owners);
  const now = nowIso();
  const id = newId('msr_');
  db().tx(() => {
    db().run(
      `INSERT INTO record_measures (id, record_id, title, owners, due_date, note, done_at, done_by, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.id,
      input.title,
      JSON.stringify(input.owners),
      input.dueDate,
      input.note,
      input.done ? now : null,
      input.done ? u.username : null,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'record.measure_added',
      entityType: 'record',
      entityId: r.id,
      summary: `Measure "${input.title}" added to ${r.number} (due ${input.dueDate})`,
      details: { measureId: id, owners: input.owners, dueDate: input.dueDate },
    });
  });
  return listMeasures(r.id);
}

export function updateMeasure(recordId: string, measureId: string, input: Partial<MeasureInput>): RecordMeasures {
  const u = me();
  const r = reviewRow(recordId);
  const m = measureRow(r.id, measureId);
  const editor = canEditMeasures(u, r);
  // owners who are not editors may only mark it done (or not) and change the note
  const onlyOwnerFields = Object.keys(input).every((k) => k === 'done' || k === 'note');
  if (!editor && !(ownsMeasure(u, m) && onlyOwnerFields))
    throw new HttpError(403, 'You are not allowed to change this measure', 'FORBIDDEN', { context: 'editMeasures' });
  const owners = input.owners ?? parseJson<string[]>(m.owners, []);
  if (input.owners) assertKnownSubjects(input.owners, parseJson<string[]>(m.owners, []));
  const now = nowIso();
  const done = input.done === undefined ? !!m.done_at : input.done;
  const doneAt = done ? (m.done_at ?? now) : null;
  const doneBy = done ? (m.done_by ?? u.username) : null;
  db().tx(() => {
    db().run(
      'UPDATE record_measures SET title = ?, owners = ?, due_date = ?, note = ?, done_at = ?, done_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.title ?? m.title,
      JSON.stringify(owners),
      input.dueDate ?? m.due_date,
      input.note ?? m.note,
      doneAt,
      doneBy,
      now,
      u.username,
      m.id,
    );
    const what = done !== !!m.done_at ? (done ? 'done' : 'reopened') : 'changed';
    audit({
      action: `record.measure_${what}`,
      entityType: 'record',
      entityId: r.id,
      summary: `Measure "${input.title ?? m.title}" of ${r.number} ${what === 'changed' ? 'changed' : what === 'done' ? 'marked done' : 'reopened'}`,
      details: { measureId: m.id, owners, dueDate: input.dueDate ?? m.due_date },
    });
  });
  return listMeasures(r.id);
}

export function deleteMeasure(recordId: string, measureId: string): RecordMeasures {
  const u = me();
  const r = reviewRow(recordId);
  const m = measureRow(r.id, measureId);
  if (!canEditMeasures(u, r)) throw new HttpError(403, 'You are not allowed to change the measures of this review', 'FORBIDDEN', { context: 'editMeasures' });
  db().tx(() => {
    db().run('DELETE FROM record_measures WHERE id = ?', m.id);
    db().run('DELETE FROM record_measure_reminders WHERE measure_id = ?', m.id);
    audit({ action: 'record.measure_removed', entityType: 'record', entityId: r.id, summary: `Measure "${m.title}" removed from ${r.number}` });
  });
  return listMeasures(r.id);
}

/** Records linked to a service, either way (as the service page finds its documents). */
function recordIdsOfService(serviceId: string): string[] {
  return db()
    .all<{ id: string }>(
      `SELECT from_id AS id FROM item_links WHERE from_kind = 'record' AND to_kind = 'service' AND to_id = ?
       UNION SELECT to_id AS id FROM item_links WHERE from_kind = 'service' AND from_id = ? AND to_kind = 'record'`,
      serviceId,
      serviceId,
    )
    .map((r) => r.id);
}

export interface MeasureFilter {
  serviceId?: string;
  state?: 'open' | 'overdue' | 'done' | 'all';
  /** Measures this subject owns (user:x / team:y) */
  owner?: string;
}

/** Measures of the incident reviews the user may read, with their review (newest due date last). */
export function listOpenMeasures(f: MeasureFilter = {}): OpenMeasure[] {
  const u = me();
  const state = f.state ?? 'open';
  const ids = f.serviceId ? new Set(recordIdsOfService(f.serviceId)) : null;
  const rows = db().all<MeasureRow & { number: string; record_title: string; type_id: string; record_fields: string; record_owner: string }>(
    `SELECT m.*, r.number, r.title AS record_title, r.type_id, r.fields AS record_fields, r.owner AS record_owner
     FROM record_measures m JOIN records r ON r.id = m.record_id
     ${state === 'done' ? 'WHERE m.done_at IS NOT NULL' : state === 'all' ? '' : 'WHERE m.done_at IS NULL'}
     ORDER BY m.due_date, m.created_at`,
  );
  const day = today();
  return rows
    .filter(
      (m) => (!ids || ids.has(m.record_id)) && canReadRecordRow(u, { id: m.record_id, type_id: m.type_id, fields: m.record_fields, owner: m.record_owner }),
    )
    .filter((m) => state !== 'overdue' || m.due_date < day)
    .filter((m) => !f.owner || parseJson<string[]>(m.owners, []).includes(f.owner.toLowerCase()))
    .map((m) => ({ ...toMeasure(m, day), recordNumber: m.number, recordTitle: m.record_title }));
}

// ---------- timeline ----------

const windowOf = (from: string, to: string) => {
  const f = Date.parse(from);
  const tt = Date.parse(to);
  if (!(tt > f)) throw new HttpError(400, 'The time window must end after it starts', 'TIMELINE_RANGE');
  if (tt - f > TIMELINE_LIMITS.maxDays * DAY)
    throw new HttpError(400, `The time window is at most ${TIMELINE_LIMITS.maxDays} days`, 'TIMELINE_TOO_LONG', { days: TIMELINE_LIMITS.maxDays });
  return { from: new Date(f).toISOString(), to: new Date(tt).toISOString() };
};

/** What Steward saw in [from, to) that the user may see, by time. */
export function timelineCandidates(recordId: string, from: string, to: string): TimelineCandidates {
  const u = me();
  reviewRow(recordId);
  const w = windowOf(from, to);
  const items: TimelineCandidate[] = [];
  const visible = monitorVisibility(u);
  for (const h of db().all<{ id: number; monitor_id: string; ts: string; status: string; previous: string | null; message: string | null; name: string }>(
    `SELECT h.id, h.monitor_id, h.ts, h.status, h.previous, h.message, m.name FROM monitor_history h JOIN monitors m ON m.id = h.monitor_id
     WHERE h.check_id = '' AND h.ts >= ? AND h.ts < ? ORDER BY h.ts LIMIT 2000`,
    w.from,
    w.to,
  )) {
    if (!visible(h.monitor_id)) continue;
    items.push({
      key: `monitor:${h.id}`,
      at: h.ts,
      source: 'monitor',
      text: `${h.name}: ${h.previous ?? '–'} → ${h.status}${h.message ? ` – ${h.message.slice(0, 200)}` : ''}`,
      link: `/monitors/${h.monitor_id}`,
    });
  }
  const procs = new Map<string, boolean>();
  const mayView = (pid: string) => {
    if (!procs.has(pid)) {
      const p = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', pid);
      procs.set(pid, !!p && processPermissions(u, { id: pid, owner: p.owner, acl: parseJson<AclEntry<ProcessPermission>[]>(p.acl, []) }).includes('view'));
    }
    return procs.get(pid)!;
  };
  for (const r of db().all<{
    id: string;
    process_id: string;
    process_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    error: string | null;
  }>(
    `SELECT id, process_id, process_name, status, started_at, finished_at, error FROM runs
     WHERE status IN ('failed', 'interrupted') AND dry_run = 0 AND COALESCE(finished_at, started_at) >= ? AND COALESCE(finished_at, started_at) < ?
     ORDER BY started_at LIMIT 2000`,
    w.from,
    w.to,
  )) {
    if (!mayView(r.process_id)) continue;
    items.push({
      key: `run:${r.id}`,
      at: r.finished_at ?? r.started_at,
      source: 'run',
      text: `Run of "${r.process_name}" ${r.status}${r.error ? `: ${r.error.slice(0, 200)}` : ''}`,
      link: `/runs/${r.id}`,
    });
  }
  // ticket references the reader may see (#131)
  for (const e of db().all<{
    id: number;
    ticket_id: string;
    ts: string;
    kind: string;
    from_status: string | null;
    to_status: string | null;
    comment: string;
    external_number: string;
    title: string;
    responsible: string;
  }>(
    `SELECT e.id, e.ticket_id, e.ts, e.kind, e.from_status, e.to_status, e.comment, t.external_number, t.title, t.responsible FROM ticket_ref_events e
     JOIN ticket_refs t ON t.id = e.ticket_id WHERE e.kind IN ('created', 'status') AND e.ts >= ? AND e.ts < ? ORDER BY e.ts LIMIT 2000`,
    w.from,
    w.to,
  )) {
    if (!ticketVisible({ id: e.ticket_id, responsible: e.responsible })) continue;
    const what = e.kind === 'created' ? 'opened' : `${e.from_status ?? '–'} → ${e.to_status ?? '–'}`;
    items.push({
      key: `ticket:${e.id}`,
      at: e.ts,
      source: 'ticket',
      text: `Ticket ${e.external_number} "${e.title.slice(0, 120)}": ${what}${e.comment ? ` – ${e.comment.slice(0, 200)}` : ''}`,
      link: `/tickets/${e.ticket_id}`,
    });
  }
  if (capabilities(u).viewAudit)
    for (const a of queryAudit({ from: w.from, to: w.to, limit: 1000 }))
      items.push({ key: `audit:${a.seq}`, at: a.ts, source: 'audit', text: `${a.actor}: ${a.summary.slice(0, 300)}`, link: null });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  return { ...w, items: items.slice(0, TIMELINE_LIMITS.items), truncated: items.length > TIMELINE_LIMITS.items };
}

const TIMELINE_HEADINGS = ['timeline', 'zeitlicher ablauf'];

/**
 * Copies chosen candidates into the review's text, under its "Timeline" heading (a new one at the end otherwise), as
 * a list with the time in the instance's time zone. Only while the text can be changed (a draft).
 */
export function addToTimeline(recordId: string, from: string, to: string, keys: string[]): ReturnType<typeof getRecord> {
  const u = me();
  const r = reviewRow(recordId);
  const chosen = new Set(keys);
  const items = timelineCandidates(r.id, from, to).items.filter((i) => chosen.has(i.key));
  if (!items.length) throw new HttpError(400, 'Choose at least one entry', 'TIMELINE_EMPTY');
  let locale;
  try {
    locale = resolveLocale(getUser(u.id).locale, getSettings().defaultLocale);
  } catch {
    locale = resolveLocale(getSettings().defaultLocale);
  }
  const lines = items.map((i) => `- ${formatDateTime(locale, i.at)} – ${i.text.replace(/\r?\n/g, ' ')}`);
  const rec = getRecord(r.id);
  const body = rec.body;
  // headings of level 2; `.*` runs to the end of the line, so this never backtracks
  const re = /^##[ \t]+(.*)$/gm;
  let at = -1;
  let next = body.length;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (at >= 0) {
      next = m.index;
      break;
    }
    if (TIMELINE_HEADINGS.includes(m[1]!.trim().toLowerCase())) at = m.index + m[0].length;
  }
  let out: string;
  if (at < 0) out = `${body.trimEnd()}\n\n## ${t(locale, 'review.timelineHeading' as MessageKey)}\n\n${lines.join('\n')}\n`;
  else {
    const section = body.slice(at, next).trimEnd();
    out = `${body.slice(0, at)}${section ? `${section}\n` : '\n\n'}${lines.join('\n')}\n\n${body.slice(next)}`.trimEnd() + '\n';
  }
  return updateRecord(r.id, { body: out, baseVersion: rec.version, comment: `Timeline: ${items.length} entries added` });
}

// ---------- starting a review ----------

export const startInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('ticket'), ticketId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      source: z.literal('monitor'),
      monitorId: z.string().min(1).max(100),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }).nullable().default(null),
    })
    .strict(),
]);

/** A new incident review from a closed ticket reference (its time, title and services) or a monitor outage. */
export async function startReview(input: z.infer<typeof startInput>): Promise<ReturnType<typeof getRecord>> {
  if (input.source === 'ticket') {
    const { getTicket } = await import('../tickets/service.js');
    const tk = getTicket(input.ticketId);
    if (isTicketOpen(tk.status)) throw new HttpError(409, 'The ticket is still open', 'INCIDENT_TICKET_OPEN');
    const services = tk.links
      .filter((l) => l.kind === 'service' && l.visible && l.targetId)
      .map((l) => ({ kind: 'service' as const, id: l.targetId!, note: '' }));
    const rec = createRecord({
      type: INCIDENT_TYPE_ID,
      title: `${tk.externalNumber} ${tk.title}`.slice(0, 200),
      fields: { incidentStart: tk.openedAt, ...(tk.resolvedAt ? { incidentEnd: tk.resolvedAt } : {}) },
      links: services,
    });
    // the ticket names its review (tickets link out; records cannot link to tickets)
    addLink('ticket', tk.id, { kind: 'record', id: rec.id, note: '' }, tk.externalNumber);
    return getRecord(rec.id);
  }
  const { requireMonitor } = await import('../monitors/service.js');
  const m = requireMonitor(input.monitorId, 'view', 'view this monitor');
  if (input.to && !(Date.parse(input.to) > Date.parse(input.from))) throw new HttpError(400, 'The time window must end after it starts', 'TIMELINE_RANGE');
  return createRecord({
    type: INCIDENT_TYPE_ID,
    title: `${m.name}: outage`.slice(0, 200),
    fields: { incidentStart: input.from, ...(input.to ? { incidentEnd: input.to } : {}) },
    links: [{ kind: 'monitor', id: m.id, note: '' }],
  });
}

// ---------- reminders ----------

/**
 * Reminds the owners of open measures (else the review's owner): once a few days before the due date, on the due date,
 * then once a week while it is overdue. Each reminder is claimed once.
 */
export async function runMeasureJob(now = Date.now()): Promise<number> {
  const day = today(now);
  const soon = today(now + MEASURE_LIMITS.reminderDays * DAY);
  const rows = db().all<MeasureRow & { number: string; record_title: string; record_owner: string; status: string }>(
    `SELECT m.*, r.number, r.title AS record_title, r.owner AS record_owner, r.status FROM record_measures m JOIN records r ON r.id = m.record_id
     WHERE m.done_at IS NULL AND m.due_date <= ? AND r.status NOT IN ('rejected', 'superseded', 'deprecated')`,
    soon,
  );
  if (!rows.length) return 0;
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const { notify, titleName } = await import('../notifications/service.js');
  let sent = 0;
  for (const m of rows) {
    const overdueDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${m.due_date}T00:00:00Z`)) / DAY);
    const kind = overdueDays < 0 ? 'soon' : overdueDays === 0 ? 'due' : 'overdue';
    const key = kind === 'overdue' ? `overdue:${Math.floor((overdueDays - 1) / 7)}` : kind;
    const claimed =
      db().run('INSERT INTO record_measure_reminders (measure_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', m.id, key, nowIso())
        .changes === 1;
    if (!claimed) continue;
    let recipients = usersOfSubjects(parseJson<string[]>(m.owners, []));
    if (!recipients.length && m.record_owner) recipients = usersOfSubjects([`user:${m.record_owner.toLowerCase()}`]);
    if (!recipients.length) continue;
    const params = { measure: m.title, record: `${m.number} ${m.record_title}`, due: m.due_date, days: Math.abs(overdueDays) };
    notify({
      event: 'measure.due',
      text: (l) => ({
        title: t(l, `measure.${kind}.title` as MessageKey, { ...params, measure: titleName(m.title) }),
        body: t(l, `measure.${kind}.body` as MessageKey, params),
      }),
      link: `/records/${m.record_id}`,
      recipients,
      about: { kind: 'record', id: m.record_id },
      inAppKey: `measure:${m.id}:${key}`,
      externalKey: `measure:${m.id}:${key}`,
      data: { measureId: m.id, recordId: m.record_id, dueDate: m.due_date, kind },
    });
    sent++;
  }
  return sent;
}
