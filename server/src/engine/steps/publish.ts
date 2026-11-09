import { normalizeStatus, type DatasetRow, type NodeOf } from '@sm/shared';
import { datasetOwner, publishDataset } from '../../dashboards/datasets.js';
import { stringify } from '../expr.js';
import * as store from '../store.js';
import type { LeafResult, StepContext, StepExecutor } from './context.js';

/** "Publish a dataset": rows, metrics and limits for dashboards; a debug run, or a dry run of another process, only previews. */
export const publishStep: StepExecutor<'publish'> = { type: 'publish', exec: execPublish };

async function execPublish(step: NodeOf<'publish'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const list = step.rows ? await ctx.list(step.rows) : [];
  const max = step.maxRows ?? 5000;
  if (list.length > max) throw new Error(`${list.length} rows exceed the limit of ${max} (maxRows)`);
  let columns: string[];
  const rows: DatasetRow[] = [];
  if (step.columns?.length) {
    columns = step.columns.map((c) => c.label);
  } else {
    const keys = new Set<string>();
    for (const it of list.slice(0, 50)) if (it && typeof it === 'object' && !Array.isArray(it)) Object.keys(it).forEach((k) => keys.add(k));
    columns = keys.size ? [...keys] : ['value'];
  }
  for (const item of list) {
    const row: DatasetRow = {};
    if (step.columns?.length) {
      for (const c of step.columns) row[c.label] = cell(await ctx.item(c.value, item));
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const c of columns) row[c] = cell((item as Record<string, unknown>)[c]);
    } else row.value = cell(item);
    if (step.key) row._key = stringify(await ctx.item(step.key, item));
    if (step.status) row._status = normalizeStatus(await ctx.item(step.status, item));
    if (step.statusText) row._statusText = stringify(await ctx.item(step.statusText, item));
    rows.push(row);
  }
  const metrics: Record<string, number> = {};
  for (const [name, expr] of Object.entries(step.metrics ?? {})) {
    const v = Number(await ctx.eval(expr));
    if (Number.isFinite(v)) metrics[name] = v;
    else ctx.log('warn', `Metric "${name}" is not a number – skipped`, key);
  }
  // limits of metrics (#145): upper limits, and floors (lower limits) – a limit that is not a number is left out
  const limits: Record<string, { value: number; lower: boolean }> = {};
  for (const [kind, map] of [
    ['limit', step.limits],
    ['floor', step.floors],
  ] as const)
    for (const [name, expr] of Object.entries(map ?? {})) {
      const v = Number(await ctx.eval(expr));
      if (Number.isFinite(v)) limits[name] = { value: v, lower: kind === 'floor' };
      else ctx.log('warn', `The ${kind} of metric "${name}" is not a number – skipped`, key);
    }
  const run = store.runRow(ctx.runId);
  // A dataset key is owned by the first process to publish it. A real run by another
  // process is rejected inside publishDataset (dashboard poisoning). A *dry run* by
  // another process must not fail or overwrite the owner's data – e.g. previewing a
  // second instance of a template that publishes the same key – so it returns a preview.
  const owner = datasetOwner(step.dataset);
  // a debug run never publishes (ADR 0010): the preview a dry run of another process gets
  if (ctx.debug || (ctx.dryRun && owner && owner !== run.process_id)) {
    const statusCounts: Record<string, number> = {};
    for (const r of rows) if (r._status) statusCounts[r._status] = (statusCounts[r._status] ?? 0) + 1;
    const counts = Object.entries(statusCounts)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    ctx.log(
      'info',
      ctx.debug ? `DEBUG RUN – "${step.dataset}" was not written` : `DRY RUN – "${step.dataset}" is owned by another process; it was not written`,
      key,
    );
    return {
      status: 'dryrun',
      output: { dataset: step.dataset, rows: rows.length, statusCounts, metrics, dryRun: true },
      summary: `DRY RUN – would publish ${step.dataset}: ${rows.length} row(s)${counts ? ` (${counts})` : ''}`,
    };
  }
  const meta = publishDataset({
    key: step.dataset,
    title: step.title || step.name || step.dataset,
    processId: run.process_id,
    processName: run.process_name,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
    columns,
    rows: ctx.redactor.apply(rows),
    metrics,
    limits,
    staleAfterMinutes: step.staleAfterMinutes,
    staleAfterFixed: step.staleAfterFixed,
    sourceSlot: step.source,
  });
  const counts = Object.entries(meta.statusCounts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return {
    output: { dataset: step.dataset, rows: rows.length, statusCounts: meta.statusCounts, metrics },
    summary: `${step.dataset}: ${rows.length} row(s)${counts ? ` (${counts})` : ''}${
      Object.keys(metrics).length
        ? ` · ${Object.entries(metrics)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : ''
    }`,
  };
}

/** Cell values are kept flat so snapshots stay small and render as text. */
function cell(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) return v.join(', ');
  return stringify(v).slice(0, 500);
}
