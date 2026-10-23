import type { ReportLang } from '@sm/shared';
import { ReportWriter } from '../reports/pdf/engine.js';
import { translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag } from '../reports/common.js';
import { getBranding, logo } from '../reports/branding.js';

/** The PDF/A summary (index.pdf) of an evidence pack: scope, controls with their coverage, contents, how to verify. */

const TEXTS = {
  en: {
    title: 'Audit evidence pack',
    subject: 'Evidence pack',
    scope: 'Scope',
    period: 'Period',
    createdBy: 'Created by',
    createdAt: 'Created at',
    packId: 'Pack',
    controls: 'Controls and evidence',
    control: 'Control',
    status: 'Coverage',
    evidence: 'Evidence',
    covered: 'evidence in the period',
    gap: 'GAP – no evidence in the period',
    unmapped: 'not mapped to any Steward item',
    notVisible: 'NOT VISIBLE – there is evidence, but the creator of this pack may not see it',
    hidden: '{n} hidden',
    filtered:
      'This pack holds only what {user} may see. Evidence they may not see is left out (see the column Evidence) – an auditor or administrator can create a complete pack.',
    contents: 'Contents',
    kind: 'Kind',
    item: 'Item',
    at: 'Date',
    files: 'Files',
    omitted: 'Not included',
    integrity: 'Integrity and verification',
    integrityText:
      'manifest.json lists every file of this pack with its SHA-256 and is signed (manifest.sig, Ed25519) with the key that also signs the audit checkpoints of this installation. Check the pack with: npm run evidence:verify -- <pack.zip> --fingerprint <fingerprint> (or: steward evidence verify …), with the fingerprint of the installation’s key as shown under Audit log → Anchoring outside the database – not the one printed here, which anyone building a pack could choose.',
    keyFingerprint: 'Key fingerprint',
    disclaimer:
      'This pack collects evidence that Steward recorded. It does not certify compliance with ISO/IEC 27001, IEC 62443 or any other standard – the assessment is up to your organisation and its auditors.',
    more: '… and {n} more (see index.json)',
    kinds: {
      run: 'Run',
      record: 'Record',
      accessChange: 'Access change',
      snapshot: 'Access snapshot',
      finding: 'Reconciliation finding',
      report: 'Scheduled report',
      monitor: 'Monitor',
    },
  },
  de: {
    title: 'Audit-Nachweispaket',
    subject: 'Nachweispaket',
    scope: 'Umfang',
    period: 'Zeitraum',
    createdBy: 'Erstellt von',
    createdAt: 'Erstellt am',
    packId: 'Paket',
    controls: 'Kontrollen und Nachweise',
    control: 'Kontrolle',
    status: 'Abdeckung',
    evidence: 'Nachweise',
    covered: 'Nachweise im Zeitraum',
    gap: 'LÜCKE – keine Nachweise im Zeitraum',
    unmapped: 'keinem Steward-Element zugeordnet',
    notVisible: 'NICHT SICHTBAR – es gibt Nachweise, aber der Ersteller dieses Pakets darf sie nicht sehen',
    hidden: '{n} verborgen',
    filtered:
      'Dieses Paket enthält nur, was {user} sehen darf. Nachweise, die nicht sichtbar sind, fehlen (siehe Spalte Nachweise) – Auditoren und Administratoren können ein vollständiges Paket erstellen.',
    contents: 'Inhalt',
    kind: 'Art',
    item: 'Element',
    at: 'Datum',
    files: 'Dateien',
    omitted: 'Nicht enthalten',
    integrity: 'Integrität und Prüfung',
    integrityText:
      'manifest.json führt jede Datei dieses Pakets mit ihrem SHA-256 auf und ist signiert (manifest.sig, Ed25519) – mit dem Schlüssel, der auch die Prüfpunkte des Audit-Logs dieser Installation signiert. Prüfen Sie das Paket mit: npm run evidence:verify -- <paket.zip> --fingerprint <Fingerabdruck> (oder: steward evidence verify …), mit dem Fingerabdruck des Schlüssels der Installation, wie ihn Audit-Log → Verankerung außerhalb der Datenbank zeigt – nicht dem hier gedruckten, den jeder wählen könnte, der ein Paket baut.',
    keyFingerprint: 'Fingerabdruck des Schlüssels',
    disclaimer:
      'Dieses Paket sammelt Nachweise, die Steward aufgezeichnet hat. Es bescheinigt keine Konformität mit ISO/IEC 27001, IEC 62443 oder anderen Normen – die Bewertung liegt bei Ihrer Organisation und ihren Auditoren.',
    more: '… und {n} weitere (siehe index.json)',
    kinds: {
      run: 'Ausführung',
      record: 'Dokument',
      accessChange: 'Zugriffsänderung',
      snapshot: 'Zugriffs-Snapshot',
      finding: 'Abgleich-Befund',
      report: 'Geplanter Bericht',
      monitor: 'Monitor',
    },
  },
};

