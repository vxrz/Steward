import type { NodeOf } from '@sm/shared';
import { secretValues } from '../../platforms/http.js';
import * as store from '../store.js';
import { connectionSources, type LeafResult, type StepContext, type StepExecutor } from './context.js';
import { scanSecrets, secretBindings } from './outbound.js';

export const queryStep: StepExecutor<'query'> = {
  type: 'query',
  exec: execQuery,
  preview: async (node, ctx) => ({ sql: node.sql, params: node.params?.length ? await ctx.render(node.params) : [] }), // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  sources: (step, ctx) => connectionSources(step.connection, ctx),
};

/**
 * Query a database (0.7.0, dbms/step.ts): one read-only statement on the bound database platform, its parameters
 * rendered from their templates and bound (never put into the text). The password is masked like an HTTP platform's
 * secrets; the rows are the step's output.
 */
async function execQuery(step: NodeOf<'query'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  ctx.redactor.add(...secretValues(b.secrets));
  // Semgrep's res-render-injection takes (step, ctx, key) for Express's (req, res, next): ctx.render() evaluates the
  // step's templates in the run scope, it never loads a file or template by name (false positive).
  const params = (step.params?.length ? await ctx.render(step.params) : []) as unknown[]; // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  // the secrets of the run's other platforms never go to the database (as for an http step to a foreign origin)
  const host = String(b.platform.config.database?.host ?? 'database.invalid').replace(/^\[|\]$/g, '');
  await scanSecrets(
    ctx,
    key,
    `https://${host.includes(':') ? `[${host}]` : host}/`,
    {},
    { sql: step.sql, params },
    secretBindings(ctx, step.connection).filter((x) => x.foreign),
  );
  const { runQueryStep } = await import('../../dbms/step.js');
  const res = await runQueryStep(step, {
    platform: b.platform,
    secrets: b.secrets,
    params,
    dryRun: ctx.dryRun,
    recorded: ctx.recorded,
    setInput: (input) => store.updateStepInput(ctx.runId, key, ctx.redactor.apply(input)),
    log: (level, message) => ctx.log(level, message, key),
    signal: ctx.signal,
  });
  return { output: res.output, summary: res.summary };
}
