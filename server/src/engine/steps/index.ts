import type { FlowNode } from '@sm/shared';
import { accessChangeStep } from './access-change.js';
import { aiStep } from './ai.js';
import { browserStep } from './browser.js';
import { checkStep } from './check.js';
import type { StepExecutor, StepRegistry, StepType } from './context.js';
import { contractTestStep } from './contract-test.js';
import { failStep } from './fail.js';
import { httpStep } from './http.js';
import { logStep } from './log.js';
import { publishStep } from './publish.js';
import { queryStep } from './query.js';
import { reportStep } from './report.js';
import { setStep } from './set.js';
import { subprocessStep } from './subprocess.js';
import { userTaskStep } from './user-task.js';
import { waitStep } from './wait.js';

/**
 * The step registry (ADR 0011, update 0.11): every step type is a module of its own behind one typed record, so the
 * compiler checks that none is missing. Flow control (start, note, if, forEach) is the engine's own (runner.ts).
 */
export const STEPS: StepRegistry = {
  http: httpStep,
  query: queryStep,
  set: setStep,
  userTask: userTaskStep,
  check: checkStep,
  log: logStep,
  report: reportStep,
  browser: browserStep,
  publish: publishStep,
  accessChange: accessChangeStep,
  ai: aiStep,
  contractTest: contractTestStep,
  subprocess: subprocessStep,
  wait: waitStep,
  fail: failStep,
};

/** The executor of a node's step type; undefined for flow control. */
export function stepOf(node: FlowNode): StepExecutor<StepType> | undefined {
  return Object.hasOwn(STEPS, node.type) ? (STEPS[node.type as StepType] as StepExecutor<StepType>) : undefined;
}
