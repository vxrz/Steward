import type { ReportLang } from '@sm/shared';

/**
 * Strings of the PDF reports (English and German). Kept separate from the web
 * UI translations: reports are archived documents and their wording is part
 * of what is signed, so it changes deliberately and rarely.
 */
const en = {
  runReport: 'Run report',
  summaryReport: 'Summary report',
  interimTag: 'Interim',
  dryRunTag: 'Dry run',
  reportNo: 'Report {id}',
  version: 'Version {n}',
  generatedWith: 'Generated with {product}',
  pageOf: 'Page {n} of {total}',
  footerRun: 'Run {runId} · generated {date} by {user} · report {reportId}',
  footerSummary: '{count} process(es), {from} – {to} · generated {date} by {user} · report {reportId}',
  footerHash: 'Protocol hash (sealed fingerprint of the run journal): {hash}',
  footerVerify: 'Verify: the SHA-256 of this file is in the audit log (report.generated, {reportId}) · Audit log → Verify chain (GET /api/audit/verify)',
  footerVerifySummary: 'Verify: the SHA-256 of this file is in the audit log (report.generated, {reportId}) · Audit log → Verify chain (GET /api/audit/verify)',

  dryRunTitle: 'DRY RUN – nothing was changed',
  dryRunBody:
    'Read calls were executed; write calls (POST/PUT/PATCH/DELETE) were only recorded and not sent to the platform. The changes listed below show what would have been changed.',
  interimTitle: 'INTERIM REPORT – the run has not finished',
  interimBody:
    'Status at the time of this report: {status}. Results, decisions and the sealed protocol hash may still change. Generate a new report when the run has finished.',
  failedTitle: 'The run failed',
  cancelledTitle: 'The run was cancelled',
  modifiedTitle: 'WARNING: the run journal was modified after completion',
  modifiedBody:
    'The protocol hash recorded in the audit log when the run finished does not match the current journal. Treat the content of this report with caution and check the audit log.',

  summary: 'Summary',
  process: 'Process',
  processVersion: 'Version',
  definitionHash: 'Definition hash',
  runId: 'Run ID',
  trigger: 'Trigger',
  startedBy: 'Started by',
  started: 'Started',
  finished: 'Finished',
  duration: 'Duration',
  status: 'Status',
  dryRun: 'Dry run',
  yes: 'Yes',
  no: 'No',
  none: 'None',
  notFinished: 'not finished',
  parentRun: 'Started by run',
  schedule: 'Schedule',
  connections: 'Platforms used',
  slot: 'Connection slot',
  platform: 'Platform',
  kind: 'Kind',
  environment: 'Environment',
  inputs: 'Inputs',
  input: 'Input',
  value: 'Value',
  processDescription: 'About this process',

  atAGlance: 'Results at a glance',
  statSteps: 'Steps executed',
  statFailedSteps: 'Failed steps',
  statChanges: 'Changes made',
  statSimulated: 'Simulated changes',
  statChecksPassed: 'Checks passed',
  statChecksFailed: 'Checks failed',
  statDecisions: 'Decisions',

  whatWasDone: 'What was done',
  stepsIntro: 'Every executed step in order, as recorded in the run journal.',
  time: 'Time',
  step: 'Step',
  type: 'Type',
  result: 'Result',
  stepsTruncated: '{n} further steps are not listed. The complete journal is in the JSON protocol of the run.',

  changes: 'Changes (write operations)',
  changesIntro: 'Calls that create, change or delete data on a platform.',
  changesIntroDry: 'Dry run: these calls were not executed.',
  method: 'Method',
  request: 'Request',
  httpStatus: 'HTTP status',
  notExecuted: 'Simulated – not executed',
  noChanges: 'No write operations.',

  decisions: 'Decisions and approvals',
  noDecisions: 'This run did not ask for any decision.',
  decisionApprove: 'Approval',
  decisionSelect: 'Selection',
  decidedBy: 'Decided by',
  decidedAt: 'Decided at',
  outcome: 'Outcome',
  approved: 'Approved',
  rejected: 'Rejected',
  selectedOf: '{n} of {total} selected',
  openDecision: 'Open – waiting for a decision',
  cancelledDecision: 'Cancelled',
  assignedTo: 'Assigned to',
  anyone: 'Anyone allowed to run or approve the process',
  fourEyes: 'Four-eyes rule',
  fourEyesOk: 'Applied: decided by {decider}, run started by {starter}.',
  fourEyesOpen: 'Applied: the person who started the run ({starter}) may not decide.',
  decisionComment: 'Comment',
  selected: 'Selected',
  item: 'Item',
  itemsTruncated: '{n} further items are not listed.',

  manualSteps: 'Manual steps',
  manualStepsIntro: 'Work done by people, documented in the run: checklist, fields, evidence files and, where required, the verification by a second person.',
  manualStep: 'Manual step',
  manualVerified: 'Done and verified by a second person',
  manualDone: 'Done',
  manualWaitingVerification: 'Completed – waiting for the verification by a second person',
  manualOpen: 'Not completed yet',
  manualRejected: 'Verification rejected – the run failed',
  completedBy: 'Completed by',
  enteredAt: 'Entered in Steward at',
  doneAtStated: 'Done at (stated)',
  doneAtReason: 'Entered after the fact, because',
  verification: 'Second-person verification',
  verificationNotNeeded: 'Not required',
  verificationNeeded: 'Required ({reasons})',
  reason_step: 'step setting',
  reason_notAvailable: 'something required was not available',
  reason_backdated: 'entered after the fact',
  reason_returned: 'an earlier entry was sent back',
  verifiedBy: 'Verified by',
  verifiedAt: 'Verified at',
  rejectedBy: 'Rejected by',
  rejectedAt: 'Rejected at',
  mayVerify: 'May verify',
  mayVerifyNotStarter: '{who}; not the person who completed the step or started the run',
  mayVerifyNotCompleter: '{who}; not the person who completed the step',
  verificationComment: 'Verification comment',
  checklist: 'Checklist',
  checklistAllRequired: 'Checklist (every item required)',
  ticked: 'Ticked',
  fieldsTitle: 'Fields',
  field: 'Field',
  required: 'Required',
  optional: 'Optional',
  notAvailableTitle: '“Not available” reasons',
  notAvailableValue: 'Not available: {reason}',
  what: 'What',
  reason: 'Reason',
  evidenceTarget: 'Evidence files',
  evidenceFiles: 'Evidence files',
  evidenceNone: 'No evidence files were added.',
  evidenceOff: 'This step takes no evidence files.',
  addedBy: 'Added by',
  returnedTitle: 'Sent back for correction',
  returnedEntry: 'Entry by',

  checks: 'Checks',
  noChecks: 'This run did not perform any checks.',
  check: 'Check',
  severity: 'Severity',
  message: 'Message',
  passed: 'Passed',
  failed: 'Failed',

  processReports: 'Results reported by the process',
  noRows: 'No rows.',

  evidence: 'Evidence',
  noEvidence: 'No evidence files were recorded.',
  file: 'File',
  size: 'Size',
  recorded: 'Recorded',

  errors: 'Errors',
  noErrors: 'No errors were recorded.',
  runError: 'Run error',

  comments: 'Comments',
  reviewerComment: 'Reviewer comment',
  reviewerCommentBy: '{user} · {date}',
  noReviewerComment: 'No comment was entered when this report was generated.',
  decisionComments: 'Comments on decisions',
  noDecisionComments: 'No comments were entered on decisions.',

  integrity: 'Integrity and verification',
  sealedHash: 'Sealed protocol hash (recorded when the run finished)',
  sealVerifiedAgainst: 'Seal verified against',
  importedHistoryOf: 'the imported audit history of the instance with key fingerprint {fingerprint} (moved here with a migration package)',
  currentHash: 'Protocol hash at report generation',
  integrityStatus: 'Journal integrity',
  intact: 'Intact – unchanged since the run finished',
  modified: 'MODIFIED after the run finished',
  notSealed: 'Not sealed yet – the run has not finished',
  contentHash: 'Report content hash',
  reportId: 'Report ID',
  auditTrail: 'Audit trail of this run',
  auditIntro: 'Entries of the HMAC-chained audit log for this run. Any later change to these entries is detected by “Verify chain”.',
  seq: '#',
  actor: 'Actor',
  action: 'Action',
  hash: 'Entry hash',
  auditTruncated: '{n} further audit entries are not listed.',
  howToVerify: 'How to verify this document',
  verify1:
    '1. Compute the SHA-256 of this PDF file and compare it with the value in the audit log entry “report.generated” for report {reportId}. Signing adds an incremental update: for a signed copy, hash only as many leading bytes as the size recorded in the same entry.',
  verify2: '2. Verify the audit chain (Audit log → Verify chain, or GET /api/audit/verify). A valid chain proves that the recorded hash has not been altered.',
  verify3: '3. The protocol hash printed in the footer is the sealed fingerprint of the run journal; the run page shows whether the journal is still intact.',

  signoff: 'Sign-off',
  signoffIntro:
    'Sign by hand on a printout, or sign the digital signature fields with a PDF reader (e.g. Adobe Acrobat). Signing digitally keeps this archived PDF/A file valid.',
  preparedBy: 'Prepared by',
  reviewedBy: 'Reviewed by',
  approvedBy: 'Approved by',
  name: 'Name',
  role: 'Role',
  date: 'Date',
  signature: 'Signature',
  digitalSignature: 'Digital signature field – sign with a PDF reader',

  period: 'Period',
  processes: 'Processes',
  timeZone: 'Time zone',
  totals: 'Totals',
  runs: 'Runs',
  succeeded: 'Succeeded',
  failedRuns: 'Failed',
  cancelledRuns: 'Cancelled',
  openRuns: 'Not finished',
  dryRuns: 'Dry runs',
  byProcess: 'By process',
  runList: 'Runs in this period',
  noRuns: 'No runs were started in this period.',
  runsTruncated: '{n} further runs are not listed.',
  decisionsCount: 'Decisions',
  decisionsShort: 'Decisions',
  colRuns: 'Runs',
  colFailed: 'Failed',
  colOpen: 'Not finished',
  changesShort: 'Changes',
  runIdHash: 'Run ID / protocol hash',
  changesCount: 'Changes',
  checksFailed: 'Checks failed',
  scope: 'Scope',

  status_succeeded: 'Succeeded',
  status_failed: 'Failed',
  status_cancelled: 'Cancelled',
  status_waiting: 'Waiting for a decision',
  status_running: 'Running',
  status_queued: 'Queued',
  status_interrupted: 'Interrupted',
  status_skipped: 'Skipped',
  status_dryrun: 'Simulated',
  trigger_manual: 'Manual',
  trigger_schedule: 'Schedule',
  trigger_resume: 'Resumed',
  trigger_subprocess: 'Sub-process',
  trigger_webhook: 'Webhook trigger',
  trigger_monitor: 'Monitor',
  severity_info: 'Info',
  severity_warning: 'Warning',
  severity_error: 'Error',
  severity_critical: 'Critical',

  sampleProcess: 'Sample – Access review',
  sampleNote: 'SAMPLE – preview of the report branding with invented data.',
};

