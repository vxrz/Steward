import { CA_LIMITS, CORRECTIVE_DATASET, type DatasetRow } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { publishDataset } from '../dashboards/datasets.js';
import { formatDay, t, type MessageKey } from '../i18n/index.js';
import { nowIso, parseJson } from '../util.js';
import { caToday } from './corrective.js';
import { scanSuggestions } from './corrective-sources.js';

/**
 * The job of the register of corrective actions (every five minutes; module Compliance): the suggestions (hourly,
 * corrective-sources.ts), the reminders of open actions and the built-in dataset (hourly).
 */

const DAY = 86_400_000;

export async function runCorrectiveJob(now = Date.now()): Promise<{ suggested: number; reminders: number; published: boolean }> {
  let suggested = 0;
  try {
    suggested = scanSuggestions(now).added;
  } catch (err) {
    logger.warn({ err }, 'corrective actions: suggestions could not be collected');
  }
  const reminders = await remindActions(now);
  const published = publishCorrectiveDataset(false, now);
  return { suggested, reminders, published };
}

/**
 * Reminds the owners of open actions (else the finding's owner): a few days before the due date, on the due date, then
 * once a week while it is overdue – each reminder claimed once (the mechanism of incident review measures, whose own
 * job reminds the measures an incident finding reads as its actions).
 */
