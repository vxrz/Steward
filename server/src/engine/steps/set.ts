import { ANY } from '../../ai/provenance.js';
import { stringify } from '../expr.js';
import type { StepExecutor } from './context.js';

/** "Set variables": each value is rendered in the run scope and is a variable at once (the next value can use it). */
export const setStep: StepExecutor<'set'> = {
  type: 'set',
  async exec(step, ctx) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.values ?? {})) {
      const val = await ctx.render(v);
      out[k] = val === undefined ? null : val;
      ctx.vars[k] = out[k];
      ctx.taint(k, [ANY]);
    }
    return {
      output: out,
      summary: Object.keys(out)
        .map((k) => `${k} = ${describe(out[k])}`)
        .join(', '),
    };
  },
  preview: async (node, ctx) => ({ values: await ctx.render(node.values ?? {}) }), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  // the values are the variables (also when a resumed run replays the step); saveAs does not apply
  applyOutput(_step, ctx, output) {
    if (!output || typeof output !== 'object') return false;
    Object.assign(ctx.vars, output as Record<string, unknown>);
    for (const k of Object.keys(output)) ctx.taint(k, [ANY]);
    return true;
  },
};

function describe(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (v && typeof v === 'object') return '{…}';
  const s = stringify(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
