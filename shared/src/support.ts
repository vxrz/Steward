import { z } from 'zod';

/**
 * Support channels, support levels and guides (0.26.0, ADR 0039 parts 4–6, docs/SUPPORT.md): where the consumers of a
 * data product and the users of a service or application ask, report a problem and find documentation, and what support
 * the providing team promises. Documentation – Steward is not a help desk and does not measure a level.
 *
 * - A **channel** has a purpose, a tool, a name, an address (`https://` – `http://` for internal pages –, `mailto:`, `tel:`), hours and a note (the
 *   queue or assignment group to use). Channels name shared addresses, not people: people are contacts (ADR 0038).
 * - A **support level** is an entry of the administrators' catalogue (_Settings → Support levels_): a name in English
 *   and German, hours, one first-response time as text, a note and optionally the address of the SLA document. An item
 *   picks one. Criticality stays separate: it says how bad an outage is, the level what support is promised.
 * - A **guide** is where the consumers of a data product find a guide or documentation: a title and an external address.
 * - A data product can name the **service that supports it**: it shows that service's channels and level, marked as
 *   such, unless it names its own – for readers who may see the service.
 */

export const SUPPORT_ITEM_KINDS = ['data_product', 'service', 'application'] as const;
export type SupportItemKind = (typeof SUPPORT_ITEM_KINDS)[number];

/** What a channel is for (ODPS `scope`: questions → interactive, issues → issues, announcements → announcements). */
export const SUPPORT_PURPOSES = ['questions', 'issues', 'announcements', 'access'] as const;
export type SupportPurpose = (typeof SUPPORT_PURPOSES)[number];

/** The tool behind a channel (ODPS `tool`). */
export const SUPPORT_TOOLS = ['ticket', 'email', 'teams', 'slack', 'web', 'phone', 'other'] as const;
export type SupportTool = (typeof SUPPORT_TOOLS)[number];

export const SUPPORT_LIMITS = {
  /** Channels per item */
  channels: 20,
  /** Guides per item */
  guides: 30,
  /** Entries of the support level catalogue */
  levels: 50,
  name: 200,
  address: 2000,
  hours: 200,
  firstResponse: 120,
  note: 1000,
  levelNote: 2000,
  title: 200,
  url: 2000,
} as const;

/**
 * A channel's address: a web address (`https://`; `http://` is taken for internal pages), an e-mail address
 * (`mailto:`) or a telephone number (`tel:`).
 */
