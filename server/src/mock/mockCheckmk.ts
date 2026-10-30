import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Simulated CheckMk site for demo mode and tests, mounted at /mock/checkmk/demo/check_mk/api/1.0 (#130). It mirrors
 * the parts of the REST API 1.0 (CheckMk 2.2+) Steward uses:
 *   GET  /version
 *   GET  /domain-types/host/collections/all?query=<Livestatus filter>&columns=…
 *   GET  /domain-types/service/collections/all?query=<Livestatus filter>&columns=…
 *   POST /domain-types/metric/actions/get/invoke   { time_range: {start, end}, reduce, site, host_name, service_description,
 *                                                   type: "single_metric", metric_id } → { time_range, step, curves[{title, rrddata}] }
 * Authentication: `Authorization: Bearer <automation user> <secret>`. Collections answer `{ value: [{ extensions }] }`;
 * the Livestatus filter supports `=` and `or`/`and` of them, which is what Steward sends.
 */

export const DEMO_CHECKMK = { user: 'steward-reader', secret: 'demo-checkmk-secret' };
const PREFIX = '/checkmk/demo/check_mk/api/1.0';
const DAY = 86_400_000;

interface State {
  state: number;
  output: string;
  last_check: number;
  has_been_checked: number;
  scheduled_downtime_depth: number;
  acknowledged: number;
}
interface Host extends State {
  name: string;
}
interface Service extends State {
  host_name: string;
  description: string;
  /** metric id → value at a time (ms) */
  metrics: Record<string, (t: number) => number>;
}

const now = () => Math.floor(Date.now() / 1000);
const st = (state: number, output: string): State => ({
  state,
  output,
  last_check: now() - 30,
  has_been_checked: 1,
  scheduled_downtime_depth: 0,
  acknowledged: 0,
});
// a smooth daily wave plus a little deterministic noise
const wave = (t: number, amp: number) => amp * Math.sin((2 * Math.PI * (t % DAY)) / DAY) + amp * 0.3 * Math.sin(t / 3_700_000);

function seed(): { hosts: Host[]; services: Service[] } {
  const t0 = Date.now();
  // /var on db01 fills by about 0.6 % a day: 82 % today, at 90 % (CheckMk's CRIT level) in about two weeks
  const varUsed = (t: number) => 82 - (0.6 * (t0 - t)) / DAY + wave(t, 0.4);
  return {
    hosts: [
      { name: 'db01', ...st(0, 'Packet received via smart PING') },
      { name: 'web01', ...st(0, 'Packet received via smart PING') },
      { name: 'backup01', ...st(1, 'CRIT - 192.0.2.30 rta nan, lost 100%') },
    ],
    services: [
      {
        host_name: 'db01',
        description: 'Filesystem /var',
        ...st(1, 'WARN - Used: 82.0% (warn/crit at 80.0%/90.0%) - 164 GiB of 200 GiB'),
        metrics: { fs_used_percent: varUsed },
      },
      { host_name: 'db01', description: 'CPU load', ...st(0, 'OK - 15 min load: 1.21 at 8 cores'), metrics: { load15: (t) => 1.2 + wave(t, 0.5) } },
      {
        host_name: 'web01',
        description: 'Memory',
        ...st(0, 'OK - RAM: 54.8% - 8.8 GB of 16 GB'),
        metrics: { mem_used_percent: (t) => 55 + wave(t, 6) },
      },
      {
        host_name: 'web01',
        description: 'HTTPS shop',
        ...st(2, 'CRIT - HTTP 503 Service Unavailable'),
        metrics: { response_time: (t) => 0.35 + wave(t, 0.1) },
      },
    ],
  };
}

let data = seed();

/** For tests: change a host (no service) or a service state. */
export function setCheckmkState(host: string, service: string | null, patch: Partial<State>): void {
  const target = service ? data.services.find((s) => s.host_name === host && s.description === service) : data.hosts.find((h) => h.name === host);
  if (target) Object.assign(target, patch);
}
export function resetCheckmk(): void {
  data = seed();
}

type Filter = { op: string; left?: string; right?: unknown; expr?: Filter[] };
function matches(f: Filter | undefined, row: Record<string, unknown>): boolean {
  if (!f) return true;
  if (f.op === 'or') return (f.expr ?? []).some((x) => matches(x, row));
  if (f.op === 'and') return (f.expr ?? []).every((x) => matches(x, row));
  if (f.op === '=') return String(row[f.left ?? '']) === String(f.right);
  if (f.op === '!=') return String(row[f.left ?? '']) !== String(f.right);
  return false;
}

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers.authorization === `Bearer ${DEMO_CHECKMK.user} ${DEMO_CHECKMK.secret}`) return true;
  void reply.code(401).send({ title: 'Unauthorized', status: 401, detail: 'You need to be authenticated to use the REST API.' });
  return false;
}

