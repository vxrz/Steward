import { CONTROL_POINTS, controlPoint, type ReportLang } from '@sm/shared';
import { ReportWriter } from '../reports/pdf/engine.js';
import { translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag, type BrandingInput } from '../reports/common.js';
import type { ModuleAccessEvidence } from '../modules/access-evidence.js';

/**
 * The assurance report as PDF/A (#210, compliance/assurance-report.ts collects the model): the policy in force in a
 * period and its changes, per control point the events and how they were confirmed, and the exceptions. Drawn from
 * collected data only (it runs in the PDF worker, reports/pdf/drawers.ts).
 */

export interface AssuranceReportModel {
  from: string;
  to: string;
  generatedAt: string;
  generatedBy: string;
  lang: ReportLang;
  timeZone?: string | null;
  /** The policy version at the start and at the end of the period */
  startVersion: number;
  endVersion: number;
  /** The rules at the end of the period */
  rules: { point: string; fourEyes: string | null; stepUp: boolean; maxAgeMinutes: number | null; mfa: boolean; baseline: boolean }[];
  windowMinutes: number;
  /** Versions that took effect in the period */
  versions: { version: number; at: string; by: string; approvedBy: string | null; changes: string[] }[];
  /** Requests to loosen it (approved, rejected, withdrawn, expired, still pending) */
  requests: { at: string; by: string; outcome: string; decidedBy: string | null; changes: string[] }[];
  /** Per control point: events and how they were confirmed */
  points: { point: string; events: number; methods: Record<string, number>; fourEyes: number }[];
  exceptions: { kind: 'emergencySignIn' | 'emergencyConfirmation' | 'mfaRefused' | 'mfaMissing' | 'loosening'; at: string; actor: string; text: string }[];
  /** Audit entries read, and entries that failed their check (left out) */
  audit: { entries: number; rejected: number };
  truncated: boolean;
  /** Who uses each restricted module now, and the changes of module access in the period (ADR 0034) */
  moduleAccess?: Pick<ModuleAccessEvidence, 'current' | 'changes'>;
}

