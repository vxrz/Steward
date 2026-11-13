import { dataRopaDetailsInput, type DataRopaDetails, type DataTomsRef, type DataTomsView, type DataTransfer } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { canReadRecordRow } from '../records/access.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { objectAccess } from './access.js';
import { objectNotFound } from './common.js';
import { editableProduct, visibleProduct } from './service.js';
import { chunks, marks, objectRow } from './store.js';

/**
 * The GDPR Art. 30 details of a data object or a data product (0.25.0, the carry-over of the 0.24.0 release review;
 * docs/DATA-PRODUCTS.md#records-of-processing-gdpr-art-30): the **transfers to third countries** or international
 * organisations with their safeguards – Art. 30(1)(e) – and a **reference to the technical and organisational
 * measures** – Art. 30(1)(g): a link to a document, or a document of Steward (records). Entered where they fit: on the
 * data object (every processing of it) or on a product (its own processing, e.g. a platform outside the EU).
 *
 * Kept apart from the forms and the file format (their own route, `PUT …/ropa-details`), so an import that leaves them
 * out keeps them. A referenced record the reader may not see is neither named nor linked.
 */

interface RecordBits {
  id: string;
  number: string;
  title: string;
  type_id: string;
  fields: string;
  owner: string;
}

const invalid = (message: string, context: string) => new HttpError(400, message, 'DATA_ROPA_DETAILS_INVALID', { context });

export const transfersOf = (raw: string | null | undefined): DataTransfer[] => parseJson<DataTransfer[]>(raw ?? '[]', []).filter((t) => t && t.country);
export const tomsOf = (raw: string | null | undefined): DataTomsRef | null => (raw ? parseJson<DataTomsRef | null>(raw, null) : null);

/** The records these references name, as `u` may see them (one statement per 500). */
export function recordsForToms(u: AuthUser | null, refs: readonly (DataTomsRef | null)[]): Map<string, RecordBits | null> {
  const ids = [...new Set(refs.flatMap((r) => (r?.kind === 'record' ? [r.recordId] : [])))];
  const out = new Map<string, RecordBits | null>(ids.map((id) => [id, null]));
  for (const part of chunks(ids))
    for (const r of db().all<RecordBits>(`SELECT id, number, title, type_id, fields, owner FROM records WHERE id IN (${marks(part.length)})`, ...part))
      out.set(r.id, canReadRecordRow(u, r) ? r : null);
  return out;
}

export function tomsView(ref: DataTomsRef | null, records: Map<string, RecordBits | null>): DataTomsView | null {
  if (!ref) return null;
  if (ref.kind === 'url') return { kind: 'url', url: ref.url, label: ref.label };
  const r = records.get(ref.recordId);
  return r ? { kind: 'record', id: r.id, number: r.number, title: r.title } : { kind: 'record', hidden: true };
}

/** A record the person names: by id or number, one they may read (else refused like a missing one). */
function recordRef(u: AuthUser, idOrNumber: string): DataTomsRef {
  const r = db().get<RecordBits>(
    'SELECT id, number, title, type_id, fields, owner FROM records WHERE id = ? OR number = ?',
    idOrNumber,
    idOrNumber.toUpperCase(),
  );
  if (!r || !canReadRecordRow(u, r)) throw invalid(`Document ${idOrNumber} not found`, 'record');
  return { kind: 'record', recordId: r.id };
}

function details(u: AuthUser, transfers: string | undefined, toms: string | null | undefined, mayEdit: boolean): DataRopaDetails {
  const ref = tomsOf(toms);
  return { transfers: transfersOf(transfers), toms: tomsView(ref, recordsForToms(u, [ref])), mayEdit };
}

function parseInput(u: AuthUser, body: unknown, current: string | null | undefined): { transfers: DataTransfer[]; toms: DataTomsRef | null } {
  const input = dataRopaDetailsInput.parse(body ?? {});
  // left out: the reference stays (a document the person may not see is not shown, so it cannot be sent back)
  if (input.toms === undefined) return { transfers: input.transfers, toms: tomsOf(current) };
  const toms: DataTomsRef | null = !input.toms ? null : input.toms.kind === 'record' ? recordRef(u, input.toms.recordId) : input.toms;
  return { transfers: input.transfers, toms };
}

// ---------- data objects ----------

function visibleObjectRow(id: string, u: AuthUser) {
  const row = objectRow(id);
  if (!row) throw objectNotFound(id);
  const perms = objectAccess(u, row).permissions;
  if (!perms.length) throw objectNotFound(id);
  return { row, perms };
}

/** GET /api/data-objects/:id/ropa-details */
export function objectRopaDetails(id: string): DataRopaDetails {
  const u = me();
  const { row, perms } = visibleObjectRow(id, u);
  return details(u, row.transfers, row.toms, perms.includes('edit'));
}

/** PUT /api/data-objects/:id/ropa-details – who may change the data object. */
export function setObjectRopaDetails(id: string, body: unknown): DataRopaDetails {
  const u = me();
  const { row, perms } = visibleObjectRow(id, u);
  if (!perms.includes('edit')) forbid('change this data object', 'dataProducts');
  const next = parseInput(u, body, row.toms);
  db().tx(() => {
    db().run(
      'UPDATE dp_objects SET transfers = ?, toms = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      JSON.stringify(next.transfers),
      next.toms ? JSON.stringify(next.toms) : null,
      nowIso(),
      u.username,
      row.id,
    );
    audit({
      action: 'dataobject.ropa_details_changed',
      entityType: 'data_object',
      entityId: row.id,
      summary: `Data object "${row.name}": records of processing details changed (${next.transfers.length} transfer(s) to third countries${next.toms ? ', measures referenced' : ''})`,
      details: { before: { transfers: transfersOf(row.transfers), toms: tomsOf(row.toms) }, after: next },
    });
  });
  return objectRopaDetails(row.id);
}

// ---------- data products ----------

/** GET /api/data-products/:id/ropa-details */
export function productRopaDetails(id: string): DataRopaDetails {
  const u = me();
  const { row, perms } = visibleProduct(id, u);
  return details(u, row.transfers, row.toms, perms.includes('edit'));
}

/** PUT /api/data-products/:id/ropa-details – who may change the product. */
export function setProductRopaDetails(id: string, body: unknown): DataRopaDetails {
  const u = me();
  const { row } = editableProduct(id);
  const next = parseInput(u, body, row.toms);
  db().tx(() => {
    db().run(
      'UPDATE dp_products SET transfers = ?, toms = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      JSON.stringify(next.transfers),
      next.toms ? JSON.stringify(next.toms) : null,
      nowIso(),
      u.username,
      row.id,
    );
    audit({
      action: 'dataproduct.ropa_details_changed',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": records of processing details changed (${next.transfers.length} transfer(s) to third countries${next.toms ? ', measures referenced' : ''})`,
      details: { before: { transfers: transfersOf(row.transfers), toms: tomsOf(row.toms) }, after: next },
    });
  });
  return productRopaDetails(row.id);
}