function collection(rows: Record<string, unknown>[], q: Record<string, unknown>, domainType: string) {
  let filter: Filter | undefined;
  try {
    filter = q.query ? (JSON.parse(String(q.query)) as Filter) : undefined;
  } catch {
    return { error: true as const };
  }
  const cols = ([] as unknown[]).concat(q.columns ?? []).map(String);
  const value = rows
    .filter((r) => matches(filter, r))
    .map((r) => ({
      domainType,
      extensions: cols.length ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r,
    }));
  return { error: false as const, body: { id: domainType, domainType, value, links: [] } };
}

const row = ({ metrics: _m, ...s }: Service) => ({ ...s, plugin_output: s.output });

export async function mockCheckmk(app: FastifyInstance): Promise<void> {
  app.get(`${PREFIX}/version`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    return { site: 'demo', group: '', rest_api: { revision: '0' }, versions: { checkmk: '2.3.0p20' }, edition: 'cre', demo: true };
  });
  app.get(`${PREFIX}/domain-types/host/collections/all`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const r = collection(
      data.hosts.map((h) => ({ ...h, plugin_output: h.output })),
      req.query as Record<string, unknown>,
      'host',
    );
    return r.error ? reply.code(400).send({ title: 'Bad request', status: 400, detail: 'query is not valid JSON' }) : r.body;
  });
  app.get(`${PREFIX}/domain-types/service/collections/all`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const r = collection(data.services.map(row), req.query as Record<string, unknown>, 'service');
    return r.error ? reply.code(400).send({ title: 'Bad request', status: 400, detail: 'query is not valid JSON' }) : r.body;
  });
  app.post(`${PREFIX}/domain-types/metric/actions/get/invoke`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const b = (req.body ?? {}) as {
      time_range?: { start?: string | number; end?: string | number };
      reduce?: string;
      host_name?: string;
      service_description?: string;
      metric_id?: string;
    };
    const svc = data.services.find((s) => s.host_name === b.host_name && s.description === b.service_description);
    const fn = svc?.metrics[b.metric_id ?? ''];
    if (!fn) return reply.code(404).send({ title: 'Not found', status: 404, detail: 'No such metric' });
    const ms = (v: string | number | undefined, fallback: number) => (v === undefined ? fallback : typeof v === 'number' ? v * 1000 : Date.parse(v));
    const end = Math.min(ms(b.time_range?.end, Date.now()), Date.now());
    const start = ms(b.time_range?.start, end - DAY);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      return reply.code(400).send({ title: 'Bad request', status: 400, detail: 'time_range is not valid' });
    // CheckMk's RRDs: one value per minute for two days, then per 5 minutes, per 30 minutes, per 6 hours
    const span = end - start;
    const step = span <= 2 * DAY ? 60 : span <= 10 * DAY ? 300 : span <= 90 * DAY ? 1800 : 21600;
    const rrddata: (number | null)[] = [];
    for (let t = start; t < end && rrddata.length < 5000; t += step * 1000) rrddata.push(Math.round(fn(t) * 1000) / 1000);
    return {
      time_range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      step,
      curves: [{ color: '#1e90ff', rrddata, line_type: 'line', title: b.metric_id }],
    };
  });
}
