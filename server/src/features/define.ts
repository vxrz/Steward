import type { ModuleId } from '@sm/shared';
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
  /**
   * Sections of scheduled reports (reports/sections.ts), in the order they appear in a report; their draw halves are
   * also listed for the PDF worker (reports/pdf/drawers.ts)
   */
  reportSections?: readonly ReportSectionDef[];
}

export const defineFeature = (f: FeatureManifest): FeatureManifest => f;