export type MsgKey = keyof typeof en;

const de: Record<MsgKey, string> = {
  runReport: 'Ausführungsbericht',
  summaryReport: 'Zusammenfassender Bericht',
  interimTag: 'Zwischenstand',
  dryRunTag: 'Probelauf',
  reportNo: 'Bericht {id}',
  version: 'Version {n}',
  generatedWith: 'Erstellt mit {product}',
  pageOf: 'Seite {n} von {total}',
  footerRun: 'Ausführung {runId} · erstellt {date} von {user} · Bericht {reportId}',
  footerSummary: '{count} Prozess(e), {from} – {to} · erstellt {date} von {user} · Bericht {reportId}',
  footerHash: 'Protokoll-Hash (versiegelter Fingerabdruck des Ausführungsjournals): {hash}',
  footerVerify: 'Prüfung: Der SHA-256 dieser Datei steht im Audit-Log (report.generated, {reportId}) · Audit-Log → Kette prüfen (GET /api/audit/verify)',
  footerVerifySummary: 'Prüfung: Der SHA-256 dieser Datei steht im Audit-Log (report.generated, {reportId}) · Audit-Log → Kette prüfen (GET /api/audit/verify)',

  dryRunTitle: 'PROBELAUF (DRY RUN) – es wurde nichts geändert',
  dryRunBody:
    'Lesende Aufrufe wurden ausgeführt; schreibende Aufrufe (POST/PUT/PATCH/DELETE) wurden nur aufgezeichnet und nicht an die Plattform gesendet. Die aufgeführten Änderungen zeigen, was geändert worden wäre.',
  interimTitle: 'ZWISCHENBERICHT – die Ausführung ist noch nicht abgeschlossen',
  interimBody:
    'Status zum Zeitpunkt dieses Berichts: {status}. Ergebnisse, Entscheidungen und der versiegelte Protokoll-Hash können sich noch ändern. Erstellen Sie nach Abschluss einen neuen Bericht.',
  failedTitle: 'Die Ausführung ist fehlgeschlagen',
  cancelledTitle: 'Die Ausführung wurde abgebrochen',
  modifiedTitle: 'WARNUNG: Das Ausführungsjournal wurde nach Abschluss verändert',
  modifiedBody:
    'Der beim Abschluss im Audit-Log eingetragene Protokoll-Hash stimmt nicht mit dem aktuellen Journal überein. Prüfen Sie den Inhalt dieses Berichts und das Audit-Log sorgfältig.',

  summary: 'Zusammenfassung',
  process: 'Prozess',
  processVersion: 'Version',
  definitionHash: 'Definitions-Hash',
  runId: 'Ausführungs-ID',
  trigger: 'Auslöser',
  startedBy: 'Gestartet von',
  started: 'Beginn',
  finished: 'Ende',
  duration: 'Dauer',
  status: 'Status',
  dryRun: 'Probelauf',
  yes: 'Ja',
  no: 'Nein',
  none: 'Keine',
  notFinished: 'nicht abgeschlossen',
  parentRun: 'Gestartet von Ausführung',
  schedule: 'Zeitplan',
  connections: 'Verwendete Plattformen',
  slot: 'Verbindung',
  platform: 'Plattform',
  kind: 'Art',
  environment: 'Umgebung',
  inputs: 'Eingaben',
  input: 'Eingabe',
  value: 'Wert',
  processDescription: 'Über diesen Prozess',

  atAGlance: 'Ergebnisse im Überblick',
  statSteps: 'Ausgeführte Schritte',
  statFailedSteps: 'Fehlgeschlagene Schritte',
  statChanges: 'Durchgeführte Änderungen',
  statSimulated: 'Simulierte Änderungen',
  statChecksPassed: 'Bestandene Prüfungen',
  statChecksFailed: 'Fehlgeschlagene Prüfungen',
  statDecisions: 'Entscheidungen',

  whatWasDone: 'Durchgeführte Schritte',
  stepsIntro: 'Alle ausgeführten Schritte in zeitlicher Reihenfolge, wie im Ausführungsjournal aufgezeichnet.',
  time: 'Zeit',
  step: 'Schritt',
  type: 'Typ',
  result: 'Ergebnis',
  stepsTruncated: '{n} weitere Schritte sind nicht aufgeführt. Das vollständige Journal enthält das JSON-Protokoll der Ausführung.',

  changes: 'Änderungen (Schreibzugriffe)',
  changesIntro: 'Aufrufe, die Daten auf einer Plattform anlegen, ändern oder löschen.',
  changesIntroDry: 'Probelauf: Diese Aufrufe wurden nicht ausgeführt.',
  method: 'Methode',
  request: 'Aufruf',
  httpStatus: 'HTTP-Status',
  notExecuted: 'Simuliert – nicht ausgeführt',
  noChanges: 'Keine Schreibzugriffe.',

  decisions: 'Entscheidungen und Freigaben',
  noDecisions: 'Diese Ausführung hat keine Entscheidung angefordert.',
  decisionApprove: 'Freigabe',
  decisionSelect: 'Auswahl',
  decidedBy: 'Entschieden von',
  decidedAt: 'Entschieden am',
  outcome: 'Ergebnis',
  approved: 'Freigegeben',
  rejected: 'Abgelehnt',
  selectedOf: '{n} von {total} ausgewählt',
  openDecision: 'Offen – wartet auf Entscheidung',
  cancelledDecision: 'Abgebrochen',
  assignedTo: 'Zugewiesen an',
  anyone: 'Alle, die den Prozess ausführen oder freigeben dürfen',
  fourEyes: 'Vier-Augen-Prinzip',
  fourEyesOk: 'Angewendet: entschieden von {decider}, Ausführung gestartet von {starter}.',
  fourEyesOpen: 'Angewendet: Wer die Ausführung gestartet hat ({starter}), darf nicht entscheiden.',
  decisionComment: 'Kommentar',
  selected: 'Ausgewählt',
  item: 'Eintrag',
  itemsTruncated: '{n} weitere Einträge sind nicht aufgeführt.',

  manualSteps: 'Manuelle Schritte',
  manualStepsIntro:
    'Von Personen erledigte Arbeit, in der Ausführung dokumentiert: Checkliste, Felder, Nachweisdateien und, wo verlangt, die Prüfung durch eine zweite Person.',
  manualStep: 'Manueller Schritt',
  manualVerified: 'Erledigt und von einer zweiten Person geprüft',
  manualDone: 'Erledigt',
  manualWaitingVerification: 'Erledigt – wartet auf die Prüfung durch eine zweite Person',
  manualOpen: 'Noch nicht erledigt',
  manualRejected: 'Prüfung abgelehnt – die Ausführung ist fehlgeschlagen',
  completedBy: 'Erledigt von',
  enteredAt: 'In Steward erfasst am',
  doneAtStated: 'Erledigt am (angegeben)',
  doneAtReason: 'Nachträglich erfasst, weil',
  verification: 'Prüfung durch eine zweite Person',
  verificationNotNeeded: 'Nicht erforderlich',
  verificationNeeded: 'Erforderlich ({reasons})',
  reason_step: 'Einstellung des Schritts',
  reason_notAvailable: 'etwas Erforderliches war nicht verfügbar',
  reason_backdated: 'nachträglich erfasst',
  reason_returned: 'ein früherer Eintrag wurde zurückgegeben',
  verifiedBy: 'Geprüft von',
  verifiedAt: 'Geprüft am',
  rejectedBy: 'Abgelehnt von',
  rejectedAt: 'Abgelehnt am',
  mayVerify: 'Darf prüfen',
  mayVerifyNotStarter: '{who}; nicht die Person, die den Schritt erledigt oder die Ausführung gestartet hat',
  mayVerifyNotCompleter: '{who}; nicht die Person, die den Schritt erledigt hat',
  verificationComment: 'Kommentar der Prüfung',
  checklist: 'Checkliste',
  checklistAllRequired: 'Checkliste (jeder Punkt erforderlich)',
  ticked: 'Abgehakt',
  fieldsTitle: 'Felder',
  field: 'Feld',
  required: 'Pflicht',
  optional: 'Optional',
  notAvailableTitle: 'Gründe für „nicht verfügbar“',
  notAvailableValue: 'Nicht verfügbar: {reason}',
  what: 'Was',
  reason: 'Grund',
  evidenceTarget: 'Nachweisdateien',
  evidenceFiles: 'Nachweisdateien',
  evidenceNone: 'Es wurden keine Nachweisdateien hinzugefügt.',
  evidenceOff: 'Dieser Schritt nimmt keine Nachweisdateien an.',
  addedBy: 'Hinzugefügt von',
  returnedTitle: 'Zur Korrektur zurückgegeben',
  returnedEntry: 'Eintrag von',

  checks: 'Prüfungen',
  noChecks: 'Diese Ausführung hat keine Prüfungen durchgeführt.',
  check: 'Prüfung',
  severity: 'Schweregrad',
  message: 'Meldung',
  passed: 'Bestanden',
  failed: 'Nicht bestanden',

  processReports: 'Ergebnisse des Prozesses',
  noRows: 'Keine Zeilen.',

  evidence: 'Nachweise',
  noEvidence: 'Es wurden keine Nachweisdateien aufgezeichnet.',
  file: 'Datei',
  size: 'Größe',
  recorded: 'Aufgezeichnet',

  errors: 'Fehler',
  noErrors: 'Es wurden keine Fehler aufgezeichnet.',
  runError: 'Fehler der Ausführung',

  comments: 'Kommentare',
  reviewerComment: 'Kommentar des Prüfers',
  reviewerCommentBy: '{user} · {date}',
  noReviewerComment: 'Beim Erstellen dieses Berichts wurde kein Kommentar eingegeben.',
  decisionComments: 'Kommentare zu Entscheidungen',
  noDecisionComments: 'Zu den Entscheidungen wurden keine Kommentare eingegeben.',

  integrity: 'Integrität und Prüfung',
  sealedHash: 'Versiegelter Protokoll-Hash (bei Abschluss eingetragen)',
  sealVerifiedAgainst: 'Siegel geprüft gegen',
  importedHistoryOf: 'das importierte Audit-Protokoll der Instanz mit dem Schlüssel-Fingerabdruck {fingerprint} (mit einem Migrationspaket hierher umgezogen)',
  currentHash: 'Protokoll-Hash bei Berichtserstellung',
  integrityStatus: 'Integrität des Journals',
  intact: 'Unverändert seit Abschluss der Ausführung',
  modified: 'NACH ABSCHLUSS VERÄNDERT',
  notSealed: 'Noch nicht versiegelt – die Ausführung ist nicht abgeschlossen',
  contentHash: 'Inhalts-Hash des Berichts',
  reportId: 'Berichts-ID',
  auditTrail: 'Audit-Trail dieser Ausführung',
  auditIntro: 'Einträge des HMAC-verketteten Audit-Logs zu dieser Ausführung. Jede spätere Änderung dieser Einträge wird durch „Kette prüfen“ erkannt.',
  seq: 'Nr.',
  actor: 'Akteur',
  action: 'Aktion',
  hash: 'Eintrags-Hash',
  auditTruncated: '{n} weitere Audit-Einträge sind nicht aufgeführt.',
  howToVerify: 'So prüfen Sie dieses Dokument',
  verify1:
    '1. Berechnen Sie den SHA-256 dieser PDF-Datei und vergleichen Sie ihn mit dem Wert im Audit-Log-Eintrag „report.generated“ für Bericht {reportId}. Eine Signatur wird als inkrementelle Aktualisierung angehängt: Bei einer signierten Kopie bilden Sie den Hash nur über so viele Bytes vom Dateianfang, wie die im selben Eintrag vermerkte Größe angibt.',
  verify2:
    '2. Prüfen Sie die Audit-Kette (Audit-Log → Kette prüfen oder GET /api/audit/verify). Eine gültige Kette belegt, dass der eingetragene Hash nicht verändert wurde.',
  verify3:
    '3. Der Protokoll-Hash in der Fußzeile ist der versiegelte Fingerabdruck des Ausführungsjournals; die Seite der Ausführung zeigt, ob das Journal unverändert ist.',

  signoff: 'Freigabe und Unterschriften',
  signoffIntro:
    'Unterschreiben Sie handschriftlich auf einem Ausdruck oder digital in den Signaturfeldern mit einem PDF-Programm (z. B. Adobe Acrobat). Eine digitale Signatur erhält die Gültigkeit dieser PDF/A-Archivdatei.',
  preparedBy: 'Erstellt von',
  reviewedBy: 'Geprüft von',
  approvedBy: 'Freigegeben von',
  name: 'Name',
  role: 'Funktion',
  date: 'Datum',
  signature: 'Unterschrift',
  digitalSignature: 'Feld für digitale Signatur – mit einem PDF-Programm signieren',

  period: 'Zeitraum',
  processes: 'Prozesse',
  timeZone: 'Zeitzone',
  totals: 'Gesamt',
  runs: 'Ausführungen',
  succeeded: 'Erfolgreich',
  failedRuns: 'Fehlgeschlagen',
  cancelledRuns: 'Abgebrochen',
  openRuns: 'Nicht abgeschlossen',
  dryRuns: 'Testläufe',
  byProcess: 'Nach Prozess',
  runList: 'Ausführungen im Zeitraum',
  noRuns: 'In diesem Zeitraum wurden keine Ausführungen gestartet.',
  runsTruncated: '{n} weitere Ausführungen sind nicht aufgeführt.',
  decisionsCount: 'Entscheidungen',
  decisionsShort: 'Entsch.',
  colRuns: 'Anzahl',
  colFailed: 'Fehler',
  colOpen: 'Offen',
  changesShort: 'Änderungen',
  runIdHash: 'Ausführungs-ID / Protokoll-Hash',
  changesCount: 'Änderungen',
  checksFailed: 'Prüfungen n. b.',
  scope: 'Umfang',

  status_succeeded: 'Erfolgreich',
  status_failed: 'Fehlgeschlagen',
  status_cancelled: 'Abgebrochen',
  status_waiting: 'Wartet auf Entscheidung',
  status_running: 'Läuft',
  status_queued: 'In Warteschlange',
  status_interrupted: 'Unterbrochen',
  status_skipped: 'Übersprungen',
  status_dryrun: 'Simuliert',
  trigger_manual: 'Manuell',
  trigger_schedule: 'Zeitplan',
  trigger_resume: 'Fortgesetzt',
  trigger_subprocess: 'Unterprozess',
  trigger_webhook: 'Webhook-Auslöser',
  trigger_monitor: 'Monitor',
  severity_info: 'Info',
  severity_warning: 'Warnung',
  severity_error: 'Fehler',
  severity_critical: 'Kritisch',

  sampleProcess: 'Beispiel – Zugriffsüberprüfung',
  sampleNote: 'BEISPIEL – Vorschau des Berichtsdesigns mit erfundenen Daten.',
};