/** Labels of the control points in the report's language (the web app has its own, web/src/locales/<lang>/assurance.json). */
export const POINT_LABELS: Record<ReportLang, Record<string, string>> = {
  en: {
    'apiToken.create': 'Create an API token',
    'user.create': 'Create an account with roles',
    'user.change': "Change an account's roles or sign-in",
    'user.resetPassword': 'Reset a password',
    'user.pseudonymise': "Replace a person's data by a pseudonym",
    'team.members': 'Add team members or roles in a team',
    'access.grant': 'Give rights in an access list',
    'sso.providers': 'Add, change or delete a sign-in provider',
    'signIn.settings': 'Change sign-in, outbound or four-eyes settings',
    'vault.passphrase': 'Change the master passphrase',
    'assurance.policy': 'Change the assurance policy',
    'accessCheck.decide': 'Document or dismiss access check findings',
    'personReview.decide': 'Submit and approve person access reviews',
    'audit.anchoring': 'Change audit anchoring and archiving',
    'audit.export': 'Export the audit log',
    'evidencePack.export': 'Export an evidence pack',
    'credentials.export': 'Export the credential register',
    'personalData.export': "Export a person's data",
    'correctiveAction.verify': 'Check that a corrective action worked',
    'soa.approve': 'Approve a version of the statement of applicability',
    'record.approve': 'Approve or reject a document',
    'document.reviewOwner': 'Make oneself the review owner of a document',
    'firewallChange.close': 'Close a firewall change',
    'run.decide': 'Decide an approval in a run',
    'sync.sources': 'Change a Git sync source',
    'library.publishers': 'Trust a library publisher',
    'library.install': 'Install a library release',
    'manualStep.verify': 'Verify a manual step',
    'duty.skip': 'Decide an exception of a service duty',
    'mcp.write': 'Approve a changing call of an AI assistant',
    'mcp.allowWrites': 'Let AI assistants request changing calls',
    'mcp.allowClient': 'Allow an AI assistant (MCP client)',
    'ai.budget': 'Raise an AI token budget',
    'catalogue.ciaScale': 'Change the CIA scale',
    'cost.budget': 'Raise a cost budget',
    'notifications.delivery': 'Change where notifications go',
    'teams.bot': 'Decide with the Teams bot',
    'backup.settings': 'Change the backups',
    'export.settings': 'Change the exports',
    'platform.destination': "Send a platform's credentials to a new address",
    'migration.export': 'Export this instance',
    'migration.apply': 'Import an instance',
    'plant.mapSource': 'Change where the map of sites fetches its tiles',
    'plant.advisorySources': 'Change where security advisories are read from',
    'modules.switch': 'Switch a module on or off',
    'plant.renameId': 'Change the id of a plant entry',
    'plant.bulkChange': 'Change many plant entries at once',
    'plant.changeSet': 'Apply changes to the plant registry (second person)',
    'platform.privilegedIdentity': 'Use a privileged platform identity',
  },
  de: {
    'apiToken.create': 'Ein API-Token erstellen',
    'user.create': 'Ein Konto mit Rollen anlegen',
    'user.change': 'Rollen oder Anmeldung eines Kontos ändern',
    'user.resetPassword': 'Ein Passwort zurücksetzen',
    'user.pseudonymise': 'Daten einer Person durch ein Pseudonym ersetzen',
    'team.members': 'Teammitglieder oder Rollen in einem Team hinzufügen',
    'access.grant': 'Rechte in einer Zugriffsliste vergeben',
    'sso.providers': 'Einen Anmeldeanbieter hinzufügen, ändern oder löschen',
    'signIn.settings': 'Anmelde-, Ausgangs- oder Vier-Augen-Einstellungen ändern',
    'vault.passphrase': 'Die Master-Passphrase ändern',
    'assurance.policy': 'Die Absicherungsrichtlinie ändern',
    'accessCheck.decide': 'Befunde von Zugriffsprüfungen dokumentieren oder verwerfen',
    'personReview.decide': 'Personenprüfungen einreichen und freigeben',
    'audit.anchoring': 'Verankerung und Archivierung des Audit-Logs ändern',
    'audit.export': 'Das Audit-Log exportieren',
    'evidencePack.export': 'Ein Nachweispaket exportieren',
    'credentials.export': 'Das Zugangsdatenregister exportieren',
    'personalData.export': 'Daten einer Person exportieren',
    'correctiveAction.verify': 'Die Wirksamkeit einer Korrekturmaßnahme prüfen',
    'soa.approve': 'Eine Version der Erklärung zur Anwendbarkeit freigeben',
    'record.approve': 'Ein Dokument freigeben oder ablehnen',
    'document.reviewOwner': 'Sich selbst als Verantwortlichen der Überprüfung eines Dokuments eintragen',
    'firewallChange.close': 'Eine Firewall-Änderung abschließen',
    'run.decide': 'Über eine Freigabe in einer Ausführung entscheiden',
    'sync.sources': 'Eine Git-Sync-Quelle ändern',
    'library.publishers': 'Einem Bibliotheksherausgeber vertrauen',
    'library.install': 'Eine Bibliotheksversion installieren',
    'manualStep.verify': 'Einen manuellen Schritt prüfen',
    'duty.skip': 'Über eine Ausnahme einer Servicepflicht entscheiden',
    'mcp.write': 'Einen ändernden Aufruf eines KI-Assistenten freigeben',
    'mcp.allowWrites': 'KI-Assistenten ändernde Aufrufe anfragen lassen',
    'mcp.allowClient': 'Einen KI-Assistenten (MCP-Client) zulassen',
    'ai.budget': 'Ein KI-Token-Budget erhöhen',
    'catalogue.ciaScale': 'Die CIA-Skala ändern',
    'cost.budget': 'Ein Kostenbudget erhöhen',
    'notifications.delivery': 'Ändern, wohin Benachrichtigungen gehen',
    'teams.bot': 'Mit dem Teams-Bot entscheiden',
    'backup.settings': 'Die Sicherungen ändern',
    'export.settings': 'Die Exporte ändern',
    'platform.destination': 'Die Zugangsdaten einer Plattform an eine neue Adresse senden',
    'migration.export': 'Diese Instanz exportieren',
    'migration.apply': 'Eine Instanz importieren',
    'plant.mapSource': 'Ändern, woher die Standortkarte ihre Kacheln holt',
    'plant.advisorySources': 'Ändern, woher Sicherheitshinweise gelesen werden',
    'modules.switch': 'Ein Modul ein- oder ausschalten',
    'plant.renameId': 'Kennung eines Anlageneintrags ändern',
    'plant.bulkChange': 'Viele Anlageneinträge auf einmal ändern',
    'plant.changeSet': 'Änderungen am Anlagenregister übernehmen (zweite Person)',
    'platform.privilegedIdentity': 'Eine privilegierte Plattform-Identität verwenden',
  },
};

