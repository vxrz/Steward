import type { RecordTypeDefinition } from './records.js';

/**
 * Incident reviews (#109): a built-in record type for post-incident reviews on the decision workflow (draft →
 * proposed → accepted, approved by someone other than the author). Its measures to avoid a repeat are tracked like
 * duties: an owner, a due date, reminders, overdue ones on the service page. The timeline can be prefilled from what
 * Steward saw in the incident's time window; the chosen entries are copied into the text.
 */

/** Fixed id of the built-in type (created in every installation; administrators may archive it). */
export const INCIDENT_TYPE_ID = 'rty_pir';
export const INCIDENT_TYPE_KEY = 'PIR';

export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_RECORD_TYPE: RecordTypeDefinition = {
  key: INCIDENT_TYPE_KEY,
  name: 'Incident review',
  description:
    'A post-incident review: what happened and when, the impact, the cause, what was learned and the measures that keep it from happening again (with owners and due dates). Accepted by someone other than the author.',
  workflow: 'decision',
  template: '## Summary\n\n\n## Timeline\n\n\n## What went well\n\n- \n\n## What could be better\n\n- \n\n## Learnings\n\n- \n',
  fields: [
    { key: 'incidentStart', label: 'Incident start', kind: 'datetime', required: true },
    { key: 'incidentEnd', label: 'Incident end', kind: 'datetime' },
    { key: 'severity', label: 'Severity', kind: 'select', options: [...INCIDENT_SEVERITIES], required: true },
    { key: 'impact', label: 'Impact', kind: 'textarea', required: true, help: 'Who or what was affected, and how much' },
    { key: 'cause', label: 'Cause', kind: 'textarea', help: 'The root cause and what contributed' },
  ],
};

export const MEASURE_LIMITS = {
  title: 200,
  note: 2000,
  perRecord: 50,
  /** A reminder this many days before the due date (and on the due date, then once a week while overdue) */
  reminderDays: 3,
} as const;

export interface RecordMeasure {
  id: string;
  recordId: string;
  title: string;
  /** user:<name>, team:<name> – who carries it out and gets the reminders */
  owners: string[];
  /** YYYY-MM-DD */
  dueDate: string;
  note: string;
  doneAt: string | null;
  doneBy: string | null;
  /** Not done and past its due date */
  overdue: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface RecordMeasures {
  items: RecordMeasure[];
  /** May add, change and remove measures (the record's editors; also after acceptance) */
  canEdit: boolean;
}

/** An open measure with its review (service page, start page, API). */
export interface OpenMeasure extends RecordMeasure {
  recordNumber: string;
  recordTitle: string;
}

export const TIMELINE_SOURCES = ['monitor', 'run', 'ticket', 'audit'] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** Something Steward saw in the incident's time window, offered for the timeline. */
export interface TimelineCandidate {
  /** Stable within the window (source and id), sent back to copy the entry */
  key: string;
  at: string;
  source: TimelineSource;
  text: string;
  /** Web UI path */
  link: string | null;
}

export interface TimelineCandidates {
  from: string;
  to: string;
  items: TimelineCandidate[];
  /** More than the limit were found: narrow the window */
  truncated: boolean;
}

export const TIMELINE_LIMITS = { maxDays: 14, items: 300 } as const;
