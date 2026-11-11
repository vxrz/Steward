import type { CaSeverity, ReportLang, ResponsibilityArea, SoaCounts, SoaVersionStatus, SupplierDateState } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the "ISMS summary" section of scheduled reports (isms-report-section.ts collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

/** Rows a list of the section holds at most (the counts are complete). */
export const ISMS_MAX_ROWS = 50;

const en = {
  title: 'ISMS summary',
  intro:
    'Figures for the management review (ISO/IEC 27001 clause 9.3) from what Steward records: the statement of applicability, corrective actions, mandatory duties, reviews, the responsibility matrix and suppliers. Steward provides evidence; it does not make the organisation compliant. Only what the owner of the schedule may see is counted.',
  moduleOff: 'The Compliance module is switched off (Settings → Modules): this section holds no figures.',
  soa: 'Statement of applicability',
  noSoa: 'No statement of applicability yet.',
  missing: 'No statement of applicability for {key} yet.',
  catalogue: 'Catalogue',
  controls: 'Controls',
  applicable: 'Applicable',
  notApplicable: 'Not applicable',
  undecided: 'Undecided',
  reviewDue: 'Not reviewed for 12 months',
  noEvidence: 'Implemented without evidence',
  implemented: 'Implemented',
  partly: 'Partly',
  planned: 'Planned',
  notStarted: 'Not started',
  approved: 'Latest approved',
  waiting: 'Waiting for approval',
  changed: 'Rows changed since',
  version: 'version {n}, {date}',
  none: '–',
  decisions: 'Decisions on versions in the report period',
  noDecisions: 'No version was approved or returned in the report period.',
  decision: 'Decision',
  by: 'By',
  on: 'On',
  versionCol: 'Version',
  statuses: { submitted: 'Waiting', approved: 'Approved', returned: 'Returned', superseded: 'Superseded' } as Record<SoaVersionStatus, string>,
  corrective: 'Corrective actions',
  open: { major: 'Major open', minor: 'Minor open', observation: 'Observations open' } as Record<CaSeverity, string>,
  overdue: 'Overdue',
  closed: 'Closed in the period',
  effective: 'Checked: effective',
  notEffective: 'Checked: not effective',
  suggestions: 'Suggestions waiting',
  overdueList: 'Overdue findings',
  noOverdue: 'No finding is overdue.',
  finding: 'Finding',
  severity: 'Severity',
  owner: 'Owner',
  due: 'Due',
  severities: { major: 'Major', minor: 'Minor', observation: 'Observation' } as Record<CaSeverity, string>,
  duties: 'Mandatory duties',
  dutiesIntro: 'Periods of mandatory service duties that ended in the report period.',
  dutyStatuses: {
    done: 'On time',
    late: 'Late',
    skipped: 'Skipped',
    failed: 'Failed',
    missed: 'Missed',
    ended: 'Ended without a run',
  },
  notMet: 'Periods not met',
  allMet: 'Every period of a mandatory duty that ended in the report period was done or skipped.',
  service: 'Service',
  duty: 'Duty',
  period: 'Period',
  status: 'Status',
  reviews: 'Reviews done',
  personReviews: 'Person access reviews approved',
  personReviewsValue: '{n} ({removals} rights to remove, {gone} confirmed gone)',
  supplierReviews: 'Supplier reviews',
  supplierReviewsValue: '{done} on time, {late} late, {notDone} not done',
  documentReviews: 'Living documents (periodic reviews)',
  documentReviewsValue: '{within} within their review interval, {overdue} overdue at the end of the period; {reviewed} reviews recorded',
  overdueDocuments: 'Living documents overdue for review',
  document: 'Document',
  reviewOwner: 'Review owner',
  reviewDueOn: 'Review due',
  gaps: 'Gaps in the responsibility matrix',
  gapsIntro: 'Services whose responsibility matrix has areas not decided, or where the team does backup or recovery itself without a recovery-test duty.',
  noGaps: 'No service has a gap in its responsibility matrix.',
  undecidedAreas: 'Not decided',
  noRecoveryTest: 'No recovery test',
  areas: {
    backup: 'Backup',
    recovery: 'Recovery and continuity',
    patching: 'Patching and vulnerabilities',
    access: 'Access management',
    logging: 'Logging and monitoring',
    incidents: 'Security incidents',
  } as Record<ResponsibilityArea, string>,
  allAreas: 'all areas',
  suppliers: 'Suppliers',
  suppliersIntro: 'Certificates that run out and notice-by dates of contracts in the next {days} days or passed in the last {days} days (confirmed suppliers).',
  noSupplierDates: 'No certificate or notice-by date in this window.',
  supplier: 'Supplier',
  what: 'What',
  date: 'Date',
  kinds: { certificate: 'Certificate', notice: 'Notice by' },
  states: { past: 'Passed', dueSoon: 'Due soon', ok: 'Ahead', none: '–' } as Record<SupplierDateState, string>,
  inDays: 'in {n} days',
  daysAgo: '{n} days ago',
  today: 'today',
  unconfirmed: '{n} supplier(s) still to confirm (Suppliers → To confirm) are not counted.',
  more: '{n} more not shown.',
  glanceOpen: 'Open findings',
  glanceOverdue: 'Overdue findings',
};

type Texts = typeof en;

const de: Texts = {
  title: 'ISMS-Zusammenfassung',
  intro:
    'Kennzahlen für die Managementbewertung (ISO/IEC 27001 Abschnitt 9.3) aus dem, was Steward aufzeichnet: die Erklärung zur Anwendbarkeit, Korrekturmaßnahmen, verpflichtende Pflichten, Überprüfungen, die Verantwortungsmatrix und Lieferanten. Steward liefert Nachweise; es macht die Organisation nicht konform. Gezählt wird nur, was die Person sehen darf, der der Zeitplan gehört.',
  moduleOff: 'Das Modul Compliance ist ausgeschaltet (Einstellungen → Module): Dieser Abschnitt enthält keine Kennzahlen.',
  soa: 'Erklärung zur Anwendbarkeit',
  noSoa: 'Noch keine Erklärung zur Anwendbarkeit.',
  missing: 'Noch keine Erklärung zur Anwendbarkeit für {key}.',
  catalogue: 'Katalog',
  controls: 'Kontrollen',
  applicable: 'Anwendbar',
  notApplicable: 'Nicht anwendbar',
  undecided: 'Nicht entschieden',
  reviewDue: 'Seit 12 Monaten nicht überprüft',
  noEvidence: 'Umgesetzt ohne Nachweis',
  implemented: 'Umgesetzt',
  partly: 'Teilweise',
  planned: 'Geplant',
  notStarted: 'Nicht begonnen',
  approved: 'Zuletzt freigegeben',
  waiting: 'Wartet auf Freigabe',
  changed: 'Seitdem geänderte Zeilen',
  version: 'Version {n}, {date}',
  none: '–',
  decisions: 'Entscheidungen über Versionen im Berichtszeitraum',
  noDecisions: 'Im Berichtszeitraum wurde keine Version freigegeben oder zurückgegeben.',
  decision: 'Entscheidung',
  by: 'Von',
  on: 'Am',
  versionCol: 'Version',
  statuses: { submitted: 'Wartet', approved: 'Freigegeben', returned: 'Zurückgegeben', superseded: 'Abgelöst' },
  corrective: 'Korrekturmaßnahmen',
  open: { major: 'Wesentliche offen', minor: 'Geringfügige offen', observation: 'Beobachtungen offen' },
  overdue: 'Überfällig',
  closed: 'Im Zeitraum abgeschlossen',
  effective: 'Geprüft: wirksam',
  notEffective: 'Geprüft: nicht wirksam',
  suggestions: 'Wartende Vorschläge',
  overdueList: 'Überfällige Befunde',
  noOverdue: 'Kein Befund ist überfällig.',
  finding: 'Befund',
  severity: 'Schwere',
  owner: 'Verantwortlich',
  due: 'Fällig',
  severities: { major: 'Wesentlich', minor: 'Geringfügig', observation: 'Beobachtung' },
  duties: 'Verpflichtende Pflichten',
  dutiesIntro: 'Zeiträume verpflichtender Service-Pflichten, die im Berichtszeitraum endeten.',
  dutyStatuses: {
    done: 'Rechtzeitig',
    late: 'Verspätet',
    skipped: 'Ausgesetzt',
    failed: 'Fehlgeschlagen',
    missed: 'Versäumt',
    ended: 'Ohne Ausführung beendet',
  },
  notMet: 'Nicht erfüllte Zeiträume',
  allMet: 'Jeder Zeitraum einer verpflichtenden Pflicht, der im Berichtszeitraum endete, wurde erledigt oder ausgesetzt.',
  service: 'Service',
  duty: 'Pflicht',
  period: 'Zeitraum',
  status: 'Status',
  reviews: 'Durchgeführte Überprüfungen',
  personReviews: 'Freigegebene Personen-Zugriffsprüfungen',
  personReviewsValue: '{n} ({removals} zu entziehende Rechte, {gone} bestätigt entfernt)',
  supplierReviews: 'Lieferantenbewertungen',
  supplierReviewsValue: '{done} rechtzeitig, {late} verspätet, {notDone} nicht erledigt',
  documentReviews: 'Lebende Dokumente (regelmäßige Überprüfungen)',
  documentReviewsValue: '{within} innerhalb ihres Überprüfungsintervalls, {overdue} am Ende des Zeitraums überfällig; {reviewed} Überprüfungen erfasst',
  overdueDocuments: 'Lebende Dokumente mit überfälliger Überprüfung',
  document: 'Dokument',
  reviewOwner: 'Verantwortlich für die Überprüfung',
  reviewDueOn: 'Überprüfung fällig',
  gaps: 'Lücken in der Verantwortungsmatrix',
  gapsIntro:
    'Services, deren Verantwortungsmatrix nicht entschiedene Bereiche hat oder bei denen das Team Datensicherung oder Wiederherstellung selbst übernimmt, ohne Pflicht für einen Wiederherstellungstest.',
  noGaps: 'Kein Service hat eine Lücke in seiner Verantwortungsmatrix.',
  undecidedAreas: 'Nicht entschieden',
  noRecoveryTest: 'Kein Wiederherstellungstest',
  areas: {
    backup: 'Datensicherung',
    recovery: 'Wiederherstellung und Kontinuität',
    patching: 'Patches und Schwachstellen',
    access: 'Zugriffsverwaltung',
    logging: 'Protokollierung und Überwachung',
    incidents: 'Sicherheitsvorfälle',
  },
  allAreas: 'alle Bereiche',
  suppliers: 'Lieferanten',
  suppliersIntro:
    'Zertifikate, die ablaufen, und Kündigungstermine von Verträgen in den nächsten {days} Tagen oder in den letzten {days} Tagen verstrichen (bestätigte Lieferanten).',
  noSupplierDates: 'Kein Zertifikat und kein Kündigungstermin in diesem Zeitfenster.',
  supplier: 'Lieferant',
  what: 'Was',
  date: 'Datum',
  kinds: { certificate: 'Zertifikat', notice: 'Kündigen bis' },
  states: { past: 'Verstrichen', dueSoon: 'Bald fällig', ok: 'Künftig', none: '–' },
  inDays: 'in {n} Tagen',
  daysAgo: 'vor {n} Tagen',
  today: 'heute',
  unconfirmed: '{n} noch zu bestätigende Lieferanten (Lieferanten → Zu bestätigen) werden nicht gezählt.',
  more: '{n} weitere nicht angezeigt.',
  glanceOpen: 'Offene Befunde',
  glanceOverdue: 'Überfällige Befunde',
};

const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

export interface IsmsSoaItem {
  catalogueKey: string;
  catalogueName: string;
  scopeName: string;
  counts: SoaCounts;
  latestApproved: { number: number; decidedAt: string; decidedBy: string } | null;
  waiting: { number: number; submittedAt: string; submittedBy: string } | null;
  changedSinceApproved: number;
}

export interface IsmsSectionData {
  /** The Compliance module is switched off: nothing was collected */
  moduleOff: boolean;
  /** Days ahead (and back) of the supplier dates */
  days: number;
  soa: {
    items: IsmsSoaItem[];
    decisions: { catalogueKey: string; number: number; status: SoaVersionStatus; decidedAt: string; decidedBy: string }[];
    /** The chosen catalogue has no statement of applicability */
    missing: string | null;
  };
  corrective: {
    /** Open, in progress or implemented – by severity */
    open: Record<CaSeverity, number>;
    overdue: number;
    overdueList: { number: string; title: string; severity: CaSeverity; owner: string | null; dueDate: string | null }[];
    /** Closed in the period (the fix was checked and worked) */
    closed: number;
    /** Effectiveness checks recorded in the period */
    checks: { effective: number; notEffective: number };
    suggestions: number;
  };
  duties: {
    counts: { done: number; late: number; skipped: number; failed: number; missed: number; ended: number };
    notMet: { service: string; duty: string; period: string; status: 'missed' | 'failed' | 'ended' }[];
  };
  reviews: {
    personReviews: number;
    removals: number;
    gone: number;
    supplierReviews: { done: number; late: number; notDone: number };
    /**
     * Living documents with a review cycle the owner may read (0.18.0): within their review interval and overdue at the
     * end of the period, the reviews recorded in it, and the overdue ones (at most ISMS_MAX_ROWS). Missing in data
     * collected before 0.18.0.
     */
    documents?: {
      withinInterval: number;
      overdue: number;
      reviewed: number;
      overdueList: { number: string; title: string; owner: string; nextReviewAt: string }[];
    };
  };
  gaps: { service: string; undecided: ResponsibilityArea[]; noRecoveryTest: ResponsibilityArea[] }[];
  /** All services with gaps (the list holds at most ISMS_MAX_ROWS) */
  gapCount?: number;
  suppliers: {
    items: { supplier: string; kind: 'certificate' | 'notice'; title: string; date: string; days: number; state: SupplierDateState }[];
    /** All items in the window (the list holds at most ISMS_MAX_ROWS) */
    itemCount?: number;
    unconfirmed: number;
  };
}

const openTotal = (d: IsmsSectionData) => d.corrective.open.major + d.corrective.open.minor + d.corrective.open.observation;
const sevTone = (s: CaSeverity): Tone => (s === 'major' ? 'danger' : s === 'minor' ? 'warning' : 'muted');
const stateTone = (s: SupplierDateState): Tone => (s === 'past' ? 'danger' : s === 'dueSoon' ? 'warning' : 'default');

export const ismsSectionDraw: ReportSectionDraw<IsmsSectionData> = {
  id: 'isms',
  title: (l) => tx(l).title,
  glance: (d, l) =>
    d.moduleOff
      ? []
      : [
          { label: tx(l).glanceOpen, value: String(openTotal(d)), tone: (openTotal(d) ? 'warning' : 'default') as Tone },
          { label: tx(l).glanceOverdue, value: String(d.corrective.overdue), tone: (d.corrective.overdue ? 'danger' : 'default') as Tone },
        ],
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const day = (s: string | null) =>
      s
        ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${s.slice(0, 10)}T00:00:00Z`))
        : x.none;
    const when = (s: string | null) =>
      s ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(s)) : x.none;
    const more = (shown: number, all: number) => {
      if (all > shown) w.paragraph(fill(x.more, { n: all - shown }), { tone: 'muted', size: 7.4 });
    };
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    if (d.moduleOff) {
      w.paragraph(x.moduleOff);
      return;
    }

    // statement of applicability
    w.subheading(x.soa);
    if (d.soa.missing) w.paragraph(fill(x.missing, { key: d.soa.missing }), { tone: 'warning' });
    else if (!d.soa.items.length) w.paragraph(x.noSoa, { tone: 'muted' });
    if (d.soa.items.length) {
      const cat = (i: IsmsSoaItem): CellInput => ({ text: i.scopeName ? `${i.catalogueKey} · ${i.scopeName}` : i.catalogueKey, bold: true });
      const n = (v: number, tone: Tone = 'warning'): CellInput => ({ text: String(v), tone: v ? tone : 'default' });
      w.table(
        [
          { header: x.catalogue, width: 2.4 },
          { header: x.controls, width: 1, align: 'right' },
          { header: x.applicable, width: 1.1, align: 'right' },
          { header: x.notApplicable, width: 1.1, align: 'right' },
          { header: x.undecided, width: 1.1, align: 'right' },
          { header: x.reviewDue, width: 1.4, align: 'right' },
          { header: x.noEvidence, width: 1.4, align: 'right' },
        ],
        d.soa.items.map((i) => [
          cat(i),
          String(i.counts.controls),
          String(i.counts.applicable),
          String(i.counts.notApplicable),
          n(i.counts.undecided),
          n(i.counts.reviewDue),
          n(i.counts.noEvidence, 'danger'),
        ]),
        { size: 7.4 },
      );
      w.table(
        [
          { header: x.catalogue, width: 2.4 },
          { header: x.implemented, width: 1, align: 'right' },
          { header: x.partly, width: 0.9, align: 'right' },
          { header: x.planned, width: 0.9, align: 'right' },
          { header: x.notStarted, width: 1, align: 'right' },
          { header: x.approved, width: 1.8 },
          { header: x.waiting, width: 1.6 },
          { header: x.changed, width: 1.1, align: 'right' },
        ],
        d.soa.items.map((i) => [
          cat(i),
          String(i.counts.implemented),
          String(i.counts.partly),
          String(i.counts.planned),
          n(i.counts.notStarted),
          i.latestApproved ? fill(x.version, { n: i.latestApproved.number, date: when(i.latestApproved.decidedAt) }) : { text: x.none, tone: 'warning' },
          i.waiting ? { text: fill(x.version, { n: i.waiting.number, date: when(i.waiting.submittedAt) }), tone: 'info' } : x.none,
          i.latestApproved ? n(i.changedSinceApproved, 'info') : x.none,
        ]),
        { size: 7.4 },
      );
      w.table(
        [
          { header: x.catalogue, width: 2 },
          { header: x.versionCol, width: 1, align: 'right' },
          { header: x.decision, width: 1.4 },
          { header: x.by, width: 1.6 },
          { header: x.on, width: 1.4 },
        ],
        d.soa.decisions.map((v) => [
          v.catalogueKey,
          String(v.number),
          { text: x.statuses[v.status], tone: v.status === 'returned' ? 'warning' : 'success' },
          v.decidedBy,
          when(v.decidedAt),
        ]),
        { size: 7.4, empty: x.noDecisions },
      );
    }

    // corrective actions
    w.subheading(x.corrective);
    const c = d.corrective;
    w.stats([
      ...(['major', 'minor', 'observation'] as const).map((s) => ({
        label: x.open[s],
        value: String(c.open[s]),
        tone: c.open[s] ? sevTone(s) : ('default' as Tone),
      })),
      { label: x.overdue, value: String(c.overdue), tone: c.overdue ? 'danger' : 'default' },
      { label: x.closed, value: String(c.closed), tone: c.closed ? 'success' : 'default' },
      { label: x.effective, value: String(c.checks.effective), tone: c.checks.effective ? 'success' : 'default' },
      { label: x.notEffective, value: String(c.checks.notEffective), tone: c.checks.notEffective ? 'warning' : 'default' },
      { label: x.suggestions, value: String(c.suggestions), tone: c.suggestions ? 'info' : 'default' },
    ]);
    w.table(
      [
        { header: x.finding, width: 4 },
        { header: x.severity, width: 1.2 },
        { header: x.owner, width: 1.4 },
        { header: x.due, width: 1.2 },
      ],
      c.overdueList.map((f) => [
        { text: `${f.number} ${f.title}`, bold: true },
        { text: x.severities[f.severity], tone: sevTone(f.severity) },
        f.owner ?? x.none,
        { text: day(f.dueDate), tone: 'danger' },
      ]),
      { size: 7.4, empty: x.noOverdue },
    );
    more(c.overdueList.length, c.overdue);

    // mandatory duties
    w.subheading(x.duties);
    w.paragraph(x.dutiesIntro, { tone: 'muted', size: 8 });
    const dc = d.duties.counts;
    w.stats([
      { label: x.dutyStatuses.done, value: String(dc.done), tone: dc.done ? 'success' : 'default' },
      { label: x.dutyStatuses.late, value: String(dc.late), tone: dc.late ? 'warning' : 'default' },
      { label: x.dutyStatuses.skipped, value: String(dc.skipped), tone: dc.skipped ? 'warning' : 'default' },
      { label: x.dutyStatuses.missed, value: String(dc.missed), tone: dc.missed ? 'danger' : 'default' },
      { label: x.dutyStatuses.failed, value: String(dc.failed), tone: dc.failed ? 'danger' : 'default' },
      { label: x.dutyStatuses.ended, value: String(dc.ended), tone: dc.ended ? 'danger' : 'default' },
    ]);
    w.table(
      [
        { header: x.service, width: 2 },
        { header: x.duty, width: 3 },
        { header: x.period, width: 1.2, mono: true },
        { header: x.status, width: 1.6 },
      ],
      d.duties.notMet.map((r) => [r.service, { text: r.duty, bold: true }, r.period, { text: x.dutyStatuses[r.status], tone: 'danger' }]),
      { size: 7.4, empty: x.allMet },
    );
    more(d.duties.notMet.length, dc.missed + dc.failed + dc.ended);

    // reviews done
    w.subheading(x.reviews);
    const r = d.reviews;
    w.keyValues([
      { label: x.personReviews, value: fill(x.personReviewsValue, { n: r.personReviews, removals: r.removals, gone: r.gone }) },
      {
        label: x.supplierReviews,
        value: fill(x.supplierReviewsValue, r.supplierReviews),
        tone: r.supplierReviews.notDone ? 'danger' : r.supplierReviews.late ? 'warning' : 'default',
      },
      ...(r.documents
        ? [
            {
              label: x.documentReviews,
              value: fill(x.documentReviewsValue, { within: r.documents.withinInterval, overdue: r.documents.overdue, reviewed: r.documents.reviewed }),
              tone: (r.documents.overdue ? 'warning' : 'default') as Tone,
            },
          ]
        : []),
    ]);
    if (r.documents?.overdueList.length) {
      w.paragraph(x.overdueDocuments, { size: 8 });
      w.table(
        [
          { header: x.document, width: 4 },
          { header: x.reviewOwner, width: 1.6 },
          { header: x.reviewDueOn, width: 1.4 },
        ],
        r.documents.overdueList.map((o) => [{ text: `${o.number} ${o.title}`, bold: true }, o.owner, { text: day(o.nextReviewAt), tone: 'danger' }]),
        { size: 7.4 },
      );
      more(r.documents.overdueList.length, r.documents.overdue);
    }

    // the responsibility matrix
    w.subheading(x.gaps);
    w.paragraph(x.gapsIntro, { tone: 'muted', size: 8 });
    const areas = (l: ResponsibilityArea[]) => (l.length === 6 ? x.allAreas : l.map((a) => x.areas[a]).join(', ') || x.none);
    w.table(
      [
        { header: x.service, width: 2.2 },
        { header: x.undecidedAreas, width: 3.4 },
        { header: x.noRecoveryTest, width: 2.4 },
      ],
      d.gaps.map((g) => [
        { text: g.service, bold: true },
        { text: areas(g.undecided), tone: g.undecided.length ? 'warning' : 'default' },
        { text: g.noRecoveryTest.length ? areas(g.noRecoveryTest) : x.none, tone: g.noRecoveryTest.length ? 'danger' : 'default' },
      ]),
      { size: 7.4, empty: x.noGaps },
    );
    more(d.gaps.length, d.gapCount ?? d.gaps.length);

    // suppliers
    w.subheading(x.suppliers);
    w.paragraph(fill(x.suppliersIntro, { days: d.days }), { tone: 'muted', size: 8 });
    const rel = (n: number) => (n === 0 ? x.today : n > 0 ? fill(x.inDays, { n }) : fill(x.daysAgo, { n: -n }));
    w.table(
      [
        { header: x.supplier, width: 2.2 },
        { header: x.what, width: 3 },
        { header: x.date, width: 1.4 },
        { header: x.status, width: 1.6 },
      ],
      d.suppliers.items.map((i) => [
        { text: i.supplier, bold: true },
        `${x.kinds[i.kind]}: ${i.title}`,
        day(i.date),
        { text: `${x.states[i.state]} (${rel(i.days)})`, tone: stateTone(i.state) },
      ]),
      { size: 7.4, empty: x.noSupplierDates },
    );
    more(d.suppliers.items.length, d.suppliers.itemCount ?? d.suppliers.items.length);
    if (d.suppliers.unconfirmed) w.paragraph(fill(x.unconfirmed, { n: d.suppliers.unconfirmed }), { tone: 'muted', size: 7.4 });
  },
};
