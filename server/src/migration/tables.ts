/**
 * What a migration package carries, table by table, and which columns name people.
 *
 * Every table of the schema is either moved (MOVED: all rows, unchanged except for the fix-ups below) or
 * listed in NOT_MOVED with the reason. Columns that name users or teams are either
 *   - REWRITTEN on import (USER_REFS): who owns something or may do something now – owners, access lists,
 *     assignees, responsible people, recipients. They are mapped to the target's users and teams.
 *   - kept as HISTORY: who did something – authors, approvers, deciders, actors. Evidence is never rewritten;
 *     the mapping table (instance_imports) and the identity aliases say who a former name is now.
 * server/test/migration-tables.test.ts fails when a table or a person column is not classified here.
 */

export const NOT_MOVED: Record<string, string> = {
  users: 'mapped: every source user becomes a user of the target (see the identity mapping)',
  teams: 'mapped: every source team becomes a team of the target or is dropped',
  team_members: 'follows the identity mapping',
  sessions: 're-issued on the target (everyone signs in again)',
  api_tokens: 're-issued on the target (API and MCP tokens)',
  emergency_access_grants: 'instance-specific (emergency access is granted on the target server)',
  identity_providers: 'instance-specific (the target has its own single sign-on)',
  settings: 'selected settings only (see SETTINGS_MOVED)',
  audit_log: 'imported unchanged as imported history (verifiable with the source key)',
  notifications: 'in-app notifications are not moved',
  notification_sends: 'send bookkeeping of the source',
  notification_stale: 'send bookkeeping of the source',
  eol_releases: 'a cache of endoflife.date (filled again on the target)',
  eol_products: 'a cache of endoflife.date (filled again on the target)',
  eol_notices: 'send bookkeeping of the source (a component past its end of life is reported again on the target)',
  check_alerts: 'send bookkeeping of the source (a check that still fails is notified again on the target)',
  daily_summary_sends: 'send bookkeeping of the source',
  duty_notifications: 'send bookkeeping of the source (a reminder of the current period may be sent again on the target)',
  engine_probe: 'internal',
  sync_sources: 'instance-specific (Git sync is set up on the target again)',
  sync_items: 'belongs to the Git sync sources',
  sync_updates: 'belongs to the Git sync sources',
  instance_imports: 'history of earlier moves (moving an instance that was itself imported is not supported yet)',
  imported_audit_log: 'history of earlier moves',
  identity_aliases: 'history of earlier moves',
  schema_version: 'maintained by the migrations',
  schema_migrations: 'maintained by the migrations',
  sqlite_sequence: 'SQLite internal',
};

/** Rows keyed by user id: moved for mapped users only, with the target user's id. */
export const USER_ID_TABLES: Record<string, string> = { daily_summary_prefs: 'user_id' };

export type RefKind =
  /** a plain user name */
  | 'username'
  /** JSON array of { subject: "user:x" | "team:y" | "role:z", … } */
  | 'acl'
  /** JSON array of subjects */
  | 'subjects'
  /** JSON { users: [names], teams: [names], … } */
  | 'recipients'
  /** monitor definition: outputs[].subscribers are subjects */
  | 'monitorDefinition';

export interface UserRef {
  table: string;
  column: string;
  kind: RefKind;
}

/** Columns that decide who owns something or may do something now: mapped on import. */
export const USER_REFS: UserRef[] = [
  { table: 'processes', column: 'owner', kind: 'username' },
  { table: 'processes', column: 'acl', kind: 'acl' },
  { table: 'platforms', column: 'acl', kind: 'acl' },
  { table: 'schedules', column: 'owner', kind: 'username' },
  { table: 'dashboards', column: 'owner', kind: 'username' },
  { table: 'monitors', column: 'owner', kind: 'username' },
  { table: 'monitors', column: 'acl', kind: 'acl' },
  { table: 'monitors', column: 'definition', kind: 'monitorDefinition' },
  { table: 'monitor_gateways', column: 'owner', kind: 'username' },
  { table: 'gatus_sources', column: 'owner', kind: 'username' },
  { table: 'access_checks', column: 'owner', kind: 'username' },
  { table: 'webhook_triggers', column: 'owner', kind: 'username' },
  { table: 'report_schedules', column: 'owner', kind: 'username' },
  { table: 'report_schedules', column: 'recipients', kind: 'recipients' },
  { table: 'records', column: 'owner', kind: 'username' },
  { table: 'record_documents', column: 'review_owner', kind: 'username' },
  { table: 'run_tasks', column: 'assignees', kind: 'subjects' },
  { table: 'run_tasks', column: 'verifiers', kind: 'subjects' },
  { table: 'credentials', column: 'owner_subjects', kind: 'subjects' },
  { table: 'services', column: 'owners', kind: 'subjects' },
  { table: 'applications', column: 'owners', kind: 'subjects' },
  { table: 'service_duties', column: 'owners', kind: 'subjects' },
  { table: 'duty_skips', column: 'decider_subjects', kind: 'subjects' },
  // the owners a service had on the day of the snapshot: mapped, so the trend per owner names the target's users and teams
  { table: 'scorecard_snapshots', column: 'owners', kind: 'subjects' },
  { table: 'ticket_refs', column: 'responsible', kind: 'subjects' },
];