const CATALOG: Record<ReportLang, Record<MsgKey, string>> = { en, de };

/** Default classification labels are translated; custom ones are printed as entered. */
const CLASSIFICATIONS: Record<string, Record<ReportLang, string>> = {
  public: { en: 'Public', de: 'Öffentlich' },
  internal: { en: 'Internal', de: 'Intern' },
  confidential: { en: 'Confidential', de: 'Vertraulich' },
  restricted: { en: 'Restricted', de: 'Streng vertraulich' },
  'strictly confidential': { en: 'Strictly confidential', de: 'Streng vertraulich' },
};

export interface Translator {
  lang: ReportLang;
  locale: string;
  t(key: MsgKey, vars?: Record<string, string | number>): string;
  /** Status/trigger/severity values, falling back to the raw value */
  v(prefix: 'status' | 'trigger' | 'severity', value: string | null | undefined): string;
  classification(label: string): string;
  /** Date and time in the report's time zone, with the zone abbreviation */
  dateTime(iso: string | null | undefined): string;
  date(iso: string | null | undefined): string;
  time(iso: string | null | undefined): string;
  duration(ms: number | null | undefined): string;
  bytes(n: number): string;
  timeZone: string;
}

export function resolveTimeZone(tz?: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export function translator(lang: ReportLang, timeZone?: string | null): Translator {
  const cat = CATALOG[lang] ?? en;
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const tz = resolveTimeZone(timeZone);
  const t = (key: MsgKey, vars?: Record<string, string | number>) =>
    (cat[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => (vars && vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
  const parts = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(iso));
  const valid = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(Date.parse(iso));
  return {
    lang,
    locale,
    timeZone: tz,
    t,
    v(prefix, value) {
      if (!value) return '–';
      const key = `${prefix}_${value}` as MsgKey;
      return key in cat ? cat[key] : value;
    },
    classification(label) {
      return CLASSIFICATIONS[label.trim().toLowerCase()]?.[lang] ?? label;
    },
    dateTime(iso) {
      if (!valid(iso)) return '–';
      return parts(iso, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
        hourCycle: 'h23',
      });
    },
    date(iso) {
      if (!valid(iso)) return '–';
      return parts(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
    },
    time(iso) {
      if (!valid(iso)) return '–';
      return parts(iso, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    },
    duration(ms) {
      if (ms == null || !Number.isFinite(ms)) return '–';
      if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
      const s = Math.round(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const min = lang === 'de' ? 'Min.' : 'min';
      if (h) return `${h} h ${m} ${min}`;
      if (m) return `${m} ${min} ${sec} s`;
      return `${sec} s`;
    },
    bytes(n) {
      const units = ['B', 'KB', 'MB', 'GB'];
      let v = n;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) ((v /= 1024), i++);
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
    },
  };
}
