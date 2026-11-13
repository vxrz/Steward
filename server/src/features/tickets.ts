import { ticketRoutes } from '../tickets/routes.js';
import { ticketApiRoutes } from '../tickets/api-v1.js';
import { ticketsSection } from '../tickets/report-section.js';
import { TICKET_MIGRATIONS } from '../migrations/tickets.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';
import { ticketShareKind } from '../auth/item-shares.js';
import { ticketAccess } from '../tickets/service.js';

/** Ticket references: tickets of outside ticket systems linked to services, applications and runs. */
export default defineFeature({
  name: 'tickets',
  shareKinds: [ticketShareKind((u, r) => ticketAccess(u, r).permissions)],
  routes: [ticketRoutes],
  apiV1: [ticketApiRoutes],
  jobs: [
    // "not checked for N days" reminders (tickets/reminders.ts)
    every5Minutes('ticket-reminders', 5 * MINUTE, () => import('../tickets/reminders.js').then((m) => m.checkTicketReminders())),
  ],
  reportSections: [ticketsSection],
  migrations: [TICKET_MIGRATIONS],
});
