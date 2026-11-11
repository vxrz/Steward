import type { ReportLang, SoaCounts, SoaVersionContent } from '@sm/shared';
import { ReportWriter } from '../reports/pdf/engine.js';
import { translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag, type BrandingInput } from '../reports/common.js';

/**
 * The PDF/A of an approved version of the statement of applicability (ADR 0029 part 2): the approval, the counts and one
 * row per control – applicable and why, the status, how it is met, who is responsible, the owner and the last review,
 * the evidence Steward held when it was submitted. Drawn in the PDF worker from the frozen content (no database).
 */

const TEXTS = {
  en: {
    title: 'Statement of applicability',
    subject: 'Statement of applicability (ISO/IEC 27001 clause 6.1.3 d)',
    catalogue: 'Control catalogue',
    scope: 'Scope',
    allServices: 'all services',
    version: 'Version',
    submitted: 'Submitted',
    approved: 'Approved',
    comment: 'Comment',
    contentSha: 'SHA-256 of the content (soa.json)',
    summary: 'Summary',
    controls: 'Controls',
    applicable: 'Applicable',
    notApplicable: 'Not applicable',
    undecided: 'Undecided',
    implemented: 'Implemented',
    partly: 'Partly implemented',
    planned: 'Planned',
    notStarted: 'Not started',
    reviewDue: 'Not reviewed for 12 months',
    noEvidence: 'Implemented without evidence',
    rows: 'Controls and their applicability',
    control: 'Control',
    applies: 'Applies',
    justification: 'Justification',
    status: 'Status',
    howMet: 'How it is met',
    party: 'Responsible',
    owner: 'Owner',
    evidence: 'Evidence',
    yes: 'yes',
    no: 'no',
    statuses: { implemented: 'implemented', partly: 'partly', planned: 'planned', notStarted: 'not started' } as Record<string, string>,
    parties: { team: 'service team', supplier: 'supplier', central: 'central IT or group', shared: 'shared' } as Record<string, string>,
    coverage: { covered: 'evidence', gap: 'gap', unmapped: 'not mapped', notVisible: 'not visible' } as Record<string, string>,
    reviewed: 'reviewed {date} by {user}',
    grc: 'GRC: {ref}',
    links: 'Links: {n}',
    disclaimer:
      'This statement was recorded in Steward and approved as shown. Steward provides evidence; it does not certify compliance with ISO/IEC 27001 or any other standard – the assessment is up to your organisation and its auditors. The control texts are the ones of the catalogue in Steward.',
    integrity:
      'The signed export of this version (ZIP) holds this PDF, soa.csv, soa.json and manifest.json signed with the installation’s key; check it with: steward evidence verify <file.zip> --fingerprint <fingerprint of the installation’s key>.',
  },
  de: {
    title: 'Erklärung zur Anwendbarkeit',
    subject: 'Erklärung zur Anwendbarkeit (ISO/IEC 27001 Abschnitt 6.1.3 d)',
    catalogue: 'Kontrollkatalog',
    scope: 'Geltungsbereich',
    allServices: 'alle Services',
    version: 'Version',
    submitted: 'Eingereicht',
    approved: 'Freigegeben',
    comment: 'Kommentar',
    contentSha: 'SHA-256 des Inhalts (soa.json)',
    summary: 'Übersicht',
    controls: 'Kontrollen',
    applicable: 'Anwendbar',
    notApplicable: 'Nicht anwendbar',
    undecided: 'Nicht entschieden',
    implemented: 'Umgesetzt',
    partly: 'Teilweise umgesetzt',
    planned: 'Geplant',
    notStarted: 'Nicht begonnen',
    reviewDue: 'Seit 12 Monaten nicht überprüft',
    noEvidence: 'Umgesetzt ohne Nachweis',
    rows: 'Kontrollen und ihre Anwendbarkeit',
    control: 'Kontrolle',
    applies: 'Anwendbar',
    justification: 'Begründung',
    status: 'Status',
    howMet: 'Wie erfüllt',
    party: 'Verantwortlich',
    owner: 'Verantwortliche Person',
    evidence: 'Nachweise',
    yes: 'ja',
    no: 'nein',
    statuses: { implemented: 'umgesetzt', partly: 'teilweise', planned: 'geplant', notStarted: 'nicht begonnen' } as Record<string, string>,
    parties: { team: 'Service-Team', supplier: 'Lieferant', central: 'zentrale IT oder Konzern', shared: 'geteilt' } as Record<string, string>,
    coverage: { covered: 'Nachweise', gap: 'Lücke', unmapped: 'nicht zugeordnet', notVisible: 'nicht sichtbar' } as Record<string, string>,
    reviewed: 'überprüft am {date} von {user}',
    grc: 'GRC: {ref}',
    links: 'Links: {n}',
    disclaimer:
      'Diese Erklärung wurde in Steward erfasst und wie angegeben freigegeben. Steward liefert Nachweise; es bescheinigt keine Konformität mit ISO/IEC 27001 oder anderen Normen – die Bewertung liegt bei Ihrer Organisation und ihren Auditoren. Die Texte der Kontrollen sind die des Katalogs in Steward.',
    integrity:
      'Der signierte Export dieser Version (ZIP) enthält dieses PDF, soa.csv, soa.json und manifest.json, signiert mit dem Schlüssel der Installation; prüfen Sie ihn mit: steward evidence verify <datei.zip> --fingerprint <Fingerabdruck des Schlüssels der Installation>.',
  },
};