const TEXTS = {
  en: {
    title: 'Assurance report',
    subject: 'Assurance policy and how it was met',
    period: 'Period',
    createdBy: 'Created by',
    createdAt: 'Created at',
    policy: 'Policy in force',
    policyText:
      'The rules at the end of the period (version {end}; at the start: version {start}). Locked rules are the baseline that cannot be lowered. A step-up without an age lasts {window} minutes (SM_STEP_UP_MINUTES). Single items (a process step, a platform, a person review) can add four-eyes on top.',
    point: 'Control point',
    fourEyes: 'Four-eyes',
    stepUp: 'Step-up',
    mfa: 'MFA',
    baseline: 'baseline',
    yes: 'yes',
    no: 'no',
    maxAge: '{n} min',
    levels: { off: 'off', optional: 'per item', required: 'required' } as Record<string, string>,
    changes: 'Changes of the policy in the period',
    noChanges: 'The policy did not change in the period.',
    version: 'Version',
    at: 'Date',
    by: 'Changed by',
    approvedBy: 'Approved by',
    what: 'What changed',
    requests: 'Requests to loosen the policy',
    outcome: 'Outcome',
    outcomes: { pending: 'waiting', approved: 'approved', rejected: 'rejected', withdrawn: 'withdrawn', expired: 'expired' } as Record<string, string>,
    events: 'Events per control point',
    eventsText:
      'Each event is an audit entry that names the control point, the rule in force and how it was met (the confirmation method, the identity provider’s auth_time and amr/acr, the session, and for four-eyes who asked and who decided).',
    count: 'Events',
    methods: 'Confirmed with',
    fourEyesCount: 'Four-eyes',
    noEvents: 'No events in the period.',
    method: {
      password: 'password',
      sso: 'single sign-on',
      'sso+mfa': 'single sign-on with MFA',
      emergency: 'emergency access',
      notRequired: 'not required',
    } as Record<string, string>,
    exceptions: 'Exceptions',
    noExceptions: 'No exceptions in the period.',
    kind: 'Kind',
    actor: 'Person',
    details: 'Details',
    kinds: {
      emergencySignIn: 'Emergency sign-in',
      emergencyConfirmation: 'Confirmed by emergency access',
      mfaRefused: 'Refused: no MFA',
      mfaMissing: 'Without MFA where required',
      loosening: 'Loosened (second administrator)',
    } as Record<string, string>,
    modules: 'Module access',
    modulesText:
      'Who uses the modules restricted to selected teams and users at the end of the period, and every change of module access in it (access.module_access_changed). Every other module is used by everyone signed in; administrators and auditors use every module. Widening is confirmed with a step-up (Give rights in an access list), narrowing in the dialog.',
    module: 'Module',
    usedBy: 'Used by',
    noRestricted: 'No module is restricted: everyone signed in uses every module that is on.',
    noModuleChanges: 'Module access did not change in the period.',
    moduleChanges: 'Changes in the period',
    mode: { everyone: 'everyone signed in', selected: 'selected teams and users' } as Record<string, string>,
    granted: 'Added',
    removed: 'Removed',
    confirmedStepUp: 'step-up',
    confirmedDialog: 'dialog',
    nobody: 'administrators and auditors only',
    moduleNames: {} as Record<string, string>,
    integrity: 'Basis',
    integrityText:
      'Built from {n} authentic entries of the audit log (HMAC chain with signed checkpoints, ADR 0003). {rejected} entries did not pass their check and are left out. The audit log export of the same period lets an auditor check every count.',
    truncated: 'The period has more entries than one report can hold; the counts cover the first ones only – choose a shorter period.',
    disclaimer:
      'This report shows what Steward enforced and recorded. It does not certify compliance with ISO/IEC 27001 or any other standard (example mappings: A.5.3 segregation of duties, A.8.5 secure authentication, A.8.32 change management).',
  },
  de: {
    title: 'Absicherungsbericht',
    subject: 'Absicherungsrichtlinie und ihre Einhaltung',
    period: 'Zeitraum',
    createdBy: 'Erstellt von',
    createdAt: 'Erstellt am',
    policy: 'Geltende Richtlinie',
    policyText:
      'Die Regeln am Ende des Zeitraums (Version {end}; zu Beginn: Version {start}). Gesperrte Regeln sind die Grundlinie, die sich nicht absenken lässt. Eine erneute Bestätigung ohne eigenes Alter gilt {window} Minuten (SM_STEP_UP_MINUTES). Einzelne Elemente (ein Prozessschritt, eine Plattform, eine Personenprüfung) können das Vier-Augen-Prinzip zusätzlich verlangen.',
    point: 'Kontrollpunkt',
    fourEyes: 'Vier Augen',
    stepUp: 'Bestätigung',
    mfa: 'MFA',
    baseline: 'Grundlinie',
    yes: 'ja',
    no: 'nein',
    maxAge: '{n} Min.',
    levels: { off: 'aus', optional: 'je Element', required: 'verlangt' } as Record<string, string>,
    changes: 'Änderungen der Richtlinie im Zeitraum',
    noChanges: 'Die Richtlinie hat sich im Zeitraum nicht geändert.',
    version: 'Version',
    at: 'Datum',
    by: 'Geändert von',
    approvedBy: 'Freigegeben von',
    what: 'Was sich geändert hat',
    requests: 'Anträge, die Richtlinie zu lockern',
    outcome: 'Ergebnis',
    outcomes: { pending: 'offen', approved: 'freigegeben', rejected: 'abgelehnt', withdrawn: 'zurückgezogen', expired: 'abgelaufen' } as Record<string, string>,
    events: 'Ereignisse je Kontrollpunkt',
    eventsText:
      'Jedes Ereignis ist ein Eintrag im Audit-Log, der den Kontrollpunkt, die geltende Regel und ihre Erfüllung nennt (die Art der Bestätigung, auth_time und amr/acr des Identitätsanbieters, die Sitzung und beim Vier-Augen-Prinzip, wer beantragt und wer entschieden hat).',
    count: 'Ereignisse',
    methods: 'Bestätigt mit',
    fourEyesCount: 'Vier Augen',
    noEvents: 'Keine Ereignisse im Zeitraum.',
    method: {
      password: 'Passwort',
      sso: 'Single Sign-on',
      'sso+mfa': 'Single Sign-on mit MFA',
      emergency: 'Notfallzugang',
      notRequired: 'nicht verlangt',
    } as Record<string, string>,
    exceptions: 'Ausnahmen',
    noExceptions: 'Keine Ausnahmen im Zeitraum.',
    kind: 'Art',
    actor: 'Person',
    details: 'Einzelheiten',
    kinds: {
      emergencySignIn: 'Notfallanmeldung',
      emergencyConfirmation: 'Mit Notfallzugang bestätigt',
      mfaRefused: 'Abgelehnt: keine MFA',
      mfaMissing: 'Ohne MFA, wo verlangt',
      loosening: 'Gelockert (zweiter Administrator)',
    } as Record<string, string>,
    modules: 'Modulzugriff',
    modulesText:
      'Wer die auf ausgewählte Teams und Benutzer beschränkten Module am Ende des Zeitraums nutzt, und jede Änderung des Modulzugriffs im Zeitraum (access.module_access_changed). Alle anderen Module nutzen alle angemeldeten Personen; Administratoren und Auditoren nutzen jedes Modul. Eine Erweiterung wird mit einer erneuten Bestätigung bestätigt (Rechte in einer Zugriffsliste vergeben), eine Einschränkung im Dialog.',
    module: 'Modul',
    usedBy: 'Genutzt von',
    noRestricted: 'Kein Modul ist beschränkt: Alle angemeldeten Personen nutzen jedes eingeschaltete Modul.',
    noModuleChanges: 'Der Modulzugriff hat sich im Zeitraum nicht geändert.',
    moduleChanges: 'Änderungen im Zeitraum',
    mode: { everyone: 'alle angemeldeten Personen', selected: 'ausgewählte Teams und Benutzer' } as Record<string, string>,
    granted: 'Hinzugefügt',
    removed: 'Entfernt',
    confirmedStepUp: 'Bestätigung',
    confirmedDialog: 'Dialog',
    nobody: 'nur Administratoren und Auditoren',
    moduleNames: {
      compliance: 'Compliance und Nachweise',
      scorecard: 'Scorecard',
      costs: 'Kosten',
      dataContracts: 'Datenverträge',
      ai: 'KI-Modelle',
      teamsBot: 'Freigaben in Microsoft Teams',
      libraries: 'Gemeinsame Prozessbibliotheken',
      versionWatch: 'Versionsbeobachtung und Lebensende',
      changedetection: 'changedetection.io',
      plant: 'Werksregister',
    } as Record<string, string>,
    integrity: 'Grundlage',
    integrityText:
      'Erstellt aus {n} echten Einträgen des Audit-Logs (HMAC-Kette mit signierten Prüfpunkten, ADR 0003). {rejected} Einträge haben ihre Prüfung nicht bestanden und fehlen. Mit dem Export des Audit-Logs desselben Zeitraums kann ein Auditor jede Zahl nachprüfen.',
    truncated: 'Der Zeitraum hat mehr Einträge, als ein Bericht fassen kann; die Zahlen umfassen nur die ersten – wählen Sie einen kürzeren Zeitraum.',
    disclaimer:
      'Dieser Bericht zeigt, was Steward durchgesetzt und aufgezeichnet hat. Er bescheinigt keine Konformität mit ISO/IEC 27001 oder anderen Normen (Beispielzuordnungen: A.5.3 Aufgabentrennung, A.8.5 sichere Authentisierung, A.8.32 Änderungssteuerung).',
  },
};

