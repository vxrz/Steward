import type { StepExecutor } from './context.js';

/** "Log": a line (and optional data) in the run log. */
export const logStep: StepExecutor<'log'> = {
  type: 'log',
  async exec(step, ctx, key) {
    const message = await ctx.str(step.message);
    const data = step.data ? await ctx.eval(step.data) : undefined;
    ctx.log(step.level ?? 'info', message, key, data);
    return { output: { message, data }, summary: message.slice(0, 300) };
  },
  preview: async (node, ctx) => ({ message: await ctx.str(node.message) }),
};
