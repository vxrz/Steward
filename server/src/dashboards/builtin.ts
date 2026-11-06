import { currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { monitorDatasetVisible } from '../monitors/datasets.js';

/**
 * Datasets that no process publishes (their "process id" names who does): `monitor:<id>` / `monitor:*` from the
 * monitor engine (monitors/datasets.ts) and `ai:usage` – the usage of AI models (0.6.0, ai/dataset.ts), visible to
 * administrators and auditors like the usage log, and `catalogue:versions` – the version watch's component versions
 * (#241), administrators and auditors as well. Undefined for a dataset of a process: its process decides.
 */
export function builtinDatasetVisible(processId: string): boolean | undefined {
  if (processId.startsWith('monitor:')) return monitorDatasetVisible(processId);
  if (processId.startsWith('ai:')) return capabilities(currentUser()).viewAudit;
  // the version watch's "Component versions" (#241) names every application, also those of teams others may not see
  if (processId === 'catalogue:versions') return capabilities(currentUser()).viewAudit;
  return undefined;
}
