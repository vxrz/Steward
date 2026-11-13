import {
  DATA_PRODUCT_ID_PREFIX,
  dataDomainInput,
  dataObjectInput,
  dataProductInput,
  dataProductLifecycleInput,
  dataProductRatingInput,
  dataRatingInput,
  environmentRank,
  isProductionEnvironment,
  lifecycleProblems,
  type CatalogueEnvironment,
  type DataClassification,
  type DataDomain,
  type DataEnvironmentState,
  type DataObject,
  type DataObjectListQuery,
  type DataObjectSummary,
  type DataPage,
  type DataProduct,
  type DataProductEnvironment,
  type DataProductLifecycle,
  type DataProductListQuery,
  type DataProductPermission,
  type DataProductSummary,
  type DataRef,
  type DataMemberRole,
  type RatingFloor,
  type RatingFloorDimension,
  type OwnedKind,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentStore, currentUser, type AuthUser } from '../auth/context.js';
import { forbid, me } from '../auth/access.js';
import { assignCreatorTeams, forgetOwningTeams, newResourceTeams, owningTeams, type OwningTeam } from '../auth/policy.js';
import { auditNamedGrant, outsidersOf, requireNamedGrant, type NamedGrant } from '../auth/named-grants.js';
import { environmentList } from '../catalogue/environments.js';
import { currentScale } from '../catalogue/cia.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canCreate, canManageModule, domainAccess, elementScopeSql, objectAccess, productAccess } from './access.js';
import { HIDDEN, L, actorName, domainNotFound, json, limitReached, objectNotFound, pageOf, productNotFound, refOf, refs } from './common.js';
import { deleteRatings, floorsOf, needsRerating, productsOfObjects, ratingsByItem, writeRating } from './ratings.js';
import {
  chunks,
  consumersOf,
  consumingPorts,
  environmentsOf,
  marks,
  objectsByIds,
  portsOf,
  productRow,
  productsByIds,
  domainRow,
  objectRow,
  type DomainRow,
  type ObjectRow,
  type ProductEnvironmentRow,
  type ProductRow,
} from './store.js';
import { portViews } from './ports.js';
import { onLifecycleChanged } from './notices.js';
import { forgetGovernance } from './governance-cleanup.js';

/**
 * Domains, data objects and data products (ADR 0036 parts 1–4, 12, 17): reading with team scope (a reader never sees,
 * counts or is told about what they may not see – a hidden domain or successor is a reference without a name), writing
 * with the rights of access.ts, named owners from outside the owning teams confirmed (access.grant), every change
 * audited. Members, ports and consumers are in members.ts and ports.ts, elements in elements.ts, steps in steps.ts.
 */

// ---------- environments ----------

/** Settings → Environments, read once per request (sorting the environments of every product of a page in a loop). */
const environmentsOfRequest = new WeakMap<object, CatalogueEnvironment[]>();
function requestEnvironments(): CatalogueEnvironment[] {
  const store = currentStore();
  if (!store) return environmentList();
  let list = environmentsOfRequest.get(store);
  if (!list) environmentsOfRequest.set(store, (list = environmentList()));
  return list;
}

/** Production first, then the order of Settings → Environments, unlisted ones after, by name. */
export function sortEnvironments(names: Iterable<string>, list: CatalogueEnvironment[] = requestEnvironments()): string[] {
  return [...new Set(names)].sort(
    (a, b) =>
      Number(isProductionEnvironment(list, b)) - Number(isProductionEnvironment(list, a)) ||
      environmentRank(list, a) - environmentRank(list, b) ||
      a.localeCompare(b),
  );
}

/** Adds an environment to a product (planned) when a member or a binding names one it does not have yet. */
export function ensureEnvironment(productId: string, environment: string): void {
  if (!environment) return;
  db().run(
    `INSERT INTO dp_product_environments (product_id, environment, state, updated_at, updated_by) VALUES (?, ?, 'planned', ?, ?) ON CONFLICT DO NOTHING`,
    productId,
    environment,
    nowIso(),
    actorName(),
  );
}

// ---------- domains ----------

const allDomains = (): DomainRow[] => db().all<DomainRow>('SELECT * FROM dp_domains ORDER BY name, id');

/** Domains by id as a reader sees them: a reference, or a hidden one. */
function domainRefs(u: AuthUser | null, rows: DomainRow[] = allDomains()): Map<string, DataRef> {
  return new Map(rows.map((d) => [d.id, domainAccess(u, d).permissions.length ? refOf(d) : HIDDEN]));
}

/** Products and data objects per domain that `u` may see (bulk: two statements). */
function domainCounts(u: AuthUser | null): Map<string, { products: number; objects: number }> {
  const out = new Map<string, { products: number; objects: number }>();
  const bump = (id: string | null, k: 'products' | 'objects') => {
    if (!id) return;
    const c = out.get(id) ?? { products: 0, objects: 0 };
    c[k]++;
    out.set(id, c);
  };
  for (const p of db().all<{ id: string; domain_id: string | null; owners: string }>(
    'SELECT id, domain_id, owners FROM dp_products WHERE domain_id IS NOT NULL',
  ))
    if (productAccess(u, p).permissions.length) bump(p.domain_id, 'products');
  for (const o of db().all<{ id: string; domain_id: string | null; owner: string | null; stewards: string }>(
    'SELECT id, domain_id, owner, stewards FROM dp_objects WHERE domain_id IS NOT NULL',
  ))
    if (objectAccess(u, o).permissions.length) bump(o.domain_id, 'objects');
  return out;
}

function domainView(d: DomainRow, perms: DataProductPermission[], counts: { products: number; objects: number } | undefined): DataDomain {
  return {
    id: d.id,
    key: d.key,
    name: d.name,
    description: d.description,
    parentId: d.parent_id,
    colour: (d.colour as DataDomain['colour']) ?? null,
    owners: parseJson<string[]>(d.owners, []),
    owningTeams: owningTeams('data_domain', d.id),
    products: counts?.products ?? 0,
    objects: counts?.objects ?? 0,
    permissions: perms,
    revision: d.revision,
    createdAt: d.created_at,
    createdBy: d.created_by,
    updatedAt: d.updated_at,
    updatedBy: d.updated_by,
  };
}

