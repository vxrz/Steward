import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUNDLE_FORMATS, type DatasetMeta, type ExportBundle } from '@sm/shared';
import { HttpError, nowIso, sha256, MAX_DEFINITION_TEXT } from '../util.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import * as processes from '../processes/service.js';
import * as datasets from '../dashboards/datasets.js';
import * as dashboards from '../dashboards/service.js';
import { startRun } from '../engine/runner.js';
import { getPlatform } from '../platforms/service.js';
import { parseJson } from '../util.js';
import { monitorDatasetVisible } from '../monitors/datasets.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { IMPORT_BODY_SHAPE } from '../bodyShape.js';
import { LARGE_BODIES } from '../bodyLimits.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** A dataset is visible to whoever may view the process (or monitor) that publishes it. */
const canSee = (d: Pick<DatasetMeta, 'processId'>) => monitorDatasetVisible(d.processId) ?? processes.permissionsFor(d.processId).includes('view');

/** ?source=a,b – only these sources (the dashboard's or a widget's source filter, #142) */
const viewOf = (req: FastifyRequest): datasets.View => {
  const raw = (req.query as { source?: string } | undefined)?.source;
  const sources = raw
    ? raw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];
  return sources.length ? { sources } : {};
};

function visibleDataset(key: string): DatasetMeta {
  const meta = datasets.getDatasetMeta(key);
  if (!canSee(meta)) throw new HttpError(404, `Dataset "${key}" not found`);
  return meta;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // ---------- datasets ----------
  app.get('/datasets', async () => datasets.listDatasets().filter(canSee));
  app.get('/datasets/:key/sources', async (req) => visibleDataset(params(req).key!).sources);

  app.get('/datasets/:key', async (req, reply) => {
    const meta = visibleDataset(params(req).key!);
    const view = viewOf(req);
    // the visible partitions and the filter are part of the version: another reader or filter gets other rows
    const parts = meta.sources.map((x) => `${x.id}@${x.updatedAt}:${x.stale}`).join(',');
    const etag = `"${sha256(`${meta.key}|${parts}|${(view.sources ?? []).join(',')}`).slice(0, 16)}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return datasets.getDataset(meta.key, view);
  });

  app.get('/datasets/:key/metrics', async (req) => {
    const meta = visibleDataset(params(req).key!);
    const q = z
      .object({
        names: z.string().max(2000).optional(),
        days: z.coerce.number().int().min(1).max(400).default(30),
        points: z.coerce.number().int().min(1).max(2000).default(200),
        source: z.string().max(4000).optional(),
        trend: z.string().max(5).optional(),
      })
      .parse(req.query ?? {});
    const view = viewOf(req);
    const series = datasets.metricSeries(meta.key, q.names ? q.names.split(',') : undefined, q.days, q.points, view);
    return datasets.withTrends(series, meta.key, q.trend, view);
  });

  app.delete('/datasets/:key', async (req) => {
    if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators can delete datasets');
    datasets.deleteDataset(params(req).key!);
    audit({ action: 'dataset.deleted', entityType: 'dataset', entityId: params(req).key, summary: `Dataset "${params(req).key}" deleted` });
    return { ok: true };
  });

  // ---------- dashboards ----------
  app.get('/dashboards', async () => dashboards.listDashboards());
  app.get('/dashboard-templates', async () => dashboards.listDashboardTemplates());
  app.get('/dashboards/:id', async (req) => dashboards.getDashboard(params(req).id!));
  app.post('/dashboards', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z
      .object({ definition: z.any().optional(), text: z.string().max(MAX_DEFINITION_TEXT).optional(), templateId: z.string().optional() })
      .parse(req.body);
    if (b.templateId) {
      const t = dashboards.listDashboardTemplates().find((x) => x.id === b.templateId);
      if (!t) throw new HttpError(404, 'Dashboard template not found');
      return dashboards.createDashboard(t.definition, { id: t.id.replace(/^\d+-/, '') });
    }
    return dashboards.createDashboard(b.text ? dashboards.parseDashboardText(b.text) : b.definition);
  });
  app.put('/dashboards/:id', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().max(MAX_DEFINITION_TEXT).optional() }).parse(req.body);
    return dashboards.saveDashboard(params(req).id!, b.text ? dashboards.parseDashboardText(b.text) : b.definition);
  });
  app.delete('/dashboards/:id', async (req) => {
    dashboards.deleteDashboard(params(req).id!);
    return { ok: true };
  });
  app.get('/dashboards/:id/export', async (req, reply) => {
    const d = dashboards.getDashboard(params(req).id!);
    reply.header('content-disposition', `attachment; filename="dashboard-${d.id}.yaml"`);
    return reply.type('text/yaml').send(dashboards.dashboardYaml(d));
  });

  /**
   * Refresh: re-run the processes that publish this dashboard's datasets, with
   * the inputs and connections of their latest run (requires run rights).
   */
  app.post('/dashboards/:id/refresh', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const d = dashboards.getDashboard(params(req).id!);
    const started: { processId: string; runId: string }[] = [];
    const skipped: { processId: string; reason: string }[] = [];
    const procIds = new Set<string>();
    for (const key of dashboards.datasetsOf(d.definition)) {
      try {
        procIds.add(datasets.getDatasetMeta(key).processId);
      } catch {
        /* no data yet */
      }
    }
    for (const w of d.definition.widgets) if (w.type === 'checks' && w.process) procIds.add(w.process);
    for (const pid of procIds) {
      const perms = processes.permissionsFor(pid);
      if (!perms.includes('run')) {
        skipped.push({ processId: pid, reason: 'no run permission' });
        continue;
      }
      const active = db().get<{ id: string }>("SELECT id FROM runs WHERE process_id = ? AND status IN ('running', 'waiting') LIMIT 1", pid);
      if (active) {
        skipped.push({ processId: pid, reason: `run ${active.id} is still active` });
        continue;
      }
      const last = db().get<{ inputs: string; bindings: string; dry_run: number }>(
        'SELECT inputs, bindings, dry_run FROM runs WHERE process_id = ? ORDER BY started_at DESC LIMIT 1',
        pid,
      );
      if (!last) {
        skipped.push({ processId: pid, reason: 'never ran – start it once from the process page' });
        continue;
      }
      const bindings = Object.fromEntries(
        Object.entries(parseJson<Record<string, { platformId: string }>>(last.bindings, {})).map(([k, v]) => [k, v.platformId]),
      );
      const forbidden = Object.values(bindings).find((p) => !getPlatform(p).permissions.includes('use'));
      if (forbidden) {
        skipped.push({ processId: pid, reason: `no permission to use platform ${forbidden}` });
        continue;
      }
      try {
        const runId = await startRun({ processId: pid, inputs: parseJson(last.inputs, {}), bindings, dryRun: !!last.dry_run });
        started.push({ processId: pid, runId });
      } catch (e) {
        skipped.push({ processId: pid, reason: (e as Error).message });
      }
    }
    return { started, skipped };
  });

  // ---------- bundles (export / import several processes and dashboards at once) ----------
  app.get('/bundle/export', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
    const q = z.object({ processes: z.string().max(20000).optional(), dashboards: z.string().max(20000).optional() }).parse(req.query ?? {});
    const wantP = q.processes ? new Set(q.processes.split(',')) : null;
    const wantD = q.dashboards ? new Set(q.dashboards.split(',')) : null;
    const bundle: ExportBundle = {
      format: 'steward-bundle',
      version: 1,
      exportedAt: nowIso(),
      processes: processes
        .listProcesses()
        .filter((p) => !wantP || wantP.has(p.id))
        .map((p) => ({ id: p.id, definition: processes.getProcess(p.id).definition })),
      dashboards: dashboards
        .listDashboards()
        .filter((d) => !wantD || wantD.has(d.id))
        .map((d) => ({ id: d.id, definition: d.definition })),
    };
    audit({
      action: 'bundle.exported',
      entityType: 'bundle',
      summary: `Exported ${bundle.processes.length} process(es) and ${bundle.dashboards.length} dashboard(s)`,
    });
    reply.header('content-disposition', `attachment; filename="steward-bundle-${bundle.exportedAt.slice(0, 10)}.json"`);
    return bundle;
  });

  const bundleImport = { config: { rateLimit: ROUTE_LIMITS.heavy, smBodyShape: IMPORT_BODY_SHAPE }, bodyLimit: LARGE_BODIES.exports.bytes };
  app.post('/bundle/import', bundleImport, async (req) => {
    const b = z
      .object({
        bundle: z.object({
          format: z.enum(BUNDLE_FORMATS),
          // an export of a large installation (each definition is validated on its own)
          processes: z
            .array(z.object({ id: z.string(), definition: z.any() }))
            .max(10_000)
            .default([]),
          dashboards: z
            .array(z.object({ id: z.string(), definition: z.any() }))
            .max(10_000)
            .default([]),
        }),
        /** existing ids: 'newVersion' saves the imported definition as a new version, 'skip' leaves them, 'copy' imports as a new process */
        onConflict: z.enum(['newVersion', 'skip', 'copy']).default('newVersion'),
      })
      .parse(req.body);
    const result = { created: [] as string[], updated: [] as string[], skipped: [] as { id: string; reason: string }[] };
    const caps = capabilities(currentUser());
    for (const p of b.bundle.processes) {
      const exists = db().get<{ archived: number }>('SELECT archived FROM processes WHERE id = ?', p.id);
      try {
        if (exists && !exists.archived && b.onConflict !== 'copy') {
          if (b.onConflict === 'skip') {
            result.skipped.push({ id: p.id, reason: 'exists' });
            continue;
          }
          if (!processes.permissionsFor(p.id).includes('edit')) throw new HttpError(403, 'no edit permission');
          processes.saveProcess(p.id, p.definition, 'Imported from bundle');
          result.updated.push(p.id);
        } else {
          if (!caps.createProcesses) throw new HttpError(403, 'no permission to create processes');
          result.created.push(processes.createProcess(p.definition, { id: p.id, comment: 'Imported from bundle' }).id);
        }
      } catch (e) {
        result.skipped.push({ id: p.id, reason: (e as Error).message });
      }
    }
    for (const d of b.bundle.dashboards) {
      const exists = db().get('SELECT 1 FROM dashboards WHERE id = ?', d.id);
      try {
        if (exists && b.onConflict !== 'copy') {
          if (b.onConflict === 'skip') {
            result.skipped.push({ id: d.id, reason: 'exists' });
            continue;
          }
          dashboards.saveDashboard(d.id, d.definition);
          result.updated.push(d.id);
        } else result.created.push(dashboards.createDashboard(d.definition, { id: d.id }).id);
      } catch (e) {
        result.skipped.push({ id: d.id, reason: (e as Error).message });
      }
    }
    audit({
      action: 'bundle.imported',
      entityType: 'bundle',
      summary: `Bundle imported: ${result.created.length} created, ${result.updated.length} updated, ${result.skipped.length} skipped`,
      details: result,
    });
    return result;
  });
}
