import * as store from '../store.js';
import type { StepExecutor } from './context.js';

/** "Test a data contract" (#221): the contract's test through its data contract service (datacontracts/step.ts). */
export const contractTestStep: StepExecutor<'contractTest'> = {
  type: 'contractTest',
  async exec(step, ctx, key) {
    // the contract's test through its data contract service (#221): with the run actor's rights, stored as evidence
    const { runContractTestStep } = await import('../../datacontracts/step.js');
    return runContractTestStep(step, {
      contract: await ctx.str(step.contract),
      server: step.server ? await ctx.str(step.server) : undefined,
      actor: ctx.actor,
      runId: ctx.runId,
      dryRun: ctx.dryRun,
      recorded: ctx.recorded,
      signal: ctx.signal,
      setInput: (input) => store.updateStepInput(ctx.runId, key, ctx.redactor.apply(input)),
      log: (level, message) => ctx.log(level, message, key),
    });
  },
};