export function listDomains(): DataDomain[] {
  const u = me();
  const counts = domainCounts(u);
  return allDomains()
    .map((d) => ({ d, perms: domainAccess(u, d).permissions }))
    .filter((x) => x.perms.length)
    .map((x) => domainView(x.d, x.perms, counts.get(x.d.id)));
}

function visibleDomain(id: string): { row: DomainRow; perms: DataProductPermission[] } {
  const row = domainRow(id);
  if (!row) throw domainNotFound(id);
  const perms = domainAccess(me(), row).permissions;
  if (!perms.length) throw domainNotFound(id);
  return { row, perms };
}

export function getDomain(id: string): DataDomain {
  const { row, perms } = visibleDomain(id);
  return domainView(row, perms, domainCounts(me()).get(row.id));
}

/** The key of a domain, data object or product is unique; one the reader may not see is not named. */
function refuseTakenKey(table: 'dp_domains' | 'dp_objects' | 'dp_products', key: string, except = ''): void {
  if (db().get(`SELECT 1 FROM ${table} WHERE key = ? AND id <> ?`, key, except))
    throw new HttpError(409, `The key "${key}" is taken – choose another one`, 'DATA_PRODUCT_KEY_TAKEN', { key });
}

/** A domain's parent: an existing top-level domain the caller may see, not the domain itself; a domain with sub-domains stays top-level. */
function checkParent(id: string | null, parentId: string | null): void {
  if (!parentId) return;
  const p = domainRow(parentId);
  if (!p || !domainAccess(me(), p).permissions.length) throw domainNotFound(parentId);
  if (p.id === id || p.parent_id)
    throw new HttpError(400, 'Domains have two levels: a sub-domain belongs to a top-level domain', 'DATA_DOMAIN_LEVELS', { parent: p.name });
  if (id && db().get('SELECT 1 FROM dp_domains WHERE parent_id = ?', id))
    throw new HttpError(400, 'This domain has sub-domains: it stays a top-level domain', 'DATA_DOMAIN_LEVELS', { parent: p.name });
}

const subjectsGrant = (
  entityType: string,
  id: string | null,
  label: string,
  teams: readonly OwningTeam[],
  field: string,
  before: string[],
  after: string[],
  rights: string[],
): NamedGrant => ({ entityType, entityId: id, label, field, teams, before, after: [...new Set(after)], rights });

const teamsOf = (kind: OwnedKind, id: string | null): OwningTeam[] => (id ? owningTeams(kind, id) : newResourceTeams(currentUser()).teams);

/** Named domain owners from outside its owning teams (the route's step-up asks before the handler). */
export function domainNamesOutsiders(id: string | null, body: unknown): string[] {
  const input = dataDomainInput.parse(body);
  const cur = id ? domainRow(id) : undefined;
  if (id && (!cur || !domainAccess(me(), cur).permissions.includes('edit'))) return [];
  if (!id && !canManageModule(me())) return [];
  return outsidersOf(
    subjectsGrant('data_domain', id, `domain "${input.name}"`, teamsOf('data_domain', id), 'owners', parseJson(cur?.owners, []), input.owners, [
      'view',
      'edit',
      'manage',
    ]),
  );
}

export function createDomain(body: unknown): DataDomain {
  const u = me();
  if (!canManageModule(u)) forbid('create data domains', 'dataProducts');
  const input = dataDomainInput.parse(body);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_domains')!.n) >= L.domains) throw limitReached('domains', L.domains);
  refuseTakenKey('dp_domains', input.key);
  checkParent(null, input.parentId);
  const grant = subjectsGrant('data_domain', null, `domain "${input.name}"`, teamsOf('data_domain', null), 'owners', [], input.owners, [
    'view',
    'edit',
    'manage',
  ]);
  const added = requireNamedGrant(grant);
  const id = newId(DATA_PRODUCT_ID_PREFIX.domain);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_domains (id, key, name, description, parent_id, colour, owners, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.key,
      input.name,
      input.description,
      input.parentId,
      input.colour,
      json(input.owners),
      now,
      u.username,
      now,
      u.username,
    );
    assignCreatorTeams('data_domain', id, u);
    audit({
      action: 'datadomain.created',
      entityType: 'data_domain',
      entityId: id,
      summary: `Data domain "${input.name}" (${input.key}) created`,
      details: { key: input.key, parentId: input.parentId },
    });
    auditNamedGrant({ ...grant, entityId: id }, added);
  });
  return getDomain(id);
}

