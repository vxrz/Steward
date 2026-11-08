import { sleep } from '../../util.js';
import { Cancelled, type StepExecutor } from './context.js';

/** "Wait": a timer, cancelled with the run; a single-node debug run does not wait. */
export const waitStep: StepExecutor<'wait'> = {
  type: 'wait',
  async exec(step, ctx) {
    if (ctx.debug?.kind === 'node')
      return { summary: `Would wait ${step.seconds}s (not waited in a single-node run)`, output: { wouldWaitSeconds: step.seconds } };
    await sleep(step.seconds * 1000, ctx.signal).catch(() => {
      throw new Cancelled();
    });
    return { summary: `Waited ${step.seconds}s` };
  },
};
