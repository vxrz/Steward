import type { TicketStatus } from '@sm/shared';

/**
 * Extension point (not implemented): reading the status of a ticket from the
 * system it lives in, e.g. ServiceNow's Table API, instead of somebody copying
 * it by hand. See docs/TICKETS.md, "Status sync (later)".
 *
 * An adapter would be registered for one or more ticket sources and be called
 * by a periodic job for the open entries of those sources. Rules an
 * implementation must keep:
 *   - outbound calls go through the outbound/SSRF policy (platforms/outbound.ts)
 *     with credentials of a Steward platform, sent only to that platform's own
 *     origins – never to the entry's external URL;
 *   - it only reads; Steward never changes the ticket in the other system;
 *   - a status it reads is applied like a manual change (history event with the
 *     actor "system", audit entry) and counts as a check;
 *   - failures are logged and shown on the entry, never thrown into the job.
 */
export interface TicketStatusAdapter {
  /** Ticket sources (TicketSource.key) this adapter reads, e.g. ['servicenow-incident'] */
  sources: string[];
  /** The Steward platform whose connection and credentials are used */
  platformId: string;
  /**
   * The status in the other system mapped to a Steward status, or null when the
   * ticket was not found. `raw` is the other system's status text (kept in the
   * history for reference).
   */
  readStatus(
    ref: { source: string; externalNumber: string },
    signal: AbortSignal,
  ): Promise<{ status: TicketStatus; raw: string; resolvedAt?: string | null } | null>;
}
