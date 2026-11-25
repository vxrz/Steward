import type { AccessChangeLinkKind, NodeOf } from '@sm/shared';
import type { AccessChangeInput } from '../../compliance/run-entries.js';
import { stringify } from '../expr.js';
import type { LeafResult, StepContext, StepExecutor } from './context.js';

/** "Document access changes": the entries are created when the run ends (compliance/access-changes.ts). */
export const accessChangeStep: StepExecutor<'accessChange'> = { type: 'accessChange', exec: execAccessChange };

/** Rights as a clean list: an array, or text with one right per line or comma-separated. */
function rightsList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : typeof v === 'string' ? v.split(/[\n,]/) : [v];
  return [...new Set(raw.map((x) => stringify(x).trim()).filter(Boolean))].slice(0, 500);
}

/** Ids of one link list of the step: ids, or expressions giving an id or a list of ids (at most 50 per kind). */
async function linkIds(list: string[] | undefined, ctx: StepContext): Promise<string[]> {
  if (!list?.length) return [];
  const rendered = await ctx.render(list);
  const flat = (Array.isArray(rendered) ? rendered : [rendered]).flat(2);
  return [...new Set(flat.map((x) => stringify(x).trim()).filter(Boolean))].slice(0, 50);
}

/** accessChange: collects the access changes of this run; the entries are created when the run ends (compliance/access-changes.ts). */
async function execAccessChange(step: NodeOf<'accessChange'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  // an access change recorded through a read-only identity cannot be right (0.13.0, ADR 0009) – in dry runs too
  const { assertIdentityWrites } = await import('../../platforms/identityGuard.js');
  assertIdentityWrites(b.platform, 'documenting an access change');
  const items = step.items ? await ctx.list(step.items) : [undefined];
  if (items.length > 1000) throw new Error(`${items.length} subjects exceed the limit of 1000 per step`);
  const at = (expr: string | undefined, item: unknown) => (!expr ? Promise.resolve(undefined) : step.items ? ctx.item(expr, item) : ctx.eval(expr));
  const reason = ((await ctx.str(step.reason)) || '').slice(0, 2000);
  const requestRef = ((await ctx.str(step.requestRef)) || '').slice(0, 500);
  const approvedBy = ((await ctx.str(step.approvedBy)) || '').slice(0, 200);
  // services, applications and systems the change is for: unknown ids and ids the run's actor may not see (compliance/run-entries.ts linkActor) are left out with a warning (the run goes on)
  // loaded lazily: compliance (and the reports behind it) builds on the engine, not the other way round (ADR 0011, check:imports)
  const { linkActor, visibleLinkIds } = await import('../../compliance/run-entries.js');
  const actor = linkActor(ctx.runId);
  const links: Partial<Record<AccessChangeLinkKind, string[]>> = {};
  for (const [kind, list] of [
    ['service', step.services],
    ['application', step.applications],
    ['system', step.systems],
  ] as const) {
    const { visible, skipped } = visibleLinkIds(kind, await linkIds(list, ctx), actor);
    if (visible.length) links[kind] = visible;
    for (const id of skipped) ctx.log('warn', `The ${kind} "${id}" is unknown or not visible – it is not linked to the access change`, key);
  }
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
      ...(step.subjectType ? { subjectType: step.subjectType } : {}),
      ...(links.service ? { services: links.service } : {}),
      ...(links.application ? { applications: links.application } : {}),
      ...(links.system ? { systems: links.system } : {}),
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
  const { recordStepAccessChanges } = await import('../../compliance/run-entries.js');
  recordStepAccessChanges(ctx.runId, key, b.platform.id, output.entries);
  return { output, summary: `${entries.length} access change(s) (${step.kind}) on ${b.platform.name} – documented when the run ends` };
}
