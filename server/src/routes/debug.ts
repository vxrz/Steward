import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEBUG_LIMITS,
  boundedRecord,
  debugAnswerRefusal,
  defaultDebugAnswers,
  type DebugNodeResult,
  type DebugRunState,
  type DebugSpec,
  type FlowNode,
  type RunComparison,
} from '@sm/shared';
import { HttpError, parseJson } from '../util.js';
import { currentActor } from '../auth/context.js';
import { me } from '../auth/access.js';
import { sameIdentity } from '../auth/aliases.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { engine, modeOfRow } from '../engine/index.js';
import { authorizeSignal, authorizeStart } from '../engine/commands.js';
import { compareRuns, lastGoodRun } from '../engine/compare.js';
import { reconstructVars } from '../engine/inspect.js';
import { findSecret } from '../credentials/secrets.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { requireRun } from './helpers.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const decisionSchema = z.object({
  approved: z.boolean(),
  selectedKeys: z.array(z.string().max(500)).max(10000).default([]),
  comment: z.string().max(5000).optional(),
});
const manualSchema = z
  .object({
    checked: z.array(z.number().int().min(0).max(1000)).max(1000).optional(),
    fields: boundedRecord(z.string().max(4000), 100).optional(),
    comment: z.string().max(4000).optional(),
  })
  .strict();
const answerSchema = z
  .object({ status: z.number().int().min(100).max(599), headers: boundedRecord(z.string().max(4000), 50).optional(), body: z.unknown().optional() })
  .strict();

const nodeBody = z
  .object({
    version: z.number().int().min(1).optional(),
    nodeId: z.string().min(1).max(200),
    node: z.unknown().optional(),
    vars: z.discriminatedUnion('from', [
      z.object({ from: z.literal('run'), runId: z.string().min(1).max(64) }),
      z.object({ from: z.literal('sample'), vars: boundedRecord(z.unknown(), 500), inputs: boundedRecord(z.unknown(), 200).optional() }),
      z.object({ from: z.literal('inputs'), inputs: boundedRecord(z.unknown(), 200) }),
    ]),
    answers: z.enum(['offline', 'recorded', 'live']).optional(),
    bindings: boundedRecord(z.string().max(200), 100).optional(),
    answer: answerSchema.optional(),
    decision: decisionSchema.optional(),
    manual: manualSchema.optional(),
  })
  .strict();

const runBody = z
  .object({
    version: z.number().int().min(1).optional(),
    inputs: boundedRecord(z.unknown(), 200).optional(),
    bindings: boundedRecord(z.string().max(200), 100).optional(),
    mode: z.enum(['dry', 'test']).default('test'),
    pauseBeforeEach: z.boolean().default(false),
    breakpoints: z.array(z.string().min(1).max(200)).max(DEBUG_LIMITS.breakpoints).default([]),
  })
  .strict();

const signalBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('debug.continue') }),
  z.object({ type: z.literal('debug.step') }),
  z.object({ type: z.literal('debug.skip') }),
  z.object({ type: z.literal('debug.stop') }),
  z.object({ type: z.literal('debug.breakpoints'), breakpoints: z.array(z.string().min(1).max(200)).max(DEBUG_LIMITS.breakpoints) }),
  z.object({ type: z.literal('debug.answer'), decision: decisionSchema.optional(), manual: manualSchema.optional() }),
]);

/** Keys whose values are credentials: free sample data never carries one (use a secret input or a platform instead). */
const SECRET_KEY =
  /^(password|passwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|private[_-]?key)$/i;

