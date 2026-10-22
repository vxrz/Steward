import type { ReportLang } from '@sm/shared';

/**
 * Strings of the scheduled summary reports (availability/SLA, credentials,
 * runs). Kept apart from reports/i18n.ts so sections registered by other
 * features can bring their own catalogs the same way.
 */
const en = {
  scheduledReport: 'Scheduled report',
  schedule: 'Schedule',
  owner: 'Prepared for (permissions of)',
  sections: 'Sections',
  atAGlance: 'At a glance',
  scopeNote: 'This report contains only data the owner of the schedule may see.',
  footer: '{name} · {from} – {to} · generated {date} · report {reportId}',

  availability: 'Availability of monitors',
  availabilityIntro:
    'Uptime is time-weighted from the status changes of each monitor: down counts against it, up and degraded count for it; unknown, blocked and maintenance time is left out. Response times come from the stored check results (the newest results per check).',
  gatus: 'Availability of Gatus endpoints',
  gatusIntro:
    'Uptime from the number of successful and failed results Gatus produced (counter deltas of gatus_results_total, scraped by Steward). Outages are periods in which the newest result failed. p95 needs the per-scrape samples, which are kept for a shorter time.',
  monitor: 'Monitor',
  endpoint: 'Endpoint',
  uptime: 'Uptime',
  slaTarget: 'SLA target',
  sla: 'SLA',
  slaMet: 'met',
  slaMissed: 'missed',
  noData: 'no data',
  incidents: 'Outages',
  downtime: 'Downtime',
  avgMs: 'Avg (ms)',
  p95Ms: 'p95 (ms)',
  results: 'Results',
  failedResults: 'Failed',
  outageList: 'Outages in the period',
  from: 'From',
  to: 'To',
  ongoing: 'ongoing',
  noIncidents: 'No outages in the period.',
  noMonitors: 'No monitors selected or visible.',
  noEndpoints: 'No Gatus data for the period (is metrics mode on for the platform?).',
  notAccessible: 'Platform "{name}" is not accessible for the owner of the schedule – left out.',
  noMetrics: 'Metrics mode is not configured for "{name}".',
  chartMonitors: 'Uptime per monitor (scale {min} – 100 %)',
  chartEndpoints: 'Uptime per endpoint (scale {min} – 100 %)',
  avgUptime: 'Average uptime',
  slaMissedCount: 'SLA missed',

  credentials: 'Credentials register',
  credentialsIntro: 'Entries whose expiry, rotation or review date has passed, and those due within {days} days after the end of the period.',
  expired: 'Expired',
  overdue: 'Overdue',
  dueSoon: 'Due within {days} days',
  name: 'Name',
  type: 'Type',
  platform: 'Platform',
  due: 'Due',
  dueDate: 'Date',
  owners: 'Owners',
  noCredentials: 'Nothing expired, overdue or due.',
  kind_expiry: 'Expiry',
  kind_rotation: 'Rotation',
  kind_review: 'Review',

  runs: 'Runs',
  runsIntro: 'Runs started in the period, per process.',
  process: 'Process',
  total: 'Runs',
  succeeded: 'Succeeded',
  failed: 'Failed',
  other: 'Other',
  noRuns: 'No runs in the period.',
  failedRuns: 'Failed runs',
};

export type ScheduledKey = keyof typeof en;

