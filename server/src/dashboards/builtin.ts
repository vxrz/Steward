import { MODULES } from '@sm/shared';
import { moduleAvailable } from '../modules/access.js';

/**
 * A built-in dataset of a switched-off module (ADR 0016) – or of a module the signed-in person does not use (ADR
 * 0034): hidden, as if it did not exist.
 */
export function datasetOfSwitchedOffModule(processId: string): boolean {
  const m = MODULES.find((x) => x.datasets?.some((p) => processId.startsWith(p)));
  return !!m && !moduleAvailable(m.id);
}

/**
 * Datasets that no process publishes: their "process id" names who does – `monitor:<id>` / `monitor:*` from the
 * monitor engine (monitors/datasets.ts), `ai:usage` (ai/dataset.ts), `catalogue:versions` (versions/dataset.ts),
 * `costs:model` (costs/dataset.ts). The features bring them in their manifests (features/), with who may read them.
 */
export interface BuiltinDataset {
  /** The feature that publishes it */
  name: string;
  /** Whether a dataset's process id is one of these */
  owns: (processId: string) => boolean;
  /** Whether the signed-in person may read it */
  visible: (processId: string) => boolean;
}

const DATASETS: BuiltinDataset[] = [];
/** features/index.ts registers the built-in datasets of the features. */
export function registerBuiltinDataset(d: BuiltinDataset): void {
  DATASETS.push(d);
}

/**
 * Whether the signed-in person may read a built-in dataset; undefined for a dataset of a process: its process decides.
 * Not registered (yet) means undefined too, so the process rules apply – and no process has such an id: hidden.
 */
export function builtinDatasetVisible(processId: string): boolean | undefined {
  if (datasetOfSwitchedOffModule(processId)) return false;
  return DATASETS.find((d) => d.owns(processId))?.visible(processId);
}
