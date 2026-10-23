import type { ReportLang } from './reports.js';

/** Scheduled summary reports (availability/SLA, credentials, runs …), archived like every other report. */

export const REPORT_SCHEDULE_PRESETS = ['daily', 'weekly', 'monthly', 'custom'] as const;
export type ReportSchedulePreset = (typeof REPORT_SCHEDULE_PRESETS)[number];

/** Built-in sections. The section list is open: more can be registered on the server (e.g. "records"). */
export const REPORT_SECTION_IDS = ['availability', 'gatus', 'credentials', 'runs'] as const;
export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number];

export interface AvailabilitySectionConfig {
  /** null = every monitor the owner may view */
  monitorIds: string[] | null;
  /** SLA target in percent, e.g. 99.5 */
  slaTarget?: number | null;
}
export interface GatusSectionConfig {
  sources: { platformId: string; endpointKeys: string[] | null }[];
  slaTarget?: number | null;
}
export interface CredentialsSectionConfig {
  /** Also list entries due within this many days after the period (default 30) */
  dueWithinDays?: number;
}
export interface RunsSectionConfig {
  /** null = every process the owner may view */
  processIds: string[] | null;
}

export interface ReportScheduleSections {
  availability?: AvailabilitySectionConfig;
  gatus?: GatusSectionConfig;
  credentials?: CredentialsSectionConfig;
  runs?: RunsSectionConfig;
  [section: string]: unknown;
}

export interface ReportRecipients {
  users: string[];
  teams: string[];
  emails: string[];
}

export interface ReportSchedule {
  id: string;
  name: string;
  /** Runs with this user's rights: the report contains only what the owner may see */
  owner: string;
  enabled: boolean;
  preset: ReportSchedulePreset;
  /** Cron expression (presets: fixed) */
  cron: string;
  timezone: string;
  /** custom: length of the period ending at the run (days) */
  periodDays: number;
  lang: ReportLang;
  classification: string;
  title: string;
  sections: ReportScheduleSections;
  recipients: ReportRecipients;
  /** Attach the PDF to e-mails (otherwise only a link) */
  attachPdf: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastReportId: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  canEdit: boolean;
}
