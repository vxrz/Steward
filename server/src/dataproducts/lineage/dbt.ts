import { z } from 'zod';
import {
  DATA_LINEAGE_LIMITS as LL,
  boundedRecord,
  dbtTestDimension,
  type DataLineageImport,
  type DataLineageRunState,
  type DataQualityResultStatus,
} from '@sm/shared';
import { db } from '../../db.js';
import { HttpError, nowIso } from '../../util.js';
import { recordQualityResult } from '../quality-results.js';
import { chunks, marks } from '../store.js';
import { elementsByNames, writeProposal, type ProposalRow } from './store.js';

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
 *                     skipped → other); a test's result is a **quality result** of its element (pass, warn, fail,
 *                     error, skipped, with the failing row count – never the message, which may quote values).
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

const manifest = z.object({
  metadata: z.object({ dbt_schema_version: z.string().regex(MANIFEST_RE, 'a dbt manifest schema'), adapter_type: s(60).optional() }),
  nodes: boundedRecord(z.unknown(), LL.dbtNodes),
  sources: boundedRecord(z.unknown(), LL.dbtNodes).default({}),
});

const runResults = z.object({
  metadata: z.object({ dbt_schema_version: z.string().regex(RUN_RESULTS_RE, 'a dbt run results schema'), generated_at: z.string().max(60).optional() }),
  results: z
    .array(
      z.object({
        unique_id: s(),
        status: s(40),
        failures: z.number().nullable().optional(),
        timing: z
          .array(z.object({ name: s(40), completed_at: s(60).nullable().optional() }))
          .max(10)
          .optional(),
      }),
    )
    .max(LL.dbtNodes),
});

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

/** Reads a manifest for a dbt source: proposals per model and snapshot, the tests' elements. */
export async function importManifest(sourceId: string, platformId: string, raw: unknown): Promise<ManifestResult> {
  const m = parse('manifest', manifest, raw);
  const entries = [...Object.entries(m.nodes), ...Object.entries(m.sources)];
  if (entries.length > LL.dbtNodes) throw invalid('manifest', 'nodes', `more than ${LL.dbtNodes.toLocaleString('en-GB')} nodes and sources`);
  const nodes = new Map<string, Node>();
  for (const [key, v] of entries) {
    const r = node.safeParse(v);
    if (!r.success) {
      const i = r.error.issues[0];
      throw invalid('manifest', [key.slice(0, 100), ...(i?.path ?? []).map(String)].join('.'), i?.message ?? 'not valid');
    }
    if (r.data.config?.enabled === false) continue;
    nodes.set(r.data.unique_id, r.data);
  }
  // relations → elements of the platform (bulk)
  const relations = [...nodes.values()].filter((n) => RELATIONS.has(n.resource_type) && n.config?.materialized !== 'ephemeral');
  const found = elementsByNames(platformId, relations.flatMap(namesOf));
  const elementOf = new Map<string, string | null>();
  for (const n of relations) {
    const hit = namesOf(n)
      .map((x) => found.get(x)?.[0])
      .find(Boolean);
    elementOf.set(n.unique_id, hit ?? null);
  }
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
  for (const part of chunks(steps, LL.batch)) {
    db().tx(() => {
      for (const n of part) {
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
      }
    });
    await yieldToLoop();
  }
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
  db().tx(() => {
    db().run('DELETE FROM dp_lineage_tests WHERE source_id = ?', sourceId);
    for (const part of chunks(tests, 150))
      db().run(
        `INSERT INTO dp_lineage_tests (source_id, test_key, element_id, name, test_name, column_name) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        ...part.flat(),
      );
  });
  counts.tests = tests.length;
  return { counts };
}

const RUN_STATE: Record<string, DataLineageRunState> = { success: 'complete', error: 'fail', skipped: 'other' };
const TEST_STATUS: Record<string, DataQualityResultStatus> = {
  pass: 'pass',
  success: 'pass',
  warn: 'warn',
  fail: 'fail',
  error: 'error',
  'runtime error': 'error',
  skipped: 'skipped',
};

export interface RunResultsResult {
  counts: { results: number; runs: number; tests: number; unknown: number };
}

/** Reads run_results.json for a dbt source: the last run of each model's proposal (and step), test outcomes. */
export async function importRunResults(sourceId: string, raw: unknown): Promise<RunResultsResult> {
  const r = parse('runResults', runResults, raw);
  const generated = r.metadata.generated_at && !Number.isNaN(Date.parse(r.metadata.generated_at)) ? new Date(r.metadata.generated_at).toISOString() : nowIso();
  const counts = { results: r.results.length, runs: 0, tests: 0, unknown: 0 };
  const ids = r.results.map((x) => x.unique_id);
  // the proposals and tests of these nodes (bulk)
  const proposals = new Map<string, ProposalRow>();
  const tests = new Map<string, { element_id: string; name: string; test_name: string }[]>();
  for (const part of chunks([...new Set(ids)])) {
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
  for (const part of chunks(r.results, LL.batch)) {
    db().tx(() => {
      for (const x of part) {
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
          continue;
        }
        const t = tests.get(x.unique_id);
        if (t) {
          for (const e of t)
            recordQualityResult({
              elementId: e.element_id,
              origin: 'dbt',
              key: x.unique_id,
              name: e.name,
              status: TEST_STATUS[status] ?? 'error',
              dimension: dbtTestDimension(e.test_name),
              failures: typeof x.failures === 'number' ? x.failures : null,
              observedAt: when,
              sourceId,
            });
          counts.tests++;
          continue;
        }
        counts.unknown++;
      }
    });
    await yieldToLoop();
  }
  return { counts };
}

export type DbtImportSummary = Omit<DataLineageImport, 'at' | 'by' | 'sha256'>;
