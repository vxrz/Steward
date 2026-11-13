import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATA_ENVIRONMENT_STATES, HEALTH_STATUSES, dataElementListQuery, dataObjectListQuery, dataProductListQuery } from '@sm/shared';
import { ACCESS, me } from '../auth/access.js';
import { healthOf } from './health.js';
import * as svc from './service.js';
import * as el from './elements.js';
import * as ports from './ports.js';
import * as steps from './steps.js';

/**
 * The data products module in the internal API (ADR 0036 part 19). Rights are checked in the services (a product, data
 * object, element or domain the caller may not see answers like a missing one); the module's switch in app.ts (404
 * MODULE_OFF while it is off). Retiring a product is session-only (the lifecycle route); widening – owners named from
 * outside the owning teams – asks for the access.grant step-up in the services.
 *
 *   GET|POST /api/data-domains, GET|PUT|DELETE /api/data-domains/:id
 *   GET|POST /api/data-objects, GET|PUT|DELETE /api/data-objects/:id, PUT …/:id/rating
 *   GET|POST /api/data-objects/:id/elements, DELETE …/elements/:elementId        elements that implement it
 *   GET|POST /api/data-products, GET|PUT|DELETE /api/data-products/:id, PUT …/:id/rating
 *   POST     /api/data-products/:id/lifecycle                                     proposed → draft → active → deprecated → retired
 *   PUT|DELETE /api/data-products/:id/environments/:environment
 *   GET|POST /api/data-products/:id/members, PUT|DELETE …/members/:elementId
 *   GET|POST /api/data-products/:id/ports, PUT|DELETE …/ports/:portId
 *   PUT|DELETE /api/data-products/:id/ports/:portId/bindings/:environment
 *   GET|POST /api/data-products/:id/ports/:portId/consumers, PUT|DELETE …/consumers/:consumerId
 *   GET|POST /api/data-products/:id/steps, PUT|DELETE …/steps/:stepId
 *   GET|POST /api/data-elements, GET|PUT|DELETE /api/data-elements/:id             the element catalogue
 */

const param = (req: FastifyRequest, name: string): string => {
  const v = (req.params as Record<string, unknown>)[name];
  return z.string().min(1).max(200).parse(v);
};
const idOf = (req: FastifyRequest) => param(req, 'id');

/** The product of the route, changeable by the caller (404 / 403 otherwise). */
const editable = (req: FastifyRequest) => svc.editableProduct(idOf(req)).row;

