import { registeredJobs, registerJob, type JobDefinition } from '../jobs/registry.js';
import { registerReportSection } from '../reports/sections.js';
import { registerMcpTools } from '../mcp/tools.js';
import { registerBuiltinDataset } from '../dashboards/builtin.js';
import type { ApiV1Plugin, FeatureManifest } from './define.js';
import auth from './auth.js';
import settings from './settings.js';
import platforms from './platforms.js';
import processes from './processes.js';
import triggers from './triggers.js';
import audit from './audit.js';
import home from './home.js';
import dashboards from './dashboards.js';
import ops from './ops.js';
import reports from './reports.js';
import monitors from './monitors.js';
import gatus from './gatus.js';
import changedetection from './changedetection.js';
import credentials from './credentials.js';
import records from './records.js';
import catalogue from './catalogue.js';
import versions from './versions.js';
import backup from './backup.js';
import tickets from './tickets.js';
import duties from './duties.js';
import scorecard from './scorecard.js';
import sync from './sync.js';
import libraries from './libraries.js';
import notifications from './notifications.js';
import teamsBot from './teamsBot.js';
import compliance from './compliance.js';
import plant from './plant.js';
import ai from './ai.js';
import dbms from './dbms.js';
import kafka from './kafka.js';
import kafkaconnect from './kafkaconnect.js';
import aws from './aws.js';
import snowflake from './snowflake.js';
import dtrack from './dtrack.js';
import dbschema from './dbschema.js';
import costs from './costs.js';
import datacontracts from './datacontracts.js';
import migration from './migration.js';
import onboarding from './onboarding.js';
import duplicate from './duplicate.js';
import exports from './export.js';
import demo from './demo.js';

/**
 * The composition root (docs/ARCHITECTURE.md "How features are wired"): the only list of Steward's features, and the
 * only place that wires what their manifests bring. Entry points import it – app.ts, main.ts, the CLIs – nothing
 * else does (npm run check:imports).
 *
 * The order counts: it is the order of the sections in a scheduled report.
 */
export const FEATURES: readonly FeatureManifest[] = [
  auth,
  settings,
  platforms,
  processes,
  triggers,
  audit,
  home,
  dashboards,
  ops,
  reports,
  monitors,
  gatus,
  changedetection,
  credentials,
  records,
  catalogue,
  versions,
  backup,
  tickets,
  duties,
  scorecard,
  sync,
  libraries,
  notifications,
  teamsBot,
  compliance,
  plant,
  ai,
  dbms,
  kafka,
  kafkaconnect,
  aws,
  snowflake,
  dtrack,
  dbschema,
  costs,
  datacontracts,
  migration,
  onboarding,
  duplicate,
  exports,
  demo,
];

let installed = false;

/**
 * Registers what the features bring into the registries the rest of Steward reads (report sections, MCP tools,
 * built-in datasets).
 * Called once by buildApp() (app.ts), before anything is served; later calls do nothing.
 */
export function installFeatures(): void {
  if (installed) return;
  installed = true;
  for (const f of FEATURES) {
    for (const s of f.reportSections ?? []) registerReportSection(s);
    registerMcpTools(f.mcpTools ?? []);
    for (const d of f.datasets ?? []) registerBuiltinDataset(d);
  }
}

/** The public API (/api/v1) of the features, after the API's own endpoints (api/v1/routes.ts). */
export const featureApiRoutes = (): ApiV1Plugin[] => FEATURES.flatMap((f) => f.apiV1 ?? []);

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
