import { z } from 'zod';
import { DATA_LINEAGE_LIMITS as LL, OPENLINEAGE_SCHEMA_RE, type DataLineageNamespaceAlias, type DataLineageRunState } from '@sm/shared';
import { HttpError } from '../../util.js';
import { elementsOfDatasets, keyOfDataset, writeProposal, type Dataset, type ProposalWrite } from './store.js';

/**
 * OpenLineage run events (spec 2-0-x, https://openlineage.io/spec/2-0-2/OpenLineage.json) as Steward reads them: of an
 * event only the job's namespace and name, the event type and time, the run id and the namespace and name of each input
 * and output dataset – and of the facets nothing but the job type's `integration` (AIRFLOW, DBT, SPARK …, to name the
 * tool). Every other facet – schemas, column lineage, SQL, statistics, data quality metrics, error messages – is
 * neither validated nor stored (decision 13: no data values, no query text).
 *
 *   RunEvent      the run's state and time, the job's datasets → a proposal per job and the job's last run
 *   JobEvent      (static lineage, no run) the job's datasets → its proposal
 *   DatasetEvent  nothing to do (taken, not stored)
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const dataset = z.object({ namespace: text(LL.key), name: text(LL.key) });
const EVENT_TYPES = ['START', 'RUNNING', 'COMPLETE', 'ABORT', 'FAIL', 'OTHER'] as const;

const base = {
  eventTime: z.iso.datetime({ offset: true }),
  producer: text(2_000),
  schemaURL: z.string().trim().regex(OPENLINEAGE_SCHEMA_RE, 'an OpenLineage 2-0-x schemaURL'),
};
const job = z.object({
  namespace: text(LL.key),
  name: text(LL.key),
  facets: z.object({ jobType: z.object({ integration: z.string().max(100).optional() }).optional() }).optional(),
});
const ends = {
  inputs: z.array(dataset).max(LL.datasetsPerEvent).default([]),
  outputs: z.array(dataset).max(LL.datasetsPerEvent).default([]),
};

const runEvent = z.object({
  ...base,
  eventType: z.enum(EVENT_TYPES).optional(),
  run: z.object({ runId: z.string().trim().min(1).max(100) }),
  job,
  ...ends,
});
const jobEvent = z.object({ ...base, job, ...ends });
const datasetEvent = z.object({ ...base, dataset });

export type OlEvent = { type: 'run'; event: z.infer<typeof runEvent> } | { type: 'job'; event: z.infer<typeof jobEvent> } | { type: 'dataset' };

/** 400 DATA_LINEAGE_EVENT_INVALID with where (the path of the first problem) – the event itself is never echoed. */
const invalid = (where: string, problem: string, index?: number) =>
  new HttpError(
    400,
    `Not an OpenLineage 2-0-x event${index !== undefined ? ` (event ${index + 1})` : ''}: ${where ? `${where}: ` : ''}${problem}`,
    'DATA_LINEAGE_EVENT_INVALID',
    {
      where: (where || 'body').slice(0, 200),
      ...(index !== undefined ? { index: index + 1 } : {}),
    },
  );

/** One event of a push: a run event (has `run`), a job event (has `job`, no `run`) or a dataset event. */
export function parseOlEvent(raw: unknown, index?: number): OlEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('', 'an event is a JSON object', index);
  const o = raw as Record<string, unknown>;
  const schema = 'run' in o ? runEvent : 'job' in o ? jobEvent : 'dataset' in o ? datasetEvent : null;
  if (!schema) throw invalid('', 'neither a run, a job nor a dataset event', index);
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw invalid((issue?.path ?? []).map(String).join('.'), issue?.message ?? 'not valid', index);
  }
  if (schema === runEvent) return { type: 'run', event: r.data as z.infer<typeof runEvent> };
  if (schema === jobEvent) return { type: 'job', event: r.data as z.infer<typeof jobEvent> };
  return { type: 'dataset' };
}

