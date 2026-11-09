import type { NodeOf } from '@sm/shared';
import { getProcess } from '../../processes/service.js';
import { parseJson } from '../../util.js';
import { startProblem } from '../commands.js';
import * as store from '../store.js';
import { Cancelled, type LeafResult, type StepContext, type StepExecutor } from './context.js';

/**
 * "Run a sub-process": a child run of another process with this run's mode and actor (ADR 0011, invariant 6), its
 * connections mapped from this run's. The step checks recursion, depth and the actor's rights; the engine starts the
 * child and waits for it (StepContext.startChild, waitForChild). A resumed run re-attaches to its child.
 */
export const subprocessStep: StepExecutor<'subprocess'> = {
  type: 'subprocess',
  exec: execSubprocess,
  preview: async (node, ctx) => ({ process: node.process, inputs: await ctx.render(node.inputs ?? {}) }), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
};

/** Maximum nesting of sub-process runs below a top-level run. */
export const MAX_SUBPROCESS_DEPTH = 5;
const FINISHED_RUN = ['succeeded', 'failed', 'cancelled'];

async function execSubprocess(step: NodeOf<'subprocess'>, ctx: StepContext, key: string, attempt: number): Promise<LeafResult> {
  let child = store.latestChildRun(ctx.runId, key);
  // a retry attempt starts a fresh child run; a resumed run re-attaches to the existing one
  if (child && attempt > 1 && FINISHED_RUN.includes(child.status) && child.status !== 'succeeded') child = undefined;
  if (child) {
    ctx.log('info', `Re-attached to sub-process run ${child.id} (${child.status})`, key);
  } else {
    const chain = store.ancestorChain(ctx.runId);
    const loop = chain.find((a) => a.processId === step.process);
    if (loop) {
      throw new Error(
        `Recursion: process "${step.process}" is already running in this chain (${chain
          .map((a) => a.processId)
          .reverse()
          .join(' → ')})`,
      );
    }
    if (chain.length > MAX_SUBPROCESS_DEPTH) throw new Error(`Sub-processes are nested too deeply (limit ${MAX_SUBPROCESS_DEPTH})`);
    // the command layer's start check (ADR 0011), with the rights of the run's actor: run on the child …
    const denied = startProblem(ctx.actor, { processId: step.process });
    if (denied) throw new Error(`${ctx.actor} may not run process "${step.process}" (needs the "run" right)`);
    const proc = getProcess(step.process, step.version);
    const bindings: Record<string, string> = {};
    // the child inherits the identity of the parent's slot (ADR 0009): it cannot choose another one
    const identities: Record<string, string> = {};
    for (const slot of proc.definition.connections) {
      const parentSlot = step.connections?.[slot.slot] ?? slot.slot;
      const b = ctx.bindings[parentSlot];
      if (!b) throw new Error(`Sub-process connection "${slot.slot}" needs connection "${parentSlot}" of this process, which is not bound`);
      bindings[slot.slot] = b.platform.id;
      const iid = (b.platform as { identityId?: string }).identityId;
      if (iid) identities[slot.slot] = iid;
    }
    // … and (since 0.10.0) use on every platform the child is bound to – and (0.13.0) on its identity, checked again
    const unusable = startProblem(ctx.actor, { processId: step.process, bindings, identities });
    if (unusable) throw new Error(`Sub-process "${step.process}": ${unusable.text}`);
    const inputs = (await ctx.render(step.inputs ?? {})) as Record<string, unknown>;
    const request = { process: step.process, version: step.version ?? proc.currentVersion, inputs, bindings };
    store.updateStepInput(ctx.runId, key, ctx.redactor.apply(request));
    // in the run's mode, as its actor; the child of a debug run is a debug run without pauses (ADR 0010)
    const id = await ctx.startChild(key, { processId: step.process, version: step.version, inputs, bindings, identities });
    store.updateStepInput(ctx.runId, key, ctx.redactor.apply({ ...request, childRunId: id }));
    ctx.log('info', `Started sub-process run ${id} of "${proc.name}"${ctx.dryRun ? ' (dry run)' : ''}`, key);
    child = { id, status: 'running' };
  }
  const row = await ctx.waitForChild(child.id, key);
  if (ctx.signal.aborted) throw new Cancelled();
  if (row.status !== 'succeeded') {
    throw new Error(`Sub-process run ${row.id} ("${row.process_name}") ${row.status}${row.error ? `: ${row.error}` : ''}`);
  }
  const outputs = parseJson<Record<string, unknown>>(row.outputs ?? null, {});
  return { output: outputs, summary: `"${row.process_name}" succeeded (run ${row.id})` };
}
