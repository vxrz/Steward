import { z } from 'zod';
import {
  DATA_LINEAGE_LIMITS as LL,
  DATA_QUALITY_LIMITS,
  dbtTestDimension,
  type DataLineageImport,
  type DataLineageRunState,
  type DataQualityResultInput,
  type DataQualityStatus,
} from '@sm/shared';
import { db } from '../../db.js';
import { HttpError, nowIso } from '../../util.js';
import { recordQualityResults } from '../quality.js';
import { chunks, marks } from '../store.js';
import { elementsByNamesStepwise, writeProposal, type ProposalRow } from './store.js';
import type { DbtHead, DbtReader } from './dbt-parse.js';

/**
 * dbt artefacts of a lineage source of kind `dbt` (ADR 0036 part 9, decision 31) – read for what they say about
 * lineage and outcomes, never for data:
 *
 *   manifest.json     models, seeds and snapshots (with their relation: database, schema, alias) and sources (database,
 *                     schema, identifier) are matched to elements of the source's platform by qualified name; each
 *                     model and snapshot with a relation is a **proposed step** from the relations of its `depends_on`
 *                     nodes (ephemeral models are passed through) to its own; tests are remembered with the element they
 *                     check (`attached_node`, else the one model or source they depend on). Compiled SQL, raw code,
 *                     descriptions, columns and docs are not read.
 *   run_results.json  a model's or snapshot's result is its step's **last run** (success → complete, error → fail,
 *                     skipped → other); a test's result is a **quality result** of its element (source `dbt`, through
 *                     recordQualityResults in ../quality.ts: pass → passed, warn → warning, fail → failed, error →
 *                     error; skipped tests are not recorded), with the failing row count as its value and the run's
 *                     `invocation_id` as its run – never the message, which may quote values.
 *
 * A manifest is written in batches of DATA_LINEAGE_LIMITS.batch proposals per transaction with a turn of the event loop
 * between them; elements are matched in bulk (one statement per 500 names).
 */

const MANIFEST_RE = /^https:\/\/schemas\.getdbt\.com\/dbt\/manifest\/v\d{1,3}\.json$/;
const RUN_RESULTS_RE = /^https:\/\/schemas\.getdbt\.com\/dbt\/run-results\/v\d{1,3}\.json$/;

const s = (max: number = LL.key) => z.string().max(max);
const node = z.object({
  resource_type: s(40),
  name: s(),
  unique_id: s(),
  database: s().nullable().optional(),
  schema: s().nullable().optional(),
  alias: s().nullable().optional(),
  identifier: s().nullable().optional(),
  config: z.object({ materialized: s(60).optional(), enabled: z.boolean().optional() }).optional(),
  depends_on: z.object({ nodes: z.array(s()).max(5_000).default([]) }).optional(),
  attached_node: s().nullable().optional(),
  column_name: s().nullable().optional(),
  test_metadata: z
    .object({ name: s(200).optional() })
    .nullable()
    .optional(),
});
type Node = z.infer<typeof node>;

const manifestHead = z.object({
  metadata: z.object({ dbt_schema_version: z.string().regex(MANIFEST_RE, 'a dbt manifest schema'), adapter_type: s(60).optional() }),
});

const runResultsHead = z.object({
  metadata: z.object({
    dbt_schema_version: z.string().regex(RUN_RESULTS_RE, 'a dbt run results schema'),
    generated_at: z.string().max(60).optional(),
    invocation_id: z.string().max(200).nullable().optional(),
  }),
});

const result = z.object({
  unique_id: s(),
  status: s(40),
  failures: z.number().nullable().optional(),
  timing: z
    .array(z.object({ name: s(40), completed_at: s(60).nullable().optional() }))
    .max(10)
    .optional(),
});
type Result = z.infer<typeof result>;

const invalid = (file: 'manifest' | 'runResults', where: string, problem: string) =>
  new HttpError(
    400,
    `Not a dbt ${file === 'manifest' ? 'manifest.json' : 'run_results.json'}: ${where ? `${where}: ` : ''}${problem}`,
    'DATA_LINEAGE_DBT_INVALID',
    {
      context: file,
      where: (where || 'body').slice(0, 200),
    },
  );

function parse<T>(file: 'manifest' | 'runResults', schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw invalid(file, (i?.path ?? []).map(String).join('.'), i?.message ?? 'not valid');
  }
  return r.data;
}

