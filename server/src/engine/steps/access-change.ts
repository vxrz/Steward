import type { NodeOf } from '@sm/shared';
import { recordStepAccessChanges, type AccessChangeInput } from '../../compliance/run-entries.js';
import { stringify } from '../expr.js';
import type { LeafResult, StepContext, StepExecutor } from './context.js';

/** "Document access changes": the entries are created when the run ends (compliance/access-changes.ts). */
export const accessChangeStep: StepExecutor<'accessChange'> = { type: 'accessChange', exec: execAccessChange };

/** Rights as a clean list: an array, or text with one right per line or comma-separated. */
function rightsList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : typeof v === 'string' ? v.split(/[\n,]/) : [v];
  return [...new Set(raw.map((x) => stringify(x).trim()).filter(Boolean))].slice(0, 500);
}

/** accessChange: collects the access changes of this run; the entries are created when the run ends (compliance/access-changes.ts). */
async function execAccessChange(step: NodeOf<'accessChange'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  const items = step.items ? await ctx.list(step.items) : [undefined];
  if (items.length > 1000) throw new Error(`${items.length} subjects exceed the limit of 1000 per step`);
  const at = (expr: string | undefined, item: unknown) => (!expr ? Promise.resolve(undefined) : step.items ? ctx.item(expr, item) : ctx.eval(expr));
  const reason = ((await ctx.str(step.reason)) || '').slice(0, 2000);
  const requestRef = ((await ctx.str(step.requestRef)) || '').slice(0, 500);
  const approvedBy = ((await ctx.str(step.approvedBy)) || '').slice(0, 200);
  const entries: AccessChangeInput[] = [];
  for (const item of items) {
    const subjectId = stringify(await at(step.subjectId, item)).trim();
    if (!subjectId) {
      ctx.log('warn', 'An access change without subject id was skipped', key);
      continue;
    }
    const rights = rightsList(await at(step.rights, item));
    const before = step.rightsBefore ? rightsList(await at(step.rightsBefore, item)) : null;
    const after = step.rightsAfter ? rightsList(await at(step.rightsAfter, item)) : null;
    entries.push({
      platformId: b.platform.id,
      subjectId: subjectId.slice(0, 300),
      subjectName: stringify((await at(step.subjectName, item)) ?? '').slice(0, 300),
      kind: step.kind,
      rights,
      rightsBefore: before,
      rightsAfter: after,
      reason,
      requestRef,
      approvedBy,
      performedAt: new Date().toISOString(),
    });
  }
  const output = ctx.redactor.apply({ platform: b.platform.name, kind: step.kind, entries });
  if (ctx.dryRun) {
    return { status: 'dryrun', output: { ...output, dryRun: true }, summary: `DRY RUN – would document ${entries.length} access change(s) (${step.kind})` };
  }
  recordStepAccessChanges(ctx.runId, key, b.platform.id, output.entries);
  return { output, summary: `${entries.length} access change(s) (${step.kind}) on ${b.platform.name} – documented when the run ends` };
}
