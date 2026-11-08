import { stringify } from '../expr.js';
import type { StepExecutor } from './context.js';

/** "Report": a titled table (or text) in the run's report; one that carries an AI answer says so. */
export const reportStep: StepExecutor<'report'> = {
  type: 'report',
  async exec(step, ctx) {
    const title = await ctx.str(step.title);
    const text = step.text ? await ctx.str(step.text) : undefined;
    let columns: string[] | undefined;
    let rows: unknown[][] | undefined;
    if (step.rows) {
      const list = await ctx.list(step.rows);
      if (step.columns?.length) {
        columns = step.columns.map((c) => c.label);
        rows = [];
        for (const item of list) rows.push(await Promise.all(step.columns.map(async (c) => stringify(await ctx.item(c.value, item)))));
      } else {
        const keys = new Set<string>();
        for (const it of list.slice(0, 50)) if (it && typeof it === 'object') Object.keys(it).forEach((k) => keys.add(k));
        columns = keys.size ? [...keys] : ['value'];
        rows = list.map((it) => (keys.size ? columns!.map((k) => stringify((it as Record<string, unknown>)?.[k])) : [stringify(it)]));
      }
    }
    // a report that carries an AI answer says so (and names the model) wherever it is shown
    const ai = ctx.aiModelsIn(title, text, rows);
    return {
      output: { title, text, columns, rows, ...(ai ? { aiGenerated: { models: ai } } : {}) },
      summary: (rows ? `${title}: ${rows.length} row(s)` : title) + (ai ? ` · AI-generated (${ai.join(', ')})` : ''),
    };
  },
};
