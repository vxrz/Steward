import { z, type ZodType } from 'zod';
import { RECORD_TYPE_KEY_RE, RECORD_WORKFLOWS, type RecordWorkflowKey, type ReportLang, type ReviewStatus } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentUser } from '../auth/context.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { canReadRecordRow, canReadRecords } from './access.js';
import { recordTexts } from './pdf-i18n.js';
import { reviewState, type DocRow } from './document-model.js';
import { reminderSettings } from '../credentials/service.js';

/**
 * "Records" section of scheduled summary reports: what happened to records in
 * the period (created, changed, approved, implemented), the change requests
 * open at the end of the period by status, and the planned change windows in
 * or after the period. Collected with the rights of the schedule's owner
 * (records are readable by everyone who can sign in, see access.ts).
 *
 * The status "at the end of the period" is replayed from the record events, so
 * a report generated later for the same period shows the same figures.
 *
 * Living documents (workflow "document") get their own table: the edition valid
 * and the review status at the end of the period (replayed from the editions and
 * reviews; the review settings are today's), with the editions approved and the
 * reviews recorded in the period.
 */

const DAY = 86400000;
const MAX_ROWS = 500;

const en = {
  title: 'Records and change requests',
  intro:
    'Records created, changed, approved or implemented in the period; change requests still open at the end of the period; and planned change windows from the start of the period until {days} days after its end. Statuses are those at the end of the period.',
  created: 'Created',
  changed: 'Changed',
  approved: 'Approved',
  implemented: 'Implemented',
  openCrs: 'Open change requests',
  windows: 'Planned change windows',
  activity: 'Activity in the period',
  openByStatus: 'Open change requests by status',
  number: 'Number',
  recordTitle: 'Title',
  type: 'Type',
  status: 'Status',
  what: 'In the period',
  owner: 'Owner',
  count: 'Count',
  start: 'Planned start',
  end: 'Planned end',
  risk: 'Risk',
  noActivity: 'No records were created or changed in the period.',
  noOpen: 'No open change requests.',
  noWindows: 'No planned change windows.',
  more: '{n} more not shown.',
  documents: 'Living documents: editions and reviews',
  documentsIntro:
    'The edition valid and the review status at the end of the period; editions approved and reviews recorded in the period. Due soon: within {days} days (the credentials reminder setting).',
  edition: 'Edition',
  reviewStatus: 'Review',
  nextReview: 'Next review',
  lastReview: 'Last review',
  editionsApproved: 'Editions approved',
  reviewsRecorded: 'Reviews',
  reviewsDue: 'Reviews due or overdue',
  noDocuments: 'No living documents.',
  rs_current: 'current',
  rs_dueSoon: 'due soon',
  rs_overdue: 'overdue',
  rs_none: '–',
};
type Key = keyof typeof en;
const de: Record<Key, string> = {
  title: 'Dokumente und Änderungsanträge',
  intro:
    'Im Zeitraum erstellte, geänderte, freigegebene oder umgesetzte Dokumente; am Ende des Zeitraums noch offene Änderungsanträge; und geplante Änderungsfenster vom Beginn des Zeitraums bis {days} Tage nach seinem Ende. Der Status ist jeweils der am Ende des Zeitraums.',
  created: 'Erstellt',
  changed: 'Geändert',
  approved: 'Freigegeben',
  implemented: 'Umgesetzt',
  openCrs: 'Offene Änderungsanträge',
  windows: 'Geplante Änderungsfenster',
  activity: 'Aktivität im Zeitraum',
  openByStatus: 'Offene Änderungsanträge nach Status',
  number: 'Nummer',
  recordTitle: 'Titel',
  type: 'Art',
  status: 'Status',
  what: 'Im Zeitraum',
  owner: 'Eigentümer',
  count: 'Anzahl',
  start: 'Geplanter Beginn',
  end: 'Geplantes Ende',
  risk: 'Risiko',
  noActivity: 'Im Zeitraum wurden keine Dokumente erstellt oder geändert.',
  noOpen: 'Keine offenen Änderungsanträge.',
  noWindows: 'Keine geplanten Änderungsfenster.',
  more: '{n} weitere nicht angezeigt.',
  documents: 'Lebende Dokumente: Fassungen und Überprüfungen',
  documentsIntro:
    'Die gültige Fassung und der Überprüfungsstatus am Ende des Zeitraums; im Zeitraum freigegebene Fassungen und erfasste Überprüfungen. Bald fällig: innerhalb von {days} Tagen (Einstellung der Erinnerungen für Zugangsdaten).',
  edition: 'Fassung',
  reviewStatus: 'Überprüfung',
  nextReview: 'Nächste Überprüfung',
  lastReview: 'Letzte Überprüfung',
  editionsApproved: 'Freigegebene Fassungen',
  reviewsRecorded: 'Überprüfungen',
  reviewsDue: 'Fällige oder überfällige Überprüfungen',
  noDocuments: 'Keine lebenden Dokumente.',
  rs_current: 'aktuell',
  rs_dueSoon: 'bald fällig',
  rs_overdue: 'überfällig',
  rs_none: '–',
};
const rt = (lang: ReportLang, key: Key, vars?: Record<string, string | number>) =>
  (lang === 'de' ? de : en)[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));

