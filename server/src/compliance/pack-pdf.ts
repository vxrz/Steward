import type { ReportLang } from '@sm/shared';
import { ReportWriter } from '../reports/pdf/engine.js';
import { translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag } from '../reports/common.js';
import { getBranding, logo } from '../reports/branding.js';
import { CIA_DIMENSIONS } from '@sm/shared';
import type { PackCatalogue, PackRating } from '../catalogue/evidence.js';

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
    protection: 'Protection need (CIA)',
    protectionText:
      'Per dimension, a service needs the highest protection of its applications (maximum principle, BSI-Standard 200-2), unless the service sets it with a reason (cumulation or distribution effect). As rated when this pack was built.',
    dimension: 'Dimension',
    need: 'Protection need',
    basis: 'Basis',
    derived: 'derived from {rated} of {total} rated applications (maximum principle)',
    overridden: 'set by {user} (derived: {derived}): {reason}',
    notRated: 'not rated',
    needsRerating: 'needs re-rating',
    stale: '{n} rating(s) need re-rating after a scale change',
    archived: '{n} archived application(s) not counted',
    applications: 'Applications',
    application: 'Application',
    role: 'Role',
    platformApplication: 'The platform belongs to the application {name}.',
    noApplication: 'The platform belongs to no application of the service catalogue.',
    dimensions: { confidentiality: 'Confidentiality', integrity: 'Integrity', availability: 'Availability' },
    roles: { primary: 'primary', dependency: 'dependency', other: 'other' },
    builtinLevels: { normal: 'Normal', high: 'High', very_high: 'Very high' } as Record<string, string>,
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
    protection: 'Schutzbedarf (CIA)',
    protectionText:
      'Ein Service hat je Grundwert den höchsten Schutzbedarf seiner Anwendungen (Maximumprinzip, BSI-Standard 200-2), außer der Service legt ihn mit einer Begründung fest (Kumulations- oder Verteilungseffekt). Stand: Erstellung dieses Pakets.',
    dimension: 'Grundwert',
    need: 'Schutzbedarf',
    basis: 'Grundlage',
    derived: 'abgeleitet aus {rated} von {total} bewerteten Anwendungen (Maximumprinzip)',
    overridden: 'festgelegt von {user} (abgeleitet: {derived}): {reason}',
    notRated: 'nicht bewertet',
    needsRerating: 'Neubewertung nötig',
    stale: '{n} Bewertung(en) nach einer Änderung der Skala neu zu bewerten',
    archived: '{n} archivierte Anwendung(en) nicht berücksichtigt',
    applications: 'Anwendungen',
    application: 'Anwendung',
    role: 'Rolle',
    platformApplication: 'Die Plattform gehört zur Anwendung {name}.',
    noApplication: 'Die Plattform gehört zu keiner Anwendung des Servicekatalogs.',
    dimensions: { confidentiality: 'Vertraulichkeit', integrity: 'Integrität', availability: 'Verfügbarkeit' },
    roles: { primary: 'primär', dependency: 'Abhängigkeit', other: 'sonstige' },
    builtinLevels: { normal: 'normal', high: 'hoch', very_high: 'sehr hoch' } as Record<string, string>,
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
  /** Service and platform packs: the protection need of the service, or the platform's application */
  catalogue?: PackCatalogue | null;
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

  const cat = m.catalogue;
  if (cat && (cat.service || cat.application !== undefined)) {
    // built-in (BSI) levels in the pack's language; custom levels as the administrator named them
    const level = (key: string | null, label: string | null) =>
      !key ? L.notRated : cat.scale.mode === 'default' ? (L.builtinLevels[key] ?? label ?? key) : (label ?? key);
    const rating = (r: PackRating | null) => (r ? `${level(r.level, r.label)}${r.needsRerating ? ` (${L.needsRerating})` : ''}` : L.notRated);
    w.section(`${++n}. ${L.protection}`);
    w.paragraph(L.protectionText, { tone: 'muted', size: 8 });
    if (cat.service) {
      const need = cat.service.protectionNeed;
      w.table(
        [
          { header: L.dimension, width: 2 },
          { header: L.need, width: 2 },
          { header: L.basis, width: 6 },
        ],
        CIA_DIMENSIONS.map((d) => {
          const x = need[d];
          const basis = x.override
            ? L.overridden.replace('{user}', x.override.setBy).replace('{derived}', level(x.derived, x.derivedLabel)).replace('{reason}', x.override.reason)
            : L.derived.replace('{rated}', String(x.rated)).replace('{total}', String(x.total));
          const notCounted = [
            x.needsRerating ? L.stale.replace('{n}', String(x.needsRerating)) : '',
            x.archived ? L.archived.replace('{n}', String(x.archived)) : '',
          ].filter(Boolean);
          return [
            L.dimensions[d],
            { text: level(x.effective, x.effectiveLabel), bold: true },
            notCounted.length ? `${basis} – ${notCounted.join(', ')}` : basis,
          ];
        }),
      );
      if (cat.service.applications.length) {
        w.subheading(L.applications);
        w.table(
          [{ header: L.application, width: 3 }, { header: L.role, width: 2 }, ...CIA_DIMENSIONS.map((d) => ({ header: L.dimensions[d], width: 2 }))],
          cat.service.applications
            .slice(0, MAX_ROWS)
            .map((a) => [
              a.name,
              a.role === 'other' ? a.roleText : a.role ? L.roles[a.role as keyof typeof L.roles] : '–',
              ...CIA_DIMENSIONS.map((d) => rating(a.rating[d])),
            ]),
        );
      }
    } else if (cat.application) {
      w.paragraph(L.platformApplication.replace('{name}', cat.application.name), { size: 9 });
      w.table(
        [
          { header: L.dimension, width: 2 },
          { header: L.need, width: 2 },
          { header: L.basis, width: 6 },
        ],
        CIA_DIMENSIONS.map((d) => {
          const r = cat.application!.rating[d];
          return [L.dimensions[d], { text: rating(r), bold: true }, r ? `${r.justification} (${r.ratedBy})` : '–'];
        }),
      );
    } else w.paragraph(L.noApplication, { size: 9 });
  }

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
