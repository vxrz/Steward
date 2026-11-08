import { registeredJobs, registerJob, type JobDefinition } from '../jobs/registry.js';
import { registerReportSection } from '../reports/sections.js';
import type { FeatureManifest } from './define.js';
import auth from './auth.js';
import platforms from './platforms.js';
import processes from './processes.js';
import audit from './audit.js';
import ops from './ops.js';
import reports from './reports.js';
import changedetection from './changedetection.js';
import credentials from './credentials.js';
import records from './records.js';
import catalogue from './catalogue.js';
import versions from './versions.js';
import tickets from './tickets.js';
import duties from './duties.js';
import scorecard from './scorecard.js';
import sync from './sync.js';
import notifications from './notifications.js';
import ai from './ai.js';
import kafka from './kafka.js';
import kafkaconnect from './kafkaconnect.js';
import aws from './aws.js';
import snowflake from './snowflake.js';
import dtrack from './dtrack.js';
import dbschema from './dbschema.js';
import costs from './costs.js';
import datacontracts from './datacontracts.js';

/**
 * The composition root (docs/ARCHITECTURE.md "How features are wired"): the only list of Steward's features, and the
 * only place that wires what their manifests bring. Entry points import it – app.ts, main.ts, the CLIs – nothing
 * else does (npm run check:imports).
 *
 * The order counts: it is the order of the sections in a scheduled report.
 */
export const FEATURES: readonly FeatureManifest[] = [
  auth,
  platforms,
  processes,
  audit,
  ops,
  reports,
  changedetection,
  credentials,
  records,
  catalogue,
  versions,
  tickets,
  duties,
  scorecard,
  sync,
  notifications,
  ai,
  kafka,
  kafkaconnect,
  aws,
  snowflake,
  dtrack,
  dbschema,
  costs,
  datacontracts,
];

let installed = false;

/**
 * Registers what the features bring into the registries the rest of Steward reads (report sections). Called once by
 * buildApp() (app.ts), before anything is served; later calls do nothing.
 */
export function installFeatures(): void {
  if (installed) return;
  installed = true;
  for (const f of FEATURES) for (const s of f.reportSections ?? []) registerReportSection(s);
}

/** The background jobs of all features (jobs/registry.ts). */
export const featureJobs = (): JobDefinition[] => FEATURES.flatMap((f) => f.jobs ?? []);

/**
 * Registers the background jobs (main.ts, before bootstrap's startBackground() starts them). Each job is idempotent
 * and decides itself whether there is something to do; the interval is how often it is asked. A job registered
 * already is left as it is.
 */
export function registerFeatureJobs(): void {
  const known = new Set(registeredJobs());
  for (const j of featureJobs()) if (!known.has(j.name)) registerJob(j);
}