const schema = z.object({
  /** Record type keys (CR, ADR, …); null: all types */
  types: z.array(z.string().regex(RECORD_TYPE_KEY_RE)).max(50).nullable().default(null),
  /** Planned change windows up to this many days after the end of the period */
  windowDays: z.number().int().min(0).max(365).default(30),
});
type RecordsConfig = z.infer<typeof schema>;

export type RecordActivity = 'created' | 'changed' | 'approved' | 'implemented';

interface RecordRef {
  id: string;
  number: string;
  title: string;
  type: string;
  status: string;
  owner: string;
}

export interface RecordsSectionData {
  windowDays: number;
  counts: Record<RecordActivity, number>;
  activity: (RecordRef & { what: RecordActivity[] })[];
  openByStatus: { status: string; count: number }[];
  open: RecordRef[];
  windows: (RecordRef & { start: string | null; end: string | null; risk: string })[];
  /** Living documents at the end of the period */
  documents: (RecordRef & {
    edition: string | null;
    reviewStatus: ReviewStatus;
    nextReviewAt: string | null;
    lastReviewedAt: string | null;
    editionsInPeriod: string[];
    reviewsInPeriod: number;
  })[];
  dueSoonDays: number;
}

interface TypeRow {
  id: string;
  key: string;
  name: string;
  workflow: RecordWorkflowKey;
}

const typeRows = () => db().all<TypeRow>('SELECT id, key, name, workflow FROM record_types ORDER BY key');

const empty = (windowDays: number): RecordsSectionData => ({
  windowDays,
  counts: { created: 0, changed: 0, approved: 0, implemented: 0 },
  activity: [],
  openByStatus: [],
  open: [],
  windows: [],
  documents: [],
  dueSoonDays: reminderSettings().dueSoonDays,
});