const de: Record<ScheduledKey, string> = {
  scheduledReport: 'Geplanter Bericht',
  schedule: 'Zeitplan',
  owner: 'Erstellt für (Rechte von)',
  sections: 'Abschnitte',
  atAGlance: 'Überblick',
  scopeNote: 'Dieser Bericht enthält nur Daten, die der Eigentümer des Zeitplans sehen darf.',
  footer: '{name} · {from} – {to} · erstellt {date} · Bericht {reportId}',

  availability: 'Verfügbarkeit der Monitore',
  availabilityIntro:
    'Die Verfügbarkeit ist zeitgewichtet aus den Statuswechseln jedes Monitors berechnet: Ausgefallen zählt dagegen, OK und Beeinträchtigt dafür; Zeiten mit Unbekannt, Blockiert und Wartung bleiben unberücksichtigt. Antwortzeiten stammen aus den gespeicherten Prüfergebnissen (die neuesten Ergebnisse je Prüfung).',
  gatus: 'Verfügbarkeit der Gatus-Endpunkte',
  gatusIntro:
    'Verfügbarkeit aus der Zahl erfolgreicher und fehlgeschlagener Ergebnisse von Gatus (Zählerdifferenzen von gatus_results_total, von Steward abgerufen). Ausfälle sind Zeiträume, in denen das neueste Ergebnis fehlschlug. Für p95 sind die Einzelwerte nötig, die kürzer aufbewahrt werden.',
  monitor: 'Monitor',
  endpoint: 'Endpunkt',
  uptime: 'Verfügbarkeit',
  slaTarget: 'SLA-Ziel',
  sla: 'SLA',
  slaMet: 'erfüllt',
  slaMissed: 'verfehlt',
  noData: 'keine Daten',
  incidents: 'Ausfälle',
  downtime: 'Ausfallzeit',
  avgMs: 'Mittel (ms)',
  p95Ms: 'p95 (ms)',
  results: 'Ergebnisse',
  failedResults: 'Fehlgeschl.',
  outageList: 'Ausfälle im Zeitraum',
  from: 'Von',
  to: 'Bis',
  ongoing: 'andauernd',
  noIncidents: 'Keine Ausfälle im Zeitraum.',
  noMonitors: 'Keine Monitore ausgewählt oder sichtbar.',
  noEndpoints: 'Keine Gatus-Daten für den Zeitraum (ist der Metrik-Modus für die Plattform aktiv?).',
  notAccessible: 'Die Plattform „{name}“ ist für den Eigentümer des Zeitplans nicht zugänglich – nicht enthalten.',
  noMetrics: 'Der Metrik-Modus ist für „{name}“ nicht eingerichtet.',
  chartMonitors: 'Verfügbarkeit je Monitor (Skala {min} – 100 %)',
  chartEndpoints: 'Verfügbarkeit je Endpunkt (Skala {min} – 100 %)',
  avgUptime: 'Mittlere Verfügbarkeit',
  slaMissedCount: 'SLA verfehlt',

  credentials: 'Zugangsdaten-Register',
  credentialsIntro:
    'Einträge, deren Ablauf-, Rotations- oder Überprüfungsdatum überschritten ist, und solche, die innerhalb von {days} Tagen nach Ende des Zeitraums fällig werden.',
  expired: 'Abgelaufen',
  overdue: 'Überfällig',
  dueSoon: 'Fällig innerhalb von {days} Tagen',
  name: 'Name',
  type: 'Typ',
  platform: 'Plattform',
  due: 'Fällig',
  dueDate: 'Datum',
  owners: 'Eigentümer',
  noCredentials: 'Nichts abgelaufen, überfällig oder fällig.',
  kind_expiry: 'Ablauf',
  kind_rotation: 'Rotation',
  kind_review: 'Überprüfung',

  runs: 'Ausführungen',
  runsIntro: 'Im Zeitraum gestartete Ausführungen je Prozess.',
  process: 'Prozess',
  total: 'Ausführungen',
  succeeded: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
  other: 'Sonstige',
  noRuns: 'Keine Ausführungen im Zeitraum.',
  failedRuns: 'Fehlgeschlagene Ausführungen',
};

const CATALOG: Record<ReportLang, Record<ScheduledKey, string>> = { en, de };

export function st(lang: ReportLang, key: ScheduledKey, vars?: Record<string, string | number>): string {
  const s = (CATALOG[lang] ?? en)[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (vars && vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** Percent with two decimals in the report language. */
export const pctText = (lang: ReportLang, v: number | null | undefined): string =>
  v === null || v === undefined
    ? '–'
    : `${new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)} %`;
