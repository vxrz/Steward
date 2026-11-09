import type { ReportLang, ReviewStatus } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { recordTexts } from './pdf-i18n.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

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

export type RecordActivity = 'created' | 'changed' | 'approved' | 'implemented';

export interface RecordRef {
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

export const recordsSectionDraw: ReportSectionDraw<RecordsSectionData> = {
  id: 'records',
  title: (l) => rt(l, 'title'),
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
};
