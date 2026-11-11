import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CA_SEVERITIES, CA_SOURCES, CA_STATUSES, CA_SUGGESTION_STATUSES, caReasonInput } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { params } from '../routes/params.js';
import * as ca from './corrective.js';
import * as sug from './corrective-sources.js';

/**
 * The register of corrective actions in the web app (ADR 0029 part 3; Compliance module). Reading also works with an
 * API token; every change is a decision of a person in a session in the app (ADR 0029 decision 9), so the changing
 * routes refuse API tokens. Rights on single findings are checked in corrective.ts.
 */

const list = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(values as [T, ...T[]])).optional());

const session = { config: { access: ACCESS.session } };

export async function correctiveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/compliance/corrective-actions', async (req) => {
    const q = z
      .object({
        state: z.enum(['open', 'closed', 'all']).default('all'),
        status: list(CA_STATUSES),
        source: list(CA_SOURCES),
        severity: list(CA_SEVERITIES),
        serviceId: z.string().max(100).optional(),
        supplierId: z.string().max(100).optional(),
        controlId: z.string().max(100).optional(),
        overdue: z.enum(['true', 'false']).optional(),
        owner: z.string().max(130).optional(),
        q: z.string().max(200).optional(),
      })
      .parse(req.query);
    return sug.listRegister({ ...q, overdue: q.overdue === undefined ? undefined : q.overdue === 'true' });
  });
  app.post('/compliance/corrective-actions', session, async (req) => ca.createFinding(req.body as never));
  app.get('/compliance/corrective-actions/:findingId', async (req) => ca.getFinding(params(req).findingId!));
  app.put('/compliance/corrective-actions/:findingId', session, async (req) => ca.updateFinding(params(req).findingId!, req.body as never));
  app.post('/compliance/corrective-actions/:findingId/actions', session, async (req) => ca.addAction(params(req).findingId!, req.body as never));
  app.put('/compliance/corrective-actions/:findingId/actions/:actionId', session, async (req) =>
    ca.updateAction(params(req).findingId!, params(req).actionId!, req.body as never),
  );
  app.delete('/compliance/corrective-actions/:findingId/actions/:actionId', session, async (req) =>
    ca.deleteAction(params(req).findingId!, params(req).actionId!),
  );
  app.post('/compliance/corrective-actions/:findingId/effectiveness', session, async (req) => ca.checkEffectiveness(params(req).findingId!, req.body as never));
  app.post('/compliance/corrective-actions/:findingId/cancel', session, async (req) =>
    ca.cancelFinding(params(req).findingId!, caReasonInput.parse(req.body).reason),
  );

  app.get('/compliance/corrective-suggestions', async (req) => {
    const q = z.object({ status: z.enum([...CA_SUGGESTION_STATUSES, 'all']).default('pending') }).parse(req.query);
    return sug.listSuggestions(q.status);
  });
  app.post('/compliance/corrective-suggestions/:suggestionId/confirm', session, async (req) =>
    sug.confirmSuggestion(params(req).suggestionId!, (req.body ?? {}) as never),
  );
  app.post('/compliance/corrective-suggestions/:suggestionId/dismiss', session, async (req) =>
    sug.dismissSuggestion(params(req).suggestionId!, caReasonInput.parse(req.body).reason),
  );

  app.get('/compliance/corrective-settings', async () => sug.getSettings());
  app.put('/compliance/corrective-settings', session, async (req) => sug.updateSettings(req.body as never));
}
