import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TICKET_LINK_KINDS, TICKET_STATUSES, type TicketList } from '@sm/shared';
import { currentUser } from '../auth/context.js';
import { HttpError } from '../util.js';
import * as svc from './service.js';

/**
 * Ticket references (mounted under /api). Every route checks permissions in the service.
 *   GET    /ticket-references                 list (filters: q, status, state, source, vendor, link, responsible, minAgeDays)
 *   GET    /ticket-references/settings        sources and the reminder default; PUT: administrators
 *   GET    /ticket-references/vendors         vendors of earlier entries (suggestions)
 *   GET    /ticket-references/open-counts     open tickets per affected item of a kind (?kind=service&vendorOnly=1)
 *   POST   /ticket-references                 create
 *   GET    /ticket-references/:id             entry with history
 *   PUT    /ticket-references/:id             update
 *   POST   /ticket-references/:id/status      change the status {status, comment?, resolvedAt?}
 *   POST   /ticket-references/:id/checked     mark checked {comment?}
 *   DELETE /ticket-references/:id             administrators
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const signedIn = () => {
  if (!currentUser()) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
};

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === '') return undefined;
  return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
};

export const ticketListQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.preprocess(list, z.array(z.enum(TICKET_STATUSES)).max(5).optional()),
  state: z.enum(['open', 'closed', 'all']).optional(),
  source: z.preprocess(list, z.array(z.string().max(40)).max(30).optional()),
  vendor: z.string().max(120).optional(),
  link: z
    .string()
    .max(240)
    .regex(/^[a-z]+:.+$/, 'use kind:id, e.g. service:svc_123')
    .optional(),
  responsible: z.string().max(130).optional(),
  minAgeDays: z.coerce.number().int().min(0).max(3650).optional(),
  waitingOn: z.enum(['vendor']).optional(),
});

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ticket-references', async (req): Promise<TicketList> => {
    signedIn();
    const q = ticketListQuery.parse(req.query ?? {});
    return { items: svc.listTickets(q), canCreate: svc.canCreateTickets() };
  });

  app.get('/ticket-references/settings', async () => {
    signedIn();
    return svc.ticketSettings();
  });
  app.put('/ticket-references/settings', async (req) => svc.saveTicketSettings(svc.ticketSettingsSchema.parse(req.body ?? {})));

  app.get('/ticket-references/vendors', async () => svc.vendorSuggestions());

  app.get('/ticket-references/open-counts', async (req) => {
    const q = z
      .object({ kind: z.enum(TICKET_LINK_KINDS), vendorOnly: z.enum(['0', '1']).default('0') })
      .strict()
      .parse(req.query ?? {});
    return svc.openCounts(q.kind, q.vendorOnly === '1');
  });

  app.post('/ticket-references', async (req) => svc.createTicket(svc.ticketInputSchema.parse(req.body ?? {})));
  app.get('/ticket-references/:id', async (req) => svc.getTicket(params(req).id!));
  app.put('/ticket-references/:id', async (req) => svc.updateTicket(params(req).id!, svc.ticketInputSchema.parse(req.body ?? {})));
  app.post('/ticket-references/:id/status', async (req) => svc.setStatus(params(req).id!, svc.statusSchema.parse(req.body ?? {})));
  app.post('/ticket-references/:id/checked', async (req) => svc.markChecked(params(req).id!, svc.checkedSchema.parse(req.body ?? {})));
  app.delete('/ticket-references/:id', async (req) => {
    svc.deleteTicket(params(req).id!);
    return { ok: true };
  });
}