/**
 * Columns that record who did something: kept as they are (evidence, often inside hashes and seals).
 * Listed so that the classification test notices new person columns.
 */
export const HISTORY_COLUMNS: string[] = [
  'access_checks.updated_by',
  'application_components.created_by',
  'application_components.updated_by',
  'application_components.sbom_imported_by',
  'application_platforms.created_by',
  'application_ratings.rated_by',
  'applications.created_by',
  'applications.updated_by',
  'cia_scales.updated_by',
  'component_stack.set_by',
  'access_findings.resolved_by',
  'access_findings.dismiss_requested_by',
  'access_snapshots.taken_by',
  'control_catalogues.updated_by',
  'control_tags.created_by',
  'credential_events.actor',
  'credentials.created_by',
  'credentials.updated_by',
  'duty_skips.decided_by',
  'duty_skips.requested_by',
  'evidence_packs.created_by',
  'gatus_sources.updated_by',
  'item_links.created_by',
  'link_types.created_by',
  'link_types.updated_by',
  'monitor_maintenance.created_by',
  'monitor_state.ack_by',
  'monitors.updated_by',
  'process_versions.author',
  'record_documents.last_reviewed_by',
  'record_editions.authors',
  'record_editions.submitted_by',
  'record_editions.approved_by',
  'record_events.actor',
  'record_applications.created_by',
  'record_attachments.created_by',
  'record_reviews.reviewer',
  'record_types.updated_by',
  'record_versions.author',
  'records.created_by',
  'records.updated_by',
  'records.submitted_by',
  'records.superseded_by',
  'reports.created_by',
  'run_tasks.decided_by',
  'run_tasks.completed_by',
  'run_tasks.verified_by',
  'run_task_evidence.uploaded_by',
  'runs.actor',
  'service_applications.created_by',
  'service_protection_overrides.set_by',
  'services.created_by',
  'services.updated_by',
  'service_duties.created_by',
  'service_duties.updated_by',
  'availability_objectives.created_by',
  'availability_objectives.updated_by',
  'availability_objectives.archived_by',
  'scorecard_rules.created_by',
  'scorecard_rules.updated_by',
  'ticket_ref_events.actor',
  'ticket_refs.created_by',
  'ticket_refs.updated_by',
];

/** Columns whose names look like people but are not (classification test). */
export const NOT_PEOPLE_COLUMNS: string[] = [
  'access_findings.subject_id',
  'access_findings.subject_name',
  'access_snapshots.subject_count',
  'monitor_output_state.subject',
  'credentials.owners',
  'credentials.used_by',
  'monitor_checks.caused_by',
  'monitor_history.caused_by',
  'notifications.user_id',
];

/** Tables whose automation is paused after the import: an administrator reviews and turns them on again. */
export const PAUSED_ON_IMPORT: { table: string; column: string; label: string }[] = [
  { table: 'schedules', column: 'enabled', label: 'schedules' },
  { table: 'webhook_triggers', column: 'enabled', label: 'webhook triggers' },
  { table: 'monitors', column: 'enabled', label: 'monitors' },
  { table: 'monitor_gateways', column: 'enabled', label: 'heartbeat gateways' },
  { table: 'report_schedules', column: 'enabled', label: 'report schedules' },
  { table: 'access_checks', column: 'enabled', label: 'access checks' },
  { table: 'gatus_sources', column: 'enabled', label: 'Gatus sources' },
];

/** Settings that move (everything else is instance-specific and shown as "not applied"). */
export const SETTINGS_MOVED = [
  'browserHeadless',
  'browserTimeoutMs',
  'retentionRunDays',
  'retentionNotificationDays',
  'retentionMonitorDays',
  'defaultLocale',
  'findingDismissFourEyes',
  'theme.settings',
  'theme.logo',
  'reports.branding',
  'credentials.reminders',
  'tickets.settings',
  'notifications.dailySummary',
  'notifications.look',
  'catalogue.lifecycle',
];

/** Folders of the data directory with stored files (attachments, artifacts, reports, evidence packs, logos). */
export const FILE_DIRS = ['artifacts', 'docs', 'reports', 'records', 'evidence-packs', 'branding'];
