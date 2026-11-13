import { DATA_PRODUCT_LIMITS, type DataExternalRef, type DataRef } from '@sm/shared';
import { currentUser } from '../auth/context.js';
import { HttpError } from '../util.js';

/** Small helpers of the data products module's services. */

export const actorName = (): string => currentUser()?.username ?? 'system';

export const productNotFound = (id: string) => new HttpError(404, `Data product ${id} not found`, 'DATA_PRODUCT_NOT_FOUND', { id });
export const objectNotFound = (id: string) => new HttpError(404, `Data object ${id} not found`, 'DATA_OBJECT_NOT_FOUND', { id });
export const elementNotFound = (id: string) => new HttpError(404, `Data element ${id} not found`, 'DATA_ELEMENT_NOT_FOUND', { id });
export const domainNotFound = (id: string) => new HttpError(404, `Data domain ${id} not found`, 'DATA_DOMAIN_NOT_FOUND', { id });
export const portNotFound = (id: string) => new HttpError(404, `Port ${id} not found`, 'DATA_PORT_NOT_FOUND', { id });
export const stepNotFound = (id: string) => new HttpError(404, `Step ${id} not found`, 'DATA_STEP_NOT_FOUND', { id });

/** What a limit counts (the context of DATA_PRODUCT_LIMIT: the web app has a text for each). */
export type LimitKind =
  | 'domains'
  | 'objects'
  | 'products'
  | 'elements'
  | 'membersPerProduct'
  | 'portsPerProduct'
  | 'elementsPerBinding'
  | 'consumersPerPort'
  | 'stepsPerPipeline'
  | 'stepEnds'
  | 'checkLinksPerElement';

/** 409 DATA_PRODUCT_LIMIT: an instance or item limit of ADR 0036 part 19 is reached. */
export const limitReached = (kind: LimitKind, max: number) =>
  new HttpError(409, `Limit reached: at most ${max.toLocaleString('en-GB')} (${kind})`, 'DATA_PRODUCT_LIMIT', { context: kind, max });

export const HIDDEN: DataRef = { id: null, key: null, name: null, hidden: true };
export const refOf = (r: { id: string; key: string; name: string }): DataRef => ({ id: r.id, key: r.key, name: r.name });

export const json = (v: unknown): string => JSON.stringify(v ?? null);
export const refs = (s: string | null): DataExternalRef[] => {
  try {
    const v = JSON.parse(s ?? '[]') as unknown;
    return Array.isArray(v) ? (v as DataExternalRef[]) : [];
  } catch {
    return [];
  }
};

/** Keyset cursors: the sort key and the id of the last row of a page, as base64url JSON. */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* refused below */
  }
  throw new HttpError(400, 'The cursor of this page is not valid – start from the first page', 'BAD_REQUEST');
}

/**
 * One page of rows sorted by (sortKey, id) that are already filtered in memory (products, data objects, domains: a few
 * thousand at most).
 */
export function pageOf<T>(
  rows: readonly T[],
  sortKey: (r: T) => string,
  id: (r: T) => string,
  cursor: string | undefined,
  limit: number,
): { items: T[]; next: string | null } {
  const after = decodeCursor(cursor);
  const sorted = [...rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  const start = after ? sorted.findIndex((r) => sortKey(r) > after[0] || (sortKey(r) === after[0] && id(r) > after[1])) : 0;
  const from = start < 0 ? sorted.length : start;
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  return { items, next: last && from + limit < sorted.length ? encodeCursor(sortKey(last), id(last)) : null };
}

export const L = DATA_PRODUCT_LIMITS;
