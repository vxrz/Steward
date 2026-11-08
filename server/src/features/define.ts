import type { FastifyInstance } from 'fastify';
import type { ModuleId } from '@sm/shared';
import type { JobDefinition } from '../jobs/registry.js';
import type { ReportSectionDef } from '../reports/sections.js';

/**
 * The manifest of a feature (docs/ARCHITECTURE.md "How features are wired"): everything it brings to the rest of
 * Steward, in one place. The composition root (features/index.ts) lists the manifests and is the only place that
 * wires them. A feature never registers itself by being imported.
 */
export interface FeatureManifest {
  /** Short name, mostly the folder (server/src/<name>/) */
  name: string;
  /** The module of shared/src/modules.ts it belongs to (ADR 0016); none: always on */
  module?: ModuleId;
  /** Internal API under /api (routes/index.ts), registered in this order */
  routes?: readonly RoutePlugin[];
  /** Background jobs (jobs/registry.ts); their code is imported when a job first runs */
  jobs?: readonly JobDefinition[];
  /**
   * Sections of scheduled reports (reports/sections.ts), in the order they appear in a report; their draw halves are
   * also listed for the PDF worker (reports/pdf/drawers.ts)
   */
  reportSections?: readonly ReportSectionDef[];
}

export type RoutePlugin = (app: FastifyInstance) => Promise<void> | void;

export const defineFeature = (f: FeatureManifest): FeatureManifest => f;

export const MINUTE = 60_000;
/** A job asked every 5 minutes whether there is something to do (most decide themselves how often they really work). */
export const every5Minutes = (name: string, timeoutMs: number, run: () => Promise<unknown>): JobDefinition => ({
  name,
  intervalMs: 5 * MINUTE,
  timeoutMs,
  run,
});