function build(c: RecordsConfig, ctx: { from: number; to: number; now: number }): RecordsSectionData {
  const out = empty(c.windowDays);
  if (!canReadRecords(currentUser())) return out;
  const types = new Map(
    typeRows()
      .filter((t) => !c.types || c.types.includes(t.key))
      .map((t) => [t.id, t]),
  );
  if (!types.size) return out;
  const fromIso = new Date(ctx.from).toISOString();
  const toIso = new Date(ctx.to).toISOString();
  // the state at the end of the period (or now, if the period ends in the future)
  const atIso = new Date(Math.min(ctx.to, ctx.now)).toISOString();
  const reader = currentUser();
  const records = db()
    .all<{ id: string; type_id: string; number: string; title: string; owner: string; fields: string; created_at: string }>(
      'SELECT id, type_id, number, title, owner, fields, created_at FROM records WHERE created_at <= ? ORDER BY number',
      atIso,
    )
    .filter((r) => types.has(r.type_id) && canReadRecordRow(reader, r));
  if (!records.length) return out;
  const ids = new Set(records.map((r) => r.id));

  // status at the end of the period: the newest status-changing event up to then
  const statusAt = new Map<string, string>();
  for (const e of db().all<{ record_id: string; to_status: string }>(
    'SELECT record_id, to_status FROM record_events WHERE to_status IS NOT NULL AND created_at <= ? ORDER BY created_at, id',
    atIso,
  ))
    if (ids.has(e.record_id)) statusAt.set(e.record_id, e.to_status);

  const what = new Map<string, Set<RecordActivity>>();
  const mark = (id: string, a: RecordActivity) => {
    if (!ids.has(id)) return;
    const s = what.get(id) ?? new Set<RecordActivity>();
    s.add(a);
    what.set(id, s);
  };
  for (const r of records) if (r.created_at >= fromIso && r.created_at < toIso) mark(r.id, 'created');
  for (const v of db().all<{ record_id: string }>(
    'SELECT DISTINCT record_id FROM record_versions WHERE version > 1 AND created_at >= ? AND created_at < ?',
    fromIso,
    toIso,
  ))
    mark(v.record_id, 'changed');
  for (const e of db().all<{ record_id: string; to_status: string }>(
    "SELECT record_id, to_status FROM record_events WHERE kind = 'transition' AND to_status IN ('approved', 'accepted', 'implemented', 'published') AND created_at >= ? AND created_at < ?",
    fromIso,
    toIso,
  ))
    mark(e.record_id, e.to_status === 'implemented' ? 'implemented' : 'approved');

  const ref = (r: (typeof records)[number]): RecordRef => ({
    id: r.id,
    number: r.number,
    title: r.title,
    type: types.get(r.type_id)!.name,
    status: statusAt.get(r.id) ?? RECORD_WORKFLOWS[types.get(r.type_id)!.workflow]?.initial ?? 'draft',
    owner: r.owner,
  });
  const order: RecordActivity[] = ['created', 'changed', 'approved', 'implemented'];
  for (const r of records) {
    const w = what.get(r.id);
    if (!w) continue;
    const list = order.filter((a) => w.has(a));
    list.forEach((a) => out.counts[a]++);
    out.activity.push({ ...ref(r), what: list });
  }

  const change = RECORD_WORKFLOWS.change;
  const crs = records.filter((r) => types.get(r.type_id)!.workflow === 'change').map((r) => ({ r, ref: ref(r) }));
  const open = crs.filter((x) => !change.terminal.includes(x.ref.status));
  out.open = open.map((x) => x.ref);
  out.openByStatus = change.statuses.map((status) => ({ status, count: open.filter((x) => x.ref.status === status).length })).filter((x) => x.count > 0);

  const horizon = ctx.to + c.windowDays * DAY;
  for (const { r, ref: rr } of crs) {
    if (rr.status === 'cancelled') continue;
    const f = parseJson<Record<string, string>>(r.fields, {});
    const start = f.plannedStart || null;
    const end = f.plannedEnd || null;
    const s = start ? Date.parse(start) : NaN;
    const e = end ? Date.parse(end) : NaN;
    if (Number.isNaN(s) && Number.isNaN(e)) continue;
    const first = Number.isNaN(s) ? e : s;
    const last = Number.isNaN(e) ? s : e;
    if (last < ctx.from || first > horizon) continue;
    out.windows.push({ ...rr, start, end, risk: f.risk ?? '' });
  }
  out.windows.sort((a, b) => Date.parse(a.start ?? a.end!) - Date.parse(b.start ?? b.end!) || a.number.localeCompare(b.number));

  // living documents: edition and review status at the end of the period
  const docs = records.filter((r) => types.get(r.type_id)!.workflow === 'document');
  if (docs.length) {
    const at = Math.min(ctx.to, ctx.now);
    const intervals = new Map(
      db()
        .all<{ id: string; review_interval_months: number | null }>("SELECT id, review_interval_months FROM record_types WHERE workflow = 'document'")
        .map((t) => [t.id, t.review_interval_months]),
    );
    const docIds = new Set(docs.map((r) => r.id));
    const editions = db()
      .all<{ record_id: string; edition: string; approved_at: string; major: number; minor: number }>(
        'SELECT record_id, edition, approved_at, major, minor FROM record_editions WHERE approved_at <= ? ORDER BY approved_at, major, minor',
        atIso,
      )
      .filter((e) => docIds.has(e.record_id));
    const reviews = db()
      .all<{ record_id: string; outcome: string; created_at: string }>(
        'SELECT record_id, outcome, created_at FROM record_reviews WHERE created_at <= ? ORDER BY created_at',
        atIso,
      )
      .filter((v) => docIds.has(v.record_id));
    for (const r of docs) {
      const rr = ref(r);
      const mine = editions.filter((e) => e.record_id === r.id);
      const cur = mine[mine.length - 1];
      const rv = reviews.filter((v) => v.record_id === r.id);
      // the last "no change" review after the current edition moves the next review (as reviewDocument does)
      const last = rv.filter((v) => v.outcome === 'no_change' && (!cur || v.created_at >= cur.approved_at)).pop();
      const d = db().get<DocRow>('SELECT * FROM record_documents WHERE record_id = ?', r.id);
      const replay = d ? { ...d, last_reviewed_at: last?.created_at ?? null, next_review_override: null } : undefined;
      const state = reviewState(
        { owner: r.owner, status: rr.status },
        { workflow: 'document', review_interval_months: intervals.get(r.type_id) ?? null },
        replay,
        cur?.approved_at ?? null,
        at,
        out.dueSoonDays,
      );
      const editionsInPeriod = mine.filter((e) => e.approved_at >= fromIso && e.approved_at < toIso).map((e) => e.edition);
      const reviewsInPeriod = rv.filter((v) => v.created_at >= fromIso && v.created_at < toIso).length;
      out.documents.push({
        ...rr,
        edition: cur?.edition ?? null,
        reviewStatus: state.status,
        nextReviewAt: state.nextReviewAt,
        lastReviewedAt: rv[rv.length - 1]?.created_at ?? null,
        editionsInPeriod,
        reviewsInPeriod,
      });
    }
  }
  return out;
}