/** A turn of the event loop between two batches. */
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Writes `items` in transactions of at most BATCH_MS each (and at most the part given), with a turn of the event loop
 * after each (0.25.0): a batch of 250 proposals took 100–190 ms on SQLite – a turn of the event loop that long holds up
 * every request. `end` runs at the end of each transaction, inside it.
 */
const BATCH_MS = 15;
async function timedBatches<T>(items: readonly T[], each: (x: T) => void, end?: () => void): Promise<void> {
  let i = 0;
  while (i < items.length) {
    const t0 = performance.now();
    db().tx(() => {
      while (i < items.length) {
        each(items[i++]!);
        if (performance.now() - t0 > BATCH_MS) break;
      }
      end?.();
    });
    await yieldToLoop();
  }
}

/**
 * The head of a file (0.25.0: parsed in a worker, dbt-parse.ts): a dbt document is an object with the metadata of its
 * kind and its lists – at most DATA_LINEAGE_LIMITS.dbtNodes items – as the schema of 0.24.0 said.
 */
function checkHead(file: 'manifest' | 'runResults', head: DbtHead): void {
  if (head.doc !== 'object') throw invalid(file, '', `Invalid input: expected object, received ${head.doc === 'array' ? 'array' : 'a value'}`);
  parse(file, file === 'manifest' ? manifestHead : runResultsHead, { metadata: head.metadata });
  const lists = file === 'manifest' ? (['nodes', 'sources'] as const) : (['results'] as const);
  let total = 0;
  for (const name of lists) {
    const l = head.lists[name] ?? { kind: 'missing', count: 0 };
    const want = name === 'results' ? 'array' : 'object';
    // sources may be left out (an empty project)
    if (l.kind === 'missing' && name === 'sources') continue;
    if (l.kind !== want) throw invalid(file, name, `Invalid input: expected ${want === 'array' ? 'array' : 'record'}`);
    if (l.count > LL.dbtNodes) throw invalid(file, name, `Too big: expected ${want} to have <=${LL.dbtNodes} ${want === 'array' ? 'items' : 'entries'}`);
    total += l.count;
  }
  if (total > LL.dbtNodes) throw invalid(file, 'nodes', `more than ${LL.dbtNodes.toLocaleString('en-GB')} nodes and sources`);
}

/** The items of a file, part by part; a turn of the event loop between two parts (the worker's message is one). */
async function* itemsOf(reader: DbtReader): AsyncGenerator<unknown[]> {
  for (let part = await reader.next(); part; part = await reader.next()) {
    yield part;
    if (!reader.inWorker) await yieldToLoop();
  }
}

/** The names an element of the platform may have for a relation: DB.SCHEMA.NAME, and SCHEMA.NAME (database platforms). */
const namesOf = (n: Node): string[] => {
  const rel = n.resource_type === 'source' ? (n.identifier ?? n.name) : (n.alias ?? n.name);
  if (!n.schema || !rel) return [];
  return [...(n.database ? [`${n.database}.${n.schema}.${rel}`] : []), `${n.schema}.${rel}`].map((x) => x.toLowerCase());
};

const RELATIONS = new Set(['model', 'seed', 'snapshot', 'source']);
const STEPS = new Set(['model', 'snapshot']);

export interface ManifestResult {
  counts: { nodes: number; steps: number; created: number; changed: number; unmatched: number; tests: number; skipped: number };
}

/**
 * Reads a manifest for a dbt source: proposals per model and snapshot, the tests' elements. The file comes parsed from
 * the worker (dbt-parse.ts), part by part: each node is validated here, everything is written in batches with a turn of
 * the event loop between (elements matched DATA_LINEAGE_LIMITS.batch × 2 names at a time).
 */
