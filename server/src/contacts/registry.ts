import type { ContactLinkKind } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';

/**
 * The link kinds of the contacts directory (ADR 0038 part 1, docs/CONTACTS.md): each module that names contacts on
 * its items registers its kinds here – through its feature manifest (`contactKinds`, features/index.ts) or by calling
 * registerContactKind() – so the directory decides who sees and who changes a contact without importing the modules.
 *
 * A kind that is not registered (its module is not loaded) is seen by administrators and auditors only, and changed by
 * administrators only: a contact is never shown to more people because a module is missing.
 */
export interface ContactKindDef {
  /** The items of `itemIds` the user may see (bulk: one call for many items, a few statements at most) */
  visibleIds(u: AuthUser, itemIds: readonly string[]): Set<string>;
  /** Whether the user may change the item (and so its contacts) */
  canChange(u: AuthUser, itemId: string): boolean;
  /** Display names of the items (bulk), for the where-used list – asked only for items the reader may see */
  names(itemIds: readonly string[]): Map<string, string>;
  /** The web app's address of the item (without the base path), e.g. /services/svc_1 */
  href(itemId: string): string;
  /**
   * Optional: after a contact was erased, the items of this kind it was linked to (its links are gone already). A kind
   * whose items keep rows of their own per link (a supplier's contact entry with its scope and note) deletes them here.
   */
  onLinksErased?(itemIds: readonly string[]): void;
  /**
   * Optional: whether the user may create contacts on the Contacts page and in the pickers (POST /api/contacts) because
   * of this kind – e.g. a module-only user who may change the module's items (a data products contributor). Who works in
   * Steward with a core role may anyway. Inline contacts in setLinks need only the right to change the item.
   */
  createsContacts?(u: AuthUser): boolean;
}

/** What other modules add to the directory besides link kinds. */
export interface ContactHooks {
  /** Documented decisions that name these contacts, counted per contact id (the where-used page) */
  countDecisions?(contactIds: readonly string[]): Map<string, number>;
  /**
   * After a contact was erased (GDPR Art. 17): set its id to null in frozen snapshots (ContactSnapshot) – the names
   * stay, they are evidence (Art. 17(3)(b) and (e)). Runs in the erasing transaction.
   */
  onErased?(contactId: string): void;
}

const kinds = new Map<string, ContactKindDef>();
const hooks: ContactHooks[] = [];

/** Registers a link kind (a later registration of the same kind replaces the earlier one: tests, hot reload). */
export function registerContactKind(kind: ContactLinkKind, def: ContactKindDef): void {
  kinds.set(kind, def);
}

export function registerContactHooks(h: ContactHooks): void {
  if (!hooks.includes(h)) hooks.push(h);
}

/** Shorthand: a function that nulls the erased contact's id in the module's frozen snapshots. */
export function onContactErased(fn: (contactId: string) => void): void {
  registerContactHooks({ onErased: fn });
}

const isAdmin = (u: AuthUser) => u.roles.includes('admin');

/** The fallback of a kind nobody registered: administrators and auditors see its items, administrators change them. */
const UNREGISTERED: ContactKindDef = {
  visibleIds: (u, ids) => (isAdmin(u) || u.roles.includes('auditor') ? new Set(ids) : new Set()),
  canChange: (u) => isAdmin(u),
  names: (ids) => new Map(ids.map((id) => [id, id])),
  href: () => '',
};

export const contactKind = (kind: string): ContactKindDef => kinds.get(kind) ?? UNREGISTERED;
/** The registered kinds (for createsContacts). */
export const contactKinds = (): readonly ContactKindDef[] => [...kinds.values()];
export const contactKindRegistered = (kind: string): boolean => kinds.has(kind);
export const contactHooks = (): readonly ContactHooks[] => hooks;
