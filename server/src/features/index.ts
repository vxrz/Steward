import { registerReportSection } from '../reports/sections.js';
import type { FeatureManifest } from './define.js';
import reports from './reports.js';
import records from './records.js';
import tickets from './tickets.js';
import duties from './duties.js';
import scorecard from './scorecard.js';
import ai from './ai.js';
import costs from './costs.js';
import datacontracts from './datacontracts.js';

/**
 * The composition root (docs/ARCHITECTURE.md "How features are wired"): the only list of Steward's features, and the
 * only place that wires what their manifests bring. Entry points import it – app.ts, main.ts, the CLIs – nothing
 * else does (npm run check:imports).
 *
 * The order counts: it is the order of the sections in a scheduled report.
 */
export const FEATURES: readonly FeatureManifest[] = [reports, records, tickets, duties, scorecard, ai, costs, datacontracts];

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
