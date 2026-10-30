import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { tagsMatch, MONITOR_STATUS_CODE, type MonitorSummary } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { decodeCursor, linkNext, pageArray, pageRows } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';
import * as A from './api-schemas.js';

/**
 * Monitors in the public, read-only API – for pull integrations such as the
 * Zabbix HTTP agent (with LLD), Grafana or scripts. Permissions as in the UI.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const notFound = (what: string) => new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });

function viewable(idOrKey: string) {
  try {
    return svc.getMonitor(idOrKey);
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Monitor ${idOrKey}`);
    throw e;
  }
}

const mapMonitor = (m: MonitorSummary) => ({
  id: m.id,
  key: m.key,
  name: m.name,
  description: m.description,
  tags: m.tags,
  owner: m.owner,
  enabled: m.enabled,
  status: m.status,
  statusCode: MONITOR_STATUS_CODE[m.status],
  since: m.since,
  rootCauses: m.rootCauses,
  checkCount: m.checkCount,
  counts: m.counts,
  uptime: m.uptime,
  maintenance: m.maintenance ? { startsAt: m.maintenance.startsAt, endsAt: m.maintenance.endsAt, reason: m.maintenance.reason } : null,
  acknowledged: m.acknowledged,
  templateId: m.templateId,
  updatedAt: m.updatedAt,
  lastEvaluatedAt: m.lastEvaluatedAt,
});

const ref = (name: keyof typeof A.MONITOR_COMPONENTS & string) => ({ $ref: `${name}#` });
const pageOf = (name: keyof typeof A.MONITOR_COMPONENTS & string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: ref(name) },
    nextCursor: { type: ['string', 'null'], description: 'Opaque cursor for the next page; null on the last page.' },
  },
  additionalProperties: false,
});

export async function monitorApiRoutes(_app: FastifyInstance, get: Get): Promise<void> {
  get(
    '/monitors',
    {
      operationId: 'listMonitors',
      tag: 'Monitors',
      summary: 'List monitors with their status',
      description: 'Monitors you may view (templates are left out), ordered by name.',
      query: A.MonitorListQuery,
      paginated: true,
      response: pageOf('Monitor', 'A page of monitors'),
    },
    async (req, reply) => {
      const q = req.query as { status?: string[]; tag?: string; q?: string; cursor?: string; limit: number };
      const needle = q.q?.toLowerCase();
      const list = svc
        .listMonitors({ templates: false })
        .filter((m) => !q.status?.length || q.status.includes(m.status))
        .filter((m) => tagsMatch(m.tags, q.tag))
        .filter((m) => !needle || m.key.includes(needle) || m.name.toLowerCase().includes(needle))
        .map(mapMonitor);
      const page = pageArray(list, (m) => [m.name.toLowerCase(), m.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/monitors/discovery',
    {
      operationId: 'discoverMonitors',
      tag: 'Monitors',
      summary: 'Zabbix low-level discovery (LLD) of monitors and checks',
      description:
        'Returns `{"data":[{"{#MONITOR}":"machine-17-powermeter","{#CHECK}":"pm-reachable",…}]}` for a Zabbix HTTP agent discovery rule. Use the macros in item prototypes, e.g. a dependent item on `/monitors/{#MONITOR}/status` with JSONPath `$.checks[?(@.checkId=="{#CHECK}")].statusCode.first()`.',
      query: A.MonitorDiscoveryQuery,
      response: ref('MonitorDiscovery'),
    },
    async (req) => {
      const q = req.query as { level: 'checks' | 'monitors'; tag?: string };
      const list = svc.listMonitors({ templates: false }).filter((m) => m.enabled && tagsMatch(m.tags, q.tag));
      if (q.level === 'monitors') {
        return { data: list.map((m) => ({ '{#MONITOR}': m.key, '{#MONITORNAME}': m.name, '{#MONITORID}': m.id })) };
      }
      return {
        data: list.flatMap((m) =>
          svc.getMonitor(m.id).checks.map((c) => ({
            '{#MONITOR}': m.key,
            '{#MONITORNAME}': m.name,
            '{#MONITORID}': m.id,
            '{#CHECK}': c.checkId,
            '{#CHECKNAME}': c.name,
            '{#CHECKTYPE}': c.type,
            '{#CHECKKEY}': c.key,
          })),
        ),
      };
    },
  );

  get(
    '/monitors/:monitorId',
    {
      operationId: 'getMonitor',
      tag: 'Monitors',
      summary: 'Get a monitor with its definition',
      params: { monitorId: 'Monitor id or key' },
      response: ref('MonitorDetail'),
    },
    async (req) => {
      const m = viewable(params(req).monitorId!);
      return { ...mapMonitor(m), definition: m.definition as unknown as Record<string, unknown> };
    },
  );

  get(
    '/monitors/:monitorId/status',
    {
      operationId: 'getMonitorStatus',
      tag: 'Monitors',
      summary: 'Current status of a monitor and all its checks',
      description: 'For pull integrations (Zabbix HTTP agent, scripts). Status codes: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance.',
      params: { monitorId: 'Monitor id or key' },
      response: ref('MonitorStatusReport'),
    },
    async (req) => {
      const m = viewable(params(req).monitorId!);
      return {
        ...mapMonitor(m),
        checks: m.checks.map((c) => ({
          checkId: c.checkId,
          key: c.key,
          name: c.name,
          type: c.type,
          critical: c.critical,
          enabled: c.enabled,
          status: c.status,
          statusCode: MONITOR_STATUS_CODE[c.status],
          since: c.since,
          lastCheckedAt: c.last?.ts ?? null,
          lastOkAt: c.lastOkAt,
          message: c.last?.message ?? null,
          durationMs: c.last?.durationMs ?? null,
          causedBy: c.causedBy,
          note: c.note,
          uptime: c.uptime,
        })),
        time: new Date().toISOString(),
      };
    },
  );

  get(
    '/monitors/:monitorId/history',
    {
      operationId: 'listMonitorHistory',
      tag: 'Monitors',
      summary: 'Status changes of a monitor and its checks',
      description: 'Newest first. Kept for the monitor retention period (default 30 days).',
      params: { monitorId: 'Monitor id or key' },
      query: A.MonitorHistoryQuery,
      paginated: true,
      response: pageOf('MonitorHistoryEntry', 'A page of status changes'),
    },
    async (req, reply) => {
      const m = viewable(params(req).monitorId!);
      const q = req.query as { check?: string; cursor?: string; limit: number };
      const filters = { check: q.check, id: m.id };
      const after = decodeCursor(q.cursor, filters);
      const rows = svc
        .listHistory(m.id, { checkId: q.check, limit: q.limit + 1, beforeId: after ? Number(after[0]) : undefined })
        .map((h) => ({ ...h, id: String(h.id) }));
      const page = pageRows(rows, q.limit, (h) => [Number(h.id)], filters);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );
}
