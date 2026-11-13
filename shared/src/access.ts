import { z } from 'zod';
import type { OwnedKind } from './api.js';

/**
 * Shares (ADR 0033, docs/adr/0033-one-access-model.md): one subject – `user:`, `team:` or `role:` – given a level and,
 * where the kind has them, action rights on one resource. Shares only add (no deny rules); a resource whose scope is
 * _Restricted_ gives instance roles nothing, so only its shares (and administrators, auditors, owners) reach it.
 */

/** The levels of a share, lowest first: Manage includes Edit, Edit includes View. Only Manage changes shares (decision 3). */
export const SHARE_LEVELS = ['view', 'edit', 'manage'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

/** Rights beside the level (decision 2): using a production tenant is not editing it, running a process is not changing it. */
export const SHARE_ACTION_RIGHTS = ['run', 'approve', 'use', 'acknowledge', 'propose', 'test'] as const;
export type ShareAction = (typeof SHARE_ACTION_RIGHTS)[number];

/** The action rights each kind offers beside the level (ADR 0033 part 1); a kind without any has only the levels. */
export const SHARE_ACTIONS: Record<OwnedKind, readonly ShareAction[]> = {
  process: ['run', 'approve'],
  platform: ['use'],
  monitor: ['acknowledge'],
  site: ['propose'],
  contract: ['test'],
  service: [],
  application: [],
  system: [],
  supplier: [],
  record: [],
  credential: [],
  ticket: [],
  dashboard: [],
  // identities keep their own `use` right, managed on the platform's Access tab (ADR 0033 part 1)
  platform_identity: [],
  // 0.21.0 (ADR 0035): price books and calculators – the levels only
  cost_price_book: [],
  cost_calculator: [],
};

/** Kinds of the plant registry: the only ones a plant viewer (role `plant`) may be given a share on (ADR 0033 security notes). */
export const PLANT_SHARE_KINDS: readonly OwnedKind[] = ['site'];

/** At most this many shares per resource. */
export const SHARE_LIMIT = 100;
/** A reminder goes to the Manage holders this many days before a share ends (decision 4). */
export const SHARE_REMINDER_DAYS = 7;

/** Whether `a` includes `b` (Manage includes Edit includes View). */
export const levelIncludes = (a: ShareLevel, b: ShareLevel): boolean => SHARE_LEVELS.indexOf(a) >= SHARE_LEVELS.indexOf(b);

/** The latest end date a share may have when it is set at `now`: one year ahead (decision 4). */
export function latestShareEnd(now: number = Date.now()): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

/** One share of a resource. */
export interface ResourceShare {
  /** `user:<name>`, `team:<name>` or `role:<role>`, lower case */
  subject: string;
  level: ShareLevel;
  /** The kind's action rights beside the level */
  actions: ShareAction[];
  /** When the share ends (ISO), or null */
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** A share as a form or an API sends it. */
export const shareInputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  level: z.enum(SHARE_LEVELS),
  actions: z.array(z.enum(SHARE_ACTION_RIGHTS)).max(SHARE_ACTION_RIGHTS.length).default([]),
  /** ISO date or date-time; null or left out: no end */
  expiresAt: z.string().max(40).nullable().default(null),
});
export type ShareInput = z.input<typeof shareInputSchema>;

/** The whole list of a resource's shares (it replaces the stored one). */
export const sharesInputSchema = z.object({ shares: z.array(shareInputSchema).max(SHARE_LIMIT) });

/** A resource's scope (ADR 0033 part 1): the whole instance, its owning teams, or only its shares (Restricted). */
export const SHARE_SCOPES = ['instance', 'teams', 'restricted'] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];

/** A share as the Access tab lists it. */
export interface ShareView extends ResourceShare {
  /** Whether the user or team exists (a deleted team or a removed user stays an entry that matches nobody) */
  known: boolean;
}

/**
 * A share implied by a field of the item (ADR 0033 part 2): an owner has Edit, computed from the owner field when the
 * item is read, never stored. Not removable on the Access tab: removing the owner removes it.
 */
export interface ImpliedShare {
  subject: string;
  level: ShareLevel;
  as: 'owner' | 'responsible';
  /** From outside the owning teams (or on a Restricted item): naming it was a widening, confirmed with the step-up */
  outside: boolean;
}

/** What someone holds on an item in share terms: `'all'` for administrators. */
export type HeldShareView = 'all' | { level: ShareLevel | null; actions: ShareAction[] };

/** GET /api/access/:kind/:id/shares – the Access tab of an item (ADR 0033 part 7). */
export interface ResourceAccessView {
  kind: OwnedKind;
  id: string;
  name: string;
  scope: ShareScope;
  owningTeams: { id: string; name: string }[];
  restricted: boolean;
  /**
   * The shares, for Manage holders, administrators and auditors; null for everyone else (they see only their own
   * reasons, in Why do I have access?)
   */
  shares: ShareView[] | null;
  /** Shares whose subject the reader may not see: counted, not named, and kept when the list is saved */
  hidden: number;
  /** Shares implied by owners (and responsibles) – read-only */
  implied: ImpliedShare[];
  /** The action rights the kind offers beside the level */
  actions: ShareAction[];
  /** What the reader holds: nobody shares more (administrators: all) */
  held: HeldShareView;
  /** Whether the reader may change the shares (Manage) */
  canManage: boolean;
  /** Whether the reader may switch Restricted (administrators; on some kinds the Manage holders, decision 15) */
  canRestrict: boolean;
  /** The latest end date a share may get now (ISO) */
  maxEnd: string;
}

/** POST /api/access/:kind/:id/preview – a change of shares or scope, nothing stored. */
export const accessPreviewSchema = z.object({
  shares: z.array(shareInputSchema).max(SHARE_LIMIT).optional(),
  restricted: z.boolean().optional(),
});
export type AccessPreviewInput = z.input<typeof accessPreviewSchema>;

/** A subject and the rights a change gives it or takes from it (`view`, `edit`, `manage`, action rights, `extended`, `roleDefaults`). */
export interface AccessChangeLine {
  subject: string;
  rights: string[];
}

/** The answer of the preview: who gains what (a widening asks for the step-up) and who loses what (confirmed). */
export interface AccessPreview {
  gains: AccessChangeLine[];
  losses: AccessChangeLine[];
}

/** PUT /api/access/:kind/:id/scope */
export const accessScopeSchema = z.object({ restricted: z.boolean() });
