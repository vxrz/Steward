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
  resource_teams: 'follows the identity mapping: carried with its team (owns) and given to the team it is mapped to',
  team_settings: 'follows the identity mapping: carried with its team (settings, the channel URL with the package key)',
  sessions: 're-issued on the target (everyone signs in again)',
  api_tokens: 're-issued on the target (API and MCP tokens)',
  oauth_clients: 'belong to the instance (#12): MCP clients register again with the target',
  oauth_codes: 'one-time codes of the instance, minutes long',
  oauth_grants: 'access of MCP clients to this instance: people allow their clients again on the target',
  oauth_used_refresh: 'refresh tokens the grants of this instance used (reuse detection), not moved like the grants',
  emergency_access_grants: 'instance-specific (emergency access is granted on the target server)',
  identity_providers: 'instance-specific (the target has its own single sign-on)',
  settings: 'selected settings only (see SETTINGS_MOVED)',
  audit_log: 'imported unchanged as imported history (verifiable with the source key)',
  notifications: 'in-app notifications are not moved',
  notification_sends: 'send bookkeeping of the source',
  notification_stale: 'send bookkeeping of the source',
  eol_releases: 'a cache of endoflife.date (filled again on the target)',
  eol_products: 'a cache of endoflife.date (filled again on the target)',
  version_lookups: 'a cache of what the version watch read from registries and platforms (read again on the target)',
  version_notices: 'send bookkeeping of the source (a new major release already reported is not reported again)',
  prom_objective_readings: 'a cache of Prometheus figures for objectives (read again on the target)',
  backup_runs: 'instance-specific (the backups of the source; set up backups on the target)',
  export_jobs: 'instance-specific (scheduled exports send data to S3 targets of the source; set them up again on the target)',
  export_runs: 'instance-specific (the runs of the scheduled exports of the source)',
  aws_account_cache: 'a cache of what Steward read from AWS accounts (read again on the target)',
  mcp_requests: 'short-lived requests of MCP clients waiting for a person (they expire after 24 hours)',
  plant_proposals: 'plant registry changes proposed by AI assistants (0.12.0): they belong to their MCP requests, which are not moved',
  // 0.13.0 (ADR 0020): open change sets are not moved, as MCP requests are not; the history and the import baselines are
  plant_change_sets: 'plant change sets (0.13.0): drafts and proposals belong to this instance (as MCP requests); the history of their entries is moved',
  plant_change_ops: 'the operations of plant change sets (not moved, as their change sets)',
  plant_change_sources: 'the documents of plant change sets (not moved, as their change sets)',
  status_pages: 'status pages name services by id and carry the secret of their public link: set them up again on the target',
  mqtt_topics: 'when an MQTT topic last had a message and how many (read again from the broker)',
  eol_notices: 'send bookkeeping of the source (a component past its end of life is reported again on the target)',
  notify_alerts: 'send bookkeeping of the source (a check that still fails is notified again on the target)',
  notify_pause_ends: 'send bookkeeping of the source',
  record_measure_reminders: 'send bookkeeping of the source (a reminder of an open measure may be sent again on the target)',
  ca_action_reminders: 'send bookkeeping of the source (a reminder of an open corrective action may be sent again on the target)',
  maintenance_notices: 'send bookkeeping of the source (announcements of future occurrences are sent again on the target)',
  daily_summary_sends: 'send bookkeeping of the source',
  notification_outbox: "messages held for quiet hours and digests (short-lived; another instance must not send this one's messages)",
  notification_digest_sends: 'send bookkeeping of the source',
  approval_posts: 'send bookkeeping of the source: where decision cards went (their follow-up cards are sent by the source)',
  teams_cards: 'cards the Teams bot of the source posted (short-lived; the target posts its own)',
  teams_conversations:
    "where the Teams bot of the source is installed: its messaging endpoint points to the source, so the target's bot records its own conversations once its app is installed",
  teams_bot_activities: 'replay protection of the Teams bot of the source (24 hours)',
  duty_notifications: 'send bookkeeping of the source (a reminder of the current period may be sent again on the target)',
  engine_probe: 'internal',
  background_jobs: 'state of the background jobs of the source (the target keeps its own)',
  copied_from: 'where copies came from (0.4.0): a note of this instance, the audit log keeps the same (monitor.duplicated …)',
  sync_sources: 'instance-specific (Git sync is set up on the target again)',
  sync_items: 'belongs to the Git sync sources',
  sync_updates: 'belongs to the Git sync sources',
  // shared procedure libraries (#238, ADR 0014): trust is pinned per installation; the installed items move as
  // ordinary items (their process versions keep the library origin), sync_items with their library links do not
  library_publishers: 'trust is pinned per installation: an administrator of the target trusts publishers again (step-up)',
  library_keys: 'trust is pinned per installation: the keys are sealed with the vault of this installation',
  library_releases: "releases are staged again on the target (Git source or upload); the items moved keep their versions' library origin",
  library_installs: 'belongs to the library releases (not moved); the items stay as local items on the target',
  instance_imports: 'history of earlier moves (moving an instance that was itself imported is not supported yet)',
  imported_audit_log: 'history of earlier moves',
  audit_archives: "archives of this instance's own audit log (the files stay in its data folder; the target starts its own)",
  identity_aliases: 'history of earlier moves',
  assurance_policy_changes:
    "pending changes of this instance's assurance policy (7 days at most; the target keeps its own policy, set it there – a second administrator approves loosening it)",
  ai_budget_notices: 'send bookkeeping of the source (an AI budget notice of the current period may be sent again on the target)',
  schema_version: 'maintained by the migrations',
  schema_migrations: 'maintained by the migrations',
  sqlite_sequence: 'SQLite internal',
  db_schema_push_tokens: 'push tokens of CI (#222), only their hashes: created again on the target, like API tokens',
  cost_push_tokens: 'push tokens of CI for FOCUS cost files (#226), only their hashes: created again on the target, like API tokens',
  cost_budget_notices: 'send bookkeeping of the source (a cost budget notice of the current month may be sent again on the target)',
  supplier_reminders: 'send bookkeeping of the source (a supplier reminder of a date ahead may be sent again on the target)',
  cost_booking_reminders: 'send bookkeeping of the source (a reminder of contract payments not booked may be sent again on the target)',
};

