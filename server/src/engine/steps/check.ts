import type { NodeOf } from '@sm/shared';
import { audit } from '../../audit.js';
import { checkOutcome } from '../check-alerts.js';
import * as store from '../store.js';
import type { StepContext, StepExecutor } from './context.js';

/**
 * "Check": a condition with a message. A failed check is audited and may alert (the schedule's setting and the check's
 * state, #127); it marks the step failed and the run goes on – unless `failRun`.
 */
export const checkStep: StepExecutor<'check'> = {
  type: 'check',
  async exec(step, ctx, key) {
    const passed = await ctx.bool(step.condition);
    const message = (await ctx.str(step.message)) || (passed ? 'Passed' : `Condition not met: ${step.condition}`);
    const severity = step.severity ?? 'error';
    // what the messages say (#144): optional, and a problem here never fails the check
    const content = await checkContent(ctx, step, passed, key);
    if (passed) ctx.stats.checksPassed++;
    else ctx.stats.checksFailed++;
    // a debug run records the result in its protocol only: no check.failed entry, no alert, no message (ADR 0010)
    if (!passed && !ctx.debug) {
      audit({
        actor: ctx.actor,
        action: 'check.failed',
        entityType: 'run',
        entityId: ctx.runId,
        runId: ctx.runId,
        summary: `Check "${step.name || step.id}" failed (${severity}): ${message.slice(0, 200)}`,
      });
    }
    // whether this result notifies: the schedule's setting and the check's state (#127)
    const run = store.runRow(ctx.runId);
    if (!ctx.debug)
      checkOutcome({
        runId: ctx.runId,
        processId: run.process_id,
        processName: ctx.def.name,
        scheduleId: run.schedule_id ?? null,
        check: step.name || step.id,
        passed,
        severity,
        message,
        dryRun: ctx.dryRun,
        notify: step.notify,
        checkId: step.id,
        ...content,
        betterWhen: step.betterWhen ?? 'lower',
        runbook: step.runbook ?? ctx.def.runbook ?? null,
      });
    if (!passed && step.failRun) throw new Error(message);
    return {
      status: passed ? 'succeeded' : 'failed',
      // notify: false (informational check) stays out of the start page's failed checks
      output: { passed, severity, message, ...content, ...(step.notify === false ? { notify: false } : {}) },
      summary: `${passed ? '✔' : '✘'} ${message}`,
    };
  },
  preview: async (node, ctx) => ({ condition: node.condition, passes: await ctx.bool(node.condition) }),
};

/** Most items a check keeps for its messages, and characters per item (#144). */
const CHECK_ITEMS_MAX = 200;
const CHECK_ITEM_CHARS = 300;

/**
 * The optional content of a check's messages (#144): the headline and the items of a failure and the value. They are
 * evaluated like the message; an expression that fails only logs a warning, the check result stays as it is.
 */
async function checkContent(
  ctx: StepContext,
  step: NodeOf<'check'>,
  passed: boolean,
  key: string,
): Promise<{ headline?: string; value?: number; items?: string[]; aiGenerated?: string[] }> {
  const out: { headline?: string; value?: number; items?: string[]; aiGenerated?: string[] } = {};
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      ctx.log('warn', `Check "${step.name || step.id}": the ${what} could not be evaluated – ${(e as Error).message}`, key);
    }
  };
  if (step.value?.trim())
    await attempt('value', async () => {
      const v = Number(await ctx.eval(step.value!));
      if (Number.isFinite(v)) out.value = v;
    });
  if (!passed && step.headline?.trim())
    await attempt('headline', async () => {
      const h = (await ctx.str(step.headline!)).replace(/\s+/g, ' ').trim();
      if (h) out.headline = h.slice(0, 200);
    });
  if (!passed && step.items?.trim())
    await attempt('items', async () => {
      const v = await ctx.eval(step.items!);
      const list = (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
        .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, CHECK_ITEM_CHARS))
        .filter(Boolean);
      if (list.length) out.items = list.slice(0, CHECK_ITEMS_MAX);
    });
  const ai = passed ? undefined : ctx.aiModelsIn(out.headline, out.items, step.message ? await ctx.str(step.message).catch(() => '') : '');
  if (ai) out.aiGenerated = ai;
  return out;
}
