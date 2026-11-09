import type { NodeOf } from '@sm/shared';
import { ANY, INPUT, datasetSource, resultVars } from '../../ai/provenance.js';
import { runAiStep } from '../../ai/step.js';
import { runAs } from '../../auth/context.js';
import { findUserByName, toAuthUser } from '../../auth/users.js';
import { builtinDatasetVisible } from '../../dashboards/builtin.js';
import { datasetOwner, getDataset } from '../../dashboards/datasets.js';
import { buildUrl, secretValues } from '../../platforms/http.js';
import { permissionsFor } from '../../processes/service.js';
import * as store from '../store.js';
import type { LeafResult, StepContext, StepExecutor } from './context.js';
import { enforceOutbound } from './outbound.js';

export const aiStep: StepExecutor<'ai'> = {
  type: 'ai',
  exec: execAi,
  /** The gateway and everything the step's context may carry (ai/provenance.ts). */
  sources(node, ctx) {
    const out = new Set<string>();
    const gw = ctx.bindings[node.connection]?.platform.id;
    if (gw) out.add(gw);
    for (const c of node.context ?? []) {
      const src = c.from === 'step' ? ctx.nodes.get(c.step ?? '') : undefined;
      if (c.from === 'dataset') out.add(datasetSource(c.dataset ?? '*'));
      else if (c.from === 'input') out.add(INPUT);
      else for (const x of src ? ctx.sourcesOf(resultVars(src)) : [ANY]) out.add(x);
    }
    return [...out];
  },
  // an AI answer, also of a step replayed after a resume: reports and check messages that carry it are marked
  applyOutput(node, ctx, output) {
    if (output && typeof output === 'object' && (output as { aiGenerated?: unknown }).aiGenerated) {
      const o = output as { text?: unknown; answer?: unknown; modelLabel?: string };
      ctx.rememberAiText(o.text, o.modelLabel ?? node.model);
      if (o.answer && typeof o.answer === 'object') for (const t of stringLeaves(o.answer)) ctx.rememberAiText(t, o.modelLabel ?? node.model);
    }
  },
};

/**
 * Ask an AI model (0.6.0, ai/step.ts): the step reads its context from the run (results of earlier steps, datasets the
 * actor may read, inputs), and its call goes through the same outbound policy and secret-leak check as an http step.
 * The answer's text is remembered, so reports and check messages that carry it are marked as AI-generated.
 */
async function execAi(step: NodeOf<'ai'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  const res = await runAiStep(step, {
    runId: ctx.runId,
    processId: ctx.processId,
    parentProcessIds: store
      .ancestorChain(ctx.runId)
      .slice(1)
      .map((a) => a.processId),
    processName: ctx.def.name,
    processVersion: store.runRow(ctx.runId).process_version ?? null,
    stepKey: key,
    actor: ctx.actor,
    // a live read of one AI node (ADR 0010) asks the model: the tokens are spent and count against the budgets
    dryRun: ctx.dryRun && !ctx.debug?.live,
    recorded: ctx.recorded,
    def: ctx.def,
    gateway: { platform: b.platform, secrets: b.secrets },
    vars: ctx.vars,
    inputs: ctx.inputs,
    sourcesOf: (names) => ctx.expandSources(ctx.sourcesOf(names)),
    inputSources: () => ctx.expandSources([INPUT]),
    evalOn: (expr, value) => ctx.data(expr, value),
    datasetRows: (dsKey) => {
      const owner = datasetOwner(dsKey);
      if (!owner) throw new Error(`Dataset "${dsKey}" has no data yet`);
      const user = findUserByName(ctx.actor);
      const visible =
        owner === ctx.processId ||
        (!!user && user.active && runAs(toAuthUser(user), () => builtinDatasetVisible(owner) ?? permissionsFor(owner).includes('view')));
      if (!visible) throw new Error(`Dataset "${dsKey}" is not visible to ${ctx.actor}`);
      return (user ? runAs(toAuthUser(user), () => getDataset(dsKey)) : getDataset(dsKey)).rows as Record<string, unknown>[];
    },
    secrets: () => [...ctx.redactor.list(), ...Object.values(ctx.bindings).flatMap((x) => secretValues(x.secrets))],
    log: (level, message) => ctx.log(level, message, key),
    setInput: (input) => store.updateStepInput(ctx.runId, key, ctx.redactor.apply(input)),
    enforceOutbound: async (p, headers, body) =>
      enforceOutbound(ctx, await buildUrl(b.platform, b.secrets, p), { headers, body, sender: step.connection, key }),
    signal: ctx.signal,
  });
  return { output: res.output, status: res.output.dryRun ? 'dryrun' : 'succeeded', summary: res.summary };
}

/** Strings inside a JSON answer (long enough to be recognised in a message). */
function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20 || out.length > 500) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out, depth + 1);
  return out;
}
