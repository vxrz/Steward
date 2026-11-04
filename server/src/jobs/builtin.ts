import { registerJob, registeredJobs } from './registry.js';
import { CHECKPOINT_INTERVAL_MINUTES } from '../audit-anchor.js';

/**
 * Steward's own periodic background jobs, run by the job runner (jobs/registry.ts). Each one is idempotent and
 * decides itself whether there is something to do (most integrations refresh every few hours, reminders once a
 * day); the interval is how often it is asked. Modules are imported when the job first runs, as before.
 */

const MINUTE = 60_000;
const NOTIFY_INTERVAL = 5 * MINUTE;

export function registerBuiltInJobs(): void {
  if (registeredJobs().includes('cleanup')) return;
  const every5 = (name: string, timeoutMs: number, run: () => Promise<unknown>) => registerJob({ name, intervalMs: NOTIFY_INTERVAL, timeoutMs, run });

  // dashboard data older than its freshness limit (notifications/service.ts)
  every5('stale-datasets', 2 * MINUTE, () => import('../notifications/service.js').then((m) => m.checkStaleDatasets()));
  // credentials register: expiry / rotation / review reminders (credentials/reminders.ts)
  every5('credential-reminders', 2 * MINUTE, () => import('../credentials/reminders.js').then((m) => m.checkCredentialReminders()));
  // living documents: periodic review reminders (records/documents.ts)
  every5('document-reviews', 2 * MINUTE, () => import('../records/documents.js').then((m) => m.checkDocumentReviews()));
  // ticket references: "not checked for N days" reminders (tickets/reminders.ts)
  every5('ticket-reminders', 5 * MINUTE, () => import('../tickets/reminders.js').then((m) => m.checkTicketReminders()));
  // service duties: store and close periods, reminders and "missed" messages (duties/jobs.ts)
  every5('duties', 5 * MINUTE, () => import('../duties/jobs.js').then((m) => m.runDutyJob()));
  // availability objectives and the scorecard: Prometheus figures first (#110), then hourly samples, breaches, daily snapshots
  every5('scorecard', 10 * MINUTE, async () => {
    let promError: unknown;
    await import('../scorecard/objectives.js').then((o) => o.readPromObjectives()).catch((err) => (promError = err));
    // the scorecard still runs on the figures it has
    await import('../scorecard/jobs.js').then((m) => m.runScorecardJob());
    if (promError) throw new Error(`Reading Prometheus figures for objectives failed: ${(promError as Error)?.message ?? promError}`);
  });
  // end of life of the tech stacks: daily refresh from endoflife.date and messages to application owners
  every5('end-of-life', 15 * MINUTE, () => import('../catalogue/lifecycle.js').then((m) => m.runLifecycleJob()));
  // Kubernetes namespaces, repositories, Kafka topics, AWS accounts, Snowflake, Dependency-Track of applications (every few hours)
  every5('kubernetes', 30 * MINUTE, () => import('../catalogue/kubernetes.js').then((m) => m.runKubernetesJob()));
  every5('repositories', 30 * MINUTE, () => import('../catalogue/repositories.js').then((m) => m.runRepositoryJob()));
  every5('kafka', 30 * MINUTE, () => import('../kafka/service.js').then((m) => m.runKafkaJob()));
  every5('aws', 30 * MINUTE, () => import('../aws/service.js').then((m) => m.runAwsJob()));
  every5('snowflake', 30 * MINUTE, () => import('../snowflake/service.js').then((m) => m.runSnowflakeJob()));
  every5('dependency-track', 30 * MINUTE, () => import('../dtrack/service.js').then((m) => m.runDtrackJob()));
  // credentials register entries linked to their IBM Verify Privilege Vault secret (#205): metadata every few hours
  every5('vault-links', 30 * MINUTE, () => import('../credentials/vault.js').then((m) => m.runVaultLinkJob()));
  // daily summaries of the people who turned them on (notifications/summary.ts)
  every5('daily-summary', 10 * MINUTE, () => import('../notifications/summary.js').then((m) => m.runDailySummaries()));
  // maintenance windows: reminders, start and end messages (catalogue/maintenance.ts)
  every5('maintenance-windows', 2 * MINUTE, () => import('../catalogue/maintenance.js').then((m) => m.runMaintenanceJob()));
  // measures from incident reviews: due and overdue reminders (records/reviews.ts)
  every5('measure-reminders', 2 * MINUTE, () => import('../records/reviews.js').then((m) => m.runMeasureJob()));
  // paused messages of schedules, triggers and monitor outputs: one "still failing" message when a pause ends (#139)
  every5('pause-ends', 2 * MINUTE, () => import('../notifications/pause.js').then((m) => m.checkPauseEnds()));
  // periodic connection tests of the platforms that turned them on (platforms/health.ts); Kafka topic prefixes kept in sync (kafka/prefixes.ts)
  every5('platform-health', 5 * MINUTE, () => import('../platforms/health.js').then((m) => m.runPlatformHealthJob()));
  every5('kafka-topic-prefixes', 10 * MINUTE, () => import('../kafka/prefixes.js').then((m) => m.runTopicPrefixJob()));

  // retention clean-up: one minute after the start, then daily (maintenance.ts)
  registerJob({
    name: 'cleanup',
    intervalMs: 24 * 60 * MINUTE,
    firstRunAfterMs: MINUTE,
    timeoutMs: 30 * MINUTE,
    run: () => import('../maintenance.js').then((m) => m.runCleanup()),
  });
  // signed audit checkpoints (audit-anchor.ts, SM_AUDIT_CHECKPOINT_MINUTES; nothing is signed while the vault is locked)
  registerJob({
    name: 'audit-checkpoint',
    intervalMs: CHECKPOINT_INTERVAL_MINUTES * MINUTE,
    timeoutMs: 5 * MINUTE,
    run: () => import('../audit-anchor.js').then((m) => m.createCheckpoint('interval')),
  });
  // the scheduler's "still running" mark: fires after the last mark count as missed at the next start (scheduler.ts)
  // the full verification of the audit chain every SM_AUDIT_FULL_VERIFY_DAYS; it starts a background job and returns (audit-archive.ts)
  registerJob({
    name: 'audit-full-verification',
    intervalMs: 60 * MINUTE,
    timeoutMs: 5 * MINUTE,
    run: () => import('../audit-archive.js').then((m) => m.scheduledFullVerification()),
  });
  registerJob({ name: 'scheduler-heartbeat', intervalMs: MINUTE, timeoutMs: MINUTE, run: () => import('../scheduler.js').then((m) => m.recordAlive()) });
  // scheduled Git sync fetches: once a minute, every source whose interval has passed (sync/engine.ts)
  registerJob({ name: 'git-sync', intervalMs: MINUTE, timeoutMs: 15 * MINUTE, run: () => import('../sync/engine.js').then((m) => m.tick()) });
}
