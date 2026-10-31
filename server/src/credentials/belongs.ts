import { z } from 'zod';
import { CREDENTIAL_BELONGS_KINDS, type CredentialBelongsKind, type CredentialBelongsTarget, type CredentialBelongsTo } from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { currentUser } from '../auth/context.js';
import { catalogueAccess } from '../auth/policy.js';

/** Whether the current reader may see the item (#131); jobs see everything. */
const sees = (kind: 'application' | 'system', id: string, owners: string) => {
  const u = currentUser();
  return !u || catalogueAccess(u, { kind, id, owners: parseJson<string[]>(owners, []) }).view;
};

/**
 * What a credential belongs to in the catalogue (#143): an application, one of its components, or a system (#129).
 * Names of items the reader may not see (another team's, #131) are left out; such a target counts as not existing.
 * Plain SQL here (no imports from the catalogue modules, which import the credentials register).
 */

export const belongsToSchema = z.object({ kind: z.enum(CREDENTIAL_BELONGS_KINDS), id: z.string().trim().min(1).max(100) }).strict();
export type BelongsToInput = z.infer<typeof belongsToSchema>;

type Target = { name: string; owners: string[]; applicationId: string | null; applicationName: string | null };

/** The target, or null when it does not exist (or the reader may not see it). */
export function belongsTarget(kind: CredentialBelongsKind, id: string): Target | null {
  if (kind === 'application') {
    const a = db().get<{ name: string; owners: string }>('SELECT name, owners FROM applications WHERE id = ?', id);
    return a && sees('application', id, a.owners)
      ? { name: a.name, owners: parseJson<string[]>(a.owners, []), applicationId: null, applicationName: null }
      : null;
  }
  if (kind === 'component') {
    const c = db().get<{ name: string; app_id: string; app_name: string; owners: string }>(
      'SELECT c.name, a.id AS app_id, a.name AS app_name, a.owners FROM application_components c JOIN applications a ON a.id = c.application_id WHERE c.id = ?',
      id,
    );
    return c && sees('application', c.app_id, c.owners)
      ? { name: c.name, owners: parseJson<string[]>(c.owners, []), applicationId: c.app_id, applicationName: c.app_name }
      : null;
  }
  const s = db().get<{ name: string; owners: string }>('SELECT name, owners FROM systems WHERE id = ?', id);
  return s && sees('system', id, s.owners) ? { name: s.name, owners: parseJson<string[]>(s.owners, []), applicationId: null, applicationName: null } : null;
}

/** 400 for a target that does not exist; an unchanged one is kept even when it is gone. */
export function checkBelongsTo(b: BelongsToInput | null | undefined, before: { kind: string | null; id: string | null }): void {
  if (!b || (b.kind === before.kind && b.id === before.id)) return;
  if (!belongsTarget(b.kind, b.id))
    throw new HttpError(400, `The ${b.kind} ${b.id} does not exist`, 'CREDENTIAL_BELONGS_NOT_FOUND', { kind: b.kind, id: b.id });
}

export function toBelongsTo(kind: string | null, id: string | null): CredentialBelongsTo | null {
  if (!kind || !id) return null;
  const t = belongsTarget(kind as CredentialBelongsKind, id);
  return {
    kind: kind as CredentialBelongsKind,
    id,
    name: t?.name ?? null,
    applicationId: t?.applicationId ?? null,
    applicationName: t?.applicationName ?? null,
  };
}

/** Everything a credential can belong to: applications (not archived), their components, and systems. */
export function belongsTargets(): CredentialBelongsTarget[] {
  const apps = db()
    .all<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM applications WHERE archived = 0 ORDER BY name')
    .filter((a) => sees('application', a.id, a.owners));
  const comps = db()
    .all<{ id: string; name: string; environment: string; app: string; app_id: string; owners: string }>(
      `SELECT c.id, c.name, c.environment, a.name AS app, a.id AS app_id, a.owners FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE a.archived = 0 ORDER BY a.name, c.name`,
    )
    .filter((c) => sees('application', c.app_id, c.owners));
  const systems = db()
    .all<{ id: string; name: string; vendor: string; owners: string }>('SELECT id, name, vendor, owners FROM systems ORDER BY name')
    .filter((x) => sees('system', x.id, x.owners));
  return [
    ...apps.map((a) => ({ kind: 'application' as const, id: a.id, name: a.name, context: '', owners: parseJson<string[]>(a.owners, []) })),
    ...comps.map((c) => ({
      kind: 'component' as const,
      id: c.id,
      name: c.environment ? `${c.name} (${c.environment})` : c.name,
      context: c.app,
      owners: parseJson<string[]>(c.owners, []),
    })),
    ...systems.map((s) => ({ kind: 'system' as const, id: s.id, name: s.name, context: s.vendor, owners: parseJson<string[]>(s.owners, []) })),
  ];
}
