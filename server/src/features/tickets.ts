import { ticketRoutes } from '../tickets/routes.js';
import { ticketApiRoutes } from '../tickets/api-v1.js';
import { ticketsSection } from '../tickets/report-section.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Ticket references: tickets of outside ticket systems linked to services, applications and runs. */
export default defineFeature({
  name: 'tickets',
  routes: [ticketRoutes],
  apiV1: [ticketApiRoutes],
  jobs: [
    // "not checked for N days" reminders (tickets/reminders.ts)
    every5Minutes('ticket-reminders', 5 * MINUTE, () => import('../tickets/reminders.js').then((m) => m.checkTicketReminders())),
  ],
  reportSections: [ticketsSection],
});
