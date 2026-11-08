import type { FlowNode } from '@sm/shared';
import type { StepExecutor, StepRegistry, StepType } from './context.js';

/**
 * The step registry (ADR 0011, update 0.11): every step type is a module of its own behind one typed record, so the
 * compiler checks that none is missing. Flow control (start, note, if, forEach) is the engine's own.
 */

let registry: Partial<StepRegistry> | undefined;

/** Built on first use: step modules import modules that import the engine again (an import cycle), so not at load time. */
export function steps(): Partial<StepRegistry> {
  return (registry ??= {});
}

/** The executor of a node's step type (undefined for flow control). */
export function stepOf(node: FlowNode): StepExecutor<StepType> | undefined {
  return (steps() as Partial<Record<string, StepExecutor<StepType>>>)[node.type];
}
