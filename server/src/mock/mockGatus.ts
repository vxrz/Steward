import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * Simulated Gatus (https://github.com/TwiN/gatus) for demo mode, mounted at
 * /mock/gatus. It mirrors the parts of the Gatus API the bundled processes use
 * (checked against Gatus v5.37 / master, api/*.go):
 *   GET  /api/v1/endpoints/statuses?page&pageSize   all endpoints; page/pageSize page the *results* of each endpoint
 *   GET  /api/v1/endpoints/{key}/statuses           one endpoint (plus events)
 *   GET  /api/v1/endpoints/{key}/uptimes/{1h|24h|7d|30d}         text/plain, e.g. 0.958333
 *   GET  /api/v1/endpoints/{key}/response-times/{1h|24h|7d|30d}  text/plain, average in ms
 *   POST /api/v1/endpoints/{key}/external?success=&error=&duration=   Authorization: Bearer <external endpoint token>
 *   GET  /health
 * The status routes are protected with HTTP Basic auth, as with Gatus' `security.basic`;
 * uptime, response-time and external routes are unprotected in Gatus too.
 * Results are ordered oldest → newest; `duration` is in nanoseconds.
 * The monitored "applications" live at /mock/gatus-apps/*.
 */

export const DEMO_GATUS = { username: 'demo-reader', password: 'demo-gatus-password', externalToken: 'demo-external-token' };

interface Result {
  status?: number;
  hostname?: string;
  duration: number;
  errors?: string[];
  conditionResults?: { condition: string; success: boolean }[];
  success: boolean;
  timestamp: string;
}
interface Endpoint {
  name: string;
  group: string;
  key: string;
  external?: boolean;
  results: Result[];
  uptime: Record<string, number>;
}

/** Gatus key: <group>_<name>, both lower-cased with / _ . , space # + & replaced by "-" (config/key/key.go). */
export function gatusKey(group: string, name: string): string {
  const s = (x: string) =>
    x
      .trim()
      .toLowerCase()
      .replace(/[/_.,\s#+&]/g, '-');
  return `${s(group)}_${s(name)}`;
}

const MAX_RESULTS = 100;
const INTERVAL_MS = 5 * 60000;

function seed(): Endpoint[] {
  const base = `http://127.0.0.1:${config.port}`;
  const now = Date.now() - 60000;
  const mk = (
    group: string,
    name: string,
    url: string,
    conditions: string[],
    pattern: (i: number, n: number) => { ok: boolean; ms: number; status?: number; error?: string },
    uptime: Record<string, number>,
  ): Endpoint => {
    const n = 30;
    const host = /^[a-z]+:\/\/([^/:]+)/i.exec(url)?.[1] ?? '';
    const results: Result[] = [];
    for (let i = 0; i < n; i++) {
      const p = pattern(i, n);
      results.push({
        ...(p.status ? { status: p.status } : {}),
        hostname: host,
        duration: Math.round(p.ms * 1e6),
        ...(p.ok ? {} : { errors: [p.error ?? `condition failed`] }),
        conditionResults: conditions.map((c, ci) => ({ condition: c, success: p.ok || ci > 0 })),
        success: p.ok,
        timestamp: new Date(now - (n - 1 - i) * INTERVAL_MS).toISOString(),
      });
    }
    return { name, group, key: gatusKey(group, name), results, uptime };
  };
  const jitter = (i: number, ms: number) => ms + ((i * 37) % 11) - 5;
  return [
    mk('core', 'Steward API', `${base}/api/health`, ['[STATUS] == 200'], (i) => ({ ok: true, ms: jitter(i, 14), status: 200 }), {
      '1h': 1,
      '24h': 1,
      '7d': 0.9995,
      '30d': 0.9991,
    }),
    mk('core', 'Steward readiness', `${base}/api/ready`, ['[STATUS] == 200', '[BODY].ready == true'], (i) => ({ ok: true, ms: jitter(i, 22), status: 200 }), {
      '1h': 1,
      '24h': 1,
      '7d': 0.998,
      '30d': 0.9985,
    }),
    mk(
      'plant',
      'MES frontend',
      `${base}/mock/gatus-apps/mes`,
      ['[STATUS] == 200', '[RESPONSE_TIME] < 800'],
      (i) => (i === 9 || i === 17 ? { ok: false, ms: 1250, status: 200, error: '' } : { ok: true, ms: jitter(i, 310), status: 200 }),
      { '1h': 1, '24h': 0.9583, '7d': 0.9721, '30d': 0.9802 },
    ),
    mk(
      'plant',
      'Historian API',
      `${base}/mock/gatus-apps/historian/health`,
      ['[STATUS] == 200', '[BODY].status == UP'],
      (i, n) => (i >= n - 4 ? { ok: false, ms: 48, status: 503 } : { ok: true, ms: jitter(i, 95), status: 200 }),
      { '1h': 0.25, '24h': 0.9861, '7d': 0.9952, '30d': 0.9979 },
    ),
    mk('edge', 'OPC UA gateway', 'tcp://opcua.plant.local:4840', ['[CONNECTED] == true'], (i) => ({ ok: true, ms: jitter(i, 1450) }), {
      '1h': 1,
      '24h': 1,
      '7d': 0.9994,
      '30d': 0.9988,
    }),
    {
      ...mk('steward', 'Steward checks', '', ['external'], (i) => ({ ok: true, ms: jitter(i, 400) }), { '1h': 1, '24h': 1, '7d': 1, '30d': 1 }),
      external: true,
    },
    {
      ...mk('steward', 'Machine monitors', '', ['external'], (i) => ({ ok: true, ms: jitter(i, 20) }), { '1h': 1, '24h': 1, '7d': 1, '30d': 1 }),
      external: true,
    },
  ].map((e) => {
    // failed results carry the condition text as Gatus does, e.g. "[STATUS] (503) == 200"
    for (const r of e.results) {
      if (!r.success && r.errors?.[0] === '') r.errors = ['[RESPONSE_TIME] (1250) < 800'];
      if (!r.success && e.key === 'plant_historian-api') r.errors = ['[STATUS] (503) == 200', '[BODY].status (DOWN) == UP'];
      if (e.external) delete r.conditionResults;
    }
    return e;
  });
}

function page(results: Result[], q: { page?: string; pageSize?: string }): Result[] {
  let p = Number.parseInt(q.page ?? '', 10);
  if (!Number.isFinite(p) || p < 1) p = 1;
  let size = Number.parseInt(q.pageSize ?? '', 10);
  if (!Number.isFinite(size)) size = 50;
  if (p === 1 && size > MAX_RESULTS) size = MAX_RESULTS;
  else if (size < 1) size = 50;
  // page 1 = the newest results, returned oldest → newest
  const end = results.length - (p - 1) * size;
  if (end <= 0) return [];
  return results.slice(Math.max(0, end - size), end);
}

/** Go duration string → nanoseconds ("150ms", "1.5s", "1m30s"); NaN when invalid. */
function goDuration(s: string): number {
  const unit: Record<string, number> = { ns: 1, us: 1e3, µs: 1e3, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 };
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy;
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * unit[m[2]!]!;
    pos = re.lastIndex;
  }
  return pos === s.length && pos > 0 ? total : Number.NaN;
}

export async function mockGatus(app: FastifyInstance): Promise<void> {
  let endpoints: Endpoint[] | null = null;
  const all = () => (endpoints ??= seed());
  const byKey = (key: string) => all().find((e) => e.key === decodeURIComponent(key));

  const basic = async (req: FastifyRequest, reply: FastifyReply) => {
    const [user, pass] = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic\s+/i, ''), 'base64')
      .toString()
      .split(':');
    if (user !== DEMO_GATUS.username || pass !== DEMO_GATUS.password) {
      return reply.code(401).header('www-authenticate', 'Basic').type('text/plain').send('Unauthorized');
    }
  };
  const view = (e: Endpoint, q: Record<string, string>, events = false) => ({
    name: e.name,
    group: e.group,
    key: e.key,
    results: page(e.results, q),
    ...(events
      ? {
          events: [
            { type: 'START', timestamp: e.results[0]?.timestamp },
            ...(e.results.some((r) => !r.success)
              ? [{ type: e.results.at(-1)?.success ? 'HEALTHY' : 'UNHEALTHY', timestamp: e.results.at(-1)?.timestamp }]
              : []),
          ],
        }
      : {}),
  });
  const P = '/gatus/api/v1/endpoints';

  app.post('/gatus/reset', async () => {
    endpoints = null;
    return { ok: true };
  });
  app.get('/gatus/health', async () => ({ status: 'UP' }));
  app.get(`${P}/statuses`, { preHandler: basic }, async (req) => all().map((e) => view(e, req.query as Record<string, string>)));
  app.get(`${P}/:key/statuses`, { preHandler: basic }, async (req, reply) => {
    const e = byKey((req.params as { key: string }).key);
    if (!e) return reply.code(404).type('text/plain').send('endpoint not found');
    return view(e, req.query as Record<string, string>, true);
  });
  app.get(`${P}/:key/uptimes/:duration`, async (req, reply) => {
    const { key, duration } = req.params as { key: string; duration: string };
    if (!['1h', '24h', '7d', '30d'].includes(duration)) return reply.code(400).type('text/plain').send('Durations supported: 30d, 7d, 24h, 1h');
    const e = byKey(key);
    if (!e) return reply.code(404).type('text/plain').send('endpoint not found');
    return reply.type('text/plain').header('cache-control', 'no-cache, no-store, must-revalidate').send(e.uptime[duration]!.toFixed(6));
  });
  app.get(`${P}/:key/response-times/:duration`, async (req, reply) => {
    const { key, duration } = req.params as { key: string; duration: string };
    if (!['1h', '24h', '7d', '30d'].includes(duration)) return reply.code(400).type('text/plain').send('Durations supported: 30d, 7d, 24h, 1h');
    const e = byKey(key);
    if (!e) return reply.code(404).type('text/plain').send('endpoint not found');
    const avg = e.results.reduce((s, r) => s + r.duration, 0) / Math.max(1, e.results.length) / 1e6;
    return reply.type('text/plain').send(String(Math.round(avg)));
  });
  app.post(`${P}/:key/external`, async (req, reply) => {
    const q = req.query as { success?: string; error?: string; duration?: string };
    if (q.success !== 'true' && q.success !== 'false') return reply.code(400).type('text/plain').send('missing or invalid success query parameter');
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ')) return reply.code(401).type('text/plain').send('invalid Authorization header');
    const token = auth.slice(7).trim();
    if (!token) return reply.code(401).type('text/plain').send('bearer token must not be empty');
    const e = byKey((req.params as { key: string }).key);
    if (!e?.external) return reply.code(404).type('text/plain').send('not found');
    if (token !== DEMO_GATUS.externalToken) return reply.code(401).type('text/plain').send('invalid token');
    let duration = 0;
    if (q.duration) {
      duration = goDuration(q.duration);
      if (Number.isNaN(duration)) return reply.code(400).type('text/plain').send(`invalid duration: time: invalid duration "${q.duration}"`);
    }
    const success = q.success === 'true';
    e.results.push({ duration, success, timestamp: new Date().toISOString(), ...(!success && q.error ? { errors: [q.error] } : {}) });
    if (e.results.length > MAX_RESULTS) e.results.shift();
    return reply.code(200).send('');
  });

  // ---- the "applications" Gatus watches ----
  app.get('/gatus-apps/mes', async () => ({ status: 'UP', app: 'MES frontend' }));
  app.get('/gatus-apps/historian/health', async (_req, reply) =>
    reply.code(503).send({ status: 'DOWN', checks: { database: 'connection pool exhausted (50/50)', disk: 'ok' } }),
  );
}