/** Rows keyed by user id: moved for mapped users only, with the target user's id. */
export const USER_ID_TABLES: Record<string, string> = {
  daily_summary_prefs: 'user_id',
  notification_prefs: 'user_id',
  notification_personal_channels: 'user_id',
  notification_opt_ins: 'user_id',
};

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
  // an identity's own access list (0.9.0, ADR 0009; the default identity has none)
  { table: 'platform_identities', column: 'acl', kind: 'acl' },
  { table: 'schedules', column: 'owner', kind: 'username' },
  { table: 'dashboards', column: 'owner', kind: 'username' },
  { table: 'monitors', column: 'owner', kind: 'username' },
  { table: 'monitors', column: 'acl', kind: 'acl' },
  { table: 'monitors', column: 'definition', kind: 'monitorDefinition' },
  { table: 'monitor_gateways', column: 'owner', kind: 'username' },
  { table: 'gatus_sources', column: 'owner', kind: 'username' },
  // changedetection.io (#242): the background read runs as the person who read the watches last
  { table: 'cd_reads', column: 'read_by', kind: 'username' },
  { table: 'access_checks', column: 'owner', kind: 'username' },
  { table: 'webhook_triggers', column: 'owner', kind: 'username' },
  { table: 'report_schedules', column: 'owner', kind: 'username' },
  { table: 'report_schedules', column: 'recipients', kind: 'recipients' },
  // the schedule's team, for its report branding (#136)
  { table: 'report_schedules', column: 'team', kind: 'subjects' },
  { table: 'records', column: 'owner', kind: 'username' },
  { table: 'record_documents', column: 'review_owner', kind: 'username' },
  { table: 'run_tasks', column: 'assignees', kind: 'subjects' },
  { table: 'run_tasks', column: 'verifiers', kind: 'subjects' },
  { table: 'credentials', column: 'owner_subjects', kind: 'subjects' },
  { table: 'services', column: 'owners', kind: 'subjects' },
  { table: 'applications', column: 'owners', kind: 'subjects' },
  { table: 'systems', column: 'owners', kind: 'subjects' },
  // suppliers (0.17.0, ADR 0029): owners like systems
  { table: 'suppliers', column: 'owners', kind: 'subjects' },
  // contracts with their own scope (0.18.0, ADR 0031): who manages a contract now
  { table: 'supplier_contracts', column: 'owners', kind: 'subjects' },
  { table: 'maintenance_windows', column: 'responsible', kind: 'subjects' },
  { table: 'record_measures', column: 'owners', kind: 'subjects' },
  // corrective actions (ADR 0029): who owns a finding and its actions now
  { table: 'ca_findings', column: 'owner', kind: 'username' },
  { table: 'ca_actions', column: 'owners', kind: 'subjects' },
  // statement of applicability (ADR 0029 part 2): who owns a row now
  { table: 'soa_entries', column: 'owner', kind: 'subjects' },
  { table: 'service_duties', column: 'owners', kind: 'subjects' },
  { table: 'duty_skips', column: 'decider_subjects', kind: 'subjects' },
  // the owners a service had on the day of the snapshot: mapped, so the trend per owner names the target's users and teams
  { table: 'scorecard_snapshots', column: 'owners', kind: 'subjects' },
  { table: 'ticket_refs', column: 'responsible', kind: 'subjects' },
  // the access list of a plant registry site (#218)
  { table: 'plant_sites', column: 'acl', kind: 'acl' },
];

