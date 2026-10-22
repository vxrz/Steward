import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EvaluateResult, ScopeHints } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { HttpError, nowIso } from '../util.js';
import { currentUser, runAs } from '../auth/context.js';
import { require } from '../auth/permissions.js';
import * as processes from '../processes/service.js';
import * as platforms from '../platforms/service.js';
import * as scheduler from '../scheduler.js';
import * as store from '../engine/store.js';
import { evalExpr, render } from '../engine/expr.js';
import { FUNCTIONS, expressionContext, inspectNode, limitSize, pickRun, sample } from '../engine/inspect.js';
import { contractCheck } from '../engine/contract.js';
import { initMetrics, metricsText } from '../metrics.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

function requireProcess(processId: string, perms: ('view' | 'run' | 'edit')[], what: string) {
  const have = processes.permissionsFor(processId);
  if (!have.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
  if (!perms.some((p) => have.includes(p))) throw new HttpError(403, `You are not allowed to ${what}`);
}

function requireRunView(runId: string) {
  const r = store.runRow(runId);
  if (!processes.permissionsFor(r.process_id).includes('view')) throw new HttpError(404, `Run ${runId} not found`);
  return r;
}

const EVAL_TIMEOUT_MS = 1000;
const MAX_RESULT_CHARS = 50000;

/** Metrics, readiness, expression evaluation, node inspection (mounted under /api). */
export async function engineExtrasRoutes(app: FastifyInstance): Promise<void> {
  initMetrics();

  // ---------- Prometheus metrics ----------
  app.get('/metrics', async (_req, reply) => {
    if (process.env.SM_METRICS_PUBLIC !== '1') {
      const u = currentUser();
      if (!u) throw new HttpError(401, 'Please sign in');
      if (!u.roles.includes('admin') && !u.roles.includes('auditor')) throw new HttpError(403, 'Metrics are available to administrators and auditors');
    }
    const m = await metricsText();
    return reply.type(m.contentType).send(m.body);
  });

  // ---------- readiness (public) ----------
  app.get('/ready', async (_req, reply) => {
    const checks: Record<'vault' | 'database' | 'scheduler', { ok: boolean; message?: string }> = {
      vault: { ok: false },
      database: { ok: false },
      scheduler: { ok: false },
    };
    const v = vault();
    checks.vault = v.unlocked ? { ok: true } : { ok: false, message: v.initialized ? 'Vault is locked' : 'Not set up yet' };
    try {
      db().get('SELECT 1');
      db().run('INSERT INTO engine_probe (id, ts) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts', nowIso());
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, message: (e as Error).message };
    }
    try {
      // schedules are armed once the vault is unlocked
      const all = runAs({ id: 'system', username: 'system', displayName: 'System', roles: ['admin'], teams: [] }, () => scheduler.listSchedules());
      const enabled = all.filter((s) => s.enabled);
      const armed = enabled.filter((s) => s.nextRunAt).length;
      checks.scheduler =
        enabled.length === 0 || armed > 0
          ? { ok: true, message: `${armed} of ${enabled.length} enabled schedule(s) armed` }
          : { ok: false, message: `None of ${enabled.length} enabled schedule(s) is armed` };
    } catch (e) {
      checks.scheduler = { ok: false, message: (e as Error).message };
    }
    const ready = Object.values(checks).every((c) => c.ok);
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  // ---------- editor support ----------
  app.get('/processes/:id/scope', async (req): Promise<ScopeHints> => {
    const id = params(req).id!;
    requireProcess(id, ['view'], 'view this process');
    const q = req.query as { runId?: string };
    const current = processes.getProcess(id).definition;
    let runId: string | null = null;
    let vars: ScopeHints['vars'] = [];
    let connections: ScopeHints['connections'] = current.connections.map((c) => ({ slot: c.slot, vars: [] }));
    const run = pickRun(id, q.runId);
    if (run) {
      const ctx = expressionContext(id, { runId: run.id });
      runId = run.id;
      vars = Object.entries(ctx.vars).map(([name, v]) => ({ name, sample: ctx.redactor.apply(sample(v)) }));
      connections = connections.map((c) => ({ slot: c.slot, vars: ctx.connections.find((x) => x.slot === c.slot)?.vars ?? [] }));
    }
    return {
      inputs: (current.inputs ?? []).map((i) => i.name),
      constants: Object.keys(current.constants ?? {}),
      connections,
      vars,
      functions: FUNCTIONS,
      runId,
    };
  });

  app.post('/processes/:id/evaluate', async (req): Promise<EvaluateResult> => {
    const id = params(req).id!;
    requireProcess(id, ['edit', 'run'], 'evaluate expressions of this process');
    const b = z
      .object({
        expression: z.string().max(20000),
        template: z.boolean().optional(),
        runId: z.string().optional(),
        nodeId: z.string().optional(),
        item: z.unknown().optional(),
      })
      .parse(req.body);
    let ctx: ReturnType<typeof expressionContext>;
    try {
      ctx = expressionContext(id, { runId: b.runId, nodeId: b.nodeId });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      if (err.statusCode && err.statusCode < 500) throw new HttpError(err.statusCode, err.message);
      throw e;
    }
    const opts = { timeoutMs: EVAL_TIMEOUT_MS, maxDepth: 500 };
    const perItem = b.item !== undefined;
    const root = perItem ? b.item : ctx.scope;
    const bindings = perItem ? { ...ctx.bindings, item: b.item } : ctx.bindings;
    try {
      const value = b.template ? await render(b.expression, root, bindings, opts) : await evalExpr(b.expression, root, bindings, opts);
      return { ok: true, value: limitSize(ctx.redactor.apply(value), MAX_RESULT_CHARS), runId: ctx.runId };
    } catch (e) {
      return { ok: false, error: ctx.redactor.apply((e as Error).message ?? String(e)), runId: ctx.runId };
    }
  });

  app.get('/runs/:id/inspect/:nodeId', async (req) => {
    const r = requireRunView(params(req).id!);
    return inspectNode(r.id, params(req).nodeId!);
  });

  // ---------- sandbox contract tests ----------
  app.post('/platforms/:id/contract-check', async (req) => {
    const id = params(req).id!;
    require(platforms.getPlatform(id).permissions, 'manage', 'run contract checks against this platform');
    return contractCheck(id);
  });
}
