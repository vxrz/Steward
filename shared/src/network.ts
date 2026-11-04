import type { RecordFieldDef, RecordTableColumn, RecordTypeDefinition, ReviewStatus } from './records.js';

/**
 * Network segments and audit-proof firewall changes (#208). Opt-in documentation, not a CMDB: only the segments
 * (shopfloor IoT VLANs, rVLANs behind a firewall) and systems (servers a provider manages) that need it carry network
 * data. Nothing is required; systems in a cloud need none at all.
 *
 * - A system of kind `network` ("Network segment") has optional attributes: VLAN ID, subnets (CIDR, format-checked
 *   only), zone or security level, site and who manages its firewall.
 * - Any system can be "in segment": a link to a network segment with an optional address (IP or host name) and a note.
 * - Firewall changes (record type FWC, change workflow) list their rule lines in a table field; closing one updates
 *   the "Approved firewall rules" living document (FWR) of each affected segment or system.
 */

// ---------- attributes of a network segment ----------

/** Who manages the firewall of a segment: the own team or a provider (named in firewallProvider). */
export const FIREWALL_MANAGERS = ['team', 'provider'] as const;
export type FirewallManager = (typeof FIREWALL_MANAGERS)[number];

export const NETWORK_LIMITS = {
  subnets: 32,
  zone: 120,
  site: 120,
  provider: 120,
  /** An address of a system in a segment: an IP address or a host name (253 characters at most, as DNS) */
  address: 253,
  note: 500,
  /** Segments one system can be in */
  segmentsPerSystem: 20,
} as const;

/** The attributes of a system of kind "network" (all optional). */
export interface NetworkAttributes {
  /** 802.1Q VLAN ID (1–4094); null: none or not known */
  vlanId: number | null;
  /** Subnets in CIDR notation, IPv4 or IPv6 (format-checked only, no overlap checks) */
  subnets: string[];
  /** Zone or security level, e.g. an IEC 62443 zone ("Zone 2 – cell", "SL 2") */
  zone: string;
  site: string;
  /** Who manages the firewall of the segment (null: not said) */
  firewallManagedBy: FirewallManager | null;
  /** The provider when a provider manages it */
  firewallProvider: string;
}

export const EMPTY_NETWORK_ATTRIBUTES: NetworkAttributes = {
  vlanId: null,
  subnets: [],
  zone: '',
  site: '',
  firewallManagedBy: null,
  firewallProvider: '',
};

/**
 * Attributes of a system, by its kind: a network segment has the network attributes (all keys present), every other
 * kind none (an empty object).
 */
export type SystemAttributes = Partial<NetworkAttributes>;

// ---------- format checks (no lookups, no overlap checks) ----------

