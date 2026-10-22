import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Simulated IoT time series for the monitor demo (machines with PowerMeters).
 * Served through the Insights Hub mock:
 *   GET /mock/ih/api/iottimeseries/v3/timeseries/{assetId}/{aspect}
 *       ?latestRecord=true                  newest record only (it holds just the variables written at that time)
 *       ?from=&to=[&select=a,b][&limit=]     records in the range, oldest first (default limit 2000)
 *       (no parameters)                      newest record, like latestRecord
 * Every variable has its own cadence and "lag" (age of its newest point), so
 * some variables are fresh and others stale. Data is generated relative to now.
 *
 * Test helpers (no auth):
 *   POST /mock/ih/test/timeseries  { assetId, aspect, variable, lagSeconds?, cadenceSeconds? }   change a variable
 *   GET  /mock/ih/test/timeseries/calls                                                           calls per asset/aspect
 *   POST /mock/ih/test/timeseries/reset
 */

const assetId = (name: string) => crypto.createHash('md5').update(`iot-asset:${name}`).digest('hex');

export interface IotVariable {
  name: string;
  /** Seconds between points */
  cadenceSeconds: number;
  /** Age of the newest point in seconds */
  lagSeconds: number;
  base: number;
  spread: number;
}

/** Assets used by the demo monitors (not part of the asset list of the IH mock). */
export const DEMO_IOT_ASSETS = {
  pm17: { assetId: assetId('PowerMeter PM-17'), name: 'PowerMeter PM-17', aspect: 'Energy' },
  machine17: { assetId: assetId('Machine 17'), name: 'Machine 17', aspect: 'MachineData' },
  pm18: { assetId: assetId('PowerMeter PM-18'), name: 'PowerMeter PM-18', aspect: 'Energy' },
  machine18: { assetId: assetId('Machine 18'), name: 'Machine 18', aspect: 'MachineData' },
} as const;

function seed(): Map<string, IotVariable[]> {
  const energy = (lag: number): IotVariable[] => [
    { name: 'activePower', cadenceSeconds: 60, lagSeconds: lag, base: 48, spread: 12 },
    { name: 'energy', cadenceSeconds: 60, lagSeconds: lag, base: 15230, spread: 5 },
    { name: 'voltage', cadenceSeconds: 60, lagSeconds: lag, base: 400, spread: 6 },
  ];
  const machine = (lag: number): IotVariable[] => [
    // on-change data: sparse points
    { name: 'spindleSpeed', cadenceSeconds: 240, lagSeconds: lag, base: 1450, spread: 300 },
    { name: 'state', cadenceSeconds: 600, lagSeconds: lag + 30, base: 1, spread: 0 },
    // a variable that stopped reporting hours ago
    { name: 'toolWear', cadenceSeconds: 900, lagSeconds: 3 * 3600, base: 37, spread: 4 },
  ];
  const a = DEMO_IOT_ASSETS;
  return new Map([
    [`${a.pm17.assetId}/${a.pm17.aspect}`, energy(20)],
    [`${a.machine17.assetId}/${a.machine17.aspect}`, machine(90)],
    // the gateway of machine 18 stopped forwarding PowerMeter data 25 minutes ago
    [`${a.pm18.assetId}/${a.pm18.aspect}`, energy(25 * 60)],
    [`${a.machine18.assetId}/${a.machine18.aspect}`, machine(45)],
  ]);
}

let series = seed();
const calls = new Map<string, number>();

/** Deterministic pseudo-random value per variable and timestamp. */
function valueAt(v: IotVariable, t: number): number {
  if (v.spread === 0) return v.base;
  const h = crypto.createHash('sha1').update(`${v.name}:${t}`).digest();
  return Math.round((v.base + ((h[0]! / 255) * 2 - 1) * v.spread) * 100) / 100;
}

/** Point times of a variable within [from, to] (ms), newest first, at most `max`. */
function pointTimes(v: IotVariable, now: number, from: number, to: number, max: number): number[] {
  const newest = Math.floor((now - v.lagSeconds * 1000) / 1000) * 1000;
  const step = v.cadenceSeconds * 1000;
  const out: number[] = [];
  let t = newest;
  while (t > to) t -= step;
  for (; t >= from && out.length < max; t -= step) out.push(t);
  return out;
}

function records(vars: IotVariable[], times: Map<number, IotVariable[]>): Record<string, unknown>[] {
  void vars;
  return [...times.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, list]) => {
      const rec: Record<string, unknown> = { _time: new Date(t).toISOString() };
      for (const v of list) {
        rec[v.name] = valueAt(v, t);
        rec[`${v.name}_qc`] = 0;
      }
      return rec;
    });
}

/** Answers a time series request for a simulated IoT asset; null when the asset/aspect is not simulated. */
export function iotTimeseries(entity: string, aspect: string, q: Record<string, string>): Record<string, unknown>[] | null {
  const key = `${entity}/${aspect}`;
  const vars = series.get(key);
  if (!vars) return null;
  calls.set(key, (calls.get(key) ?? 0) + 1);
  const now = Date.now();
  const select = q.select ? new Set(q.select.split(',').map((s) => s.trim().toLowerCase().replace(/_qc$/, ''))) : null;
  const chosen = vars.filter((v) => !select || select.has(v.name.toLowerCase()));
  const byTime = new Map<number, IotVariable[]>();
  if (q.from || q.to) {
    const from = q.from ? Date.parse(q.from) : now - 3600000;
    const to = q.to ? Date.parse(q.to) : now;
    const limit = Math.min(Math.max(1, Number(q.limit ?? 2000)), 2000);
    for (const v of chosen) for (const t of pointTimes(v, now, from, to, limit)) byTime.set(t, [...(byTime.get(t) ?? []), v]);
    return records(chosen, byTime).slice(0, limit);
  }
  // latest record: only the variables written at the newest timestamp
  let newest = -Infinity;
  for (const v of chosen) newest = Math.max(newest, pointTimes(v, now, 0, now, 1)[0] ?? -Infinity);
  if (!Number.isFinite(newest)) return [];
  byTime.set(
    newest,
    chosen.filter((v) => pointTimes(v, now, newest, newest, 1)[0] === newest),
  );
  return records(chosen, byTime);
}

export async function mockIotRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ih/test/timeseries', async (req, reply) => {
    const b = req.body as { assetId?: string; aspect?: string; variable?: string; lagSeconds?: number; cadenceSeconds?: number };
    const key = `${b?.assetId}/${b?.aspect}`;
    let vars = series.get(key);
    if (!vars) series.set(key, (vars = []));
    let v = vars.find((x) => x.name === b.variable);
    if (!v) {
      if (!b.variable) return reply.code(400).send({ error: 'variable required' });
      vars.push((v = { name: b.variable, cadenceSeconds: 60, lagSeconds: 0, base: 10, spread: 1 }));
    }
    if (typeof b.lagSeconds === 'number') v.lagSeconds = b.lagSeconds;
    if (typeof b.cadenceSeconds === 'number') v.cadenceSeconds = b.cadenceSeconds;
    return { ok: true, variable: v };
  });
  app.get('/ih/test/timeseries/calls', async () => ({ calls: Object.fromEntries(calls) }));
  app.post('/ih/test/timeseries/reset', async () => {
    series = seed();
    calls.clear();
    return { ok: true };
  });
}
