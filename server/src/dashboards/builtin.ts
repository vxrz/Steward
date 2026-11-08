import { currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { monitorDatasetVisible } from '../monitors/datasets.js';
import { MODULES } from '@sm/shared';
import { moduleEnabled } from '../modules/registry.js';

/** A built-in dataset of a switched-off module (ADR 0016): hidden from everyone, as if it did not exist. */
export function datasetOfSwitchedOffModule(processId: string): boolean {
  const m = MODULES.find((x) => x.datasets?.some((p) => processId.startsWith(p)));
  return !!m && !moduleEnabled(m.id);
}

/**
 * Datasets that no process publishes (their "process id" names who does): `monitor:<id>` / `monitor:*` from the
 * monitor engine (monitors/datasets.ts) and `ai:usage` – the usage of AI models (0.6.0, ai/dataset.ts), visible to
 * administrators and auditors like the usage log, and `catalogue:versions` – the version watch's component versions
 * (#241), administrators and auditors as well – and `costs:model`, the costs (#226, costs/dataset.ts), the same.
 * Undefined for a dataset of a process: its process decides.
 */
export function builtinDatasetVisible(processId: string): boolean | undefined {
  if (datasetOfSwitchedOffModule(processId)) return false;
  if (processId.startsWith('monitor:')) return monitorDatasetVisible(processId);
  if (processId.startsWith('ai:')) return capabilities(currentUser()).viewAudit;
  // the version watch's "Component versions" (#241) names every application, also those of teams others may not see
  if (processId === 'catalogue:versions') return capabilities(currentUser()).viewAudit;
  // the built-in dataset "Costs" (#226): its rows name every service, application, team and platform
  if (processId.startsWith('costs:')) return capabilities(currentUser()).viewAudit;
  return undefined;
}
