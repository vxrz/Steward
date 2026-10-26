import type { ApplicationDocument } from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { canReadRecordRow } from '../records/access.js';
import { documentStates } from '../records/document-model.js';

/**
 * Living documents (workflow "document") of catalogue items – services (linked either way) and applications (their
 * scope). Documents the user may not read are left out entirely: neither listed nor counted.
 */

export type DocLinkRow = {
  id: string;
  number: string;
  title: string;
  status: string;
  type_id: string;
  fields: string;
  owner: string;
  type_key: string;
  type_name: string;
};
const DOC_SELECT =
  "SELECT r.id, r.number, r.title, r.status, r.type_id, r.fields, r.owner, t.key AS type_key, t.name AS type_name FROM records r JOIN record_types t ON t.id = r.type_id WHERE t.workflow = 'document'";

/** The living documents among these record ids, read in chunks. */
export function documentRows(ids: string[]): DocLinkRow[] {
  const rows: DocLinkRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...db().all<DocLinkRow>(`${DOC_SELECT} AND r.id IN (${chunk.map(() => '?').join(', ')})`, ...chunk));
  }
  return rows;
}

/** The documents among these ids that the user may read, with edition and review status, ordered by number. */
export function readableDocuments(ids: string[], u: AuthUser | null): ApplicationDocument[] {
  if (!u || !ids.length) return [];
  const readable = documentRows([...new Set(ids)]).filter((r) => canReadRecordRow(u, r));
  const states = documentStates(
    undefined,
    undefined,
    readable.map((r) => r.id),
  );
  return readable
    .map((r): ApplicationDocument => {
      const d = states.get(r.id);
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        typeKey: r.type_key,
        typeName: r.type_name,
        status: r.status,
        edition: d?.edition ?? null,
        reviewStatus: d?.review.status ?? 'none',
        nextReviewAt: d?.review.nextReviewAt ?? null,
        daysLeft: d?.review.daysLeft ?? null,
      };
    })
    .sort((a, b) => a.number.localeCompare(b.number));
}

/**
 * For pairs (item, record): per item, the documents the user may read and how many of them have an overdue review.
 * Each document is read and checked once, whatever the number of items.
 */
export function documentCounts(pairs: { item: string; record: string }[], u: AuthUser): Map<string, { documents: number; overdue: number }> {
  const out = new Map<string, { documents: number; overdue: number }>();
  if (!pairs.length) return out;
  const readable = new Set(
    documentRows([...new Set(pairs.map((p) => p.record))])
      .filter((r) => canReadRecordRow(u, r))
      .map((r) => r.id),
  );
  if (!readable.size) return out;
  const overdue = new Set([...documentStates(undefined, undefined, [...readable])].filter(([, st]) => st.review.status === 'overdue').map(([id]) => id));
  for (const p of pairs) {
    if (!readable.has(p.record)) continue;
    const c = out.get(p.item) ?? { documents: 0, overdue: 0 };
    c.documents++;
    if (overdue.has(p.record)) c.overdue++;
    out.set(p.item, c);
  }
  return out;
}
