import type { FlowNode } from '@sm/shared';
import type { StepExecutor, StepRegistry, StepType } from './context.js';
import { browserStep } from './browser.js';
import { subprocessStep } from './subprocess.js';
import { userTaskStep } from './user-task.js';
import { httpStep } from './http.js';
import { aiStep } from './ai.js';
import { queryStep } from './query.js';
import { contractTestStep } from './contract-test.js';
import { accessChangeStep } from './access-change.js';
import { publishStep } from './publish.js';
import { checkStep } from './check.js';
import { reportStep } from './report.js';
import { waitStep } from './wait.js';
import { failStep } from './fail.js';
import { logStep } from './log.js';
import { setStep } from './set.js';

/**
 * The step registry (ADR 0011, update 0.11): every step type is a module of its own behind one typed record, so the
 * compiler checks that none is missing. Flow control (start, note, if, forEach) is the engine's own.
 */

let registry: Partial<StepRegistry> | undefined;

/** Built on first use: step modules import modules that import the engine again (an import cycle), so not at load time. */
export function steps(): Partial<StepRegistry> {
  return (registry ??= {
    browser: browserStep,
    subprocess: subprocessStep,
    userTask: userTaskStep,
    http: httpStep,
    ai: aiStep,
    query: queryStep,
    contractTest: contractTestStep,
    accessChange: accessChangeStep,
    publish: publishStep,
    check: checkStep,
    report: reportStep,
    wait: waitStep,
    fail: failStep,
    log: logStep,
    set: setStep,
  });
}

/** The executor of a node's step type (undefined for flow control). */
export function stepOf(node: FlowNode): StepExecutor<StepType> | undefined {
  return (steps() as Partial<Record<string, StepExecutor<StepType>>>)[node.type];
}
