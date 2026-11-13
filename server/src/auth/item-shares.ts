import type { OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { AuthUser } from './context.js';
import { ITEM_SHARE_MODEL, recordAccess, type ShareModel } from './policy.js';
import type { ShareKindDef } from './shares.js';

/**
 * Records, credentials, ticket references and dashboards switched to shares (0.23.0, ADR 0033 phase 2, #297): View sees
 * the item, Edit changes it, Manage also changes its shares (and names an owner from outside its owning teams). Their
 * owners and responsibles imply a share – computed from the field, never stored: an owner or responsible of a record,
 * a credential or a ticket reference Edit, a dashboard's owner Manage. Approving a record, archiving and deleting a
 * credential and deleting a ticket reference stay role rights (administrators).
 *
 * The kinds' own access functions decide (with shares and Restricted); `rights` adds `manage` – who changes the
 * shares – which their public `permissions` leave out.
 */

type Right = 'view' | 'edit' | 'manage';
const RIGHTS: readonly Right[] = ['view', 'edit', 'manage'];

/** A user or team subject of an owner field (lower case). */
const subjects = (raw: string | null | undefined): string[] =>
  [...new Set(parseJson<unknown[]>(raw ?? '[]', []).map((s) => String(s).trim().toLowerCase()))].filter((s) => /^(user|team):./.test(s));
const userSubject = (name: string | null | undefined): string[] => (name?.trim() ? [`user:${name.trim().toLowerCase()}`] : []);

function itemKind(o: {
  kind: OwnedKind;
  table: string;
  nameColumn: string;
  ownerColumn: string;
  path: (id: string) => string;
  decide: (u: AuthUser, row: Record<string, unknown>) => readonly string[];
  implied: (row: Record<string, unknown>) => { subject: string; level: 'edit' | 'manage'; as: 'owner' | 'responsible' }[];
  model?: ShareModel<string>;
}): ShareKindDef<string> {
  const row = (id: string) => db().get<Record<string, unknown>>(`SELECT * FROM ${o.table} WHERE id = ?`, id);
  return {
    kind: o.kind,
    model: o.model ?? ITEM_SHARE_MODEL,
    name: (id) => {
      const r = row(id);
      return r ? String(r[o.nameColumn] ?? id) : undefined;
    },
    link: o.path,
    rights: (u, id) => {
      const r = row(id);
      return r ? o.decide(u, r) : [];
    },
    implied: (id) => {
      const r = row(id);
      return r ? o.implied(r) : [];
    },
  };
}

/** A record or living document: its owner implies Edit; designers manage it by role (recordAccess). */
export const recordShareKind = (): ShareKindDef<string> =>
  itemKind({
    kind: 'record',
    table: 'records',
    nameColumn: 'title',
    ownerColumn: 'owner',
    path: (id) => `/records/${id}`,
    decide: (u, r) => {
      const d = recordAccess(u, { id: String(r.id), owner: String(r.owner ?? '') });
      return RIGHTS.filter((p) => d[p]);
    },
    implied: (r) => userSubject(r.owner as string).map((subject) => ({ subject, level: 'edit' as const, as: 'owner' as const })),
  });

/** A credentials register entry: its owners imply Edit; designers and operators manage it by role. */
export const credentialShareKind = (
  decide: (u: AuthUser, r: { id: string; owner_subjects: string; archived: number }) => readonly string[],
): ShareKindDef<string> =>
  itemKind({
    kind: 'credential',
    table: 'credentials',
    nameColumn: 'name',
    ownerColumn: 'owner_subjects',
    path: (id) => `/credentials?open=${encodeURIComponent(id)}`,
    decide: (u, r) => decide(u, { id: String(r.id), owner_subjects: String(r.owner_subjects ?? '[]'), archived: Number(r.archived ?? 0) }),
    implied: (r) => subjects(r.owner_subjects as string).map((subject) => ({ subject, level: 'edit' as const, as: 'owner' as const })),
  });

/** A ticket reference: its responsibles imply Edit; its editors by role manage it. */
export const ticketShareKind = (decide: (u: AuthUser, r: { id: string; responsible: string }) => readonly string[]): ShareKindDef<string> =>
  itemKind({
    kind: 'ticket',
    table: 'ticket_refs',
    nameColumn: 'title',
    ownerColumn: 'responsible',
    path: (id) => `/tickets/${id}`,
    decide: (u, r) => decide(u, { id: String(r.id), responsible: String(r.responsible ?? '[]') }),
    implied: (r) => subjects(r.responsible as string).map((subject) => ({ subject, level: 'edit' as const, as: 'responsible' as const })),
  });

/** A dashboard: its owner implies Manage (decision 13); designers among the members edit it (decision 11). */
export const dashboardShareKind = (decide: (u: AuthUser, r: { id: string; owner: string | null }) => readonly string[]): ShareKindDef<string> =>
  itemKind({
    kind: 'dashboard',
    table: 'dashboards',
    nameColumn: 'name',
    ownerColumn: 'owner',
    path: (id) => `/dashboards/${id}`,
    decide: (u, r) => decide(u, { id: String(r.id), owner: (r.owner as string | null) ?? null }),
    implied: (r) => userSubject(r.owner as string).map((subject) => ({ subject, level: 'manage' as const, as: 'owner' as const })),
  });