/**
 * Columns that record who did something: kept as they are (evidence, often inside hashes and seals).
 * Listed so that the classification test notices new person columns.
 */
export const HISTORY_COLUMNS: string[] = [
  'ai_usage.actor',
  'ai_budgets.updated_by',
  // platform costs (#226)
  'cost_sources.updated_by',
  'cost_imports.actor',
  'cost_budgets.updated_by',
  // service cost planning (0.16.0, ADR 0026)
  'cost_plan_lines.created_by',
  'cost_plan_lines.updated_by',
  'cost_entries.created_by',
  'cost_entries.updated_by',
  // contract payments and recorded costs (0.18.0, ADR 0030): payment schedules, CSV imports of entries
  'cost_schedules.created_by',
  'cost_schedules.updated_by',
  'cost_entry_imports.created_by',
  'cost_entry_imports.removed_by',
  // suppliers (0.17.0, ADR 0029): who made and changed one, who looked at a certificate
  'suppliers.created_by',
  'suppliers.updated_by',
  'supplier_certificates.checked_by',
  // contracts with their own scope (0.18.0, ADR 0031): who made and changed a contract, who added and confirmed a covered service
  'supplier_contracts.created_by',
  'supplier_contracts.updated_by',
  'supplier_contract_services.added_by',
  'supplier_contract_services.confirmed_by',
  // who kept a group of "Same supplier in several teams" separate (ADR 0031)
  'supplier_merge_dismissals.dismissed_by',
  // the plant registry (#218)
  'plant_sites.created_by',
  'plant_sites.updated_by',
  'plant_nodes.created_by',
  'plant_nodes.updated_by',
  'plant_buildings.created_by',
  'plant_buildings.updated_by',
  'plant_assets.created_by',
  'plant_assets.updated_by',
  'plant_asset_images.updated_by',
  'plant_imports.created_by',
  // database schema snapshots and their settings (#222)
  'db_schema_snapshots.actor',
  'db_schema_settings.updated_by',
  // links of changedetection.io watches (#242)
  'cd_watches.linked_by',
  // data contracts, their versions, links and test runs (#221)
  'data_contracts.created_by',
  'data_contracts.updated_by',
  'data_contract_versions.created_by',
  'data_contract_links.created_by',
  'data_contract_runs.actor',
  'data_contract_kept_rules.deleted_by',
  'plant_profiles.created_by',
  'plant_profiles.updated_by',
  'plant_kpis.created_by',
  'plant_kpis.updated_by',
  'plant_assignments.created_by',
  'plant_assignments.updated_by',
  // the OT network (#220)
  'plant_vlans.created_by',
  'plant_vlans.updated_by',
  'plant_zones.created_by',
  'plant_zones.updated_by',
  'plant_conduits.created_by',
  'plant_conduits.updated_by',
  'plant_devices.created_by',
  'plant_devices.updated_by',
  'plant_data_paths.created_by',
  'plant_data_paths.updated_by',
  'plant_asset_checks.created_by',
  'plant_asset_checks.updated_by',
  // data collections and the gateway names remembered from imports (0.11.0)
  'plant_collections.created_by',
  'plant_collections.updated_by',
  'plant_collection_mappings.created_by',
  // the kept files of collection imports (0.12)
  'plant_collection_sources.imported_by',
  // 0.14: the last check of an Insights Hub mapping and the links of sink items to monitor checks
  'plant_ih_checks.checked_by',
  'plant_ih_monitor_links.created_by',
  // old ids of renamed plant entries (0.11.0)
  'plant_id_aliases.renamed_by',
  // the history of plant entries (0.13.0): who wrote a change and who applied it
  'plant_entry_history.author',
  'plant_entry_history.applied_by',
  // security advisories (0.14): who added a source or a document, who decided on a match, recorded a remediation or
  // marked an advisory as not applicable at a site
  'plant_advisory_sources.created_by',
  'plant_advisory_sources.updated_by',
  'plant_advisories.created_by',
  'plant_advisories.updated_by',
  'plant_advisory_matches.decided_by',
  'plant_advisory_matches.remediation_by',
  'plant_advisory_sites.decided_by',
  // who confirmed plant documentation as still current (0.14)
  'plant_doc_confirmations.confirmed_by',
  'access_checks.updated_by',
  'application_components.created_by',
  'platform_recordings.created_by',
  'platform_recordings.updated_by',
  'platform_health.updated_by',
  // who last read a Confluent Cloud platform (0.14)
  'confluent_readouts.read_by',
  'kafka_connect_readouts.read_by',
  // platform identities (0.9.0, ADR 0009): who created and last changed one
  'platform_identities.created_by',
  'platform_identities.updated_by',
  'application_topic_prefixes.created_by',
  'application_components.updated_by',
  'application_components.sbom_imported_by',
  'application_platforms.created_by',
  'application_ratings.rated_by',
  'applications.created_by',
  'applications.updated_by',
  'cia_scales.updated_by',
  'component_stack.set_by',
  'systems.created_by',
  'maintenance_windows.created_by',
  'maintenance_windows.updated_by',
  'maintenance_windows.cancelled_by',
  'record_measures.created_by',
  'record_measures.updated_by',
  'record_measures.done_by',
  // corrective actions (ADR 0029): who recorded, changed, closed and checked a finding, did an action, decided a suggestion
  'ca_findings.created_by',
  'ca_findings.updated_by',
  'ca_findings.closed_by',
  'ca_findings.eff_checked_by',
  // who took part in a fix (security review 0.17.0): subjects user:/team:/role:, kept as history
  'ca_findings.fix_participants',
  'ca_actions.created_by',
  'ca_actions.updated_by',
  'ca_actions.done_by',
  'ca_suggestions.decided_by',
  // statement of applicability and responsibility matrix (ADR 0029 part 2): who made, changed, reviewed, submitted and decided
  'soas.created_by',
  'soas.updated_by',
  'soa_entries.reviewed_by',
  'soa_entries.updated_by',
  'soa_versions.submitted_by',
  'soa_versions.decided_by',
  'service_responsibilities.updated_by',
  'systems.updated_by',
  'systems.sbom_imported_by',
  'system_stack.set_by',
  'stack_version_watch.set_by',
  'application_systems.created_by',
  'system_segments.created_by',
  'access_findings.resolved_by',
  'access_findings.dismiss_requested_by',
  'access_snapshots.taken_by',
  'person_reviews.person_user',
  'person_reviews.created_by',
  'person_reviews.submitted_by',
  'person_reviews.approved_by',
  'person_review_items.decided_by',
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
  'person_review_items.subject_id',
  'person_review_items.subject_name',
  'person_review_items.subject_type',
  'person_reviews.person_name',
  'monitor_output_state.subject',
  'credentials.owners',
  'credentials.used_by',
  'monitor_checks.caused_by',
  'monitor_history.caused_by',
  'notifications.user_id',
  // the OT network (#220): owners and managers are free text (a team's name, a provider), the subject of a data path is its data
  'plant_vlans.owner',
  'plant_vlans.managed_by',
  'plant_zones.owner',
  'plant_devices.owner',
  'plant_data_paths.subject',
  // a database platform or system (#222), not a person
  'db_schema_snapshots.subject_kind',
  'db_schema_snapshots.subject_id',
  'db_schema_settings.subject_kind',
  'db_schema_settings.subject_id',
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
  'retentionDebugRunDays',
  'debugPauseMinutes',
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
  'catalogue.versions',
  'catalogue.environments',
  'plant.settings',
  'compliance.corrective',
];

/** Folders of the data directory with stored files (attachments, artifacts, reports, evidence packs, logos). */
export const FILE_DIRS = ['artifacts', 'docs', 'reports', 'records', 'evidence-packs', 'branding'];