const MAX_ROWS = 400;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? ''));

export async function drawAssurancePdf(m: AssuranceReportModel, brand: BrandingInput, o: { compress?: boolean } = {}): Promise<Buffer> {
  const L = TEXTS[m.lang] ?? TEXTS.en;
  const labels = POINT_LABELS[m.lang] ?? POINT_LABELS.en;
  const label = (k: string) => labels[k] ?? k;
  const tr = translator(m.lang, m.timeZone);
  const branding = brand.branding;
  const period = `${tr.dateTime(m.from)} – ${tr.dateTime(m.to)}`;
  const w = new ReportWriter(
    {
      title: `${L.title}: ${tr.date(m.from)} – ${tr.date(m.to)}`,
      author: m.generatedBy,
      subject: L.subject,
      keywords: [PRODUCT.split(' ')[0]!, L.subject, 'ISO/IEC 27001'],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.generatedAt),
      custom: { periodFrom: m.from, periodTo: m.to, policyVersion: String(m.endVersion), generatedBy: m.generatedBy, generatedAt: m.generatedAt },
    },
    chrome(tr, brand, { shortTitle: L.title, classification: branding.classification, tags: [], lines: () => [period] }),
    { accent: branding.accentColor, compress: o.compress },
  );
  w.cover({ title: L.title, subtitle: period, meta: [`${L.createdBy}: ${m.generatedBy}`, tr.dateTime(m.generatedAt)] });
  let n = 0;
  w.paragraph(L.disclaimer, { tone: 'muted', size: 8 });
  if (m.truncated) w.paragraph(L.truncated, { tone: 'warning', size: 8.5 });

  w.section(`${++n}. ${L.policy}`);
  w.paragraph(fill(L.policyText, { start: m.startVersion, end: m.endVersion, window: m.windowMinutes }), { size: 8.5 });
  const order = new Map(CONTROL_POINTS.map((p, i) => [p.key, i]));
  w.table(
    [
      { header: L.point, width: 5 },
      { header: L.fourEyes, width: 2 },
      { header: L.stepUp, width: 2 },
      { header: L.mfa, width: 1 },
    ],
    [...m.rules]
      .sort((a, b) => (order.get(a.point) ?? 0) - (order.get(b.point) ?? 0))
      .map((r) => [
        { text: `${label(r.point)}${r.baseline ? ` (${L.baseline})` : ''}`, bold: r.baseline },
        r.fourEyes ? (L.levels[r.fourEyes] ?? r.fourEyes) : '–',
        !controlPoint(r.point)?.supports.stepUp ? '–' : r.stepUp ? (r.maxAgeMinutes ? fill(L.maxAge, { n: r.maxAgeMinutes }) : L.yes) : L.no,
        r.stepUp ? (r.mfa ? L.yes : L.no) : '–',
      ]),
  );

  w.section(`${++n}. ${L.changes}`);
  if (!m.versions.length) w.paragraph(L.noChanges, { size: 9 });
  else
    w.table(
      [
        { header: L.version, width: 1, align: 'right' },
        { header: L.at, width: 2 },
        { header: L.by, width: 2 },
        { header: L.approvedBy, width: 2 },
        { header: L.what, width: 5 },
      ],
      m.versions.slice(0, MAX_ROWS).map((v) => [String(v.version), tr.dateTime(v.at), v.by, v.approvedBy ?? '–', v.changes.join('\n')]),
    );
  if (m.requests.length) {
    w.subheading(L.requests);
    w.table(
      [
        { header: L.at, width: 2 },
        { header: L.by, width: 2 },
        { header: L.outcome, width: 2 },
        { header: L.what, width: 5 },
      ],
      m.requests
        .slice(0, MAX_ROWS)
        .map((r) => [tr.dateTime(r.at), r.by, `${L.outcomes[r.outcome] ?? r.outcome}${r.decidedBy ? ` (${r.decidedBy})` : ''}`, r.changes.join('\n')]),
    );
  }

  w.section(`${++n}. ${L.events}`);
  w.paragraph(L.eventsText, { tone: 'muted', size: 8 });
  if (!m.points.length) w.paragraph(L.noEvents, { size: 9 });
  else
    w.table(
      [
        { header: L.point, width: 5 },
        { header: L.count, width: 1, align: 'right' },
        { header: L.methods, width: 4 },
        { header: L.fourEyesCount, width: 1, align: 'right' },
      ],
      [...m.points]
        .sort((a, b) => (order.get(a.point) ?? 0) - (order.get(b.point) ?? 0))
        .map((p) => [
          label(p.point),
          String(p.events),
          Object.entries(p.methods)
            .filter(([, c]) => c > 0)
            .map(([k, c]) => `${L.method[k] ?? k}: ${c}`)
            .join(', ') || '–',
          String(p.fourEyes),
        ]),
    );

  w.section(`${++n}. ${L.exceptions}`);
  if (!m.exceptions.length) w.paragraph(L.noExceptions, { size: 9, tone: 'success' });
  else
    w.table(
      [
        { header: L.kind, width: 3 },
        { header: L.at, width: 2 },
        { header: L.actor, width: 2 },
        { header: L.details, width: 5 },
      ],
      m.exceptions
        .slice(0, MAX_ROWS)
        .map((e) => [{ text: L.kinds[e.kind] ?? e.kind, tone: e.kind === 'loosening' ? 'info' : 'warning' }, tr.dateTime(e.at), e.actor, e.text]),
    );

  if (m.moduleAccess) {
    const ma = m.moduleAccess;
    const moduleName = (id: string, name: string) => L.moduleNames[id] ?? name;
    const subjects = (xs: string[]) => xs.join(', ') || '–';
    w.section(`${++n}. ${L.modules}`);
    w.paragraph(L.modulesText, { tone: 'muted', size: 8 });
    if (!ma.current.length) w.paragraph(L.noRestricted, { size: 9 });
    else
      w.table(
        [
          { header: L.module, width: 3 },
          { header: L.usedBy, width: 6 },
          { header: L.at, width: 2 },
        ],
        ma.current.map((c) => [moduleName(c.module, c.name), c.subjects.join(', ') || L.nobody, c.updatedAt ? `${tr.dateTime(c.updatedAt)}${c.updatedBy ? ` (${c.updatedBy})` : ''}` : '–']),
      );
    w.subheading(L.moduleChanges);
    if (!ma.changes.length) w.paragraph(L.noModuleChanges, { size: 9 });
    else
      w.table(
        [
          { header: L.at, width: 2 },
          { header: L.actor, width: 2 },
          { header: L.module, width: 2 },
          { header: L.what, width: 5 },
          { header: L.stepUp, width: 1 },
        ],
        ma.changes
          .slice(0, MAX_ROWS)
          .map((c) => [
            tr.dateTime(c.at),
            c.actor,
            moduleName(c.module, c.name),
            [
              c.before !== c.after ? `${L.mode[c.before] ?? c.before} → ${L.mode[c.after] ?? c.after}` : (L.mode[c.after] ?? c.after),
              c.granted.length ? `${L.granted}: ${subjects(c.granted)}` : '',
              c.removed.length ? `${L.removed}: ${subjects(c.removed)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            c.confirmed ? L.confirmedStepUp : L.confirmedDialog,
          ]),
      );
  }

  w.section(`${n + 1}. ${L.integrity}`);
  w.paragraph(fill(L.integrityText, { n: m.audit.entries, rejected: m.audit.rejected }), { size: 8.5 });
  return w.finish();
}