/** The events of a push body: one event or an array of at most DATA_LINEAGE_LIMITS.eventsPerPush. */
export function parseOlPush(body: unknown): OlEvent[] {
  if (Array.isArray(body)) {
    if (!body.length) throw invalid('', 'the array holds no event');
    if (body.length > LL.eventsPerPush) throw invalid('', `at most ${LL.eventsPerPush} events in one push`);
    return body.map((e, i) => parseOlEvent(e, i));
  }
  return [parseOlEvent(body)];
}

const TOOLS: [RegExp, string][] = [
  [/airflow/i, 'Airflow'],
  [/dbt/i, 'dbt'],
  [/spark|databricks/i, 'Spark'],
  [/flink/i, 'Flink'],
  [/glue/i, 'AWS Glue'],
  [/data ?factory|adf/i, 'Azure Data Factory'],
  [/fivetran/i, 'Fivetran'],
];

/** The tool in words: the job type's integration, else what the producer URL says, else OpenLineage. */
export function toolOf(integration: string | undefined, producer: string): string {
  for (const [re, name] of TOOLS) if (integration && re.test(integration)) return name;
  for (const [re, name] of TOOLS) if (re.test(producer)) return name;
  const i = (integration ?? '').trim();
  return i ? i.slice(0, 40) : 'OpenLineage';
}

export interface OlApplied {
  events: number;
  proposals: { created: number; changed: number; skipped: number };
  /** What was not read as sent (namespaces beyond the limit of an event) – in the push's answer and its audit entry */
  warnings: string[];
}

/**
 * Applies parsed events of a source: one proposal per job (`namespace/name`), its datasets matched to elements, the
 * last run kept. A fixed number of statements per event whatever the number of its datasets. Call inside a transaction.
 */
export function applyOlEvents(sourceId: string, aliases: readonly DataLineageNamespaceAlias[], events: readonly OlEvent[]): OlApplied {
  const out: OlApplied = { events: 0, proposals: { created: 0, changed: 0, skipped: 0 }, warnings: [] };
  const info = { ignoredNamespaces: 0 };
  for (const e of events) {
    out.events++;
    if (e.type === 'dataset') continue;
    const ev = e.event;
    const all: Dataset[] = [...ev.inputs, ...ev.outputs];
    const matched = elementsOfDatasets(all, aliases, info);
    const side = (ds: readonly Dataset[]) => {
      const ids: string[] = [];
      const unmatched: string[] = [];
      for (const d of ds) {
        const hit = matched.get(keyOfDataset(d, aliases));
        if (hit?.length) ids.push(...hit);
        else unmatched.push(`${d.namespace}/${d.name}`);
      }
      return { ids, unmatched };
    };
    const ins = side(ev.inputs);
    const outs = side(ev.outputs);
    const state: DataLineageRunState | null = e.type === 'run' ? ((e.event.eventType ?? 'OTHER').toLowerCase() as DataLineageRunState) : null;
    const at = new Date(ev.eventTime).toISOString();
    const w: ProposalWrite | null = writeProposal({
      origin: 'openlineage',
      sourceId,
      key: `${ev.job.namespace}/${ev.job.name}`,
      name: ev.job.name,
      kind: 'transform',
      tool: toolOf(ev.job.facets?.jobType?.integration, ev.producer),
      inputs: ins.ids,
      outputs: outs.ids,
      unmatchedInputs: ins.unmatched,
      unmatchedOutputs: outs.unmatched,
      run: e.type === 'run' && state ? { id: e.event.run.runId, state, at } : null,
      union: e.type === 'run' && state !== 'complete',
    });
    if (!w) out.proposals.skipped++;
    else if (w.created) out.proposals.created++;
    else if (w.changed) out.proposals.changed++;
  }
  if (info.ignoredNamespaces)
    out.warnings.push(
      `${info.ignoredNamespaces} dataset namespace(s) beyond ${LL.namespacesPerEvent} per event were not matched – their datasets stay unmatched`,
    );
  return out;
}