const IPV4_PART = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`);

export const isIpv4 = (s: string): boolean => IPV4_RE.test(s);

/** An IPv6 address (RFC 4291 text forms, with "::" and an IPv4 tail; no zone index). */
export function isIpv6(s: string): boolean {
  if (!s || s.length > 45 || !/^[0-9a-fA-F:.]+$/.test(s)) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | null => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return false;
  const all = [...head, ...tail];
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const g = all[i]!;
    // an IPv4 tail counts as two groups and may only come last
    if (g.includes('.')) {
      if (i !== all.length - 1 || !isIpv4(g)) return false;
      count += 2;
    } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) count += 1;
    else return false;
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

export const isIpAddress = (s: string): boolean => isIpv4(s) || isIpv6(s);

/** A subnet in CIDR notation: an IPv4 address with /0–32 or an IPv6 address with /0–128. */
export function isCidr(s: string): boolean {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(s);
  if (!m) return false;
  const bits = Number(m[2]);
  if (m[2]!.length > 1 && m[2]!.startsWith('0')) return false;
  if (isIpv4(m[1]!)) return bits <= 32;
  if (isIpv6(m[1]!)) return bits <= 128;
  return false;
}

/** A DNS host name (RFC 1123 labels, a trailing dot allowed): letters, digits and hyphens, 63 characters per label. */
export function isHostName(s: string): boolean {
  const name = s.endsWith('.') ? s.slice(0, -1) : s;
  if (!name || name.length > NETWORK_LIMITS.address) return false;
  // all digits and dots would be a (wrong) IPv4 address, not a name
  if (/^[\d.]+$/.test(name)) return false;
  return name.split('.').every((l) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l));
}

/** An address of a system in a segment: an IP address (v4 or v6) or a host name. */
export const isNetworkAddress = (s: string): boolean => isIpAddress(s) || isHostName(s);

// ---------- systems in segments ----------

/** A segment a system is in (the system page), with the system's address there. */
export interface SystemSegmentLink {
  id: string;
  segmentId: string;
  segmentName: string;
  vlanId: number | null;
  subnets: string[];
  zone: string;
  /** IP address or host name of the system in the segment (empty: not documented) */
  address: string;
  note: string;
  createdAt: string;
  createdBy: string;
}

/** A system in a segment (the segment's page). Systems the reader may not see are left out. */
export interface SegmentMember {
  linkId: string;
  systemId: string;
  name: string;
  kind: string;
  address: string;
  note: string;
}

// ---------- the "Firewall & network" panel ----------

/** An "Approved firewall rules" document of a segment or system (the reader may read it). */
export interface FirewallRulesDocument {
  id: string;
  number: string;
  title: string;
  status: string;
  /** The edition valid now (null: not approved yet) */
  edition: string | null;
  reviewStatus: ReviewStatus;
  nextReviewAt: string | null;
  daysLeft: number | null;
  /** Rule lines of the edition valid now (or of the draft before the first approval) */
  rules: Record<string, string>[];
  /** A new edition waits for approval (in review) or is being drafted (revising) */
  pending: boolean;
}

/** A firewall change (FWC) that names the segment or system. */
export interface FirewallChangeRef {
  id: string;
  number: string;
  title: string;
  status: string;
  /** Closed or cancelled */
  done: boolean;
  implementer: string | null;
  providerTicket: string | null;
  /** Rule lines of the change */
  ruleCount: number;
  updatedAt: string;
}

/** A ticket reference that names the segment or system as affected (e.g. the provider's change ticket). */
export interface FirewallTicketRef {
  id: string;
  source: string;
  sourceLabel: string;
  externalNumber: string;
  externalUrl: string | null;
  title: string;
  status: string;
}

export interface SystemFirewall {
  documents: FirewallRulesDocument[];
  changes: FirewallChangeRef[];
  tickets: FirewallTicketRef[];
}

// ---------- the record types FWC and FWR ----------

/** Fixed ids of the built-in types (created in every installation, also existing ones). */
export const FIREWALL_TYPE_ID = 'rty_fwc';
export const FIREWALL_TYPE_KEY = 'FWC';
export const FIREWALL_RULES_TYPE_ID = 'rty_fwr';
export const FIREWALL_RULES_TYPE_KEY = 'FWR';

/** Where a rule is enforced. */
export const FIREWALL_ENFORCEMENT = ['perimeter', 'host', 'cloud'] as const;
export const FIREWALL_ACTIONS = ['allow', 'deny'] as const;
/** What a rule line of a change does to the approved rules. */
export const FIREWALL_RULE_CHANGES = ['add', 'remove'] as const;
export type FirewallRuleChange = (typeof FIREWALL_RULE_CHANGES)[number];

/** The columns that describe a rule (both types). */
const RULE_COLUMNS: RecordTableColumn[] = [
  { key: 'source', label: 'Source', kind: 'text', required: true },
  { key: 'destination', label: 'Destination', kind: 'text', required: true },
  { key: 'service', label: 'Protocol/port', kind: 'text', required: true },
  { key: 'action', label: 'Action', kind: 'select', options: [...FIREWALL_ACTIONS], required: true },
  { key: 'enforcedAt', label: 'Enforced at', kind: 'select', options: [...FIREWALL_ENFORCEMENT], required: true },
  { key: 'purpose', label: 'Purpose', kind: 'text', required: true },
  { key: 'expiry', label: 'Expiry', kind: 'date' },
];

/** The rule lines of a firewall change: what each line does (add or remove) and the rule. */
export const FIREWALL_CHANGE_COLUMNS: RecordTableColumn[] = [
  { key: 'change', label: 'Change', kind: 'select', options: [...FIREWALL_RULE_CHANGES], required: true },
  ...RULE_COLUMNS,
];

/** The approved rules: the rule and the firewall change that approved it. */
export const FIREWALL_RULES_COLUMNS: RecordTableColumn[] = [...RULE_COLUMNS, { key: 'approvedBy', label: 'Approved by change', kind: 'text' }];

/** The columns that identify a rule: a line of a change with the same values changes or removes it. */
export const FIREWALL_RULE_IDENTITY = ['source', 'destination', 'service', 'enforcedAt'] as const;

const FIREWALL_CHANGE_FIELDS: RecordFieldDef[] = [
  { key: 'reason', label: 'Reason', kind: 'textarea', required: true },
  { key: 'risk', label: 'Risk', kind: 'select', options: ['low', 'medium', 'high'], required: true },
  { key: 'implementer', label: 'Implemented by', kind: 'select', options: ['internal', 'provider'], required: true },
  { key: 'provider', label: 'Provider', kind: 'text', help: 'The provider who implements the change, if any' },
  {
    key: 'providerTicket',
    label: 'Provider ticket',
    kind: 'text',
    help: "The provider's ticket number; add the ticket as a ticket reference that names this change too",
  },
  // the maintenance window, under the keys of change requests (so reports list it with the change windows)
  { key: 'plannedStart', label: 'Planned start', kind: 'datetime' },
  { key: 'plannedEnd', label: 'Planned end', kind: 'datetime' },
  { key: 'rollbackPlan', label: 'Rollback plan', kind: 'textarea' },
  { key: 'rules', label: 'Rules', kind: 'table', required: true, columns: FIREWALL_CHANGE_COLUMNS },
];

export const FIREWALL_RECORD_TYPE: RecordTypeDefinition = {
  key: FIREWALL_TYPE_KEY,
  name: 'Firewall change',
  description:
    'A change of firewall rules for a network segment or a system: who asked for it and why, the rule lines, who implements it (the own team or a provider) and the evidence. Approved and verified by people other than the requester and the implementer; closing it updates the approved rules.',
  workflow: 'change',
  template:
    '## Affected segments and systems\n\nLink them under Links (note: affected).\n\n## Description\n\n\n## Implementation\n\n1. \n\n## Verification\n\n',
  fields: FIREWALL_CHANGE_FIELDS,
};

export const FIREWALL_RULES_RECORD_TYPE: RecordTypeDefinition = {
  key: FIREWALL_RULES_TYPE_KEY,
  name: 'Approved firewall rules',
  description:
    'The approved firewall rules of a network segment or system. Each closed firewall change drafts the next edition, which an approver confirms; the rules are recertified once a year.',
  workflow: 'document',
  template: '## Scope\n\n\n## Notes\n\n',
  fields: [{ key: 'approvedRules', label: 'Approved rules', kind: 'table', columns: FIREWALL_RULES_COLUMNS }],
  reviewIntervalMonths: 12,
};
