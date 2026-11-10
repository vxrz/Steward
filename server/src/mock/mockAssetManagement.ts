import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_IOT_ASSETS } from './mockIot.js';

/**
 * Insights Hub Asset Management, the reads Steward's "Check mapping" makes (0.14, docs/PLANT.md "Insights Hub mapping"):
 *   GET /mock/ih/api/assetmanagement/v3/assets/{id}                    one asset (404: not there)
 *   GET /mock/ih/api/assetmanagement/v3/assets/{id}/aspects?page=&size=  its aspects with their variables (paged)
 *   GET /mock/ih/api/assetmanagement/v3/aspecttypes/{id}               an aspect type with its variables
 * The assets are the mock's asset list (motors, halls, pumps) and the simulated IoT assets of the monitor demo
 * (machines and their PowerMeters, mockIot.ts) – those stay out of the list, as before.
 *
 * Test helpers (no auth):
 *   POST /mock/ih/test/assetmanagement  { failWith?: 401|403|429|500, failAfter?: n, omitVariables?: boolean }
 *        the reads after the first n answer with that status (429 with Retry-After: 0); omitVariables: aspects
 *        come without their variables (the reader falls back to the aspect type)
 *   GET  /mock/ih/test/assetmanagement/calls   the reads so far
 *   POST /mock/ih/test/assetmanagement/reset
 */

export interface MockVariable {
  name: string;
  dataType: string;
  unit: string;
  searchable: boolean;
  qualityCode: boolean;
}
export interface MockAspectType {
  id: string;
  name: string;
  variables: MockVariable[];
}
export interface MockAssetType {
  id: string;
  name: string;
  variables: MockVariable[];
  aspects: { name: string; aspectType: MockAspectType }[];
}
export interface MockAsset {
  assetId: string;
  name: string;
  typeId: string;
  description: string;
}

const v = (name: string, dataType: string, unit = ''): MockVariable => ({ name, dataType, unit, searchable: true, qualityCode: true });

/** The aspect and asset types of the monitor demo's machines and PowerMeters. */
const IOT_ASPECTS = {
  machine: {
    id: 'demo.MachineData',
    name: 'MachineData',
    variables: [v('spindleSpeed', 'DOUBLE', 'rpm'), v('state', 'INT'), v('toolWear', 'DOUBLE', '%'), v('feedRate', 'DOUBLE', 'mm/min')],
  },
  meter: {
    id: 'demo.PowerMeterEnergy',
    name: 'PowerMeterEnergy',
    variables: [v('activePower', 'DOUBLE', 'kW'), v('energy', 'DOUBLE', 'kWh'), v('voltage', 'DOUBLE', 'V'), v('current', 'DOUBLE', 'A')],
  },
} satisfies Record<string, MockAspectType>;
const IOT_TYPES: MockAssetType[] = [
  { id: 'demo.Machine', name: 'Machine', variables: [], aspects: [{ name: 'MachineData', aspectType: IOT_ASPECTS.machine }] },
  { id: 'demo.PowerMeter', name: 'PowerMeter', variables: [], aspects: [{ name: 'Energy', aspectType: IOT_ASPECTS.meter }] },
];
const IOT_ASSETS: MockAsset[] = Object.values(DEMO_IOT_ASSETS).map((a) => ({
  assetId: a.assetId,
  name: a.name,
  typeId: a.aspect === 'Energy' ? 'demo.PowerMeter' : 'demo.Machine',
  description: 'Simulated IoT asset of the monitor demo',
}));

interface Faults {
  failWith: number | null;
  failAfter: number;
  omitVariables: boolean;
}

export function mockAssetManagementRoutes(
  app: FastifyInstance,
  base: string,
  auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  state: () => { assets: MockAsset[]; assetTypes: MockAssetType[] },
): void {
  let faults: Faults = { failWith: null, failAfter: 0, omitVariables: false };
  let calls = 0;
  const assets = () => [...state().assets, ...IOT_ASSETS];
  const types = () => [...state().assetTypes, ...IOT_TYPES];
  /** A simulated failure (after failAfter reads), or null. */
  const fault = (reply: FastifyReply) => {
    calls++;
    if (faults.failWith === null || calls <= faults.failAfter) return null;
    if (faults.failWith === 429) reply.header('retry-after', '0');
    return reply.code(faults.failWith).send({ errors: [{ message: `simulated ${faults.failWith}` }] });
  };
  const assetOf = (id: string) => assets().find((a) => a.assetId === id);
  app.get(`${base}/assets/:id`, { preHandler: auth }, async (req, reply) => {
    const f = fault(reply);
    if (f) return f;
    const a = assetOf((req.params as { id: string }).id);
    return a ? { ...a, tenantId: 'demotenant', etag: 1 } : reply.code(404).send({ errors: [{ message: 'Asset not found' }] });
  });
  app.get(`${base}/assets/:id/aspects`, { preHandler: auth }, async (req, reply) => {
    const f = fault(reply);
    if (f) return f;
    const a = assetOf((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ errors: [{ message: 'Asset not found' }] });
    const t = types().find((x) => x.id === a.typeId);
    const all = (t?.aspects ?? []).map((x) => ({
      name: x.name,
      holder: a.assetId,
      aspectTypeId: x.aspectType.id,
      aspectTypeName: x.aspectType.name,
      category: 'dynamic',
      ...(faults.omitVariables ? {} : { variables: x.aspectType.variables }),
    }));
    const q = req.query as Record<string, string>;
    const size = Math.min(Math.max(1, Number(q.size ?? 10)), 2000);
    const page = Number(q.page ?? 0);
    return {
      _embedded: { aspects: all.slice(page * size, page * size + size) },
      page: { size, totalElements: all.length, totalPages: Math.ceil(all.length / size), number: page },
    };
  });
  app.get(`${base}/aspecttypes/:id`, { preHandler: auth }, async (req, reply) => {
    const f = fault(reply);
    if (f) return f;
    const id = (req.params as { id: string }).id;
    const t = types()
      .flatMap((x) => x.aspects.map((y) => y.aspectType))
      .find((x) => x.id === id);
    return t
      ? { id: t.id, name: t.name, category: 'dynamic', scope: 'private', variables: t.variables }
      : reply.code(404).send({ errors: [{ message: 'not found' }] });
  });
  app.post('/ih/test/assetmanagement', async (req) => {
    const b = (req.body ?? {}) as Partial<Faults>;
    faults = { failWith: typeof b.failWith === 'number' ? b.failWith : null, failAfter: Number(b.failAfter ?? 0), omitVariables: !!b.omitVariables };
    calls = 0;
    return { ok: true };
  });
  app.get('/ih/test/assetmanagement/calls', async () => ({ calls }));
  app.post('/ih/test/assetmanagement/reset', async () => {
    faults = { failWith: null, failAfter: 0, omitVariables: false };
    calls = 0;
    return { ok: true };
  });
}
