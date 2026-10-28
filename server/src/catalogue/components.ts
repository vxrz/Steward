import fs from 'node:fs';
import { EnvHttpProxyAgent } from 'undici';
import { z } from 'zod';
import {
  BRAND,
  boundedRecord,
  COMPONENT_LIMITS,
  COMPONENT_TYPES,
  type ApplicationComponent,
  type ApplicationStackItem,
  type ComponentType,
  type SbomChange,
  type SbomFormat,
  type SbomPreview,
  type StackEntry,
  type StackProduct,
  type StackSource,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { forbid, me } from '../records/access.js';
import { httpUrl } from '../records/links.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { assetPath } from '../reports/pdf/assets.js';

/**
 * Components of an application (#103): what it consists of – repositories, container images, Kafka topics,
 * Snowflake databases, cloud accounts, Kubernetes namespaces, platforms, anything else – and the tech stack of
 * each one: endoflife.date products with the version in use, entered by hand or read from an SBOM (CycloneDX or
 * SPDX JSON). Only products endoflife.date knows are kept (operating systems, runtimes, databases, major
 * frameworks); libraries stay out. Entries entered by hand win over the SBOM.
 *
 * Permissions follow the application: everyone who can sign in reads them, whoever may edit the application
 * changes them. Every change is audited on the application.
 */

// ---------- the endoflife.date product list ----------

interface ProductRecord extends StackProduct {
  aliases: string[];
  purls: string[];
  cpes: string[];
}

interface ProductIndex {
  list: ProductRecord[];
  byId: Map<string, ProductRecord>;
  byPurl: Map<string, string>;
  byCpe: Map<string, string>;
  byName: Map<string, string>;
  source: string;
}

let index: ProductIndex | null = null;

/** Lower case type/namespace/name of a package URL, without version, qualifiers and subpath (pkg:npm/%40a/b@1?x#y → pkg:npm/@a/b). */
export function purlKey(purl: string): string | null {
  const s = purl.trim();
  if (!/^pkg:[a-z0-9.+-]+\//i.test(s)) return null;
  let rest = s.split('#')[0]!.split('?')[0]!;
  // the version follows the last "@" after the name (a namespace like %40angular is encoded)
  const at = rest.lastIndexOf('@');
  if (at > rest.indexOf('/')) rest = rest.slice(0, at);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep it encoded */
  }
  return rest.toLowerCase().replace(/\/+$/, '');
}

/** part:vendor:product of a CPE 2.3 (cpe:2.3:a:nodejs:node.js:…) or 2.2 URI (cpe:/a:nodejs:node.js:…). */
export function cpeKey(cpe: string): string | null {
  const s = cpe.trim().toLowerCase();
  const parts = s.startsWith('cpe:2.3:') ? s.slice(8).split(':') : s.startsWith('cpe:/') ? s.slice(5).split(':') : null;
  if (!parts || parts.length < 3 || !parts[0] || !parts[1] || !parts[2] || parts[1] === '*' || parts[2] === '*') return null;
  return `${parts[0]}:${parts[1]}:${parts[2]}`;
}

const nameKey = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

function loadIndex(): ProductIndex {
  if (index) return index;
  let data: { source?: string; products?: ProductRecord[] } = {};
  try {
    data = JSON.parse(fs.readFileSync(assetPath('endoflife/products.json'), 'utf8')) as typeof data;
  } catch {
    throw new HttpError(500, 'The endoflife.date product list is missing (server/assets/endoflife/products.json)', 'STACK_PRODUCTS_MISSING');
  }
  const list = (data.products ?? []).filter((p) => typeof p?.id === 'string');
  const byId = new Map(list.map((p) => [p.id, p]));
  const byPurl = new Map<string, string>();
  const byCpe = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of list) {
    for (const u of p.purls ?? []) {
      const k = purlKey(u);
      if (k && !byPurl.has(k)) byPurl.set(k, p.id);
    }
    for (const c of p.cpes ?? []) {
      const k = cpeKey(c);
      if (k && !byCpe.has(k)) byCpe.set(k, p.id);
    }
    for (const n of [p.id, p.label, ...(p.aliases ?? [])]) if (n && !byName.has(nameKey(n))) byName.set(nameKey(n), p.id);
  }
  index = { list, byId, byPurl, byCpe, byName, source: data.source ?? '' };
  return index;
}