export function updateDomain(id: string, body: unknown): DataDomain {
  const { row, perms } = visibleDomain(id);
  if (!perms.includes('edit')) forbid('change this data domain', 'dataProducts');
  const input = dataDomainInput.parse(body);
  refuseTakenKey('dp_domains', input.key, row.id);
  checkParent(row.id, input.parentId);
  const grant = subjectsGrant(
    'data_domain',
    row.id,
    `domain "${input.name}"`,
    owningTeams('data_domain', row.id),
    'owners',
    parseJson(row.owners, []),
    input.owners,
    ['view', 'edit', 'manage'],
  );
  const added = requireNamedGrant(grant);
  db().tx(() => {
    db().run(
      `UPDATE dp_domains SET key = ?, name = ?, description = ?, parent_id = ?, colour = ?, owners = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      input.key,
      input.name,
      input.description,
      input.parentId,
      input.colour,
      json(input.owners),
      nowIso(),
      actorName(),
      row.id,
    );
    audit({
      action: 'datadomain.updated',
      entityType: 'data_domain',
      entityId: row.id,
      summary: `Data domain "${input.name}" changed`,
      details: { before: { key: row.key, name: row.name, parentId: row.parent_id }, after: { key: input.key, name: input.name, parentId: input.parentId } },
    });
    auditNamedGrant({ ...grant, entityId: row.id }, added);
  });
  return getDomain(row.id);
}

export function deleteDomain(id: string): void {
  const { row, perms } = visibleDomain(id);
  if (!perms.includes('manage')) forbid('delete this data domain', 'dataProducts');
  const used =
    Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_domains WHERE parent_id = ?', row.id)!.n) +
    Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_products WHERE domain_id = ?', row.id)!.n) +
    Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_objects WHERE domain_id = ?', row.id)!.n);
  // counted, not named: the products and objects may be another team's
  if (used)
    throw new HttpError(409, 'The domain still has sub-domains, data products or data objects – move them first', 'DATA_DOMAIN_IN_USE', { count: used });
  db().tx(() => {
    db().run('DELETE FROM dp_domains WHERE id = ?', row.id);
    forgetOwningTeams('data_domain', row.id);
    audit({ action: 'datadomain.deleted', entityType: 'data_domain', entityId: row.id, summary: `Data domain "${row.name}" (${row.key}) deleted` });
  });
}

/** A domain the caller may see, for an item they change (404 otherwise). */
function usableDomain(id: string | null): void {
  if (!id) return;
  const d = domainRow(id);
  if (!d || !domainAccess(me(), d).permissions.length) throw domainNotFound(id);
}

// ---------- data objects ----------

function objectSummary(o: ObjectRow, perms: DataProductPermission[], domains: Map<string, DataRef>, rating: DataObjectSummary['rating']): DataObjectSummary {
  return {
    id: o.id,
    key: o.key,
    name: o.name,
    domain: o.domain_id ? (domains.get(o.domain_id) ?? HIDDEN) : null,
    lifecycle: o.lifecycle as DataObjectSummary['lifecycle'],
    classification: (o.classification as DataClassification | null) ?? null,
    personalData: o.personal_data as DataObjectSummary['personalData'],
    rating,
    owner: o.owner,
    permissions: perms,
    updatedAt: o.updated_at,
  };
}

export function listObjects(q: DataObjectListQuery): DataPage<DataObjectSummary> {
  const u = me();
  const text = q.q?.toLowerCase();
  const rows = db()
    .all<Pick<ObjectRow, 'id' | 'key' | 'name_norm' | 'owner' | 'stewards' | 'domain_id' | 'lifecycle' | 'classification' | 'personal_data'>>(
      'SELECT id, key, name_norm, owner, stewards, domain_id, lifecycle, classification, personal_data FROM dp_objects',
    )
    .filter(
      (o) =>
        (!q.domain || o.domain_id === q.domain || false) &&
        (!q.lifecycle || o.lifecycle === q.lifecycle) &&
        (!q.classification || o.classification === q.classification) &&
        (!q.personalData || o.personal_data === q.personalData) &&
        (!text || o.name_norm.includes(text) || o.key.includes(text)),
    )
    .map((o) => ({ o, perms: objectAccess(u, o).permissions }))
    .filter((x) => x.perms.length);
  const page = pageOf(
    rows,
    (x) => x.o.name_norm,
    (x) => x.o.id,
    q.cursor,
    q.limit,
  );
  const full = objectsByIds(page.items.map((x) => x.o.id));
  const ratings = ratingsByItem('object', [...full.keys()]);
  const domains = domainRefs(u);
  return {
    items: page.items.map((x) => objectSummary(full.get(x.o.id)!, x.perms, domains, ratings.get(x.o.id)!)),
    total: rows.length,
    next: page.next,
  };
}

function visibleObject(id: string): { row: ObjectRow; perms: DataProductPermission[] } {
  const row = objectRow(id);
  if (!row) throw objectNotFound(id);
  const perms = objectAccess(me(), row).permissions;
  if (!perms.length) throw objectNotFound(id);
  return { row, perms };
}

/** Products the reader may see, by id: a reference each; others counted as hidden. */
function productRefs(u: AuthUser | null, ids: Iterable<string>): { items: DataRef[]; hidden: number } {
  const rows = productsByIds([...ids]);
  const items: DataRef[] = [];
  let hidden = 0;
  for (const r of rows.values()) {
    if (productAccess(u, r).permissions.length) items.push(refOf(r));
    else hidden++;
  }
  items.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return { items, hidden };
}

export function getObject(id: string): DataObject {
  const u = me();
  const { row: o, perms } = visibleObject(id);
  const rating = ratingsByItem('object', [o.id]).get(o.id)!;
  const total = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_object_elements WHERE object_id = ?', o.id)!.n);
  const scope = elementScopeSql(u);
  const visible = Number(
    db().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dp_object_elements oe JOIN dp_elements e ON e.id = oe.element_id WHERE oe.object_id = ? AND ${scope.sql}`,
      o.id,
      ...scope.params,
    )!.n,
  );
  return {
    ...objectSummary(o, perms, domainRefs(u), rating),
    definition: o.definition,
    synonyms: parseJson(o.synonyms, []),
    categories: parseJson(o.categories, []),
    specialCategories: parseJson(o.special_categories, []),
    subjects: parseJson(o.subjects, []),
    legalBasis: (o.legal_basis as DataObject['legalBasis']) ?? null,
    legalNote: o.legal_note,
    purposes: parseJson(o.purposes, []),
    retention: o.retention,
    deletionRule: o.deletion_rule,
    regulatoryFlags: parseJson(o.regulatory_flags, []),
    attributes: parseJson(o.attributes, []),
    stewards: parseJson(o.stewards, []),
    custodians: parseJson(o.custodians, []),
    externalRefs: refs(o.external_refs),
    owningTeams: owningTeams('data_object', o.id),
    elements: { visible, hidden: total - visible },
    products: productRefs(u, productsOfObjects([o.id]).get(o.id) ?? []),
    revision: o.revision,
    createdAt: o.created_at,
    createdBy: o.created_by,
    updatedBy: o.updated_by,
  };
}

const objectSubjects = (o: { owner: string | null; stewards: string[] }) => [...(o.owner ? [`user:${o.owner.toLowerCase()}`] : []), ...o.stewards];

export function objectNamesOutsiders(id: string | null, body: unknown): string[] {
  const input = dataObjectInput.parse(body);
  const cur = id ? objectRow(id) : undefined;
  if (id && (!cur || !objectAccess(me(), cur).permissions.includes('edit'))) return [];
  if (!id && !canCreate(me())) return [];
  return outsidersOf(objectGrant(cur, input.name, objectSubjects(input)));
}

function objectGrant(cur: ObjectRow | undefined, name: string, after: string[]): NamedGrant {
  return subjectsGrant(
    'data_object',
    cur?.id ?? null,
    `data object "${name}"`,
    teamsOf('data_object', cur?.id ?? null),
    'owner and stewards',
    cur ? objectSubjects({ owner: cur.owner, stewards: parseJson(cur.stewards, []) }) : [],
    after,
    ['view'],
  );
}

function objectValues(input: ReturnType<typeof dataObjectInput.parse>): unknown[] {
  return [
    input.key,
    input.name,
    input.name.toLowerCase(),
    input.definition,
    json(input.synonyms),
    input.domainId,
    input.lifecycle,
    input.classification,
    input.personalData,
    json(input.categories),
    json(input.specialCategories),
    json(input.subjects),
    input.legalBasis,
    input.legalNote,
    json(input.purposes),
    input.retention,
    input.deletionRule,
    json(input.regulatoryFlags),
    json(input.attributes),
    input.owner ? input.owner.toLowerCase() : null,
    json(input.stewards),
    json(input.custodians),
    json(input.externalRefs),
  ];
}
const OBJECT_COLUMNS =
  'key, name, name_norm, definition, synonyms, domain_id, lifecycle, classification, personal_data, categories, special_categories, subjects, legal_basis, legal_note, purposes, retention, deletion_rule, regulatory_flags, attributes, owner, stewards, custodians, external_refs';

export function createObject(body: unknown): DataObject {
  const u = me();
  if (!canCreate(u)) forbid('create data objects', 'dataProducts');
  const input = dataObjectInput.parse(body);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_objects')!.n) >= L.objects) throw limitReached('objects', L.objects);
  refuseTakenKey('dp_objects', input.key);
  usableDomain(input.domainId);
  const grant = objectGrant(undefined, input.name, objectSubjects(input));
  const added = requireNamedGrant(grant);
  const id = newId(DATA_PRODUCT_ID_PREFIX.object);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_objects (id, ${OBJECT_COLUMNS}, lifecycle_dates, created_at, created_by, updated_at, updated_by) VALUES (?, ${marks(23)}, ?, ?, ?, ?, ?)`,
      id,
      ...objectValues(input),
      json({ [input.lifecycle]: now.slice(0, 10) }),
      now,
      u.username,
      now,
      u.username,
    );
    assignCreatorTeams('data_object', id, u);
    audit({
      action: 'dataobject.created',
      entityType: 'data_object',
      entityId: id,
      summary: `Data object "${input.name}" (${input.key}) created`,
      details: { key: input.key },
    });
    auditNamedGrant({ ...grant, entityId: id }, added);
  });
  return getObject(id);
}

export function updateObject(id: string, body: unknown): DataObject {
  const { row, perms } = visibleObject(id);
  if (!perms.includes('edit')) forbid('change this data object', 'dataProducts');
  const input = dataObjectInput.parse(body);
  refuseTakenKey('dp_objects', input.key, row.id);
  if (input.domainId !== row.domain_id) usableDomain(input.domainId);
  const grant = objectGrant(row, input.name, objectSubjects(input));
  const added = requireNamedGrant(grant);
  const dates = parseJson<Record<string, string>>(row.lifecycle_dates, {});
  if (input.lifecycle !== row.lifecycle) dates[input.lifecycle] = nowIso().slice(0, 10);
  db().tx(() => {
    db().run(
      `UPDATE dp_objects SET ${OBJECT_COLUMNS.split(', ')
        .map((c) => `${c} = ?`)
        .join(', ')}, lifecycle_dates = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...objectValues(input),
      json(dates),
      nowIso(),
      actorName(),
      row.id,
    );
    audit({
      action: 'dataobject.updated',
      entityType: 'data_object',
      entityId: row.id,
      summary: `Data object "${input.name}" changed${input.lifecycle !== row.lifecycle ? ` (${row.lifecycle} → ${input.lifecycle})` : ''}`,
      details: { key: input.key, classification: input.classification, personalData: input.personalData, lifecycle: input.lifecycle },
    });
    auditNamedGrant({ ...grant, entityId: row.id }, added);
  });
  return getObject(row.id);
}