export interface PackPdfModel {
  id: string;
  title: string;
  scopeLabel: string;
  from: string;
  to: string;
  createdAt: string;
  createdBy: string;
  keyFingerprint: string;
  lang: ReportLang;
  timeZone?: string | null;
  /** Only what the creator may see */
  filtered?: boolean;
  controls: { ref: string; catalogue: string; title: string; status: 'covered' | 'gap' | 'unmapped' | 'notVisible'; count: number; hidden?: number }[];
  items: { kind: string; label: string; at: string; files: number }[];
  omitted: string[];
}

const MAX_ROWS = 400;

export async function renderPackPdf(m: PackPdfModel, o: { compress?: boolean } = {}): Promise<Buffer> {
  const L = TEXTS[m.lang] ?? TEXTS.en;
  const tr = translator(m.lang, m.timeZone);
  const branding = getBranding();
  const brand = { branding, logo: logo().data };
  const period = `${tr.dateTime(m.from)} – ${tr.dateTime(m.to)}`;
  const w = new ReportWriter(
    {
      title: `${m.title}: ${tr.date(m.from)} – ${tr.date(m.to)}`,
      author: m.createdBy,
      subject: L.subject,
      keywords: [PRODUCT.split(' ')[0]!, L.subject, 'ISO/IEC 27001', 'IEC 62443'],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.createdAt),
      custom: { packId: m.id, periodFrom: m.from, periodTo: m.to, keyFingerprint: m.keyFingerprint, generatedBy: m.createdBy, generatedAt: m.createdAt },
    },
    chrome(tr, brand, {
      shortTitle: m.title,
      classification: branding.classification,
      tags: [],
      lines: () => [`${L.packId} ${m.id} · ${period}`, `${L.keyFingerprint}: ${m.keyFingerprint}`],
    }),
    { accent: branding.accentColor, compress: o.compress },
  );
  w.cover({ title: m.title, subtitle: period, meta: [m.scopeLabel, `${L.packId} ${m.id}`, tr.dateTime(m.createdAt)] });
  let n = 0;
  w.section(`${++n}. ${L.scope}`);
  w.keyValues([
    { label: L.scope, value: m.scopeLabel, span: 2 },
    { label: L.period, value: period, span: 2 },
    { label: L.createdBy, value: m.createdBy },
    { label: L.createdAt, value: tr.dateTime(m.createdAt) },
  ]);
  w.paragraph(L.disclaimer, { tone: 'muted', size: 8 });
  if (m.filtered) w.paragraph(L.filtered.replace('{user}', m.createdBy), { tone: 'warning', size: 8.5 });

  if (m.controls.length) {
    w.section(`${++n}. ${L.controls}`);
    w.table(
      [
        { header: L.control, width: 3 },
        { header: L.status, width: 3 },
        { header: L.evidence, width: 1, align: 'right' },
      ],
      m.controls.slice(0, MAX_ROWS).map((c) => [
        { text: `${c.catalogue} ${c.ref} – ${c.title}`, bold: c.status === 'gap' },
        {
          text: L[c.status],
          tone: c.status === 'covered' ? 'success' : c.status === 'gap' ? 'danger' : c.status === 'notVisible' ? 'warning' : 'muted',
          bold: c.status === 'gap',
        },
        c.hidden ? `${c.count} (${L.hidden.replace('{n}', String(c.hidden))})` : String(c.count),
      ]),
    );
    if (m.controls.length > MAX_ROWS) w.paragraph(L.more.replace('{n}', String(m.controls.length - MAX_ROWS)), { tone: 'muted', size: 8 });
  }

  w.section(`${++n}. ${L.contents}`);
  w.table(
    [
      { header: L.kind, width: 2 },
      { header: L.item, width: 5 },
      { header: L.at, width: 2 },
      { header: L.files, width: 1, align: 'right' },
    ],
    m.items.slice(0, MAX_ROWS).map((i) => [L.kinds[i.kind as keyof typeof L.kinds] ?? i.kind, i.label, tr.dateTime(i.at), String(i.files)]),
    { empty: '–' },
  );
  if (m.items.length > MAX_ROWS) w.paragraph(L.more.replace('{n}', String(m.items.length - MAX_ROWS)), { tone: 'muted', size: 8 });
  if (m.omitted.length) {
    w.subheading(L.omitted, 'warning');
    for (const x of m.omitted.slice(0, 50)) w.paragraph(`• ${x}`, { size: 8 });
  }

  w.section(`${n + 1}. ${L.integrity}`);
  w.paragraph(L.integrityText, { size: 8.5 });
  w.keyValues([{ label: L.keyFingerprint, value: m.keyFingerprint, mono: true, span: 2 }]);
  return w.finish();
}
