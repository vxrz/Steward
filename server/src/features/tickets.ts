import { ticketsSection } from '../tickets/report-section.js';
import { defineFeature } from './define.js';

/** Ticket references: tickets of outside ticket systems linked to services, applications and runs. */
export default defineFeature({
  name: 'tickets',
  reportSections: [ticketsSection],
});
