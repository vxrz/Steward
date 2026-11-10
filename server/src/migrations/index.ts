import type { NamedMigration } from '../db.js';
import { OPS_MIGRATIONS } from './ops.js';
import { ENGINE_MIGRATIONS } from './engine.js';
import { PERF_MIGRATIONS } from './perf.js';
import { REPORT_MIGRATIONS } from './reports.js';
import { TRIGGER_MIGRATIONS } from './triggers.js';
import { MONITOR_MIGRATIONS } from './monitors.js';
import { SECURITY_MIGRATIONS } from './security.js';
import { CREDENTIAL_MIGRATIONS } from './credentials.js';
import { GATUS_MIGRATIONS } from './gatus.js';
import { REPORT_SCHEDULE_MIGRATIONS } from './report-schedules.js';
import { RECORD_MIGRATIONS } from './records.js';
import { GITSYNC_MIGRATIONS } from './gitsync.js';
import { TICKET_MIGRATIONS } from './tickets.js';
import { DAILY_SUMMARY_MIGRATIONS } from './daily-summary.js';
import { COMPLIANCE_MIGRATIONS } from './compliance.js';
import { SIGN_IN_MIGRATIONS } from './sign-in.js';
import { MOVE_MIGRATIONS } from './instance-moves.js';
import { MANUAL_STEP_MIGRATIONS } from './manual-steps.js';
import { CATALOGUE_MIGRATIONS } from './catalogue.js';
import { DUTY_MIGRATIONS } from './duties.js';
import { SCORECARD_MIGRATIONS } from './scorecard.js';
import { PLATFORM_MIGRATIONS } from './platforms.js';
import { TEAM_MIGRATIONS } from './teams.js';
import { MCP_OAUTH_MIGRATIONS } from './mcp-oauth.js';
import { PROPOSAL_MIGRATIONS } from './proposals.js';
import { AUDIT_MIGRATIONS } from './audit.js';
import { RUNTIME_MIGRATIONS } from './runtime.js';
import { DUPLICATE_MIGRATIONS } from './duplicates.js';
import { ASSURANCE_MIGRATIONS } from './assurance.js';
import { AI_MIGRATIONS } from './ai.js';
import { PLANT_MIGRATIONS } from './plant.js';
import { DBSCHEMA_MIGRATIONS } from './dbschema.js';
import { CHANGEDETECTION_MIGRATIONS } from './changedetection.js';
import { COSTS_MIGRATIONS } from './costs.js';
import { DATA_CONTRACT_MIGRATIONS } from './datacontracts.js';
import { LIBRARY_MIGRATIONS } from './libraries.js';
import { NOTIFICATION_MIGRATIONS } from './notifications.js';
import { CONFLUENT_MIGRATIONS } from './confluent.js';

/**
 * The named migrations, in the order they run on a new database (db.ts). Each feature owns its list (its manifest
 * names it, features/), so parallel work never collides on numbers. The order is history: a new list goes at the
 * end, a new migration at the end of its list – never in between – so an upgraded database and a new one end up the
 * same (upgrade.test.ts compares them).
 */
export const MIGRATION_LISTS: readonly (readonly NamedMigration[])[] = [
  OPS_MIGRATIONS,
  ENGINE_MIGRATIONS,
  PERF_MIGRATIONS,
  REPORT_MIGRATIONS,
  TRIGGER_MIGRATIONS,
  MONITOR_MIGRATIONS,
  SECURITY_MIGRATIONS,
  CREDENTIAL_MIGRATIONS,
  GATUS_MIGRATIONS,
  REPORT_SCHEDULE_MIGRATIONS,
  RECORD_MIGRATIONS,
  GITSYNC_MIGRATIONS,
  TICKET_MIGRATIONS,
  DAILY_SUMMARY_MIGRATIONS,
  COMPLIANCE_MIGRATIONS,
  SIGN_IN_MIGRATIONS,
  MOVE_MIGRATIONS,
  MANUAL_STEP_MIGRATIONS,
  CATALOGUE_MIGRATIONS,
  DUTY_MIGRATIONS,
  SCORECARD_MIGRATIONS,
  PLATFORM_MIGRATIONS,
  TEAM_MIGRATIONS,
  MCP_OAUTH_MIGRATIONS,
  PROPOSAL_MIGRATIONS,
  AUDIT_MIGRATIONS,
  RUNTIME_MIGRATIONS,
  DUPLICATE_MIGRATIONS,
  ASSURANCE_MIGRATIONS,
  AI_MIGRATIONS,
  PLANT_MIGRATIONS,
  DBSCHEMA_MIGRATIONS,
  CHANGEDETECTION_MIGRATIONS,
  COSTS_MIGRATIONS,
  DATA_CONTRACT_MIGRATIONS,
  LIBRARY_MIGRATIONS,
  NOTIFICATION_MIGRATIONS,
  CONFLUENT_MIGRATIONS,
];

export const NAMED_MIGRATIONS: readonly NamedMigration[] = MIGRATION_LISTS.flat();
