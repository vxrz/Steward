import YAML from 'yaml';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { canonicalJson, parseJson, sha256 } from '../util.js';
import { canCreate, objectAccess, productAccess, usesModule } from './access.js';
import { DATA_PRODUCT_FORMAT_VERSION, dataProductsFileSchema, issueMessages } from './format.js';
import { Snapshot, compact, objectEntry, productEntry } from './export.js';
import { applyImport } from './import.js';
import { ratingsByItem } from './ratings.js';
import type { ObjectRow, ProductRow } from './store.js';

/**
 * Git sync of data products and data objects (ADR 0036 part 16, decision 23, phase 2): the kinds `dataProduct` and
 * `dataObject` of the existing Git sync sources (docs/GIT-SYNC.md) – one entry per file, in the module's format
 * (`version: 1` with one `data_product:` or one `data_object:`; `kind: dataProduct` / `kind: dataObject` at the top is
 * allowed and ignored), matched by `key`. The sync engine's rules apply: every change is a pending update a person
 * accepts (with the rights of the import), changes made in Steward since are flagged as a conflict.
 *
 * Accepting imports the file as _add and update_ with the product's lists taken from the file (members, ports, steps,
 * consumers the file leaves out are removed – the definition is the repository's; what the reviewer may not see stays),
 * under the origin `git:<source id>`. Elements are not synced (they are discovered): a product names them, and an
 * element Steward does not know is a problem of the update.
 */

export type DataSyncKind = 'dataProduct' | 'dataObject';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A file of the module's format holding exactly one product or data object (and nothing else). */
export function classifyDataFile(o: Obj): DataSyncKind | null {
  if (o.kind !== undefined && o.kind !== 'dataProduct' && o.kind !== 'dataObject') return null;
  if (o.version !== DATA_PRODUCT_FORMAT_VERSION && o.kind === undefined) return null;
  const keys = Object.keys(o).filter((k) => k !== 'kind' && k !== 'version');
  if (keys.length === 1 && keys[0] === 'data_product' && isObj(o.data_product)) return o.kind === 'dataObject' ? null : 'dataProduct';
  if (keys.length === 1 && keys[0] === 'data_object' && isObj(o.data_object)) return o.kind === 'dataProduct' ? null : 'dataObject';
  return o.kind === 'dataProduct' || o.kind === 'dataObject' ? o.kind : null;
}

export type DataParse =
  { ok: true; identity: string; name: string; content: { text: string }; hash: string } | { ok: false; identity: string | null; errors: string[] };

/** Checks a file with the format's schema (credentials were refused by the sync engine before). */
export function parseDataFile(kind: DataSyncKind, raw: Obj): DataParse {
  const { kind: _k, ...rest } = raw;
  const doc: Obj = { version: DATA_PRODUCT_FORMAT_VERSION, ...rest };
  const entry = (kind === 'dataProduct' ? doc.data_product : doc.data_object) as Obj | undefined;
  const identity = isObj(entry) && typeof entry.key === 'string' ? entry.key : null;
  if (!isObj(entry)) return { ok: false, identity, errors: [`A ${kind} file holds one ${kind === 'dataProduct' ? 'data_product' : 'data_object'}:`] };
  const r = dataProductsFileSchema.safeParse(doc);
  if (!r.success)
    return {
      ok: false,
      identity,
      errors: issueMessages(r.error.issues)
        .slice(0, 30)
        .map((m) => `${m.path}: ${m.message}`),
    };
  const parsed = (kind === 'dataProduct' ? r.data.data_product : r.data.data_object)!;
  const text = JSON.stringify(doc);
  return { ok: true, identity: parsed.key, name: parsed.name, content: { text }, hash: sha256(canonicalJson(r.data)) };
}

const productByKey = (key: string) => db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', key.toLowerCase());
const objectByKey = (key: string) => db().get<ObjectRow>('SELECT * FROM dp_objects WHERE key = ?', key.toLowerCase());
const tableOf = (kind: DataSyncKind) => (kind === 'dataProduct' ? 'dp_products' : 'dp_objects');