/** Where sample data looks like it carries a credential (a path such as "vars.login.password"), or null. */
function sampleSecret(v: unknown, path: string, depth = 0): string | null {
  if (depth > 40) return null;
  if (typeof v === 'string') return findSecret(v) ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = sampleSecret(v[i], `${path}[${i}]`, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && typeof x === 'string' && x && !/^\*+$/.test(x)) return `${path}.${k}`;
      const p = sampleSecret(x, `${path}.${k}`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

/** The names of variables whose (copied) values were masked in the source run. */
function maskedNames(vars: Record<string, unknown>): string[] {
  const masked = (v: unknown, d = 0): boolean =>
    d < 30 &&
    (typeof v === 'string'
      ? v.includes('***')
      : Array.isArray(v)
        ? v.some((x) => masked(x, d + 1))
        : !!v && typeof v === 'object' && Object.values(v).some((x) => masked(x, d + 1)));
  return Object.keys(vars).filter((k) => masked(vars[k]));
}

/** What a step wrote into the variables (set: its values; saveAs: its output). */
function written(node: FlowNode, output: unknown): Record<string, unknown> {
  if (node.type === 'set' && output && typeof output === 'object') return output as Record<string, unknown>;
  if (node.saveAs && output !== undefined) return { [node.saveAs]: output };
  return {};
}

const FINISHED = ['succeeded', 'failed', 'cancelled'];

async function waitFinished(runId: string, ms: number): Promise<store.RunRow> {
  const until = Date.now() + ms;
  for (;;) {
    const r = store.runRow(runId);
    if (FINISHED.includes(r.status) || Date.now() > until) return r;
    await new Promise((res) => setTimeout(res, 40));
  }
}

function debugState(runId: string): DebugRunState {
  const r = store.runRow(runId);
  const q = engine().query(runId);
  return {
    runId,
    status: r.status,
    mode: q.mode,
    debug: parseJson<DebugSpec | null>(r.debug ?? null, null) as DebugSpec,
    current: q.current,
    paused: q.paused ?? null,
    canSignal: !!r.debug && !FINISHED.includes(r.status) && sameIdentity(r.actor, me()),
    steps: store.listStepsPage(runId, { limit: 500 }),
    error: r.error,
  };
}

/** Debug runs and comparisons (ADR 0010), mounted under /api. */
export async function debugRoutes(app: FastifyInstance): Promise<void> {
  // ---------- compare two runs (a read: no audit entry) ----------
  app.get('/runs/compare', async (req): Promise<RunComparison> => {
    const q = z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) }).parse(req.query ?? {});
    const a = requireRun(q.a, 'view', 'view this run');
    const b = requireRun(q.b, 'view', 'view this run');
    if (a.process_id !== b.process_id) throw new HttpError(400, 'Only runs of the same process can be compared', 'COMPARE_OTHER_PROCESS');
    return compareRuns(a.id, b.id);
  });
  app.get('/runs/:id/last-good', async (req) => {
    const r = requireRun(params(req).id!, 'view', 'view this run');
    const id = lastGoodRun(r.id);
    return { run: id ? store.getRunSummary(id) : null };
  });

  // ---------- step through: the state the panel polls, and its signals ----------
  app.get('/runs/:id/debug', async (req): Promise<DebugRunState> => {
    const r = requireRun(params(req).id!, 'view', 'view this run');
    return debugState(r.id);
  });
  app.post('/runs/:id/debug', async (req): Promise<DebugRunState> => {
    const id = params(req).id!;
    const s = signalBody.parse(req.body);
    // the rights of now are checked again on every step (run, and use on the platforms of the paused node)
    authorizeSignal(id, s, requireRunPaused(id));
    await engine().signal(id, s, currentActor());
    return debugState(id);
  });

  app.post('/processes/:id/debug/runs', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req): Promise<DebugRunState> => {
    const processId = params(req).id!;
    const b = runBody.parse(req.body ?? {});
    authorizeStart(undefined, { processId, bindings: b.bindings, debug: { kind: 'step' } });
    const def = processes.getProcess(processId, b.version).definition;
    const ids = new Set(def.nodes.map((n) => n.id));
    const unknown = b.breakpoints.find((x) => !ids.has(x));
    if (unknown) throw new HttpError(400, `Node ${unknown.slice(0, 100)} not found`, 'DEBUG_NODE_NOT_FOUND');
    const { runId } = await engine().start({
      processId,
      version: b.version,
      inputs: b.inputs ?? {},
      bindings: b.bindings ?? {},
      mode: b.mode,
      actor: currentActor(),
      origin: { trigger: 'debug' },
      debug: { kind: 'step', pauseBeforeEach: b.pauseBeforeEach, breakpoints: b.breakpoints },
    });
    // the first pause (or the end) before the panel shows it
    await waitPausedOrDone(runId, 2000);
    return debugState(runId);
  });

  // ---------- run one node ----------
  app.post(
    '/processes/:id/debug/node',
    { bodyLimit: LARGE_BODIES.debugNode.bytes, config: { rateLimit: ROUTE_LIMITS.action } },
    async (req): Promise<DebugNodeResult> => {
      const processId = params(req).id!;
      const b = nodeBody.parse(req.body);
      const perms = processes.permissionsFor(processId);
      if (!perms.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
      const proc = processes.getProcess(processId, b.version);
      const draft = b.node as FlowNode | undefined;
      const node = draft ?? proc.definition.nodes.find((n) => n.id === b.nodeId);
      if (!node || (draft && draft.id !== b.nodeId)) throw new HttpError(404, `Node ${b.nodeId.slice(0, 100)} not found`, 'DEBUG_NODE_NOT_FOUND');
      if (typeof node !== 'object' || typeof node.type !== 'string') throw new HttpError(400, 'Invalid node', 'DEBUG_NODE_INVALID');
      const answers = b.answers ?? defaultDebugAnswers(node);
      const refusal = debugAnswerRefusal(node, answers, !!b.answer);
      if (refusal) {
        const text = {
          writes: 'This node writes: run it with recorded answers',
          interacts: 'This browser step interacts with the page: it cannot run as a live read',
          noPlatform: 'This node calls no platform: run it offline',
          needsAnswer: 'Offline, this node needs a pasted answer (or an AI sample answer)',
          needsRecording: 'This node needs its platform: run it with recorded answers',
        }[refusal];
        throw new HttpError(400, text, 'DEBUG_ANSWERS_REFUSED', { reason: refusal, answers });
      }
      const slots = [
        ...new Set([(node as { connection?: string }).connection, ...(node.type === 'subprocess' ? Object.values(node.connections ?? {}) : [])]),
      ].filter((x): x is string => typeof x === 'string' && !!x);
      // the command layer: edit; and unless offline, run and use on the node's platforms
      authorizeStart(undefined, { processId, bindings: b.bindings, debug: { kind: 'node', answers, slots } });

      // the variables just before this node
      let vars: Record<string, unknown>;
      let inputs: Record<string, unknown>;
      let masked: string[] = [];
      let varsRunId: string | undefined;
      if (b.vars.from === 'run') {
        const src = requireRun(b.vars.runId, 'view', 'view this run');
        if (src.process_id !== processId) throw new HttpError(400, 'The run belongs to another process', 'DEBUG_RUN_OTHER_PROCESS');
        const srcDef = processes.getProcess(src.process_id, src.process_version).definition;
        vars = reconstructVars(src.id, srcDef, b.nodeId).vars;
        inputs = parseJson<Record<string, unknown>>(src.inputs, {});
        masked = maskedNames(vars);
        varsRunId = src.id;
      } else {
        const sample = b.vars.from === 'sample' ? b.vars.vars : {};
        const given = b.vars.inputs ?? {};
        if (JSON.stringify({ sample, given }).length > DEBUG_LIMITS.sampleBytes)
          throw new HttpError(413, 'Sample data is limited to 1 MB', 'DEBUG_SAMPLE_TOO_LARGE');
        // secret inputs are sealed as in a run; everything else must not look like a credential
        const secretInputs = new Set((proc.definition.inputs ?? []).filter((i) => i.type === 'secret').map((i) => i.name));
        const at = sampleSecret(sample, 'vars') ?? sampleSecret(Object.fromEntries(Object.entries(given).filter(([k]) => !secretInputs.has(k))), 'inputs');
        if (at)
          throw new HttpError(
            400,
            `The sample data at ${at.slice(0, 200)} looks like a credential – use a secret input or a platform's credentials instead`,
            'DEBUG_SAMPLE_SECRET',
            { path: at.slice(0, 200) },
          );
        vars = sample;
        inputs = given;
      }
      const bindings = Object.fromEntries(Object.entries(b.bindings ?? {}).filter(([k]) => slots.includes(k)));
      const { runId } = await engine().start({
        processId,
        version: b.version,
        inputs,
        bindings,
        mode: answers === 'live' ? 'dry' : 'test',
        actor: currentActor(),
        origin: { trigger: 'debug' },
        debug: {
          kind: 'node',
          nodeId: b.nodeId,
          varsFrom: b.vars.from,
          ...(varsRunId ? { varsRunId } : {}),
          answers,
          ...(draft ? { draft: true } : {}),
          ...(answers === 'live' ? { live: true } : {}),
          ...(b.answer ? { pasted: true } : {}),
        },
        debugSeed: { vars, ...(draft ? { node: draft } : {}), answer: b.answer, decision: b.decision, manual: b.manual },
      });
      const r = await waitFinished(runId, 120_000);
      const step = store.listStepsPage(runId, { limit: 1 })[0] ?? null;
      const full = step ? store.getStepFull(runId, step.id) : null;
      return {
        runId,
        status: r.status,
        mode: modeOfRow(r),
        answers,
        step: full,
        written: full && full.status !== 'skipped' ? written(node, full.output) : {},
        masked,
        logs: store.listLogs(runId),
        error: r.error,
      };
    },
  );
}

/** The node a visible debug run is paused before, if any (visibility first: a hidden run answers "not found"). */
function requireRunPaused(runId: string): { nodeId: string } | null {
  requireRun(runId, 'view', 'view this run');
  const p = engine().query(runId).paused;
  return p ? { nodeId: p.nodeId } : null;
}

/** Waits until a step-through run pauses or ends (or `ms` pass). */
async function waitPausedOrDone(runId: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = store.runRow(runId);
    if (FINISHED.includes(r.status) || engine().query(runId).paused) return;
    await new Promise((res) => setTimeout(res, 30));
  }
}