export function deleteObject(id: string): void {
  const { row, perms } = visibleObject(id);
  if (!perms.includes('manage')) forbid('delete this data object', 'dataProducts');
  db().tx(() => {
    db().run('DELETE FROM dp_port_objects WHERE object_id = ?', row.id);
    db().run('DELETE FROM dp_object_elements WHERE object_id = ?', row.id);
    deleteRatings('object', row.id);
    db().run('DELETE FROM dp_objects WHERE id = ?', row.id);
    forgetOwningTeams('data_object', row.id);
    audit({ action: 'dataobject.deleted', entityType: 'data_object', entityId: row.id, summary: `Data object "${row.name}" (${row.key}) deleted` });
  });
}

export function rateObject(id: string, body: unknown): DataObject {
  const { row, perms } = visibleObject(id);
  if (!perms.includes('edit')) forbid('rate this data object', 'dataProducts');
  const input = dataRatingInput.parse(body);
  db().tx(() => {
    const changes = writeRating('object', row.id, input, actorName());
    if (changes.length) {
      db().run('UPDATE dp_objects SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), actorName(), row.id);
      audit({
        action: 'dataobject.rated',
        entityType: 'data_object',
        entityId: row.id,
        summary: `Data object "${row.name}" rated: ${changes.map((c) => `${c.dimension} ${c.from ?? 'not rated'} → ${c.to ?? 'not rated'}`).join(', ')}`,
        details: { changes },
      });
    }
  });
  return getObject(row.id);
}

// ---------- products ----------

interface SummaryData {
  items: DataProductSummary[];
  floors: Map<string, RatingFloor & { objectIds: string[] }>;
  objects: Map<string, ObjectRow>;
  envRows: ProductEnvironmentRow[];
  list: CatalogueEnvironment[];
}

/** The summaries of these products as `u` sees them (bulk: a fixed number of statements for the page), with what they read. */
function summaryData(u: AuthUser | null, rows: { row: ProductRow; perms: DataProductPermission[] }[]): SummaryData {
  const list = environmentList();
  if (!rows.length) return { items: [], floors: new Map(), objects: new Map(), envRows: [], list };
  const scale = currentScale();
  const ids = rows.map((r) => r.row.id);
  const ratings = ratingsByItem('product', ids, scale);
  const read: { objects?: Map<string, ObjectRow> } = {};
  const floors = floorsOf(
    rows.map((r) => r.row),
    ratings,
    scale,
    read,
  );
  const domains = domainRefs(u);
  const envRows = environmentsOf(ids);
  const envs = new Map<string, string[]>();
  for (const e of envRows) envs.set(e.product_id, [...(envs.get(e.product_id) ?? []), e.environment]);
  const items = rows.map(({ row: p, perms }) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    type: (p.type as DataProductSummary['type']) ?? null,
    domain: p.domain_id ? (domains.get(p.domain_id) ?? HIDDEN) : null,
    lifecycle: p.lifecycle as DataProductLifecycle,
    sunsetDate: p.sunset_date,
    criticality: (p.criticality as DataProductSummary['criticality']) ?? null,
    tier: (p.tier as DataProductSummary['tier']) ?? null,
    rating: ratings.get(p.id)!,
    classification: (p.classification as DataClassification | null) ?? null,
    ratingBelowObjects: !!floors.get(p.id)?.warning,
    valueTier: (p.value_tier as DataProductSummary['valueTier']) ?? null,
    environments: sortEnvironments(envs.get(p.id) ?? [], list),
    owners: parseJson<string[]>(p.owners, []),
    owningTeams: owningTeams('data_product', p.id),
    tags: parseJson<string[]>(p.tags, []),
    version: p.version,
    permissions: perms,
    updatedAt: p.updated_at,
  }));
  return { items, floors, objects: read.objects ?? new Map(), envRows, list };
}

