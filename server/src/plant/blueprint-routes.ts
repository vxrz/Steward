import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BlueprintTargetKind } from '@sm/shared';
import { currentParams } from './ids.js';
import * as bp from './blueprints.js';

/**
 * Machine blueprints (0.30.0, ADR 0041): /api/plant/blueprints, and on device profiles and assets their blueprints, the
 * mapping of signals to data points and the not-applicable marks. Like the other plant routes they need the plant
 * registry module; the rights are decided per entry in the service (blueprints.ts): readers read, plant designers edit.
 */
const p = (req: FastifyRequest) => req.params as Record<string, string>;
const read = (req: FastifyRequest) => currentParams(req.params as Record<string, string>);

export async function blueprintRoutes(app: FastifyInstance): Promise<void> {
  app.get('/plant/blueprints', async () => bp.listBlueprints());
  app.post('/plant/blueprints', async (req, reply) => reply.code(201).send(bp.createBlueprint(bp.blueprintInput.parse(req.body))));
  app.get('/plant/blueprints/:blueprintId', async (req) => bp.getBlueprint(p(req).blueprintId!));
  app.put('/plant/blueprints/:blueprintId', async (req) => bp.updateBlueprint(p(req).blueprintId!, bp.blueprintUpdate.parse(req.body)));
  app.delete('/plant/blueprints/:blueprintId', async (req) => {
    bp.deleteBlueprint(p(req).blueprintId!);
    return { ok: true };
  });
  app.post('/plant/blueprints/:blueprintId/signals', async (req, reply) =>
    reply.code(201).send(bp.addSignal(p(req).blueprintId!, bp.signalInput.parse(req.body))),
  );
  app.put('/plant/blueprints/:blueprintId/signals/:signalId', async (req) =>
    bp.updateSignal(p(req).blueprintId!, p(req).signalId!, bp.signalUpdate.parse(req.body)),
  );
  app.delete('/plant/blueprints/:blueprintId/signals/:signalId', async (req) => bp.deleteSignal(p(req).blueprintId!, p(req).signalId!));

  // the same routes on a device profile and on an asset
  for (const [kind, seg, param] of [
    ['profile', 'profiles', 'profileId'],
    ['asset', 'assets', 'assetId'],
  ] as [BlueprintTargetKind, string, string][]) {
    const base = `/plant/${seg}/:${param}/blueprints`;
    const one = `${base}/:blueprintId`;
    const sig = `${one}/signals/:signalId`;
    const id = (req: FastifyRequest) => p(req)[param]!;
    app.get(base, async (req) => (kind === 'profile' ? bp.profileCoverage(read(req)[param]!) : bp.assetCoverage(read(req)[param]!)));
    app.put(one, async (req) => bp.assignBlueprint(kind, id(req), p(req).blueprintId!));
    app.delete(one, async (req) => bp.unassignBlueprint(kind, id(req), p(req).blueprintId!));
    app.put(`${sig}/mapping`, async (req) => bp.mapSignal(kind, id(req), p(req).blueprintId!, p(req).signalId!, bp.mappingInput.parse(req.body).dataPoints));
    app.post(`${sig}/mapping`, async (req) => bp.mapSignalAdd(kind, id(req), p(req).blueprintId!, p(req).signalId!, bp.mappingAdd.parse(req.body).dataPoint));
    app.delete(`${sig}/mapping`, async (req) => bp.mapSignal(kind, id(req), p(req).blueprintId!, p(req).signalId!, []));
    app.delete(`${sig}/mapping/:dataPointId`, async (req) =>
      bp.mapSignalRemove(kind, id(req), p(req).blueprintId!, p(req).signalId!, z.string().min(1).max(120).parse(p(req).dataPointId)),
    );
    app.put(`${sig}/not-applicable`, async (req) =>
      bp.markNotApplicable(kind, id(req), p(req).blueprintId!, p(req).signalId!, bp.markInput.parse(req.body).reason),
    );
    app.delete(`${sig}/not-applicable`, async (req) => bp.unmarkNotApplicable(kind, id(req), p(req).blueprintId!, p(req).signalId!));
  }
}