export function findDataLocal(kind: DataSyncKind, key: string): { id: string; name: string } | null {
  const r = kind === 'dataProduct' ? productByKey(key) : objectByKey(key);
  return r ? { id: r.id, name: r.name } : null;
}

export function dataLocalById(kind: DataSyncKind, id: string): { id: string; name: string } | null {
  return db().get<{ id: string; name: string }>(`SELECT id, name FROM ${tableOf(kind)} WHERE id = ?`, id) ?? null;
}

/** Every change in Steward raises the entry's revision (its lists touch the product): the revision is the local hash. */
export function dataLocalHash(kind: DataSyncKind, id: string): string | null {
  const r = db().get<{ revision: number; updated_at: string }>(`SELECT revision, updated_at FROM ${tableOf(kind)} WHERE id = ?`, id);
  return r ? sha256(`${kind}|${id}|${r.revision}|${r.updated_at}`) : null;
}

/** The entry as the reader may see it, in the file's shape (for the difference). */
export function dataLocalText(kind: DataSyncKind, id: string): string | null {
  const s = new Snapshot();
  if (kind === 'dataProduct') {
    const row = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', id);
    if (!row || !productAccess(s.u, row).permissions.length) return null;
    return YAML.stringify(compact({ version: DATA_PRODUCT_FORMAT_VERSION, data_product: productEntry(s, row) }), { lineWidth: 0 });
  }
  const row = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE id = ?', id);
  if (!row || !objectAccess(s.u, row).permissions.length) return null;
  const links = db().all<{ element_id: string; note: string }>('SELECT element_id, note FROM dp_object_elements WHERE object_id = ?', row.id);
  s.elements(links.map((l) => l.element_id));
  return YAML.stringify(
    compact({ version: DATA_PRODUCT_FORMAT_VERSION, data_object: objectEntry(s, row, ratingsByItem('object', [row.id]).get(row.id)!, links) }),
    {
      lineWidth: 0,
    },
  );
}

export const dataIncomingText = (content: unknown): string => YAML.stringify(parseJson((content as { text: string }).text, {}), { lineWidth: 0 });

/** The reader may see the local entry (an entry that no longer exists hides nothing). */
export function canViewData(kind: DataSyncKind, id: string): boolean {
  const u = currentUser();
  if (!usesModule(u)) return false;
  if (kind === 'dataProduct') {
    const row = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', id);
    return !row || productAccess(u, row).permissions.length > 0;
  }
  const row = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE id = ?', id);
  return !row || objectAccess(u, row).permissions.length > 0;
}

/** Accept or reject: who may change the entry, or create one when it is new. */
export function canDecideData(kind: DataSyncKind, id: string | null): boolean {
  const u = currentUser();
  if (!u || !usesModule(u)) return false;
  if (!id) return canCreate(u);
  if (kind === 'dataProduct') {
    const row = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', id);
    return !!row && productAccess(u, row).permissions.includes('edit');
  }
  const row = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE id = ?', id);
  return !!row && objectAccess(u, row).permissions.includes('edit');
}

/** Applies an accepted file: the import (add and update, the product's lists the file's) under the origin git:<source>. */
export function applyDataFile(kind: DataSyncKind, content: unknown, o: { identity: string; sourceId?: string }): { entityId: string } {
  const text = (content as { text: string }).text;
  applyImport(
    { files: [{ name: `${o.identity}.json`, content: text }], mode: 'update', ...(o.sourceId ? { origin: `git:${o.sourceId}`.slice(0, 100) } : {}) },
    { replaceLists: kind === 'dataProduct' },
  );
  const local = findDataLocal(kind, o.identity);
  if (!local) throw new Error(`The ${kind} ${o.identity} was not imported`);
  return { entityId: local.id };
}