export async function importManifest(sourceId: string, platformId: string, reader: DbtReader): Promise<ManifestResult> {
  checkHead('manifest', reader.head);
  const nodes = new Map<string, Node>();
  for await (const part of itemsOf(reader))
    for (const [, key, v] of part as [string, string, unknown][]) {
      const r = node.safeParse(v);
      if (!r.success) {
        const i = r.error.issues[0];
        throw invalid('manifest', [String(key).slice(0, 100), ...(i?.path ?? []).map(String)].join('.'), i?.message ?? 'not valid');
      }
      if (r.data.config?.enabled === false) continue;
      nodes.set(r.data.unique_id, r.data);
    }
  // relations → elements of the platform (bulk, a turn of the event loop every few chunks)
  const relations = [...nodes.values()].filter((n) => RELATIONS.has(n.resource_type) && n.config?.materialized !== 'ephemeral');
  await yieldToLoop();
  const found = await elementsByNamesStepwise(platformId, relations.flatMap(namesOf), 2);
  await yieldToLoop();
  const elementOf = new Map<string, string | null>();
  for (const n of relations) {
    const hit = namesOf(n)
      .map((x) => found.get(x)?.[0])
      .find(Boolean);
    elementOf.set(n.unique_id, hit ?? null);
  }
  await yieldToLoop();
  /** The relations a node reads: its depends_on, through ephemeral models (each node once). */
  const inputsOf = (n: Node): string[] => {
    const out = new Set<string>();
    const seen = new Set<string>([n.unique_id]);
    const walk = (ids: readonly string[], depth: number) => {
      for (const id of ids) {
        if (seen.has(id) || depth > 20) continue;
        seen.add(id);
        const d = nodes.get(id);
        if (!d) continue;
        if (d.resource_type === 'model' && d.config?.materialized === 'ephemeral') walk(d.depends_on?.nodes ?? [], depth + 1);
        else if (RELATIONS.has(d.resource_type)) out.add(id);
      }
    };
    walk(n.depends_on?.nodes ?? [], 0);
    return [...out];
  };
  const counts = { nodes: nodes.size, steps: 0, created: 0, changed: 0, unmatched: 0, tests: 0, skipped: 0 };
  for (const n of relations) if (!elementOf.get(n.unique_id)) counts.unmatched++;
  const label = (id: string) => {
    const d = nodes.get(id);
    return d ? namesOf(d)[0]?.toUpperCase() || id : id;
  };
  const steps = relations.filter((n) => STEPS.has(n.resource_type));
  const now = nowIso();
  await yieldToLoop();
  await timedBatches(steps, (n) => {
    const own = elementOf.get(n.unique_id);
    const ins = inputsOf(n);
    const w = writeProposal(
      {
        origin: 'dbt',
        sourceId,
        key: n.unique_id,
        name: n.name,
        kind: n.resource_type === 'snapshot' ? 'stage' : 'transform',
        tool: 'dbt',
        inputs: ins.map((i) => elementOf.get(i)).filter((x): x is string => !!x),
        outputs: own ? [own] : [],
        unmatchedInputs: ins.filter((i) => !elementOf.get(i)).map(label),
        unmatchedOutputs: own ? [] : [label(n.unique_id)],
        run: null,
      },
      now,
    );
    counts.steps++;
    if (!w) counts.skipped++;
    else if (w.created) counts.created++;
    else if (w.changed) counts.changed++;
  });
  // tests → the element they check (replaced with each manifest)
  const tests: [string, string, string, string, string, string][] = [];
  for (const n of nodes.values()) {
    if (n.resource_type !== 'test') continue;
    const targets = n.attached_node ? [n.attached_node] : (n.depends_on?.nodes ?? []).filter((d) => RELATIONS.has(nodes.get(d)?.resource_type ?? ''));
    const el = targets.length === 1 ? elementOf.get(targets[0]!) : null;
    if (!el) continue;
    tests.push([
      sourceId,
      n.unique_id.slice(0, LL.key),
      el,
      n.name.slice(0, 200),
      (n.test_metadata?.name ?? '').slice(0, 200),
      (n.column_name ?? '').slice(0, 200),
    ]);
  }
  // replaced with each manifest: the old ones go with the first batch, the rest follow batch by batch (imports of one
  // source run one after the other – push.ts – so run results never read a half-written list)
  const insert = (part: (typeof tests)[number][]) =>
    db().run(
      `INSERT INTO dp_lineage_tests (source_id, test_key, element_id, name, test_name, column_name) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...part.flat(),
    );
  const batches = chunks(tests, 1_500);
  db().tx(() => {
    db().run('DELETE FROM dp_lineage_tests WHERE source_id = ?', sourceId);
    for (const part of chunks(batches[0] ?? [], 150)) insert(part);
  });
  for (const batch of batches.slice(1)) {
    await yieldToLoop();
    db().tx(() => {
      for (const part of chunks(batch, 150)) insert(part);
    });
  }
  counts.tests = tests.length;
  return { counts };
}

const RUN_STATE: Record<string, DataLineageRunState> = { success: 'complete', error: 'fail', skipped: 'other' };
/** dbt test statuses as quality result statuses (package B's dp_quality_results); skipped tests are not recorded. */
const TEST_STATUS: Record<string, DataQualityStatus | null> = {
  pass: 'passed',
  success: 'passed',
  warn: 'warning',
  fail: 'failed',
  error: 'error',
  'runtime error': 'error',
  skipped: null,
};

export interface RunResultsResult {
  counts: { results: number; runs: number; tests: number; unknown: number };
}

/** Reads run_results.json for a dbt source: the last run of each model's proposal (and step), test outcomes. */
export async function importRunResults(sourceId: string, reader: DbtReader): Promise<RunResultsResult> {
  checkHead('runResults', reader.head);
  const meta = parse('runResults', runResultsHead, { metadata: reader.head.metadata }).metadata;
  const results: Result[] = [];
  for await (const part of itemsOf(reader))
    for (const v of part) {
      const x = result.safeParse(v);
      if (!x.success) {
        const i = x.error.issues[0];
        throw invalid('runResults', ['results', String(results.length), ...(i?.path ?? []).map(String)].join('.'), i?.message ?? 'not valid');
      }
      results.push(x.data);
    }
  const r = { metadata: meta, results };
  const generated = r.metadata.generated_at && !Number.isNaN(Date.parse(r.metadata.generated_at)) ? new Date(r.metadata.generated_at).toISOString() : nowIso();
  const counts = { results: r.results.length, runs: 0, tests: 0, unknown: 0 };
  const runRef = r.metadata.invocation_id?.trim() || null;
  const ids = r.results.map((x) => x.unique_id);
  // the proposals and tests of these nodes (bulk; a turn of the event loop every few chunks)
  const proposals = new Map<string, ProposalRow>();
  const tests = new Map<string, { element_id: string; name: string; test_name: string }[]>();
  let read = 0;
  for (const part of chunks([...new Set(ids)])) {
    if (++read % 4 === 0) await yieldToLoop();
    for (const p of db().all<ProposalRow>(
      `SELECT * FROM dp_lineage_proposals WHERE source_id = ? AND origin = 'dbt' AND job_key IN (${marks(part.length)})`,
      sourceId,
      ...part,
    ))
      proposals.set(p.job_key, p);
    for (const t of db().all<{ test_key: string; element_id: string; name: string; test_name: string }>(
      `SELECT test_key, element_id, name, test_name FROM dp_lineage_tests WHERE source_id = ? AND test_key IN (${marks(part.length)})`,
      sourceId,
      ...part,
    ))
      tests.set(t.test_key, [...(tests.get(t.test_key) ?? []), t]);
  }
  // quality results go to their writer once per transaction (it joins it: unknown elements are skipped by the writer)
  let quality: DataQualityResultInput[] = [];
  await timedBatches(
    r.results,
    (x) => {
      const status = x.status.toLowerCase();
      const at = x.timing?.find((t) => t.name === 'execute')?.completed_at;
      const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : generated;
      const p = proposals.get(x.unique_id);
      if (p) {
        writeProposal({
          origin: 'dbt',
          sourceId,
          key: p.job_key,
          name: p.name,
          kind: p.step_kind,
          tool: p.tool,
          inputs: [],
          outputs: [],
          unmatchedInputs: [],
          unmatchedOutputs: [],
          run: { id: null, state: RUN_STATE[status] ?? 'other', at: when },
          runOnly: true,
        });
        counts.runs++;
        return;
      }
      const t = tests.get(x.unique_id);
      if (t) {
        const q = Object.hasOwn(TEST_STATUS, status) ? TEST_STATUS[status] : 'error';
        if (q)
          for (const e of t)
            quality.push({
              elementId: e.element_id,
              source: 'dbt',
              name: (e.name.trim() || x.unique_id).slice(0, DATA_QUALITY_LIMITS.name),
              status: q,
              dimension: dbtTestDimension(e.test_name),
              value: typeof x.failures === 'number' && Number.isFinite(x.failures) ? x.failures : null,
              runRef,
              observedAt: when,
            });
        counts.tests++;
        return;
      }
      counts.unknown++;
    },
    () => {
      recordQualityResults(quality);
      quality = [];
    },
  );
  return { counts };
}

export type DbtImportSummary = Omit<DataLineageImport, 'at' | 'by' | 'sha256'>;