/** Tests: read the list again (e.g. after SM_ASSETS_DIR changed). */
export function resetProductIndex(): void {
  index = null;
}

/** The products offered for a tech stack (autocomplete). */
export function stackProducts(): { source: string; products: StackProduct[] } {
  me();
  const i = loadIndex();
  return { source: i.source, products: i.list.map((p) => ({ id: p.id, label: p.label, category: p.category, cycles: p.cycles ?? [] })) };
}

const labelOf = (product: string) => loadIndex().byId.get(product)?.label ?? product;

// ---------- input ----------

const stackEntryInput = z
  .object({
    product: z.string().trim().min(1).max(100),
    version: z.string().trim().max(COMPONENT_LIMITS.version).default(''),
  })
  .strict();

export const componentInput = z
  .object({
    type: z.enum(COMPONENT_TYPES),
    name: z.string().trim().min(1).max(COMPONENT_LIMITS.name),
    url: z.union([httpUrl, z.literal('')]).default(''),
    note: z.string().max(COMPONENT_LIMITS.note).default(''),
    /** The whole stack of the component (missing: unchanged). Entries that keep product and version keep their source; others count as entered by hand. */
    stack: z.array(stackEntryInput).max(COMPONENT_LIMITS.stackPerComponent).optional(),
  })
  .strict();
export type ComponentInput = z.infer<typeof componentInput>;

export const sbomInput = z
  .object({
    /** The SBOM: its JSON text or the parsed document */
    sbom: z.union([z.string().max(COMPONENT_LIMITS.sbomBytes), boundedRecord(z.unknown(), 200)]).optional(),
    /** … or where to fetch it (https, outbound policy applies) */
    url: httpUrl.optional(),
  })
  .strict()
  .refine((b) => (b.sbom === undefined) !== (b.url === undefined), { message: 'Give either the SBOM or its URL' });
export type SbomInput = z.infer<typeof sbomInput>;

// ---------- reading ----------