const summaries = (u: AuthUser | null, rows: { row: ProductRow; perms: DataProductPermission[] }[]): DataProductSummary[] => summaryData(u, rows).items;

export function listProducts(q: DataProductListQuery): DataPage<DataProductSummary> {
  const u = me();
  const text = q.q?.toLowerCase();
  const inEnv = q.environment
    ? new Set(
        db()
          .all<{ product_id: string }>('SELECT product_id FROM dp_product_environments WHERE environment = ?', q.environment)
          .map((r) => r.product_id),
      )
    : null;
  const rows = db()
    .all<Pick<ProductRow, 'id' | 'key' | 'name_norm' | 'owners' | 'domain_id' | 'type' | 'lifecycle'>>(
      'SELECT id, key, name_norm, owners, domain_id, type, lifecycle FROM dp_products',
    )
    .filter(
      (p) =>
        (!q.domain || p.domain_id === q.domain || false) &&
        (!q.type || p.type === q.type) &&
        (!q.lifecycle || p.lifecycle === q.lifecycle) &&
        (!inEnv || inEnv.has(p.id)) &&
        (!text || p.name_norm.includes(text) || p.key.includes(text)) &&
        (!q.team || owningTeams('data_product', p.id).some((t) => t.id === q.team)),
    )
    .map((p) => ({ p, perms: productAccess(u, p).permissions }))
    .filter((x) => x.perms.length);
  // a sub-domain's products are part of its domain's list
  if (q.domain) {
    const subs = new Set(
      db()
        .all<{ id: string }>('SELECT id FROM dp_domains WHERE parent_id = ?', q.domain)
        .map((r) => r.id),
    );
    if (subs.size) {
      const more = db()
        .all<Pick<ProductRow, 'id' | 'key' | 'name_norm' | 'owners' | 'domain_id' | 'type' | 'lifecycle'>>(
          `SELECT id, key, name_norm, owners, domain_id, type, lifecycle FROM dp_products WHERE domain_id IN (${marks(subs.size)})`,
          ...subs,
        )
        .filter(
          (p) =>
            (!q.type || p.type === q.type) &&
            (!q.lifecycle || p.lifecycle === q.lifecycle) &&
            (!inEnv || inEnv.has(p.id)) &&
            (!text || p.name_norm.includes(text) || p.key.includes(text)),
        )
        .filter((p) => !q.team || owningTeams('data_product', p.id).some((t) => t.id === q.team))
        .map((p) => ({ p, perms: productAccess(u, p).permissions }))
        .filter((x) => x.perms.length);
      rows.push(...more);
    }
  }
  const page = pageOf(
    rows,
    (x) => x.p.name_norm,
    (x) => x.p.id,
    q.cursor,
    q.limit,
  );
  const full = productsByIds(page.items.map((x) => x.p.id));
  return {
    items: summaries(
      u,
      page.items.map((x) => ({ row: full.get(x.p.id)!, perms: x.perms })),
    ),
    total: rows.length,
    next: page.next,
  };
}

export function visibleProduct(id: string, u: AuthUser = me()): { row: ProductRow; perms: DataProductPermission[] } {
  const row = productRow(id);
  if (!row) throw productNotFound(id);
  const perms = productAccess(u, row).permissions;
  if (!perms.length) throw productNotFound(id);
  return { row, perms };
}

/** A product the caller may change (404 when they may not see it, 403 when they may only look). */
export function editableProduct(id: string, right: 'edit' | 'manage' = 'edit'): { row: ProductRow; perms: DataProductPermission[] } {
  const p = visibleProduct(id);
  if (!p.perms.includes(right)) forbid(right === 'manage' ? 'manage this data product' : 'change this data product', 'dataProducts');
  return p;
}

