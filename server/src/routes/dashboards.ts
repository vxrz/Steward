import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BUNDLE_FORMATS, type DatasetMeta, type ExportBundle } from '@sm/shared';
import { HttpError, nowIso, sha256 } from '../util.js';
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

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** A dataset is visible to whoever may view the process (or monitor) that publishes it. */
const canSee = (d: Pick<DatasetMeta, 'processId'>) => monitorDatasetVisible(d.processId) ?? processes.permissionsFor(d.processId).includes('view');

function visibleDataset(key: string): DatasetMeta {
  const meta = datasets.getDatasetMeta(key);
  if (!canSee(meta)) throw new HttpError(404, `Dataset "${key}" not found`);
  return meta;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // ---------- datasets ----------
  app.get('/datasets', async () => datasets.listDatasets().filter(canSee));

  app.get('/datasets/:key', async (req, reply) => {
    const meta = visibleDataset(params(req).key!);
    const etag = `"${sha256(`${meta.key}|${meta.updatedAt}|${meta.stale}`).slice(0, 16)}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return datasets.getDataset(meta.key);
  });

  app.get('/datasets/:key/metrics', async (req) => {
    const meta = visibleDataset(params(req).key!);
    const q = req.query as { names?: string; days?: string; points?: string };
    return datasets.metricSeries(
      meta.key,
      q.names ? q.names.split(',') : undefined,
      Math.min(Number(q.days ?? 30), 400),
      Math.min(Number(q.points ?? 200), 2000),
    );
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
  app.post('/dashboards', async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().optional(), templateId: z.string().optional() }).parse(req.body);
    if (b.templateId) {
      const t = dashboards.listDashboardTemplates().find((x) => x.id === b.templateId);
      if (!t) throw new HttpError(404, 'Dashboard template not found');
      return dashboards.createDashboard(t.definition, { id: t.id.replace(/^\d+-/, '') });
    }
    return dashboards.createDashboard(b.text ? dashboards.parseDashboardText(b.text) : b.definition);
  });
  app.put('/dashboards/:id', async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().optional() }).parse(req.body);
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
  app.post('/dashboards/:id/refresh', async (req) => {
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
  app.get('/bundle/export', async (req, reply) => {
    const q = req.query as { processes?: string; dashboards?: string };
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

  app.post('/bundle/import', async (req) => {
    const b = z
      .object({
        bundle: z.object({
          format: z.enum(BUNDLE_FORMATS),
          processes: z.array(z.object({ id: z.string(), definition: z.any() })).default([]),
          dashboards: z.array(z.object({ id: z.string(), definition: z.any() })).default([]),
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
