import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatasetPublisher } from '@sm/shared';
import * as processes from '../processes/service.js';
import * as scheduler from '../scheduler.js';

/**
 * The processes that publish a dataset key: visible processes whose current version has a "Publish to dashboard"
 * node for it – known before the first run, so an empty widget can name what fills it (and whether it is scheduled).
 */
export function datasetPublishers(key: string): DatasetPublisher[] {
  const scheduled = new Set(
    scheduler
      .listSchedules()
      .filter((s) => s.enabled)
      .map((s) => s.processId),
  );
  const out: DatasetPublisher[] = [];
  for (const p of processes.listProcesses()) {
    let nodes: { type: string; dataset?: string }[];
    try {
      nodes = processes.getProcess(p.id).definition.nodes as { type: string; dataset?: string }[];
    } catch {
      continue;
    }
    if (!nodes.some((n) => n.type === 'publish' && n.dataset?.trim() === key)) continue;
    out.push({
      processId: p.id,
      processName: p.name,
      scheduled: scheduled.has(p.id),
      canEdit: p.permissions.includes('edit'),
      canRun: p.permissions.includes('run'),
    });
  }
  return out.slice(0, 20);
}

export async function datasetPublisherRoutes(app: FastifyInstance): Promise<void> {
  app.get('/datasets/:key/publishers', async (req: FastifyRequest) => datasetPublishers((req.params as { key: string }).key));
}
