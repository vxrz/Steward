import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

/**
 * Simulated Insights Hub consumption figures for the "Tenant usage and licence check" example
 * (examples/processes/32-ih-tenant-usage.yaml).
 *
 * The response shapes follow the public Insights Hub documentation where it describes them
 * (Agent Management paging) and are ASSUMED for the aggregated usage of the Usage Transparency
 * Service, whose exact v3 response could not be confirmed – see docs/INSIGHTS-HUB-USAGE.md.
 * The figures grow a little over the month, so the trend charts of the demo are not flat.
 */

const AGENTS = [
  'Line 1 Nano',
  'Line 2 Nano',
  'Paint shop IoT2050',
  'Warehouse MindConnect',
  'Lab gateway',
  'Hall 1 Nano',
  'Hall 2 Nano',
  'Utilities IoT2050',
  'Test bench Nano',
];

/** 0..1: how far the current month has progressed. */
function monthProgress(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return (now.getTime() - start) / (end - start);
}

export function mockUsageFigures(now = new Date()) {
  const p = monthProgress(now);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [
    // monthly credits of the capability package: close to the limit in the demo (critical)
    { resource: 'credits', name: 'Credits (capability package)', unit: 'credits', amount: Math.round(9450 + 200 * p), limit: 10000 },
    // IoT time series storage: warning
    { resource: 'iot-timeseries-storage', name: 'IoT time series storage', unit: 'GB', amount: r1(168 + 8 * p), limit: 200 },
    { resource: 'file-storage', name: 'File storage', unit: 'GB', amount: r1(11.5 + 1.2 * p), limit: 50 },
    { resource: 'api-calls', name: 'API calls', unit: 'calls', amount: Math.round(1_500_000 + 600_000 * p), limit: 5_000_000 },
  ];
}

export async function mockUsageRoutes(app: FastifyInstance, auth: preHandlerAsyncHookHandler): Promise<void> {
  // Usage Transparency Service – aggregated usage of the tenant (ASSUMED path and shape)
  app.get('/ih/api/usagetransparency/v3/usages/aggregated', { preHandler: auth }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    return { tenant: 'demotenant', from: q.from ?? null, to: q.to ?? null, usages: mockUsageFigures() };
  });
  // Agent Management – agents of the tenant (Spring-style page)
  app.get('/ih/api/agentmanagement/v3/agents', { preHandler: auth }, async (req) => {
    const q = req.query as { size?: string; page?: string };
    const size = Math.min(Math.max(1, Number(q.size ?? 10)), 2000);
    const page = Math.max(0, Number(q.page ?? 0));
    const all = AGENTS.map((name, i) => ({ id: `agent-${String(i + 1).padStart(3, '0')}`, name, securityProfile: 'SHARED_SECRET', eTag: 1 }));
    return {
      content: all.slice(page * size, page * size + size),
      totalElements: all.length,
      totalPages: Math.ceil(all.length / size),
      size,
      number: page,
      first: page === 0,
      last: (page + 1) * size >= all.length,
    };
  });
}