registerReportSection<RecordsConfig, RecordsSectionData>({
  id: 'records',
  schema: schema as unknown as ZodType<RecordsConfig>,
  validate: (c) => {
    if (!c.types) return;
    const known = new Set(typeRows().map((t) => t.key));
    const missing = c.types.filter((k) => !known.has(k));
    if (missing.length) throw Object.assign(new Error(`Record type(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => rt(l, 'title'),
  build,
  glance: (d, l) => [
    { label: rt(l, 'openCrs'), value: String(d.open.length), tone: 'default' },
    { label: rt(l, 'windows'), value: String(d.windows.length), tone: d.windows.length ? 'info' : 'default' },
    ...((d.documents ?? []).length
      ? [
          {
            label: rt(l, 'reviewsDue'),
            value: String(d.documents.filter((x) => x.reviewStatus === 'dueSoon' || x.reviewStatus === 'overdue').length),
            tone: (d.documents.some((x) => x.reviewStatus === 'overdue') ? 'warning' : 'default') as Tone,
          },
        ]
      : []),
  ],
  render: (d, { w, tr, lang, section }) => {
    const rx = recordTexts(lang);
    const more = (n: number) => {
      if (n > MAX_ROWS) w.paragraph(rt(lang, 'more', { n: n - MAX_ROWS }), { tone: 'muted', size: 7.4 });
    };
    section(rt(lang, 'title'));
    w.paragraph(rt(lang, 'intro', { days: d.windowDays }), { tone: 'muted', size: 8 });
    w.stats([
      { label: rt(lang, 'created'), value: String(d.counts.created) },
      { label: rt(lang, 'changed'), value: String(d.counts.changed) },
      { label: rt(lang, 'approved'), value: String(d.counts.approved), tone: d.counts.approved ? 'success' : 'default' },
      { label: rt(lang, 'implemented'), value: String(d.counts.implemented), tone: d.counts.implemented ? 'success' : 'default' },
      { label: rt(lang, 'openCrs'), value: String(d.open.length), tone: (d.open.length ? 'info' : 'default') as Tone },
    ]);

    w.subheading(rt(lang, 'activity'));
    w.table(
      [
        { header: rt(lang, 'number'), width: 1.6, mono: true },
        { header: rt(lang, 'recordTitle'), width: 3.4 },
        { header: rt(lang, 'type'), width: 1.6 },
        { header: rt(lang, 'status'), width: 1.3 },
        { header: rt(lang, 'what'), width: 2 },
      ],
      d.activity.slice(0, MAX_ROWS).map((r): CellInput[] => [
        r.number,
        { text: r.title, bold: true },
        // the number starts with the type key (CR-2026-0001): built-in names in the report's language
        rx.typeName(r.number.split('-')[0]!, r.type),
        rx.status(r.status),
        r.what.map((a) => rt(lang, a)).join(', '),
      ]),
      { empty: rt(lang, 'noActivity'), size: 7.4 },
    );
    more(d.activity.length);

    w.subheading(rt(lang, 'openByStatus'));
    if (!d.open.length) w.paragraph(rt(lang, 'noOpen'), { tone: 'muted' });
    else {
      w.table(
        [
          { header: rt(lang, 'status'), width: 3 },
          { header: rt(lang, 'count'), width: 1, align: 'right' },
        ],
        d.openByStatus.map((x): CellInput[] => [rx.status(x.status), String(x.count)]),
        { size: 7.4 },
      );
      w.table(
        [
          { header: rt(lang, 'number'), width: 1.6, mono: true },
          { header: rt(lang, 'recordTitle'), width: 3.6 },
          { header: rt(lang, 'status'), width: 1.3 },
          { header: rt(lang, 'owner'), width: 1.5 },
        ],
        d.open.slice(0, MAX_ROWS).map((r): CellInput[] => [r.number, { text: r.title, bold: true }, rx.status(r.status), r.owner]),
        { size: 7.4 },
      );
      more(d.open.length);
    }

    w.subheading(rt(lang, 'windows'));
    w.table(
      [
        { header: rt(lang, 'number'), width: 1.6, mono: true },
        { header: rt(lang, 'recordTitle'), width: 2.8 },
        { header: rt(lang, 'start'), width: 1.8 },
        { header: rt(lang, 'end'), width: 1.8 },
        { header: rt(lang, 'status'), width: 1.2 },
        { header: rt(lang, 'risk'), width: 0.9 },
      ],
      d.windows
        .slice(0, MAX_ROWS)
        .map((r): CellInput[] => [
          r.number,
          { text: r.title, bold: true },
          r.start ? tr.dateTime(r.start) : '–',
          r.end ? tr.dateTime(r.end) : '–',
          rx.status(r.status),
          r.risk ? { text: rx.option(r.number.split('-')[0]!, { key: 'risk' }, r.risk), tone: r.risk === 'high' ? 'danger' : 'default' } : '–',
        ]),
      { empty: rt(lang, 'noWindows'), size: 7.4 },
    );
    more(d.windows.length);

    const docs = d.documents ?? [];
    if (docs.length) {
      w.subheading(rt(lang, 'documents'));
      w.paragraph(rt(lang, 'documentsIntro', { days: d.dueSoonDays }), { tone: 'muted', size: 8 });
      w.table(
        [
          { header: rt(lang, 'number'), width: 1.6, mono: true },
          { header: rt(lang, 'recordTitle'), width: 2.6 },
          { header: rt(lang, 'status'), width: 1.2 },
          { header: rt(lang, 'edition'), width: 0.8 },
          { header: rt(lang, 'reviewStatus'), width: 1 },
          { header: rt(lang, 'nextReview'), width: 1.3 },
          { header: rt(lang, 'what'), width: 1.8 },
        ],
        docs.slice(0, MAX_ROWS).map((r): CellInput[] => [
          r.number,
          { text: r.title, bold: true },
          rx.status(r.status),
          r.edition ?? '–',
          {
            text: rt(lang, `rs_${r.reviewStatus}` as Key),
            tone: r.reviewStatus === 'overdue' ? 'danger' : r.reviewStatus === 'dueSoon' ? 'warning' : 'default',
          },
          r.nextReviewAt ? tr.date(r.nextReviewAt) : '–',
          [
            r.editionsInPeriod.length ? `${rt(lang, 'editionsApproved')}: ${r.editionsInPeriod.join(', ')}` : '',
            r.reviewsInPeriod ? `${rt(lang, 'reviewsRecorded')}: ${r.reviewsInPeriod}` : '',
          ]
            .filter(Boolean)
            .join(' · ') || '–',
        ]),
        { empty: rt(lang, 'noDocuments'), size: 7.4 },
      );
      more(docs.length);
    }
  },
});