export const SUPPORT_ADDRESS_RE = /^(?:https?:\/\/[^\s/?#]+\S*|mailto:[^\s@]+@[^\s@]+|tel:\+?[0-9][0-9 ()./-]{2,39})$/i;
/** An external web address (guides, the SLA document). */
export const SUPPORT_URL_RE = /^https?:\/\/[^\s/?#]+\S*$/i;

/** Whether an address is acceptable for a channel ('' is: a channel may have only a name). */
export const isSupportAddress = (v: string): boolean => v === '' || SUPPORT_ADDRESS_RE.test(v.trim());
export const isSupportUrl = (v: string): boolean => SUPPORT_URL_RE.test(v.trim());

/** The tool a channel's address suggests (the upgrade's rule: `mailto:` → e-mail, `tel:` → phone, else other). */
export function toolOfAddress(address: string): SupportTool {
  const a = address.trim().toLowerCase();
  if (a.startsWith('mailto:')) return 'email';
  if (a.startsWith('tel:')) return 'phone';
  return 'other';
}

// ---------- inputs ----------

const text = (max: number) => z.string().trim().max(max);

export const supportChannelInput = z
  .object({
    purpose: z.enum(SUPPORT_PURPOSES),
    tool: z.enum(SUPPORT_TOOLS),
    name: text(SUPPORT_LIMITS.name).default(''),
    address: text(SUPPORT_LIMITS.address).refine(isSupportAddress, 'an https:// (or http://), mailto: or tel: address').default(''),
    hours: text(SUPPORT_LIMITS.hours).default(''),
    note: text(SUPPORT_LIMITS.note).default(''),
  })
  .strict()
  // a name or an address; hours alone are taken too – the upgrade made such a channel of a product's support hours of
  // before 0.26.0 (0.25 took hours without a channel), and the file format and the API must take back what they give
  .refine((c) => !!(c.name || c.address || c.hours), { message: 'Give the channel a name or an address', path: ['address'] });
export type SupportChannelInput = z.input<typeof supportChannelInput>;

export const guideInput = z
  .object({
    title: z.string().trim().min(1).max(SUPPORT_LIMITS.title),
    url: text(SUPPORT_LIMITS.url).refine(isSupportUrl, 'an https:// address'),
  })
  .strict();
export type GuideInput = z.input<typeof guideInput>;

/**
 * The support of an item (PUT …/support): its channels in their order, its level, its guides (data products) and the
 * service that supports it (data products). A key left out keeps what the item has.
 */
export const itemSupportInput = z
  .object({
    channels: z.array(supportChannelInput).max(SUPPORT_LIMITS.channels).optional(),
    levelId: z.string().trim().min(1).max(100).nullable().optional(),
    guides: z.array(guideInput).max(SUPPORT_LIMITS.guides).optional(),
    supportedByServiceId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
export type ItemSupportInput = z.input<typeof itemSupportInput>;

export const supportLevelInput = z
  .object({
    nameEn: z.string().trim().min(1).max(SUPPORT_LIMITS.name),
    nameDe: text(SUPPORT_LIMITS.name).default(''),
    hours: text(SUPPORT_LIMITS.hours).default(''),
    firstResponse: text(SUPPORT_LIMITS.firstResponse).default(''),
    note: text(SUPPORT_LIMITS.levelNote).default(''),
    slaUrl: z.union([text(SUPPORT_LIMITS.url).refine(isSupportUrl, 'an https:// address'), z.literal('')]).default(''),
  })
  .strict();
export type SupportLevelInput = z.input<typeof supportLevelInput>;

/** The order of the catalogue (PUT /api/support/levels/order): every level's id once. */
export const supportLevelOrderInput = z.object({ ids: z.array(z.string().min(1).max(100)).max(SUPPORT_LIMITS.levels) }).strict();

// ---------- what the API returns ----------

export interface SupportChannel {
  id: string;
  purpose: SupportPurpose;
  tool: SupportTool;
  name: string;
  address: string;
  hours: string;
  note: string;
}

/** A level as an item shows it: what it promises. */
export interface SupportLevelRef {
  id: string;
  nameEn: string;
  nameDe: string;
  hours: string;
  firstResponse: string;
  note: string;
  slaUrl: string;
}

/** A level of the catalogue (Settings → Support levels). */
export interface SupportLevel extends SupportLevelRef {
  position: number;
  /** Items that pick it (data products, services, applications – counted whatever the reader may see: administrators only) */
  usage: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Guide {
  id: string;
  title: string;
  url: string;
}

/** The service that supports a data product, with what it offers – only for a reader who may see the service. */
export interface SupportedByService {
  service: { id: string; name: string };
  channels: SupportChannel[];
  level: SupportLevelRef | null;
}

/** The help and support of an item: its own channels, level and guides; for a data product the supporting service. */
export interface ItemSupport {
  channels: SupportChannel[];
  level: SupportLevelRef | null;
  guides: Guide[];
  /** Data products: the service that supports it (null: none, or one the reader may not see – then not named) */
  supportedBy: SupportedByService | null;
}

/** The level's name in a language (German falls back to English). */
export const levelName = (l: Pick<SupportLevelRef, 'nameEn' | 'nameDe'>, lang: string): string =>
  lang.startsWith('de') && l.nameDe.trim() ? l.nameDe : l.nameEn;

/** What the item shows: its own channels, else the supporting service's (`fromService`); the same for the level. */
export function effectiveSupport(s: ItemSupport): {
  channels: SupportChannel[];
  channelsFromService: boolean;
  level: SupportLevelRef | null;
  levelFromService: boolean;
} {
  const svc = s.supportedBy;
  const channelsFromService = !s.channels.length && !!svc?.channels.length;
  const levelFromService = !s.level && !!svc?.level;
  return {
    channels: channelsFromService ? svc!.channels : s.channels,
    channelsFromService,
    level: levelFromService ? svc!.level : s.level,
    levelFromService,
  };
}

/**
 * The deprecated `support` of a data product (0.26.0: derived, read for one more release): its first channel with the
 * purpose _questions_ – name, address and hours.
 */
export function legacySupportOf(channels: readonly Pick<SupportChannel, 'purpose' | 'name' | 'address' | 'hours'>[]): {
  channel: string;
  url: string;
  hours: string;
} {
  const c = channels.find((x) => x.purpose === 'questions');
  return c ? { channel: c.name, url: c.address, hours: c.hours } : { channel: '', url: '', hours: '' };
}