/** Marks a product changed (members, ports, bindings and consumers count as changes of the product). */
export function touchProduct(id: string): void {
  db().run('UPDATE dp_products SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), actorName(), id);
}

export function getProduct(id: string): DataProduct {
  const u = me();
  const { row: p, perms } = visibleProduct(id, u);
  const data = summaryData(u, [{ row: p, perms }]);
  const summary = data.items[0];
  const { list, envRows } = data;
  const ports = portViews(u, p.id, data.objects);
  const counts: Record<DataMemberRole, number> = { input: 0, internal: 0, output: 0 };
  for (const r of db().all<{ role: DataMemberRole; n: number }>('SELECT role, COUNT(*) AS n FROM dp_members WHERE product_id = ? GROUP BY role', p.id))
    counts[r.role] = Number(r.n);
  const floor = data.floors.get(p.id)!;
  const objectRefs = floor.objectIds
    .map((oid) => data.objects.get(oid))
    .filter((o): o is ObjectRow => !!o)
    .map((o) => (objectAccess(u, o).permissions.length ? refOf(o) : HIDDEN));
  const successor = p.successor_id ? productRow(p.successor_id) : undefined;
  const environmentDetails: DataProductEnvironment[] = sortEnvironments(
    envRows.map((e) => e.environment),
    list,
  ).map((name) => {
    const e = envRows.find((x) => x.environment === name)!;
    return { environment: name, state: e.state as DataEnvironmentState, monitorId: e.monitor_id, production: isProductionEnvironment(list, name) };
  });
  const visibleIds = new Set(objectRefs.filter((r) => !r.hidden).map((r) => r.id));
  return {
    ...summary!,
    description: p.description,
    purpose: p.purpose,
    support: { channel: '', url: '', hours: '', ...parseJson<Partial<DataProduct['support']>>(p.support, {}) },
    lifecycleDates: parseJson(p.lifecycle_dates, {}),
    successor: successor ? (productAccess(u, successor).permissions.length ? refOf(successor) : HIDDEN) : null,
    valueStatement: p.value_statement,
    valueAmount: p.value_amount === null ? null : Number(p.value_amount),
    valueCurrency: p.value_currency,
    ratingReasons: parseJson(p.rating_reason, {}),
    ratingFloor: {
      // the objects a finding names: only those the reader may see (a hidden one is counted in `objects`)
      findings: floor.findings.map((f) => ({ ...f, from: f.from.filter((oid) => visibleIds.has(oid)) })),
      warning: floor.warning,
      highestClassification: floor.highestClassification,
      objects: objectRefs,
    },
    externalRefs: refs(p.external_refs),
    environmentDetails,
    ports,
    memberCounts: counts,
    objects: objectRefs,
    revision: p.revision,
    createdAt: p.created_at,
    createdBy: p.created_by,
    updatedBy: p.updated_by,
  };
}

function productGrant(cur: ProductRow | undefined, name: string, owners: string[]): NamedGrant {
  return subjectsGrant(
    'data_product',
    cur?.id ?? null,
    `data product "${name}"`,
    teamsOf('data_product', cur?.id ?? null),
    'owners',
    parseJson(cur?.owners, []),
    owners,
    ['view', 'edit', 'manage'],
  );
}

/** Named product owners from outside the owning teams (the route's step-up asks before the handler). */
export function productNamesOutsiders(id: string | null, body: unknown): string[] {
  const input = dataProductInput.parse(body);
  const cur = id ? productRow(id) : undefined;
  if (id && (!cur || !productAccess(me(), cur).permissions.includes('edit'))) return [];
  if (!id && !canCreate(me())) return [];
  return outsidersOf(productGrant(cur, input.name, input.owners));
}

/** A successor: another product the caller may see. */
function usableSuccessor(id: string | null, self: string | null): void {
  if (!id) return;
  const s = productRow(id);
  if (!s || !productAccess(me(), s).permissions.length) throw productNotFound(id);
  if (s.id === self) throw new HttpError(400, 'A product cannot be its own successor', 'DATA_PRODUCT_LIFECYCLE', { context: 'ownSuccessor' });
}

function productValues(input: ReturnType<typeof dataProductInput.parse>): unknown[] {
  return [
    input.key,
    input.name,
    input.name.toLowerCase(),
    input.description,
    input.purpose,
    input.type,
    input.domainId,
    json(input.owners),
    json(input.support),
    input.criticality,
    input.tier,
    input.version,
    input.valueStatement,
    input.valueTier,
    input.valueAmount,
    input.valueCurrency,
    input.successorId,
    json(input.tags),
    json(input.externalRefs),
  ];
}
const PRODUCT_COLUMNS =
  'key, name, name_norm, description, purpose, type, domain_id, owners, support, criticality, tier, version, value_statement, value_tier, value_amount, value_currency, successor_id, tags, external_refs';

export function createProduct(body: unknown): DataProduct {
  const u = me();
  if (!canCreate(u)) forbid('create data products', 'dataProducts');
  const input = dataProductInput.parse(body);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_products')!.n) >= L.products) throw limitReached('products', L.products);
  refuseTakenKey('dp_products', input.key);
  usableDomain(input.domainId);
  usableSuccessor(input.successorId, null);
  const grant = productGrant(undefined, input.name, input.owners);
  const added = requireNamedGrant(grant);
  const id = newId(DATA_PRODUCT_ID_PREFIX.product);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_products (id, ${PRODUCT_COLUMNS}, lifecycle, lifecycle_dates, created_at, created_by, updated_at, updated_by) VALUES (?, ${marks(19)}, 'proposed', ?, ?, ?, ?, ?)`,
      id,
      ...productValues(input),
      json({ proposed: now.slice(0, 10) }),
      now,
      u.username,
      now,
      u.username,
    );
    assignCreatorTeams('data_product', id, u);
    audit({
      action: 'dataproduct.created',
      entityType: 'data_product',
      entityId: id,
      summary: `Data product "${input.name}" (${input.key}) created`,
      details: { key: input.key, type: input.type, domainId: input.domainId },
    });
    auditNamedGrant({ ...grant, entityId: id }, added);
  });
  return getProduct(id);
}

export function updateProduct(id: string, body: unknown): DataProduct {
  const { row } = editableProduct(id);
  const input = dataProductInput.parse(body);
  refuseTakenKey('dp_products', input.key, row.id);
  if (input.domainId !== row.domain_id) usableDomain(input.domainId);
  if (input.successorId !== row.successor_id) usableSuccessor(input.successorId, row.id);
  const grant = productGrant(row, input.name, input.owners);
  const added = requireNamedGrant(grant);
  db().tx(() => {
    db().run(
      `UPDATE dp_products SET ${PRODUCT_COLUMNS.split(', ')
        .map((c) => `${c} = ?`)
        .join(', ')}, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...productValues(input),
      nowIso(),
      actorName(),
      row.id,
    );
    audit({
      action: 'dataproduct.updated',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${input.name}" changed`,
      details: {
        before: { key: row.key, name: row.name, domainId: row.domain_id, type: row.type },
        after: { key: input.key, name: input.name, domainId: input.domainId, type: input.type },
      },
    });
    auditNamedGrant({ ...grant, entityId: row.id }, added);
  });
  return getProduct(row.id);
}

