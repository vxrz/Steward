import type { StepExecutor } from './context.js';

/** "Fail": ends the run (or takes the error port) with a message. */
export const failStep: StepExecutor<'fail'> = {
  type: 'fail',
  async exec(step, ctx) {
    throw new Error(await ctx.str(step.message));
  },
};
