/** /api/v1 routes for schedules and webhook triggers. */
import { DEFAULT_SCHEDULE_NOTIFY, DEFAULT_TRIGGER_NOTIFY } from '@sm/shared';
import * as processes from '../../processes/service.js';
import * as scheduler from '../../scheduler.js';
import { fullPolicy } from '../../engine/notify-source.js';
import * as triggers from '../../triggers/service.js';
import { HttpError } from '../../util.js';
import { pageArray } from './pagination.js';
import * as S from './schemas.js';
import { notFound, paged, params, query, type Get } from './helpers.js';

const mapSchedule = (s: ReturnType<typeof scheduler.getSchedule>) => ({
  id: s.id,
  name: s.name,
  processId: s.processId,
  processName: s.processName ?? '',
  cron: s.cron,
  timezone: s.timezone ?? null,
  enabled: s.enabled,
  dryRun: s.dryRun,
  allowOverlap: s.allowOverlap,
  inputs: s.inputs,
  bindings: s.bindings,
  owner: s.owner ?? null,
  nextRunAt: s.nextRunAt ?? null,
  lastRunAt: s.lastRunAt ?? null,
  lastRunId: s.lastRunId ?? null,
  lastRunStatus: s.lastRunStatus ?? null,
  createdAt: s.createdAt,
  notify: fullPolicy(s.notify, DEFAULT_SCHEDULE_NOTIFY),
});

const mapTrigger = (t: ReturnType<typeof triggers.getTrigger>) => ({
  id: t.id,
  name: t.name,
  description: t.description ?? '',
  processId: t.processId,
  processName: t.processName ?? '',
  processVersion: t.processVersion ?? null,
  enabled: t.enabled,
  dryRun: t.dryRun,
  authMode: t.authMode,
  owner: t.owner,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  lastFiredAt: t.lastFiredAt,
  lastRunId: t.lastRunId,
  lastRunStatus: t.lastRunStatus,
  fireCount: t.fireCount,
  rejectedCount: t.rejectedCount,
  notify: fullPolicy(t.notify, DEFAULT_TRIGGER_NOTIFY),
});

export function scheduleRoutes(get: Get): void {
  // ---------- schedules ----------
  get(
    '/schedules',
    {
      operationId: 'listSchedules',
      tag: 'Schedules',
      summary: 'List schedules',
      description: 'Schedules of processes you may view, ordered by name.',
      query: S.ScheduleListQuery,
      paginated: true,
      response: S.pageOf('Schedule', 'A page of schedules'),
    },
    async (req, reply) => {
      const q = query<{ processId?: string; enabled?: boolean; cursor?: string; limit: number }>(req);
      const list = scheduler
        .listSchedules()
        .filter((s) => !q.processId || s.processId === q.processId)
        .filter((s) => q.enabled === undefined || s.enabled === q.enabled)
        .map(mapSchedule);
      return paged(
        req,
        reply,
        pageArray(list, (s) => [s.name.toLowerCase(), s.id], q, q),
      );
    },
  );

  get(
    '/schedules/:scheduleId',
    { operationId: 'getSchedule', tag: 'Schedules', summary: 'Get a schedule', params: { scheduleId: 'Schedule id' }, response: S.ref('Schedule') },
    async (req) => {
      let s;
      try {
        s = scheduler.getSchedule(params(req).scheduleId!);
      } catch {
        throw notFound(`Schedule ${params(req).scheduleId}`);
      }
      if (!processes.permissionsFor(s.processId).includes('view')) throw notFound(`Schedule ${s.id}`);
      return mapSchedule(s);
    },
  );

  // ---------- webhook triggers ----------
  get(
    '/triggers',
    {
      operationId: 'listTriggers',
      tag: 'Triggers',
      summary: 'List webhook triggers',
      description: 'Triggers of processes you may view, ordered by name. Secrets are never returned.',
      query: S.TriggerListQuery,
      paginated: true,
      response: S.pageOf('Trigger', 'A page of webhook triggers'),
    },
    async (req, reply) => {
      const q = query<{ processId?: string; enabled?: boolean; cursor?: string; limit: number }>(req);
      const list = triggers
        .listTriggers()
        .filter((t) => !q.processId || t.processId === q.processId)
        .filter((t) => q.enabled === undefined || t.enabled === q.enabled)
        .map(mapTrigger);
      return paged(
        req,
        reply,
        pageArray(list, (t) => [t.name.toLowerCase(), t.id], q, q),
      );
    },
  );

  get(
    '/triggers/:triggerId',
    { operationId: 'getTrigger', tag: 'Triggers', summary: 'Get a webhook trigger', params: { triggerId: 'Trigger id' }, response: S.ref('Trigger') },
    async (req) => {
      try {
        return mapTrigger(triggers.getTrigger(params(req).triggerId!));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Trigger ${params(req).triggerId}`);
        throw e;
      }
    },
  );
}