export function deleteProduct(id: string): void {
  const { row } = editableProduct(id, 'manage');
  const ports = portsOf([row.id]);
  const portIds = ports.map((p) => p.id);
  db().tx(() => {
    forgetGovernance({ productId: row.id, portIds });
    // input ports of other products that consumed its ports keep a note of what they consumed
    for (const c of consumingPorts(portIds).filter((c) => c.product_id !== row.id)) {
      const src = ports.find((p) => p.id === c.source_port_id);
      db().run(
        "UPDATE dp_ports SET source_kind = 'text', source_port_id = NULL, source_text = ? WHERE id = ?",
        `${row.key}/${src?.name ?? ''}${src?.version ? ` ${src.version}` : ''} (deleted)`.slice(0, L.text),
        c.id,
      );
    }
    for (const part of chunks(portIds)) {
      const m = marks(part.length);
      db().run(`DELETE FROM dp_port_elements WHERE binding_id IN (SELECT id FROM dp_port_bindings WHERE port_id IN (${m}))`, ...part);
      db().run(`DELETE FROM dp_port_bindings WHERE port_id IN (${m})`, ...part);
      db().run(`DELETE FROM dp_port_objects WHERE port_id IN (${m})`, ...part);
      db().run(`DELETE FROM dp_consumers WHERE port_id IN (${m})`, ...part);
      db().run(`UPDATE dp_ports SET successor_id = NULL WHERE successor_id IN (${m})`, ...part);
    }
    db().run('DELETE FROM dp_ports WHERE product_id = ?', row.id);
    db().run('DELETE FROM dp_members WHERE product_id = ?', row.id);
    db().run('DELETE FROM dp_product_environments WHERE product_id = ?', row.id);
    db().run('DELETE FROM dp_cost_matches WHERE product_id = ?', row.id);
    db().run("DELETE FROM dp_consumers WHERE consumer_kind = 'product' AND ref_id = ?", row.id);
    db().run('UPDATE dp_products SET successor_id = NULL WHERE successor_id = ?', row.id);
    db().run("DELETE FROM dp_notices WHERE kind = 'product' AND item_id = ?", row.id);
    deleteRatings('product', row.id);
    db().run('DELETE FROM dp_products WHERE id = ?', row.id);
    forgetOwningTeams('data_product', row.id);
    audit({
      action: 'dataproduct.deleted',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}" (${row.key}) deleted`,
      details: { ports: portIds.length },
    });
  });
}

/**
 * Rates a product (CIA, classification) and keeps the reasons for being below its data objects. A reason is only taken
 * for a dimension that is below the floor after the change (DATA_PRODUCT_RATING_REASON otherwise): reasons explain a
 * gap, they do not decorate a rating. Below the floor without a reason is allowed and warned (decision 8).
 */
export function rateProduct(id: string, body: unknown): DataProduct {
  const { row } = editableProduct(id);
  const input = dataProductRatingInput.parse(body);
  const reasons = parseJson<Partial<Record<RatingFloorDimension, string>>>(row.rating_reason, {});
  for (const [d, v] of Object.entries(input.reasons ?? {}) as [RatingFloorDimension, string | null | undefined][]) {
    if (v === undefined) continue;
    if (v === null || !v.trim()) delete reasons[d];
    else reasons[d] = v.trim();
  }
  const classification = input.classification === undefined ? row.classification : input.classification;
  db().tx(() => {
    const changes = writeRating('product', row.id, input, actorName());
    const ratings = ratingsByItem('product', [row.id]);
    const floor = floorsOf([{ id: row.id, classification, rating_reason: json(reasons) }], ratings).get(row.id)!;
    const below = new Set(floor.findings.map((f) => f.dimension));
    for (const d of Object.keys(input.reasons ?? {}) as RatingFloorDimension[])
      if (reasons[d] && !below.has(d))
        throw new HttpError(400, `${d} is not below the data objects this product exposes: there is nothing to explain`, 'DATA_PRODUCT_RATING_REASON', {
          dimension: d,
        });
    // a reason whose gap closed is dropped
    for (const d of Object.keys(reasons) as RatingFloorDimension[]) if (!below.has(d)) delete reasons[d];
    const classificationChanged = classification !== row.classification;
    db().run(
      'UPDATE dp_products SET classification = ?, rating_reason = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      classification,
      json(reasons),
      nowIso(),
      actorName(),
      row.id,
    );
    if (changes.length || classificationChanged || input.reasons)
      audit({
        action: 'dataproduct.rated',
        entityType: 'data_product',
        entityId: row.id,
        summary: `Data product "${row.name}" rated: ${
          [
            ...changes.map((c) => `${c.dimension} ${c.from ?? 'not rated'} → ${c.to ?? 'not rated'}`),
            ...(classificationChanged ? [`classification ${row.classification ?? 'none'} → ${classification ?? 'none'}`] : []),
          ].join(', ') || 'reasons changed'
        }${floor.warning ? ' – below its data objects without a reason' : ''}`,
        details: { changes, classification, reasons, belowObjects: floor.findings.map((f) => f.dimension) },
      });
  });
  return getProduct(row.id);
}

