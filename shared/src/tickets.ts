import type { ItemLink, LinkKind } from './records.js';

/**
 * Ticket references: lightweight documentation of tickets that live in other
 * systems – incidents users reported through ServiceNow, and tickets the team
 * opened with the vendors of platforms and services. Steward does not handle
 * the incident itself: it records that the ticket exists, who looks after it on
 * our side, its status and a link to it.
 */

/** Statuses (transitions are free – no workflow, no approval). */
export const TICKET_STATUSES = ['open', 'waitingVendor', 'waitingUs', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Statuses that count as "open" (lists, reminders, badges, reports). */
export const TICKET_OPEN_STATUSES: readonly TicketStatus[] = ['open', 'waitingVendor', 'waitingUs'];
export const isTicketOpen = (s: string): boolean => (TICKET_OPEN_STATUSES as readonly string[]).includes(s);

/** Kinds of Steward items a ticket can name as affected (stored in the generic link model). */
export const TICKET_LINK_KINDS = ['service', 'platform', 'credential', 'record', 'monitor', 'process'] as const satisfies readonly LinkKind[];
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];

/** A source of tickets (configurable by administrators). */
export interface TicketSource {
  /** Stable key, e.g. servicenow-incident (lower case, digits and dashes) */
  key: string;
  label: string;
  /** Tickets of this source are tickets with a vendor (counted in the "open vendor tickets" badge) */
  vendor: boolean;
}

export const DEFAULT_TICKET_SOURCES: TicketSource[] = [
  { key: 'servicenow-incident', label: 'ServiceNow incident', vendor: false },
  { key: 'servicenow-other', label: 'ServiceNow (other)', vendor: false },
  { key: 'vendor', label: 'Vendor ticket', vendor: true },
  { key: 'other', label: 'Other', vendor: false },
];
export const TICKET_SOURCE_KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;

export interface TicketSettings {
  sources: TicketSource[];
  /**
   * Default reminder: remind the responsible people when an open ticket was not
   * checked for this many days. null = no reminders unless an entry sets its own.
   */
  reminderDays: number | null;
}
export const DEFAULT_TICKET_SETTINGS: TicketSettings = { sources: DEFAULT_TICKET_SOURCES, reminderDays: null };

export type TicketPermission = 'edit' | 'delete';

export interface TicketReference {
  id: string;
  source: string;
  /** Label of the source (the key when the source was removed from the settings) */
  sourceLabel: string;
  /** The source is a vendor source */
  vendorSource: boolean;
  externalNumber: string;
  /** http(s) link to the ticket in the other system */
  externalUrl: string | null;
  title: string;
  /** Short note (Markdown, rendered safely) */
  note: string;
  /** Vendor (free text), e.g. "Siemens" */
  vendor: string;
  /** Responsible people on our side: user:<name>, team:<name> */
  responsible: string[];
  status: TicketStatus;
  openedAt: string;
  resolvedAt: string | null;
  lastCheckedAt: string | null;
  /**
   * Reminder for this entry: days without a check before the responsible people
   * are reminded; null = the global default; 0 = no reminders.
   */
  reminderDays: number | null;
  /** Effective reminder days (entry or default), null = off */
  effectiveReminderDays: number | null;
  /** Whole days since it was opened (until resolved, while it is resolved or closed) */
  ageDays: number;
  /** Affected Steward items */
  links: ItemLink[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  permissions: TicketPermission[];
  /** The signed-in user is one of the responsible people (directly or through a team) */
  responsibleMe: boolean;
}

export const TICKET_EVENT_KINDS = ['created', 'updated', 'status', 'checked', 'reminded'] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export interface TicketEvent {
  id: number;
  ts: string;
  actor: string;
  kind: TicketEventKind;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
  comment: string;
  details: Record<string, unknown>;
}

export interface TicketDetail extends TicketReference {
  events: TicketEvent[];
}

export interface TicketList {
  items: TicketReference[];
  /** The signed-in user may create entries */
  canCreate: boolean;
}

export const TICKET_LIMITS = { title: 300, number: 100, note: 20000, vendor: 120, comment: 2000, responsible: 20, links: 50 } as const;