export async function dataProductRoutes(app: FastifyInstance): Promise<void> {
  // ---------- domains ----------
  app.get('/data-domains', async () => svc.listDomains());
  app.post('/data-domains', async (req) => svc.createDomain(req.body));
  app.get('/data-domains/:id', async (req) => svc.getDomain(idOf(req)));
  app.put('/data-domains/:id', async (req) => svc.updateDomain(idOf(req), req.body));
  app.delete('/data-domains/:id', async (req, reply) => {
    svc.deleteDomain(idOf(req));
    return reply.code(204).send();
  });

  // ---------- data objects ----------
  app.get('/data-objects', async (req) => svc.listObjects(dataObjectListQuery.parse(req.query)));
  app.post('/data-objects', async (req) => svc.createObject(req.body));
  app.get('/data-objects/:id', async (req) => svc.getObject(idOf(req)));
  app.put('/data-objects/:id', async (req) => svc.updateObject(idOf(req), req.body));
  app.delete('/data-objects/:id', async (req, reply) => {
    svc.deleteObject(idOf(req));
    return reply.code(204).send();
  });
  app.put('/data-objects/:id/rating', async (req) => svc.rateObject(idOf(req), req.body));
  app.get('/data-objects/:id/elements', async (req) => {
    const q = z.object({ cursor: z.string().max(2000).optional() }).parse(req.query);
    return el.objectElements(idOf(req), q.cursor);
  });
  app.post('/data-objects/:id/elements', async (req, reply) => {
    el.addObjectElement(idOf(req), req.body);
    return reply.code(204).send();
  });
  app.delete('/data-objects/:id/elements/:elementId', async (req, reply) => {
    el.removeObjectElement(idOf(req), param(req, 'elementId'));
    return reply.code(204).send();
  });

  // ---------- products ----------
  app.get('/data-products', async (req) => {
    const q = dataProductListQuery.parse(req.query);
    // ?health=: the products in that health (in ?environment=, else each one's default) – among those the reader may see
    const health = z
      .string()
      .refine((s) => (HEALTH_STATUSES as readonly string[]).includes(s))
      .optional()
      .parse((req.query as Record<string, unknown> | undefined)?.health);
    if (!health) return svc.listProducts(q);
    return svc.listProducts(q, (ids) => {
      const keep = new Set<string>();
      for (let i = 0; i < ids.length; i += 500)
        for (const [id, h] of healthOf(me(), ids.slice(i, i + 500), q.environment ?? null)) if (h.status === health) keep.add(id);
      return keep;
    });
  });
  app.post('/data-products', async (req) => svc.createProduct(req.body));
  app.get('/data-products/:id', async (req) => svc.getProduct(idOf(req)));
  app.put('/data-products/:id', async (req) => svc.updateProduct(idOf(req), req.body));
  app.delete('/data-products/:id', async (req, reply) => {
    svc.deleteProduct(idOf(req));
    return reply.code(204).send();
  });
  app.put('/data-products/:id/rating', async (req) => svc.rateProduct(idOf(req), req.body));
  // retiring is session-only (ADR 0036 security notes); the other states, too, so one route has one rule
  app.post('/data-products/:id/lifecycle', { config: { access: ACCESS.session } }, async (req) => svc.changeLifecycle(idOf(req), req.body));
  app.put('/data-products/:id/environments/:environment', async (req) => {
    const b = z
      .object({ state: z.enum(DATA_ENVIRONMENT_STATES).default('planned') })
      .strict()
      .parse(req.body ?? {});
    return svc.setEnvironment(idOf(req), param(req, 'environment'), b.state);
  });
  app.delete('/data-products/:id/environments/:environment', async (req) => svc.removeEnvironment(idOf(req), param(req, 'environment')));

  // members
  app.get('/data-products/:id/members', async (req) => {
    svc.visibleProduct(idOf(req));
    return el.listMembers(idOf(req), req.query);
  });
  app.post('/data-products/:id/members', async (req) => {
    const p = editable(req);
    const r = el.addMembers(p.id, p.name, req.body);
    svc.touchProduct(p.id);
    return r;
  });
  app.put('/data-products/:id/members/:elementId', async (req) => {
    const p = editable(req);
    return el.updateMember(p.id, p.name, param(req, 'elementId'), req.body);
  });
  app.delete('/data-products/:id/members/:elementId', async (req, reply) => {
    const p = editable(req);
    el.removeMember(p.id, p.name, param(req, 'elementId'));
    svc.touchProduct(p.id);
    return reply.code(204).send();
  });

  // ports, bindings, consumers
  app.get('/data-products/:id/ports', async (req) => {
    const { row } = svc.visibleProduct(idOf(req));
    return ports.portViews(me(), row.id);
  });
  app.post('/data-products/:id/ports', async (req) => {
    const p = editable(req);
    const r = ports.addPort(p.id, p.name, req.body);
    svc.touchProduct(p.id);
    return r;
  });
  app.put('/data-products/:id/ports/:portId', async (req) => {
    const p = editable(req);
    const r = ports.updatePort(p.id, p.name, param(req, 'portId'), req.body);
    svc.touchProduct(p.id);
    return r;
  });
  app.delete('/data-products/:id/ports/:portId', async (req, reply) => {
    const p = editable(req);
    ports.deletePort(p.id, p.name, param(req, 'portId'));
    svc.touchProduct(p.id);
    return reply.code(204).send();
  });
  app.put('/data-products/:id/ports/:portId/bindings/:environment', async (req) => {
    const p = editable(req);
    const r = ports.setBinding(p.id, p.name, param(req, 'portId'), param(req, 'environment'), req.body);
    svc.touchProduct(p.id);
    return r;
  });
  app.delete('/data-products/:id/ports/:portId/bindings/:environment', async (req) => {
    const p = editable(req);
    const r = ports.removeBinding(p.id, p.name, param(req, 'portId'), param(req, 'environment'));
    svc.touchProduct(p.id);
    return r;
  });
  app.get('/data-products/:id/ports/:portId/consumers', async (req) => {
    const { row } = svc.visibleProduct(idOf(req));
    return ports.listConsumers(row.id, param(req, 'portId'));
  });
  app.post('/data-products/:id/ports/:portId/consumers', async (req) => {
    const p = editable(req);
    return ports.addConsumer(p.id, p.name, param(req, 'portId'), req.body);
  });
  app.put('/data-products/:id/ports/:portId/consumers/:consumerId', async (req) => {
    const p = editable(req);
    return ports.updateConsumer(p.id, p.name, param(req, 'portId'), param(req, 'consumerId'), req.body);
  });
  app.delete('/data-products/:id/ports/:portId/consumers/:consumerId', async (req, reply) => {
    const p = editable(req);
    ports.removeConsumer(p.id, p.name, param(req, 'portId'), param(req, 'consumerId'));
    return reply.code(204).send();
  });

  // steps (the pipeline: documentation, never run)
  app.get('/data-products/:id/steps', async (req) => {
    const { row } = svc.visibleProduct(idOf(req));
    return steps.productSteps(row.id);
  });
  app.post('/data-products/:id/steps', async (req) => {
    const p = editable(req);
    return steps.createStep(p.id, p.name, req.body);
  });
  app.put('/data-products/:id/steps/:stepId', async (req) => {
    const { row } = svc.visibleProduct(idOf(req));
    return steps.updateStep(row.id, row.name, param(req, 'stepId'), req.body);
  });
  app.delete('/data-products/:id/steps/:stepId', async (req, reply) => {
    const { row } = svc.visibleProduct(idOf(req));
    steps.deleteStep(row.id, row.name, param(req, 'stepId'));
    return reply.code(204).send();
  });

  // ---------- the element catalogue ----------
  app.get('/data-elements', async (req) => el.listElements(dataElementListQuery.parse(req.query)));
  app.post('/data-elements', async (req) => el.createElement(req.body));
  app.get('/data-elements/:id', async (req) => el.getElement(idOf(req)));
  app.put('/data-elements/:id', async (req) => el.updateElement(idOf(req), req.body));
  app.delete('/data-elements/:id', async (req, reply) => {
    el.deleteElement(idOf(req));
    return reply.code(204).send();
  });
}