export interface SoaPdfModel {
  lang: ReportLang;
  timeZone?: string | null;
  catalogueKey: string;
  catalogue: SoaVersionContent['catalogue'];
  scope: SoaVersionContent['scope'];
  number: number;
  contentSha256: string;
  submittedAt: string;
  submittedBy: string;
  approvedAt: string;
  approvedBy: string;
  comment: string;
  counts: SoaCounts;
  entries: SoaVersionContent['entries'];
}

export async function drawSoaPdf(m: SoaPdfModel, brand: BrandingInput, o: { compress?: boolean } = {}): Promise<Buffer> {
  const L = TEXTS[m.lang] ?? TEXTS.en;
  const tr = translator(m.lang, m.timeZone);
  const branding = brand.branding;
  const heading = `${L.title} – ${m.catalogue.name}`;
  const w = new ReportWriter(
    {
      title: `${heading}, ${L.version} ${m.number}`,
      author: m.approvedBy,
      subject: L.subject,
      keywords: [PRODUCT.split(' ')[0]!, L.title, m.catalogueKey],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.approvedAt),
      custom: { catalogue: m.catalogueKey, version: String(m.number), contentSha256: m.contentSha256, approvedBy: m.approvedBy, approvedAt: m.approvedAt },
    },
    chrome(tr, brand, {
      shortTitle: `${L.title} ${m.catalogueKey}`,
      classification: branding.classification,
      tags: [],
      lines: () => [`${L.version} ${m.number} · ${L.approved} ${tr.dateTime(m.approvedAt)} · ${m.approvedBy}`],
    }),
    { accent: branding.accentColor, compress: o.compress },
  );
  const scope = [m.scope.name, m.scope.services.length ? m.scope.services.join(', ') : L.allServices].filter(Boolean).join(' – ');
  w.cover({ title: L.title, subtitle: m.catalogue.name, meta: [scope, `${L.version} ${m.number}`, `${L.approved} ${tr.dateTime(m.approvedAt)}`] });
  w.section(`1. ${L.summary}`);
  w.keyValues([
    { label: L.catalogue, value: `${m.catalogue.name}${m.catalogue.version ? ` (${m.catalogue.version})` : ''}`, span: 2 },
    { label: L.scope, value: scope, span: 2 },
    { label: L.submitted, value: `${tr.dateTime(m.submittedAt)} · ${m.submittedBy}` },
    { label: L.approved, value: `${tr.dateTime(m.approvedAt)} · ${m.approvedBy}` },
    ...(m.comment ? [{ label: L.comment, value: m.comment, span: 2 as const }] : []),
    { label: L.contentSha, value: m.contentSha256, mono: true, span: 2 },
  ]);
  const c = m.counts;
  w.table(
    [
      { header: '', width: 4 },
      { header: '', width: 1, align: 'right' },
    ],
    [
      [L.controls, String(c.controls)],
      [L.applicable, String(c.applicable)],
      [L.notApplicable, String(c.notApplicable)],
      [L.implemented, String(c.implemented)],
      [L.partly, String(c.partly)],
      [L.planned, String(c.planned)],
      [L.notStarted, String(c.notStarted)],
      [L.reviewDue, String(c.reviewDue)],
      [L.noEvidence, String(c.noEvidence)],
    ],
  );
  w.paragraph(L.disclaimer, { tone: 'muted', size: 8 });

  w.section(`2. ${L.rows}`);
  w.table(
    [
      { header: L.control, width: 3 },
      { header: L.applies, width: 1 },
      { header: L.justification, width: 4 },
      { header: L.status, width: 2 },
      { header: L.howMet, width: 4 },
      { header: L.party, width: 2 },
      { header: L.evidence, width: 2 },
    ],
    m.entries.map((e) => {
      const party = e.party ? `${L.parties[e.party] ?? e.party}${e.supplier ? `: ${e.supplier}` : e.centralName ? `: ${e.centralName}` : ''}` : '–';
      const extra = [
        e.owner ? `${L.owner}: ${e.owner.replace(/^(user|team):/, '')}` : '',
        e.reviewedAt ? L.reviewed.replace('{date}', tr.date(e.reviewedAt)).replace('{user}', e.reviewedBy ?? '') : '',
        e.grcRef ? L.grc.replace('{ref}', e.grcRef) : '',
      ].filter(Boolean);
      return [
        { text: `${e.ref} ${e.title}`, bold: true },
        e.applicable === null ? '–' : e.applicable ? L.yes : L.no,
        e.justification || '–',
        e.status ? (L.statuses[e.status] ?? e.status) : '–',
        [e.howMet, ...extra].filter(Boolean).join('\n') || '–',
        party,
        `${L.coverage[e.coverage.status] ?? e.coverage.status} (${e.coverage.items})${e.evidenceLinks.length ? `\n${L.links.replace('{n}', String(e.evidenceLinks.length))}` : ''}`,
      ];
    }),
    { empty: '–' },
  );
  w.paragraph(L.integrity, { tone: 'muted', size: 8 });
  return w.finish();
}