export async function remindActions(now = Date.now()): Promise<number> {
  const day = caToday(now);
  const soon = caToday(now + CA_LIMITS.reminderDays * DAY);
  const rows = db().all<{
    id: string;
    finding_id: string;
    title: string;
    owners: string;
    due_date: string;
    number: string;
    finding_title: string;
    finding_owner: string | null;
    service_id: string | null;
  }>(
    `SELECT a.id, a.finding_id, a.title, a.owners, a.due_date, f.number, f.title AS finding_title, f.owner AS finding_owner, f.service_id
     FROM ca_actions a JOIN ca_findings f ON f.id = a.finding_id
     WHERE a.done_at IS NULL AND a.due_date <= ? AND f.status IN ('open', 'inProgress', 'implemented')`,
    soon,
  );
  if (!rows.length) return 0;
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const { notify, titleName } = await import('../notifications/service.js');
  let sent = 0;
  for (const a of rows) {
    const overdueDays = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${a.due_date}T00:00:00Z`)) / DAY);
    const kind = overdueDays < 0 ? 'soon' : overdueDays === 0 ? 'due' : 'overdue';
    const key = kind === 'overdue' ? `overdue:${Math.floor((overdueDays - 1) / 7)}` : kind;
    const claimed =
      db().run('INSERT INTO ca_action_reminders (action_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', a.id, key, nowIso()).changes === 1;
    if (!claimed) continue;
    let recipients = usersOfSubjects(parseJson<string[]>(a.owners, []));
    if (!recipients.length && a.finding_owner) recipients = usersOfSubjects([`user:${a.finding_owner.toLowerCase()}`]);
    if (!recipients.length) continue;
    const params = { action: a.title, finding: `${a.number} ${a.finding_title}`, due: a.due_date, days: Math.abs(overdueDays) };
    notify({
      event: 'corrective.action_due',
      text: (l) => ({
        title: t(l, `corrective.${kind}.title` as MessageKey, { ...params, action: titleName(a.title) }),
        body: t(l, `corrective.${kind}.body` as MessageKey, { ...params, due: formatDay(l, params.due) }),
      }),
      link: `/compliance/corrective-actions/${a.finding_id}`,
      recipients,
      // the service's owning teams' channels get it too (#136)
      ...(a.service_id ? { about: { kind: 'service' as const, id: a.service_id } } : {}),
      inAppKey: `corrective:${a.id}:${key}`,
      externalKey: `corrective:${a.id}:${key}`,
      data: { actionId: a.id, findingId: a.finding_id, number: a.number, dueDate: a.due_date, kind },
    });
    sent++;
  }
  return sent;
}

const COLUMNS = ['Number', 'Title', 'Source', 'Severity', 'Status', 'Service', 'Owner', 'Due', 'Overdue', 'Open actions', 'Actions', 'Created', 'Closed'];
let lastPublished = 0;

/**
 * The built-in dataset "Corrective actions" (compliance.correctiveActions): one row per finding with its source,
 * severity, status, service, owner, due date and actions. Its rows name every service, so administrators and auditors
 * read it (like costs.plans). At most hourly, and only once there is a finding.
 */
export function publishCorrectiveDataset(force = false, now = Date.now()): boolean {
  if (!force && now - lastPublished < 3600_000) return false;
  if (!db().get('SELECT id FROM ca_findings LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', CORRECTIVE_DATASET)) return false;
  lastPublished = now;
  const day = caToday(now);
  const services = new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM services')
      .map((s) => [s.id, s.name]),
  );
  const work = new Map<string, { open: number; total: number; overdue: boolean }>();
  const count = (key: string, done: string | null, due: string) => {
    const w = work.get(key) ?? { open: 0, total: 0, overdue: false };
    w.total++;
    if (!done) {
      w.open++;
      if (due < day) w.overdue = true;
    }
    work.set(key, w);
  };
  for (const a of db().all<{ finding_id: string; done_at: string | null; due_date: string }>('SELECT finding_id, done_at, due_date FROM ca_actions'))
    count(a.finding_id, a.done_at, a.due_date);
  for (const m of db().all<{ record_id: string; done_at: string | null; due_date: string }>(
    'SELECT record_id, done_at, due_date FROM record_measures WHERE record_id IN (SELECT record_id FROM ca_findings WHERE record_id IS NOT NULL)',
  ))
    count(`record:${m.record_id}`, m.done_at, m.due_date);
  const rows: DatasetRow[] = [];
  let open = 0;
  let overdueCount = 0;
  for (const f of db().all<{
    id: string;
    number: string;
    title: string;
    source: string;
    severity: string;
    status: string;
    service_id: string | null;
    owner: string | null;
    due_date: string | null;
    record_id: string | null;
    created_at: string;
    closed_at: string | null;
  }>('SELECT id, number, title, source, severity, status, service_id, owner, due_date, record_id, created_at, closed_at FROM ca_findings ORDER BY number')) {
    const w = work.get(f.record_id ? `record:${f.record_id}` : f.id) ?? { open: 0, total: 0, overdue: false };
    const active = f.status === 'open' || f.status === 'inProgress';
    const overdue = active && ((!!f.due_date && f.due_date < day) || w.overdue);
    if (f.status !== 'closed' && f.status !== 'cancelled') open++;
    if (overdue) overdueCount++;
    rows.push({
      Number: f.number,
      Title: f.title,
      Source: f.source,
      Severity: f.severity,
      Status: f.status,
      Service: f.service_id ? (services.get(f.service_id) ?? '') : '',
      Owner: f.owner ?? '',
      Due: f.due_date ?? '',
      Overdue: overdue ? 'yes' : 'no',
      'Open actions': w.open,
      Actions: w.total,
      Created: f.created_at.slice(0, 10),
      Closed: f.closed_at ? f.closed_at.slice(0, 10) : '',
      _key: f.id,
      _status: overdue ? 'serious' : active && f.severity === 'major' ? 'warning' : 'good',
      _reason: overdue ? 'Past its due date' : active && f.severity === 'major' ? 'A major nonconformity is open' : '',
    });
  }
  publishDataset({
    key: CORRECTIVE_DATASET,
    title: 'Corrective actions',
    processId: 'compliance:corrective',
    processName: 'Corrective actions (built in)',
    runId: '',
    dryRun: false,
    columns: COLUMNS,
    rows,
    metrics: { open, overdue: overdueCount, findings: rows.length },
    limits: {},
    staleAfterMinutes: 24 * 60 * 2,
    staleAfterFixed: true,
  });
  return true;
}
