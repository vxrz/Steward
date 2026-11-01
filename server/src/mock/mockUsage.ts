import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';

/**
 * Simulated Insights Hub consumption figures for the "Tenant usage and licence check" example
 * (examples/processes/32-ih-tenant-usage.yaml).
 *
 * The Usage Transparency route follows the v3.2.0 specification: `GET /aggregatedMonthlyConsumerUsage` needs month
 * (English month name), year, provider, application and KPIName and answers with the aggregated value of that KPI;
 * a missing parameter is a 400 in the error format of the specification. Agent Management uses Spring paging.
 * The KPI value grows a little over the month, so the trend charts of the demo are not flat. Monthly credits stay at
 * 95.5–97.5 % of the demo limit (10 000) all month, so the critical check fails on any day, also on the 1st.
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

/** The KPIs the demo provider reports, by application. */
const KPIS: Record<string, Record<string, { display: string; base: number; growth: number }>> = {
  'steward-demo': {
    'monthly-credits': { display: 'Monthly credits', base: 9550, growth: 200 },
    'active-users': { display: 'Active users', base: 12, growth: 2 },
  },
};
export const MOCK_UTS_PROVIDER = 'demoprovider';

/** 0..1: how far the current month has progressed. */
function monthProgress(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return (now.getTime() - start) / (end - start);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const utsError = (code: string, message: string) => ({ errors: [{ code: `mdsp.core.generic.${code}`, message, logref: 'demo-logref' }] });

export async function mockUsageRoutes(app: FastifyInstance, auth: preHandlerAsyncHookHandler): Promise<void> {
  // Usage Transparency Service v3.2.0 – aggregated monthly usage of one KPI of the consumer tenant
  app.get('/ih/api/usagetransparency/v3/aggregatedMonthlyConsumerUsage', { preHandler: auth }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    for (const name of ['month', 'year', 'provider', 'application', 'KPIName'])
      if (!q[name]) return reply.code(400).send(utsError('missingParameter', `Required parameter '${name}' is missing`));
    if (!MONTHS.includes(q.month!)) return reply.code(400).send(utsError('invalidParameter', `Invalid value '${q.month}' for parameter 'month'`));
    const kpi = q.provider === MOCK_UTS_PROVIDER ? KPIS[q.application!]?.[q.KPIName!] : undefined;
    if (!kpi) return reply.code(404).send(utsError('noMatch', `No KPI '${q.KPIName}' for application '${q.application}' of provider '${q.provider}'`));
    const now = new Date();
    return {
      provider: q.provider,
      application: q.application,
      applicationDisplayName: 'Steward demo',
      KPIName: q.KPIName,
      KPIDisplayName: kpi.display,
      aggregationUntilDate: now.toISOString().slice(0, 10),
      year: q.year,
      month: q.month!.toLowerCase(),
      aggragationFunction: { aggregationFunctionDaily: 'SUM', aggregationFunctionMonthly: 'SUM', preFill: 'ZERO' },
      consumer: 'demotenant',
      value: Math.round(kpi.base + kpi.growth * monthProgress(now)),
    };
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