interface ComponentRow {
  id: string;
  application_id: string;
  type: string;
  name: string;
  url: string;
  note: string;
  sbom_format: string | null;
  sbom_name: string | null;
  sbom_imported_at: string | null;
  sbom_imported_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface StackRow {
  component_id: string;
  product: string;
  version: string;
  source: string;
  sbom_ref: string;
  set_at: string;
  set_by: string;
}

const toEntry = (r: StackRow): StackEntry => ({
  product: r.product,
  label: labelOf(r.product),
  version: r.version,
  source: r.source as StackSource,
  sbomRef: r.sbom_ref,
  setAt: r.set_at,
  setBy: r.set_by,
});

/** The stack of the components of one application, by component. */
function stackOf(appId: string): Map<string, StackEntry[]> {
  const out = new Map<string, StackEntry[]>();
  for (const r of db().all<StackRow>(
    'SELECT cs.* FROM component_stack cs JOIN application_components c ON c.id = cs.component_id WHERE c.application_id = ? ORDER BY cs.product',
    appId,
  ))
    out.set(r.component_id, [...(out.get(r.component_id) ?? []), toEntry(r)]);
  return out;
}

const typeOrder = (t: string) => COMPONENT_TYPES.indexOf(t as ComponentType);

function toComponent(r: ComponentRow, stack: StackEntry[]): ApplicationComponent {
  return {
    id: r.id,
    type: r.type as ComponentType,
    name: r.name,
    url: r.url,
    note: r.note,
    stack,
    sbom:
      r.sbom_format && r.sbom_imported_at
        ? { format: r.sbom_format as SbomFormat, name: r.sbom_name ?? '', importedAt: r.sbom_imported_at, importedBy: r.sbom_imported_by ?? '' }
        : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The components of an application, by type (as listed in COMPONENT_TYPES) and name. */
export function componentsOf(appId: string): ApplicationComponent[] {
  const rows = db()
    .all<ComponentRow>('SELECT * FROM application_components WHERE application_id = ?', appId)
    .sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name));
  const stacks = stackOf(appId);
  return rows.map((r) => toComponent(r, stacks.get(r.id) ?? []));
}

/** Number of components per application. */
export function componentCounts(): Map<string, number> {
  return new Map(
    db()
      .all<{ id: string; n: number }>('SELECT application_id AS id, COUNT(*) AS n FROM application_components GROUP BY application_id')
      .map((c) => [c.id, Number(c.n)]),
  );
}

/** The stack of all components together: one entry per product and version, with the components using it. */
export function stackRollup(components: ApplicationComponent[]): ApplicationStackItem[] {
  const out = new Map<string, ApplicationStackItem>();
  for (const c of components)
    for (const s of c.stack) {
      const k = `${s.product}\u0000${s.version}`;
      const item = out.get(k) ?? { product: s.product, label: s.label, version: s.version, components: [] };
      item.components.push({ id: c.id, name: c.name, type: c.type });
      out.set(k, item);
    }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}

// ---------- changing ----------

type AppRow = { id: string; name: string; owners: string; archived: number };

/**
 * The application, when the user may change it and it is not archived. `canEdit` is the application module's
 * check (passed in to keep the two modules free of import cycles).
 */
function editableApp(appId: string, canEdit: (u: AuthUser | null, r: Pick<AppRow, 'owners'>) => boolean, what: string): AppRow {
  const a = db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE id = ?', appId);
  if (!a) throw new HttpError(404, `Application ${appId} not found`, 'APPLICATION_NOT_FOUND', { id: appId });
  if (!canEdit(currentUser(), a)) forbid(what, 'changeApplication');
  if (a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
  return a;
}

function componentRow(appId: string, componentId: string): ComponentRow {
  const r = db().get<ComponentRow>('SELECT * FROM application_components WHERE id = ? AND application_id = ?', componentId, appId);
  if (!r) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND', { id: componentId });
  return r;
}

function requireKnownProducts(stack: { product: string }[]): void {
  const i = loadIndex();
  const seen = new Set<string>();
  for (const s of stack) {
    if (!i.byId.has(s.product))
      throw new HttpError(400, `"${s.product}" is not a product endoflife.date knows`, 'STACK_PRODUCT_UNKNOWN', { product: s.product });
    if (seen.has(s.product)) throw new HttpError(400, `"${labelOf(s.product)}" is listed twice`, 'STACK_PRODUCT_TWICE', { product: labelOf(s.product) });
    seen.add(s.product);
  }
}

interface StackDiff {
  added: { product: string; version: string }[];
  changed: { product: string; from: string; to: string }[];
  removed: { product: string; version: string }[];
}

const stackSummary = (d: StackDiff): string =>
  [
    ...d.added.map((x) => `+${labelOf(x.product)} ${x.version}`.trim()),
    ...d.changed.map((x) => `${labelOf(x.product)} ${x.from || '?'} → ${x.to || '?'}`),
    ...d.removed.map((x) => `−${labelOf(x.product)}`),
  ].join(', ');

/** Replaces the stack of a component with these entries (inside a transaction). Unchanged entries keep their source. */
function writeStack(componentId: string, wanted: { product: string; version: string }[], u: AuthUser): StackDiff {
  const before = new Map(
    db()
      .all<StackRow>('SELECT * FROM component_stack WHERE component_id = ?', componentId)
      .map((r) => [r.product, r]),
  );
  const diff: StackDiff = { added: [], changed: [], removed: [] };
  const now = nowIso();
  for (const s of wanted) {
    const old = before.get(s.product);
    if (old && old.version === s.version) continue;
    if (old) {
      db().run(
        "UPDATE component_stack SET version = ?, source = 'manual', sbom_ref = '', set_at = ?, set_by = ? WHERE component_id = ? AND product = ?",
        s.version,
        now,
        u.username,
        componentId,
        s.product,
      );
      diff.changed.push({ product: s.product, from: old.version, to: s.version });
    } else {
      db().run(
        "INSERT INTO component_stack (component_id, product, version, source, sbom_ref, set_at, set_by) VALUES (?, ?, ?, 'manual', '', ?, ?)",
        componentId,
        s.product,
        s.version,
        now,
        u.username,
      );
      diff.added.push({ product: s.product, version: s.version });
    }
  }
  const keep = new Set(wanted.map((s) => s.product));
  for (const [product, old] of before)
    if (!keep.has(product)) {
      db().run('DELETE FROM component_stack WHERE component_id = ? AND product = ?', componentId, product);
      diff.removed.push({ product, version: old.version });
    }
  return diff;
}

const touchApplication = (id: string, u: AuthUser) => db().run('UPDATE applications SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

type CanEdit = (u: AuthUser | null, r: Pick<AppRow, 'owners'>) => boolean;

export function addComponent(appId: string, input: ComponentInput, canEdit: CanEdit): ApplicationComponent {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM application_components WHERE application_id = ?', appId)?.n ?? 0);
  if (n >= COMPONENT_LIMITS.perApplication)
    throw new HttpError(409, `An application has at most ${COMPONENT_LIMITS.perApplication} components`, 'COMPONENT_LIMIT', {
      max: COMPONENT_LIMITS.perApplication,
    });
  if (db().get('SELECT 1 FROM application_components WHERE application_id = ? AND type = ? AND lower(name) = lower(?)', appId, input.type, input.name))
    throw new HttpError(409, `The application has a ${input.type} "${input.name}" already`, 'COMPONENT_EXISTS', { name: input.name });
  if (input.stack) requireKnownProducts(input.stack);
  const id = newId('cmp_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO application_components (id, application_id, type, name, url, note, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      appId,
      input.type,
      input.name,
      input.url,
      input.note,
      now,
      u.username,
      now,
      u.username,
    );
    const diff = input.stack ? writeStack(id, input.stack, u) : { added: [], changed: [], removed: [] };
    touchApplication(appId, u);
    audit({
      action: 'application.component_added',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${input.type} "${input.name}" added to application "${a.name}"${diff.added.length ? ` (stack: ${stackSummary(diff)})` : ''}`,
      details: { componentId: id, type: input.type, name: input.name, url: input.url, stack: diff.added },
    });
  });
  return componentsOf(appId).find((c) => c.id === id)!;
}

export function updateComponent(appId: string, componentId: string, input: ComponentInput, canEdit: CanEdit): ApplicationComponent {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  if (
    db().get(
      'SELECT 1 FROM application_components WHERE application_id = ? AND type = ? AND lower(name) = lower(?) AND id <> ?',
      appId,
      input.type,
      input.name,
      componentId,
    )
  )
    throw new HttpError(409, `The application has a ${input.type} "${input.name}" already`, 'COMPONENT_EXISTS', { name: input.name });
  if (input.stack) requireKnownProducts(input.stack);
  const fields = (['type', 'name', 'url', 'note'] as const).filter((k) => input[k] !== cur[k]);
  db().tx(() => {
    const diff = input.stack ? writeStack(componentId, input.stack, u) : { added: [], changed: [], removed: [] };
    const stackChanged = diff.added.length + diff.changed.length + diff.removed.length > 0;
    if (!fields.length && !stackChanged) return;
    db().run(
      'UPDATE application_components SET type = ?, name = ?, url = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.type,
      input.name,
      input.url,
      input.note,
      nowIso(),
      u.username,
      componentId,
    );
    touchApplication(appId, u);
    audit({
      action: 'application.component_changed',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${input.type} "${input.name}" of application "${a.name}" changed (${[...fields, ...(stackChanged ? [`stack: ${stackSummary(diff)}`] : [])].join(', ')})`,
      details: {
        componentId,
        changes: fields,
        ...(fields.includes('name') ? { name: { old: cur.name, new: input.name } } : {}),
        ...(fields.includes('type') ? { type: { old: cur.type, new: input.type } } : {}),
        ...(stackChanged ? { stack: diff } : {}),
      },
    });
  });
  return componentsOf(appId).find((c) => c.id === componentId)!;
}

export function removeComponent(appId: string, componentId: string, canEdit: CanEdit): void {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  const stack = db().all<StackRow>('SELECT * FROM component_stack WHERE component_id = ?', componentId);
  db().tx(() => {
    db().run('DELETE FROM component_stack WHERE component_id = ?', componentId);
    db().run('DELETE FROM application_components WHERE id = ?', componentId);
    touchApplication(appId, u);
    audit({
      action: 'application.component_removed',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${cur.type} "${cur.name}" removed from application "${a.name}"`,
      details: { componentId, type: cur.type, name: cur.name, stack: stack.map((s) => ({ product: s.product, version: s.version, source: s.source })) },
    });
  });
}

// ---------- SBOM ----------

interface SbomItem {
  name: string;
  version: string;
  purl: string;
  cpes: string[];
  /** An operating system (CycloneDX type operating-system, SPDX purpose OPERATING-SYSTEM): matched by name too */
  os: boolean;
}

interface ParsedSbom {
  format: SbomFormat;
  name: string;
  items: SbomItem[];
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function tooMany(): never {
  throw new HttpError(400, `The SBOM lists more than ${COMPONENT_LIMITS.sbomComponents} components – Steward reads at most that many`, 'SBOM_TOO_MANY', {
    max: COMPONENT_LIMITS.sbomComponents,
  });
}

/** Reads a CycloneDX (JSON, 1.2 or newer) or SPDX (JSON, 2.2 or newer) document. */
export function parseSbom(raw: unknown): ParsedSbom {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > COMPONENT_LIMITS.sbomBytes)
      throw new HttpError(400, `The SBOM is larger than ${COMPONENT_LIMITS.sbomBytes / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', {
        max: COMPONENT_LIMITS.sbomBytes / 1024 / 1024,
      });
    try {
      doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      throw new HttpError(400, 'The SBOM is not valid JSON – Steward reads CycloneDX and SPDX in JSON', 'SBOM_INVALID');
    }
  }
  const d = obj(doc);
  if (d && str(d.bomFormat).toLowerCase() === 'cyclonedx') return parseCycloneDx(d);
  if (d && typeof d.spdxVersion === 'string') return parseSpdx(d);
  throw new HttpError(400, 'This is neither a CycloneDX nor an SPDX document (JSON)', 'SBOM_INVALID');
}

function cdxItem(c: Record<string, unknown>): SbomItem {
  const cpes = [str(c.cpe)].filter(Boolean);
  return { name: str(c.name, 200), version: str(c.version, 200), purl: str(c.purl, 1000), cpes, os: str(c.type) === 'operating-system' };
}

function parseCycloneDx(d: Record<string, unknown>): ParsedSbom {
  const items: SbomItem[] = [];
  const meta = obj(obj(d.metadata)?.component);
  // nested components (assemblies), iteratively: no deep recursion on hostile input
  const queue: unknown[] = [...arr(d.components)];
  if (meta) queue.push(...arr(meta.components));
  while (queue.length) {
    const c = obj(queue.pop());
    if (!c) continue;
    if (items.length >= COMPONENT_LIMITS.sbomComponents) tooMany();
    items.push(cdxItem(c));
    for (const sub of arr(c.components)) queue.push(sub);
  }
  if (meta) items.push(cdxItem(meta));
  const name = meta ? [str(meta.name, 200), str(meta.version, 100)].filter(Boolean).join(' ') : '';
  return { format: 'cyclonedx', name, items };
}

function parseSpdx(d: Record<string, unknown>): ParsedSbom {
  const items: SbomItem[] = [];
  for (const p of arr(d.packages)) {
    const o = obj(p);
    if (!o) continue;
    if (items.length >= COMPONENT_LIMITS.sbomComponents) tooMany();
    let purl = '';
    const cpes: string[] = [];
    for (const r of arr(o.externalRefs)) {
      const ref = obj(r);
      if (!ref) continue;
      const type = str(ref.referenceType).toLowerCase();
      const loc = str(ref.referenceLocator, 1000);
      if (type === 'purl' && !purl) purl = loc;
      else if (type.startsWith('cpe')) cpes.push(loc);
    }
    items.push({
      name: str(o.name, 200),
      version: str(o.versionInfo, 200),
      purl,
      cpes,
      os: str(o.primaryPackagePurpose).toUpperCase().replace(/_/g, '-') === 'OPERATING-SYSTEM',
    });
  }
  return { format: 'spdx', name: str(d.name, 200), items };
}

/**
 * The SBOM's items that endoflife.date knows, one per product: package URL first, then CPE, then (operating
 * systems only) the name. Everything else – libraries – stays out. With several items of one product, the
 * first one with a version counts.
 */
export function matchSbom(items: SbomItem[]): Map<string, { version: string; ref: string }> {
  const i = loadIndex();
  const out = new Map<string, { version: string; ref: string }>();
  for (const it of items) {
    let product: string | undefined;
    let ref = '';
    const pk = it.purl ? purlKey(it.purl) : null;
    if (pk && i.byPurl.has(pk)) ((product = i.byPurl.get(pk)), (ref = pk));
    if (!product)
      for (const c of it.cpes) {
        const ck = cpeKey(c);
        if (ck && i.byCpe.has(ck)) {
          product = i.byCpe.get(ck);
          ref = `cpe:${ck}`;
          break;
        }
      }
    if (!product && it.os && it.name && i.byName.has(nameKey(it.name))) ((product = i.byName.get(nameKey(it.name))), (ref = it.name));
    if (!product) continue;
    const version = it.version.trim().slice(0, COMPONENT_LIMITS.version);
    const prev = out.get(product);
    if (!prev || (!prev.version && version)) out.set(product, { version, ref: ref.slice(0, 300) });
  }
  return out;
}

function planSbom(componentId: string, found: Map<string, { version: string; ref: string }>): SbomChange[] {
  const before = new Map(
    db()
      .all<StackRow>('SELECT * FROM component_stack WHERE component_id = ?', componentId)
      .map((r) => [r.product, r]),
  );
  const changes: SbomChange[] = [];
  for (const [product, f] of found) {
    const old = before.get(product);
    const base = { product, label: labelOf(product), sbomRef: f.ref };
    if (!old) changes.push({ ...base, action: 'add', version: f.version, other: null });
    else if (old.source === 'manual')
      changes.push(
        old.version === f.version
          ? { ...base, action: 'keep', version: old.version, other: null }
          : { ...base, action: 'manual', version: old.version, other: f.version },
      );
    else if (old.version === f.version) changes.push({ ...base, action: 'keep', version: f.version, other: null });
    else changes.push({ ...base, action: 'update', version: f.version, other: old.version });
  }
  for (const [product, old] of before)
    if (!found.has(product) && old.source === 'sbom')
      changes.push({ product, label: labelOf(product), action: 'remove', version: old.version, other: null, sbomRef: old.sbom_ref });
  const order = { add: 0, update: 1, remove: 2, manual: 3, keep: 4 } as const;
  return changes.sort((a, b) => order[a.action] - order[b.action] || a.label.localeCompare(b.label));
}

const sbomDispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);

/** Fetches an SBOM: outbound policy, no redirects, at most COMPONENT_LIMITS.sbomBytes, 30 seconds. */
async function fetchSbom(url: string): Promise<string> {
  await assertOutboundAllowed(url, outboundContext());
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/vnd.cyclonedx+json, application/spdx+json, application/json;q=0.9, */*;q=0.1', 'user-agent': BRAND.slug },
      redirect: 'manual',
      dispatcher: sbomDispatcher,
      signal: AbortSignal.timeout(30_000),
    } as RequestInit);
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    if (err.cause?.code === 'ESSRFBLOCKED') throw new HttpError(403, err.cause.message, 'SBOM_FETCH_BLOCKED');
    throw new HttpError(502, 'The SBOM could not be fetched (the host is not reachable)', 'SBOM_FETCH_FAILED');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(
      502,
      `The SBOM could not be fetched (HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ', redirects are not followed' : ''})`,
      'SBOM_FETCH_FAILED',
      { status: res.status },
    );
  }
  const max = COMPONENT_LIMITS.sbomBytes;
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(502, `The SBOM is larger than ${max / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', { max: max / 1024 / 1024 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, `The SBOM is larger than ${max / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', { max: max / 1024 / 1024 });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readSbom(input: SbomInput): Promise<ParsedSbom> {
  return parseSbom(input.url ? await fetchSbom(input.url) : input.sbom);
}

/** What importing this SBOM would change in the component's stack (nothing is stored). */
export async function previewSbom(appId: string, componentId: string, input: SbomInput, canEdit: CanEdit): Promise<SbomPreview> {
  editableApp(appId, canEdit, 'change the components of this application');
  componentRow(appId, componentId);
  const sbom = await readSbom(input);
  const found = matchSbom(sbom.items);
  return { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes: planSbom(componentId, found) };
}

/** Imports the SBOM into the component's stack: entries entered by hand stay, SBOM entries follow the SBOM. */
export async function importSbom(
  appId: string,
  componentId: string,
  input: SbomInput,
  canEdit: CanEdit,
): Promise<{ component: ApplicationComponent; preview: SbomPreview }> {
  // before anything is fetched: only those who may change the component make the server fetch a URL
  editableApp(appId, canEdit, 'change the components of this application');
  componentRow(appId, componentId);
  const sbom = await readSbom(input);
  // checked after the (slow) fetch, so nothing changed in between
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  const found = matchSbom(sbom.items);
  const changes = planSbom(componentId, found);
  const now = nowIso();
  db().tx(() => {
    for (const c of changes) {
      if (c.action === 'add')
        db().run(
          "INSERT INTO component_stack (component_id, product, version, source, sbom_ref, set_at, set_by) VALUES (?, ?, ?, 'sbom', ?, ?, ?)",
          componentId,
          c.product,
          c.version,
          c.sbomRef,
          now,
          u.username,
        );
      else if (c.action === 'update')
        db().run(
          'UPDATE component_stack SET version = ?, sbom_ref = ?, set_at = ?, set_by = ? WHERE component_id = ? AND product = ?',
          c.version,
          c.sbomRef,
          now,
          u.username,
          componentId,
          c.product,
        );
      else if (c.action === 'remove') db().run('DELETE FROM component_stack WHERE component_id = ? AND product = ?', componentId, c.product);
    }
    db().run(
      'UPDATE application_components SET sbom_format = ?, sbom_name = ?, sbom_imported_at = ?, sbom_imported_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      sbom.format,
      sbom.name.slice(0, 200),
      now,
      u.username,
      now,
      u.username,
      componentId,
    );
    touchApplication(appId, u);
    const counted = (k: SbomChange['action']) => changes.filter((c) => c.action === k);
    audit({
      action: 'application.sbom_imported',
      entityType: 'application',
      entityId: appId,
      summary:
        `SBOM (${sbom.format === 'cyclonedx' ? 'CycloneDX' : 'SPDX'}) imported into component "${cur.name}" of application "${a.name}": ` +
        `${counted('add').length} added, ${counted('update').length} changed, ${counted('remove').length} removed, ${counted('manual').length} kept as entered by hand`,
      details: {
        componentId,
        format: sbom.format,
        name: sbom.name,
        ...(input.url ? { url: input.url } : {}),
        total: sbom.items.length,
        matched: found.size,
        changes: changes.filter((c) => c.action !== 'keep').map((c) => ({ action: c.action, product: c.product, version: c.version, other: c.other })),
      },
    });
  });
  return {
    component: componentsOf(appId).find((c) => c.id === componentId)!,
    preview: { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes },
  };
}

// ---------- process input ----------

/** What a process gets for an input of type application: the application with its components and stack. */
export interface ApplicationInputValue {
  id: string;
  name: string;
  criticality: string | null;
  owners: string[];
  tags: string[];
  url: string;
  components: { id: string; type: ComponentType; name: string; url: string; note: string; stack: { product: string; label: string; version: string }[] }[];
  stack: { product: string; label: string; version: string; components: string[] }[];
}

/**
 * Resolves an input of type application: an application id, its name (case does not matter – portable between
 * installations, e.g. in Git), or the value of an earlier run (an object with the id). Archived applications are
 * refused. Everyone who may start the run may read applications, so no further check.
 */
export function applicationInputValue(v: unknown, label: string): ApplicationInputValue {
  const given = typeof v === 'string' ? v.trim() : typeof obj(v)?.id === 'string' ? String(obj(v)!.id) : '';
  if (!given) throw new HttpError(400, `Input "${label}" must name an application`, 'INPUT_APPLICATION_INVALID', { input: label });
  const a =
    db().get<{ id: string; name: string; criticality: string | null; owners: string; tags: string; url: string; archived: number }>(
      'SELECT id, name, criticality, owners, tags, url, archived FROM applications WHERE id = ?',
      given,
    ) ??
    db().get<{ id: string; name: string; criticality: string | null; owners: string; tags: string; url: string; archived: number }>(
      'SELECT id, name, criticality, owners, tags, url, archived FROM applications WHERE lower(name) = lower(?) AND archived = 0',
      given,
    );
  if (!a)
    throw new HttpError(400, `Input "${label}": application "${given.slice(0, 160)}" not found`, 'INPUT_APPLICATION_NOT_FOUND', {
      input: label,
      name: given.slice(0, 160),
    });
  if (a.archived)
    throw new HttpError(400, `Input "${label}": application "${a.name}" is archived`, 'INPUT_APPLICATION_ARCHIVED', { input: label, name: a.name });
  const components = componentsOf(a.id);
  return {
    id: a.id,
    name: a.name,
    criticality: a.criticality,
    owners: parseJson<string[]>(a.owners, []),
    tags: parseJson<string[]>(a.tags, []),
    url: a.url,
    components: components.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      url: c.url,
      note: c.note,
      stack: c.stack.map((s) => ({ product: s.product, label: s.label, version: s.version })),
    })),
    stack: stackRollup(components).map((s) => ({ product: s.product, label: s.label, version: s.version, components: s.components.map((c) => c.name) })),
  };
}