/** Registered consumers of a product's output ports and active products consuming them (retiring asks for a confirmation). */
function consumersOfProduct(productId: string): number {
  const outputs = portsOf([productId]).filter((p) => p.direction === 'output');
  const ids = outputs.map((p) => p.id);
  const registered = consumersOf(ids).length;
  const consuming = consumingPorts(ids).filter((c) => c.product_id !== productId);
  const active = consuming.length ? [...productsByIds(consuming.map((c) => c.product_id)).values()].filter((p) => p.lifecycle !== 'retired').length : 0;
  return registered + active;
}

/**
 * Changes the lifecycle (part 3): active needs an owner and an output port; deprecated a sunset date; retired a
 * confirmation while consumers are registered or consuming products are active (and the manage right – the route is
 * session-only). The date of each state is kept. Audited (dataproduct.lifecycle_changed).
 */
export function changeLifecycle(id: string, body: unknown): DataProduct {
  const input = dataProductLifecycleInput.parse(body);
  const { row } = editableProduct(id, input.lifecycle === 'retired' ? 'manage' : 'edit');
  const sunset = input.sunsetDate === undefined ? row.sunset_date : input.sunsetDate;
  const successor = input.successorId === undefined ? row.successor_id : input.successorId;
  if (successor !== row.successor_id) usableSuccessor(successor, row.id);
  const outputPorts = portsOf([row.id]).filter((p) => p.direction === 'output').length;
  const consumers = input.lifecycle === 'retired' ? consumersOfProduct(row.id) : 0;
  const problems = lifecycleProblems(input.lifecycle, {
    owners: parseJson(row.owners, []),
    outputPorts,
    sunsetDate: sunset,
    consumers,
    confirmed: input.confirm,
  });
  if (problems.length)
    throw new HttpError(409, `The data product cannot become ${input.lifecycle}: ${problems.join(', ')}`, 'DATA_PRODUCT_LIFECYCLE', {
      lifecycle: input.lifecycle,
      context: problems[0]!,
      problems: problems.join(', '),
      consumers,
    });
  const dates = parseJson<Record<string, string>>(row.lifecycle_dates, {});
  if (input.lifecycle !== row.lifecycle) dates[input.lifecycle] = nowIso().slice(0, 10);
  db().tx(() => {
    db().run(
      'UPDATE dp_products SET lifecycle = ?, lifecycle_dates = ?, sunset_date = ?, successor_id = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      input.lifecycle,
      json(dates),
      input.lifecycle === 'deprecated' || input.lifecycle === 'retired' ? sunset : null,
      successor,
      nowIso(),
      actorName(),
      row.id,
    );
    audit({
      action: 'dataproduct.lifecycle_changed',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": ${row.lifecycle} → ${input.lifecycle}${input.lifecycle === 'deprecated' && sunset ? ` (sunset ${sunset})` : ''}${input.lifecycle === 'retired' && consumers ? ` with ${consumers} consumer(s), confirmed` : ''}`,
      details: { from: row.lifecycle, to: input.lifecycle, sunsetDate: sunset, successorId: successor, consumers },
    });
  });
  // deprecated: the consumers are told once (notices.ts, WP4)
  onLifecycleChanged('product', row.id, { from: row.lifecycle, to: input.lifecycle, sunsetDate: sunset, sunsetBefore: row.sunset_date });
  return getProduct(row.id);
}

/** Adds an environment or changes its state (planned, available, withdrawn). */
export function setEnvironment(id: string, environment: string, state: DataEnvironmentState): DataProduct {
  const { row } = editableProduct(id);
  const env = environment.trim();
  if (!env || env.length > 60) throw new HttpError(400, 'Name an environment', 'DATA_ELEMENT_ENVIRONMENT', { context: 'name', environment: env.slice(0, 60) });
  db().tx(() => {
    db().run(
      `INSERT INTO dp_product_environments (product_id, environment, state, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (product_id, environment) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      row.id,
      env,
      state,
      nowIso(),
      actorName(),
    );
    touchProduct(row.id);
    audit({
      action: 'dataproduct.updated',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": environment ${env} ${state}`,
      details: { environment: env, state },
    });
  });
  return getProduct(row.id);
}

/** Removes an environment that has no bindings and no member elements any more. */
export function removeEnvironment(id: string, environment: string): DataProduct {
  const { row } = editableProduct(id);
  const used =
    Number(
      db().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM dp_port_bindings b JOIN dp_ports p ON p.id = b.port_id WHERE p.product_id = ? AND b.environment = ?',
        row.id,
        environment,
      )!.n,
    ) +
    Number(
      db().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM dp_members m JOIN dp_elements e ON e.id = m.element_id WHERE m.product_id = ? AND e.environment = ?',
        row.id,
        environment,
      )!.n,
    );
  if (used)
    throw new HttpError(409, `The product still has bindings or elements in ${environment} – remove them first`, 'DATA_ENVIRONMENT_IN_USE', {
      environment,
      count: used,
    });
  db().tx(() => {
    db().run('DELETE FROM dp_product_environments WHERE product_id = ? AND environment = ?', row.id, environment);
    touchProduct(row.id);
    audit({
      action: 'dataproduct.updated',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": environment ${environment} removed`,
      details: { environment },
    });
  });
  return getProduct(row.id);
}

/** Whether a product's rating needs re-rating (a scale change flagged it) – for lists and notices. */
export const productNeedsRerating = needsRerating;
