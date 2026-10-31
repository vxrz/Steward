import type { DocumentApplicationRef } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentUser } from '../auth/context.js';
import { catalogueAccess } from '../auth/policy.js';

/**
 * Document scope: the applications a living document applies to (record_applications). Read-only helpers without
 * further imports, so the records module can use them without an import cycle; changes are in applications.ts.
 */

/** The applications each of these records applies to (ordered by name). */
export function scopesOf(recordIds: string[]): Map<string, DocumentApplicationRef[]> {
  const out = new Map<string, DocumentApplicationRef[]>();
  if (!recordIds.length) return out;
  for (let i = 0; i < recordIds.length; i += 500) {
    const chunk = recordIds.slice(i, i + 500);
    const u = currentUser();
    // applications the reader may not see are left out (#131)
    const rows = db()
      .all<{ record_id: string; id: string; name: string; archived: number; owners: string }>(
        `SELECT ra.record_id, a.id, a.name, a.archived, a.owners FROM record_applications ra JOIN applications a ON a.id = ra.application_id
       WHERE ra.record_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY a.name`,
        ...chunk,
      )
      .filter((r) => !u || catalogueAccess(u, { kind: 'application', id: r.id, owners: parseJson<string[]>(r.owners, []) }).view);
    for (const r of rows) out.set(r.record_id, [...(out.get(r.record_id) ?? []), { id: r.id, name: r.name, archived: !!r.archived }]);
  }
  return out;
}

export function scopeOf(recordId: string): DocumentApplicationRef[] {
  return scopesOf([recordId]).get(recordId) ?? [];
}
