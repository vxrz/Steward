import type { FastifyInstance } from 'fastify';
import type { ModuleId } from '@sm/shared';
import type { JobDefinition } from '../jobs/registry.js';
import type { Get } from '../api/v1/helpers.js';
import type { ToolDef } from '../mcp/tooling.js';
import type { BuiltinDataset } from '../dashboards/builtin.js';
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
  /** Public API under /api/v1 (read-only, documented in docs/openapi.json; api/v1/routes.ts), in this order */
  apiV1?: readonly ApiV1Plugin[];
  /** Background jobs (jobs/registry.ts); their code is imported when a job first runs */
  jobs?: readonly JobDefinition[];
  /**
   * Sections of scheduled reports (reports/sections.ts), in the order they appear in a report; their draw halves are
   * also listed for the PDF worker (reports/pdf/drawers.ts)
   */
  reportSections?: readonly ReportSectionDef[];
  /** Datasets no process publishes, with who may read them (dashboards/builtin.ts) */
  datasets?: readonly BuiltinDataset[];
  /** Tools of the MCP server (mcp/tools.ts), after Steward's own */
  mcpTools?: readonly ToolDef[];
}

export type RoutePlugin = (app: FastifyInstance) => Promise<void> | void;
export type ApiV1Plugin = (get: Get, app: FastifyInstance) => Promise<void> | void;

export const defineFeature = (f: FeatureManifest): FeatureManifest => f;

export const MINUTE = 60_000;
/** A job asked every 5 minutes whether there is something to do (most decide themselves how often they really work). */
export const every5Minutes = (name: string, timeoutMs: number, run: () => Promise<unknown>): JobDefinition => ({
  name,
  intervalMs: 5 * MINUTE,
  timeoutMs,
  run,
});
