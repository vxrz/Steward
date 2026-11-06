import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATA_CONTRACT_LIMITS, dataContractTestInput, dataContractYamlInput } from '@sm/shared';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { contentDisposition } from '../records/attachments.js';
import * as svc from './service.js';
import { draftContract } from './draft.js';
import { lintWithService, runContractTest } from './testing.js';

/**
 * Data contracts (0.9.0, #221, docs/DATA-CONTRACTS.md) in the internal API. Rights are checked in the service (view,
 * test, edit per contract; a hidden contract answers 404 like a missing one).
 *
 *   GET    /api/data-contracts                                  the contracts the caller may see
 *   POST   /api/data-contracts                                  create (designers, administrators)
 *   POST   /api/data-contracts/check                            parse and lint a text (the editor, before a contract exists)
 *   POST   /api/data-contracts/draft                            a draft from an OpenAPI response, a recording, a dataset, tables
 *   POST   /api/data-contracts/import                           a YAML file: a new version of the caller's contract with its id, or a new one
 *   GET    /api/data-contracts/:id                              the current version, lint, links, Steward's own findings
 *   DELETE /api/data-contracts/:id
 *   PUT    /api/data-contracts/:id/settings                     the service, the server to test, "breaking change needs a change record"
 *   POST   /api/data-contracts/:id/check                        a text against the current version (lint, changes)
 *   GET|POST /api/data-contracts/:id/versions                   the versions; save a new one
 *   GET    /api/data-contracts/:id/versions/:version
 *   GET    /api/data-contracts/:id/compare?from=&to=            the changes between two versions
 *   GET    /api/data-contracts/:id/export?version=              the YAML file
 *   POST   /api/data-contracts/:id/links, DELETE …/links/:linkId
 *   POST   /api/data-contracts/:id/test                         run the test through the data contract service
 *   POST   /api/data-contracts/:id/service-lint                 the CLI's own lint
 *   GET    /api/data-contracts/:id/runs, GET …/runs/:runId      test runs (the run with its full report)
 */

const idOf = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(100) }).parse(req.params).id;
const yaml = { bodyLimit: LARGE_BODIES.dataContracts.bytes };
const heavy = { config: { rateLimit: ROUTE_LIMITS.heavy } };

export async function dataContractRoutes(app: FastifyInstance): Promise<void> {
  app.get('/data-contracts', async () => svc.listContracts());
  app.post('/data-contracts', yaml, async (req) => svc.createContract(req.body));
  app.post('/data-contracts/check', yaml, async (req) => svc.previewVersion(null, dataContractYamlInput.parse(req.body).yaml));
  app.post('/data-contracts/draft', heavy, async (req) => draftContract(req.body));
  app.post('/data-contracts/import', yaml, async (req) => svc.importContract(req.body));
  app.get('/data-contracts/:id', async (req) => svc.getContract(idOf(req)));
  app.delete('/data-contracts/:id', async (req, reply) => {
    svc.deleteContract(idOf(req));
    return reply.code(204).send();
  });
  app.put('/data-contracts/:id/settings', async (req) => svc.setSettings(idOf(req), req.body));
  app.post('/data-contracts/:id/check', yaml, async (req) => svc.previewVersion(idOf(req), dataContractYamlInput.parse(req.body).yaml));
  app.get('/data-contracts/:id/versions', async (req) => svc.listVersions(idOf(req)));
  app.post('/data-contracts/:id/versions', yaml, async (req) => svc.saveVersion(idOf(req), req.body));
  app.get('/data-contracts/:id/versions/:version', async (req) => {
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(req.params);
    return svc.getVersion(idOf(req), version);
  });
  app.get('/data-contracts/:id/compare', async (req) => {
    const q = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }).parse(req.query);
    return svc.compareVersions(idOf(req), q.from, q.to);
  });
  app.get('/data-contracts/:id/export', async (req, reply) => {
    const q = z.object({ version: z.coerce.number().int().min(1).optional() }).parse(req.query);
    const f = svc.exportYaml(idOf(req), q.version);
    reply.header('content-disposition', contentDisposition(f.fileName));
    return reply.type('application/yaml; charset=utf-8').send(f.body);
  });
  app.post('/data-contracts/:id/links', async (req) => svc.addLink(idOf(req), req.body));
  app.delete('/data-contracts/:id/links/:linkId', async (req, reply) => {
    const { linkId } = z.object({ linkId: z.string().min(1).max(100) }).parse(req.params);
    svc.deleteLink(idOf(req), linkId);
    return reply.code(204).send();
  });
  app.post('/data-contracts/:id/test', heavy, async (req) => {
    const input = dataContractTestInput.parse(req.body ?? {});
    return runContractTest(idOf(req), { via: 'ui', server: input.server });
  });
  app.post('/data-contracts/:id/service-lint', { ...heavy, ...yaml }, async (req) => {
    const body = z
      .object({ yaml: z.string().min(1).max(DATA_CONTRACT_LIMITS.yamlBytes).optional() })
      .strict()
      .parse(req.body ?? {});
    return { findings: await lintWithService(idOf(req), body.yaml) };
  });
  app.get('/data-contracts/:id/runs', async (req) => svc.listRuns(idOf(req)));
  app.get('/data-contracts/:id/runs/:runId', async (req) => {
    const { runId } = z.object({ runId: z.string().min(1).max(100) }).parse(req.params);
    return svc.getRun(idOf(req), runId);
  });
}
