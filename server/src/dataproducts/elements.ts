import {
  DATA_ELEMENT_KIND_DEFS,
  DATA_PRODUCT_ID_PREFIX,
  dataElementInput,
  dataElementUpdate,
  dataMemberListQuery,
  dataObjectElementInput,
  dataProductMemberUpdate,
  dataProductMembersInput,
  elementKindFits,
  elementNameNorm,
  elementShortName,
  type AclEntry,
  type DataElement,
  type DataElementListQuery,
  type DataElementOnProduct,
  type DataElementReadout,
  type DataElementSummary,
  type DataMemberRole,
  type DataPage,
  type DataProductMember,
  type DataProductPermission,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformAccess } from '../auth/policy.js';
import { assignCreatorTeams } from '../auth/policy.js';
import { likeEscape } from '../database/sql.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canCreate, elementAccess, elementScopeSql, objectAccess, productAccess } from './access.js';
import { HIDDEN, L, actorName, decodeCursor, elementNotFound, encodeCursor, json, limitReached, objectNotFound, pageOf, refOf } from './common.js';
import {
  chunks,
  deleteElementRows,
  elementRow,
  elementTeamIds,
  elementsByIds,
  marks,
  membersOf,
  membershipsOfElements,
  objectRow,
  objectsByIds,
  objectsOfElements,
  productsByIds,
  readoutsOf,
  type ElementRow,
} from './store.js';

/**
 * The element catalogue (ADR 0036 part 5) and membership (part 6): elements are concrete things on a platform – a
 * table, a topic, an API, a path – in one environment, entered, imported or discovered; a product is made of them,
 * many to many, with a role per membership. Lists page by keyset (name, id) and filter by team scope in SQL; the
 * products of a page's elements are read in bulk and counted where the reader may not see them, never named.
 */

const MAX_CHAR = String.fromCodePoint(0x10ffff);

// ---------- platforms as a reader sees them ----------

/** Names of these platforms where `u` may see them (bulk: one statement). */
export function platformNames(u: AuthUser | null, ids: readonly string[]): Map<string, { name: string | null; kind: string }> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, { name: string | null; kind: string }>();
  for (const part of chunks(uniq))
    for (const p of db().all<{ id: string; name: string; kind: string; acl: string }>(
      `SELECT id, name, kind, acl FROM platforms WHERE id IN (${marks(part.length)})`,
      ...part,
    ))
      out.set(p.id, {
        name: platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length ? p.name : null,
        kind: p.kind,
      });
  return out;
}

/** The elements of these rows as a product shows them (decision 15: also those the reader may not see otherwise). */
export function elementsOnProduct(u: AuthUser | null, rows: ElementRow[]): Map<string, DataElementOnProduct> {
  const platforms = platformNames(
    u,
    rows.map((r) => r.platform_id),
  );
  const teams = elementTeamIds(rows.map((r) => r.id));
  return new Map(
    rows.map((r) => {
      const p = r.platform_id ? platforms.get(r.platform_id) : undefined;
      return [
        r.id,
        {
          id: r.id,
          kind: r.kind,
          qualifiedName: r.qualified_name,
          displayName: r.display_name,
          environment: r.environment,
          layer: r.layer,
          platformId: p?.name ? r.platform_id : null,
          platformName: p?.name ?? null,
          platformHidden: !!r.platform_id && !p?.name,
          missingSince: r.missing_since,
          visible: elementAccess(u, teams.get(r.id) ?? []).permissions.length > 0,
        },
      ];
    }),
  );
}

/** Products of these elements: visible ones and hidden ones counted (bulk). */
function productCounts(u: AuthUser | null, elementIds: string[]): Map<string, { visible: number; hidden: number }> {
  const ms = membershipsOfElements(elementIds);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const sees = new Map([...prods.values()].map((p) => [p.id, productAccess(u, p).permissions.length > 0]));
  const out = new Map<string, { visible: number; hidden: number }>(elementIds.map((id) => [id, { visible: 0, hidden: 0 }]));
  for (const m of ms) {
    const c = out.get(m.element_id)!;
    if (sees.get(m.product_id)) c.visible++;
    else c.hidden++;
  }
  return out;
}

function summaryOf(r: ElementRow, platforms: Map<string, { name: string | null }>, products: { visible: number; hidden: number }): DataElementSummary {
  const p = r.platform_id ? platforms.get(r.platform_id) : undefined;
  return {
    id: r.id,
    platformId: p?.name ? r.platform_id : null,
    platformName: p?.name ?? null,
    platformHidden: !!r.platform_id && !p?.name,
    kind: r.kind,
    qualifiedName: r.qualified_name,
    displayName: r.display_name,
    environment: r.environment,
    layer: r.layer,
    source: r.source,
    parentId: r.parent_id,
    missingSince: r.missing_since,
    products,
    updatedAt: r.updated_at,
  };
}

// ---------- the catalogue ----------

/**
 * A page of the catalogue (keyset by name and id, 100 rows): filters by platform, kind, environment, layer, a prefix
 * of the qualified name (by index), a text (a bounded scan; the count capped), in no product, missing. Team scope in
 * SQL; the platforms and products of the page in bulk.
 */
export function listElements(q: DataElementListQuery): DataPage<DataElementSummary> {
  const u = me();
  const scope = elementScopeSql(u);
  const where: string[] = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (q.platformId) {
    where.push('e.platform_id = ?');
    params.push(q.platformId);
  }
  if (q.kind) {
    where.push('e.kind = ?');
    params.push(q.kind);
  }
  if (q.environment !== undefined && q.environment !== '') {
    where.push('e.environment = ?');
    params.push(q.environment);
  }
  if (q.layer) {
    where.push('e.layer = ?');
    params.push(q.layer);
  }
  if (q.prefix) {
    const p = elementNameNorm(q.prefix);
    where.push('e.name_norm >= ? AND e.name_norm < ?');
    params.push(p, p + MAX_CHAR);
  }
  if (q.q) {
    const like = `%${likeEscape(q.q.toLowerCase())}%`;
    where.push("(e.name_norm LIKE ? ESCAPE '\\' OR lower(e.display_name) LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (q.inNoProduct) where.push('NOT EXISTS (SELECT 1 FROM dp_members m WHERE m.element_id = e.id)');
  if (q.missing) where.push('e.missing_since IS NOT NULL');
  const filter = where.join(' AND ');
  const counted = Number(
    db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM dp_elements e WHERE ${filter} LIMIT ${L.countCap + 1}) x`, ...params)!.n,
  );
  const after = decodeCursor(q.cursor);
  const rows = db().all<ElementRow>(
    `SELECT e.* FROM dp_elements e WHERE ${filter}${after ? ' AND (e.name_norm > ? OR (e.name_norm = ? AND e.id > ?))' : ''} ORDER BY e.name_norm, e.id LIMIT ?`,
    ...params,
    ...(after ? [after[0], after[0], after[1]] : []),
    q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const platforms = platformNames(
    u,
    page.map((r) => r.platform_id),
  );
  const counts = productCounts(
    u,
    page.map((r) => r.id),
  );
  const last = page[page.length - 1];
  return {
    items: page.map((r) => summaryOf(r, platforms, counts.get(r.id)!)),
    total: Math.min(counted, L.countCap),
    ...(counted > L.countCap ? { countCapped: true } : {}),
    next: rows.length > q.limit && last ? encodeCursor(last.name_norm, last.id) : null,
  };
}

function visibleElement(id: string, u: AuthUser = me()): { row: ElementRow; perms: DataProductPermission[]; teams: string[] } {
  const row = elementRow(id);
  if (!row) throw elementNotFound(id);
  const teams = elementTeamIds([row.id]).get(row.id) ?? [];
  const perms = elementAccess(u, teams).permissions;
  if (!perms.length) throw elementNotFound(id);
  return { row, perms, teams };
}

export function getElement(id: string): DataElement {
  const u = me();
  const { row: r, perms, teams } = visibleElement(id, u);
  const platforms = platformNames(u, [r.platform_id]);
  const ms = membershipsOfElements([r.id]);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const productRefs = ms
    .map((m) => {
      const p = prods.get(m.product_id);
      return p && productAccess(u, p).permissions.length ? { product: refOf(p), role: m.role } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const objs = objectsByIds(objectsOfElements([r.id]).map((x) => x.object_id));
  const readout = readoutsOf([r.id]).get(r.id);
  const teamNames = teams.length
    ? db().all<{ id: string; name: string }>(`SELECT id, name FROM teams WHERE id IN (${marks(teams.length)}) ORDER BY name`, ...teams)
    : [];
  return {
    ...summaryOf(r, platforms, { visible: productRefs.length, hidden: ms.length - productRefs.length }),
    description: r.description,
    typeLabel: r.type_label,
    discoverySourceId: r.discovery_source_id,
    externalId: r.external_id,
    olNamespace: r.ol_namespace,
    olName: r.ol_name,
    applicationId: r.application_id,
    componentId: r.component_id,
    plantSink: parseJson(r.plant_sink, null),
    apiRef: parseJson(r.api_ref, null),
    flags: parseJson(r.flags, {}),
    owningTeams: teamNames,
    permissions: perms,
    productRefs: productRefs.sort((a, b) => (a.product.name ?? '').localeCompare(b.product.name ?? '')),
    objects: [...objs.values()].map((o) => (objectAccess(u, o).permissions.length ? refOf(o) : HIDDEN)),
    readout: readout ? { ...parseJson<Omit<DataElementReadout, 'readAt'>>(readout.data, {}), readAt: readout.read_at } : null,
    revision: r.revision,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

/** A platform an element may live on: one the caller may see, of a kind that fits (null: none, where the kind allows it). */
function checkPlatform(kind: ElementRow['kind'], platformId: string | null): void {
  if (!platformId) {
    if (!elementKindFits(kind, null))
      throw new HttpError(400, `A ${kind} element lives on a platform`, 'DATA_ELEMENT_PLATFORM', { context: 'needsPlatform', kind });
    return;
  }
  const p = platformNames(me(), [platformId]).get(platformId);
  if (!p?.name) throw new HttpError(404, `Platform ${platformId} not found`, 'PLATFORM_NOT_FOUND', { id: platformId });
  if (!elementKindFits(kind, p.kind))
    throw new HttpError(400, `A ${kind} element cannot live on a ${p.kind} platform`, 'DATA_ELEMENT_PLATFORM', { kind, platformKind: p.kind });
}

/** A parent: an element the caller may see, on the same platform and in the same environment, of a kind that may contain it. */
function checkParent(kind: ElementRow['kind'], platformId: string, environment: string, parentId: string | null, self: string | null): void {
  if (!parentId) return;
  const p = visibleElement(parentId).row;
  if (p.id === self || p.platform_id !== platformId || p.environment !== environment || !DATA_ELEMENT_KIND_DEFS[kind].parentKinds.includes(p.kind))
    throw new HttpError(400, `${p.qualified_name} cannot contain a ${kind} element`, 'DATA_ELEMENT_PARENT', { parent: p.qualified_name, kind });
}

/** The unique key of the catalogue: platform, kind, environment and name (an existing one the caller may not see is not named). */
function refuseExisting(platformId: string, kind: string, environment: string, norm: string, except = ''): void {
  if (
    db().get(
      'SELECT 1 FROM dp_elements WHERE platform_id = ? AND kind = ? AND environment = ? AND name_norm = ? AND id <> ?',
      platformId,
      kind,
      environment,
      norm,
      except,
    )
  )
    throw new HttpError(409, 'An element with this platform, kind, environment and name exists already', 'DATA_ELEMENT_EXISTS', { kind, environment });
}

export function createElement(body: unknown): DataElement {
  const u = me();
  if (!canCreate(u)) forbid('add elements to the catalogue', 'dataProducts');
  const input = dataElementInput.parse(body);
  const platformId = input.platformId ?? '';
  checkPlatform(input.kind, input.platformId);
  const norm = elementNameNorm(input.qualifiedName);
  refuseExisting(platformId, input.kind, input.environment, norm);
  checkParent(input.kind, platformId, input.environment, input.parentId, null);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_elements')!.n) >= L.elements) throw limitReached('elements', L.elements);
  const id = newId(DATA_PRODUCT_ID_PREFIX.element);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, display_name, environment, parent_id, layer, description, type_label, source,
         application_id, component_id, plant_sink, api_ref, flags, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entered', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      platformId,
      input.kind,
      input.qualifiedName,
      norm,
      input.displayName || elementShortName(input.qualifiedName),
      input.environment,
      input.parentId,
      input.layer,
      input.description,
      input.typeLabel,
      input.applicationId,
      input.componentId,
      input.plantSink ? json(input.plantSink) : null,
      input.apiRef ? json(input.apiRef) : null,
      json(Object.fromEntries(input.flags.map((f) => [f.name, f.value]))),
      now,
      u.username,
      now,
      u.username,
    );
    assignCreatorTeams('data_element', id, u);
    audit({
      action: 'dataelement.created',
      entityType: 'data_element',
      entityId: id,
      summary: `Data element ${input.qualifiedName} (${input.kind}${input.environment ? `, ${input.environment}` : ''}) added to the catalogue`,
      details: { kind: input.kind, platformId: input.platformId, environment: input.environment },
    });
  });
  return getElement(id);
}

/**
 * Changes an element. People's fields – display name, layer, description, type label, owner application, component,
 * plant sink, API reference – always; the qualified name and the environment only of an element that was entered or
 * imported (a discovered element's technical fields come from its platform).
 */
export function updateElement(id: string, body: unknown): DataElement {
  const { row: r, perms } = visibleElement(id);
  if (!perms.includes('edit')) forbid('change this element', 'dataProducts');
  const input = dataElementUpdate.parse(body);
  const renames =
    (input.qualifiedName !== undefined && input.qualifiedName !== r.qualified_name) || (input.environment !== undefined && input.environment !== r.environment);
  if (renames && r.source === 'discovered')
    throw new HttpError(400, 'A discovered element keeps the name and environment its platform gives it', 'DATA_ELEMENT_DISCOVERED', {
      element: r.qualified_name,
    });
  const qualifiedName = input.qualifiedName ?? r.qualified_name;
  const environment = input.environment ?? r.environment;
  const norm = elementNameNorm(qualifiedName);
  if (renames) {
    refuseExisting(r.platform_id, r.kind, environment, norm, r.id);
    if (environment !== r.environment && db().get('SELECT 1 FROM dp_port_elements WHERE element_id = ?', r.id))
      throw new HttpError(409, 'The element is bound to a port in its environment – unbind it first', 'DATA_ELEMENT_ENVIRONMENT', {
        context: 'bound',
        element: r.qualified_name,
        environment: r.environment,
        binding: environment,
      });
  }
  const pick = <K extends keyof typeof input>(k: K, cur: unknown) => (input[k] === undefined ? cur : input[k]);
  db().tx(() => {
    db().run(
      `UPDATE dp_elements SET qualified_name = ?, name_norm = ?, environment = ?, display_name = ?, layer = ?, description = ?, type_label = ?, application_id = ?,
         component_id = ?, plant_sink = ?, api_ref = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      qualifiedName,
      norm,
      environment,
      pick('displayName', r.display_name) || elementShortName(qualifiedName),
      pick('layer', r.layer),
      pick('description', r.description),
      pick('typeLabel', r.type_label),
      pick('applicationId', r.application_id),
      pick('componentId', r.component_id),
      input.plantSink === undefined ? r.plant_sink : input.plantSink ? json(input.plantSink) : null,
      input.apiRef === undefined ? r.api_ref : input.apiRef ? json(input.apiRef) : null,
      nowIso(),
      actorName(),
      r.id,
    );
    audit({
      action: renames ? 'dataelement.renamed' : 'dataelement.updated',
      entityType: 'data_element',
      entityId: r.id,
      summary: renames
        ? `Data element ${r.qualified_name} renamed to ${qualifiedName}${environment !== r.environment ? ` (${environment})` : ''}`
        : `Data element ${r.qualified_name} changed`,
      details: { fields: Object.keys(input), ...(renames ? { from: r.qualified_name, to: qualifiedName, environment } : {}) },
    });
  });
  return getElement(r.id);
}

/** Deletes an element that is in no product (manage). A member of a product is removed from it first – by its editors. */
export function deleteElement(id: string): void {
  const { row: r, perms } = visibleElement(id);
  if (!perms.includes('manage')) forbid('delete this element', 'dataProducts');
  const used = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_members WHERE element_id = ?', r.id)!.n);
  // counted, not named: the products may be another team's
  if (used) throw new HttpError(409, `The element is part of ${used} data product(s) – remove it there first`, 'DATA_ELEMENT_IN_USE', { count: used });
  db().tx(() => {
    deleteElementRows([r.id]);
    audit({
      action: 'dataelement.deleted',
      entityType: 'data_element',
      entityId: r.id,
      summary: `Data element ${r.qualified_name} (${r.kind}) deleted from the catalogue`,
    });
  });
}

// ---------- membership ----------

function memberView(
  m: { product_id: string; element_id: string; role: DataMemberRole; include_descendants: number; note: string; added_by: string; added_at: string },
  el: DataElementOnProduct,
): DataProductMember {
  return {
    productId: m.product_id,
    elementId: m.element_id,
    role: m.role,
    includeDescendants: !!m.include_descendants,
    note: m.note,
    addedBy: m.added_by,
    addedAt: m.added_at,
    element: el,
  };
}

/** A page of a product's members (filters: role, environment), sorted by the element's name. */
export function listMembers(productId: string, query: unknown): DataPage<DataProductMember> {
  const u = me();
  const q = dataMemberListQuery.parse(query ?? {});
  const ms = membersOf([productId]).filter((m) => !q.role || m.role === q.role);
  const rows = elementsByIds(ms.map((m) => m.element_id));
  const matching = ms.filter((m) => rows.has(m.element_id) && (q.environment === undefined || rows.get(m.element_id)!.environment === q.environment));
  const page = pageOf(
    matching,
    (m) => rows.get(m.element_id)!.name_norm,
    (m) => m.element_id,
    q.cursor,
    q.limit,
  );
  const shown = elementsOnProduct(
    u,
    page.items.map((m) => rows.get(m.element_id)!),
  );
  return { items: page.items.map((m) => memberView(m, shown.get(m.element_id)!)), total: matching.length, next: page.next };
}

/**
 * Adds elements to a product with a role (needs edit on the product and view on each element; adding gives nobody
 * rights on the element). An element that is a member already gets the new role and note. The product gains the
 * elements' environments (planned). `includeDescendants` only for a project or a bundle.
 */
export function addMembers(productId: string, productName: string, body: unknown): { added: number; changed: number } {
  const u = me();
  const input = dataProductMembersInput.parse(body);
  const ids = [...new Set(input.elementIds)];
  const rows = elementsByIds(ids);
  const teams = elementTeamIds(ids);
  for (const id of ids) {
    const r = rows.get(id);
    if (!r || !elementAccess(u, teams.get(id) ?? []).permissions.length) throw elementNotFound(id);
    if (input.includeDescendants && !DATA_ELEMENT_KIND_DEFS[r.kind].container)
      throw new HttpError(400, `${r.qualified_name} has nothing below it`, 'DATA_ELEMENT_PARENT', { parent: r.qualified_name, kind: r.kind });
  }
  const existing = new Set(
    membersOf([productId])
      .filter((m) => ids.includes(m.element_id))
      .map((m) => m.element_id),
  );
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_members WHERE product_id = ?', productId)!.n);
  const adding = ids.filter((id) => !existing.has(id));
  if (count + adding.length > L.membersPerProduct) throw limitReached('membersPerProduct', L.membersPerProduct);
  const now = nowIso();
  db().tx(() => {
    for (const id of ids) {
      if (existing.has(id))
        db().run(
          'UPDATE dp_members SET role = ?, include_descendants = ?, note = ? WHERE product_id = ? AND element_id = ?',
          input.role,
          input.includeDescendants ? 1 : 0,
          input.note,
          productId,
          id,
        );
      else
        db().run(
          'INSERT INTO dp_members (product_id, element_id, role, include_descendants, note, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          productId,
          id,
          input.role,
          input.includeDescendants ? 1 : 0,
          input.note,
          actorName(),
          now,
        );
      const env = rows.get(id)!.environment;
      if (env)
        db().run(
          `INSERT INTO dp_product_environments (product_id, environment, state, updated_at, updated_by) VALUES (?, ?, 'planned', ?, ?) ON CONFLICT DO NOTHING`,
          productId,
          env,
          now,
          actorName(),
        );
    }
    const names = ids.map((id) => rows.get(id)!.qualified_name);
    audit({
      action: adding.length ? 'dataproduct.member_added' : 'dataproduct.member_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": ${adding.length} element(s) added${existing.size ? `, ${existing.size} changed` : ''} as ${input.role}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}`,
      details: { role: input.role, added: adding, changed: [...existing], includeDescendants: input.includeDescendants },
    });
  });
  return { added: adding.length, changed: existing.size };
}

/** The output or input ports of this product an element is bound to (the role follows them). */
function boundDirections(productId: string, elementId: string): Set<string> {
  return new Set(
    db()
      .all<{ direction: string }>(
        `SELECT DISTINCT p.direction FROM dp_port_elements pe JOIN dp_port_bindings b ON b.id = pe.binding_id JOIN dp_ports p ON p.id = b.port_id
         WHERE pe.element_id = ? AND p.product_id = ?`,
        elementId,
        productId,
      )
      .map((r) => r.direction),
  );
}

export function updateMember(productId: string, productName: string, elementId: string, body: unknown): DataProductMember {
  const input = dataProductMemberUpdate.parse(body);
  const m = membersOf([productId]).find((x) => x.element_id === elementId);
  if (!m) throw new HttpError(404, `The element ${elementId} is not part of this product`, 'DATA_MEMBER_NOT_FOUND', { id: elementId });
  const el = elementRow(elementId)!;
  if (input.role && input.role !== m.role) {
    const bound = boundDirections(productId, elementId);
    const want = bound.has('output') ? 'output' : bound.has('input') ? 'input' : null;
    if (want && input.role !== want)
      throw new HttpError(409, `${el.qualified_name} is bound to an ${want} port: its role is ${want}`, 'DATA_PORT_BINDING', { context: 'role', role: want });
  }
  if (input.includeDescendants && !DATA_ELEMENT_KIND_DEFS[el.kind].container)
    throw new HttpError(400, `${el.qualified_name} has nothing below it`, 'DATA_ELEMENT_PARENT', { parent: el.qualified_name, kind: el.kind });
  db().tx(() => {
    db().run(
      'UPDATE dp_members SET role = ?, include_descendants = ?, note = ? WHERE product_id = ? AND element_id = ?',
      input.role ?? m.role,
      input.includeDescendants === undefined ? m.include_descendants : input.includeDescendants ? 1 : 0,
      input.note ?? m.note,
      productId,
      elementId,
    );
    audit({
      action: 'dataproduct.member_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": ${el.qualified_name} ${input.role && input.role !== m.role ? `is now ${input.role}` : 'changed'}`,
      details: { elementId, role: input.role ?? m.role },
    });
  });
  const shown = elementsOnProduct(me(), [el]).get(el.id)!;
  return memberView(
    {
      ...m,
      role: input.role ?? m.role,
      include_descendants: input.includeDescendants === undefined ? m.include_descendants : input.includeDescendants ? 1 : 0,
      note: input.note ?? m.note,
    },
    shown,
  );
}

/** Removes an element from one product (and from that product's bindings); other products keep it. */
export function removeMember(productId: string, productName: string, elementId: string): void {
  const m = membersOf([productId]).find((x) => x.element_id === elementId);
  if (!m) throw new HttpError(404, `The element ${elementId} is not part of this product`, 'DATA_MEMBER_NOT_FOUND', { id: elementId });
  const el = elementRow(elementId);
  db().tx(() => {
    db().run(
      'DELETE FROM dp_port_elements WHERE element_id = ? AND binding_id IN (SELECT b.id FROM dp_port_bindings b JOIN dp_ports p ON p.id = b.port_id WHERE p.product_id = ?)',
      elementId,
      productId,
    );
    db().run('DELETE FROM dp_members WHERE product_id = ? AND element_id = ?', productId, elementId);
    audit({
      action: 'dataproduct.member_removed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": ${el?.qualified_name ?? elementId} removed`,
      details: { elementId, role: m.role },
    });
  });
}

// ---------- data objects implemented by elements ----------

function editableObject(id: string) {
  const o = objectRow(id);
  const perms = o ? objectAccess(me(), o).permissions : [];
  if (!o || !perms.length) throw objectNotFound(id);
  if (!perms.includes('edit')) forbid('change this data object', 'dataProducts');
  return o;
}

/** A page of the elements that implement a data object (the ones the reader may see; the others counted). */
export function objectElements(objectId: string, cursor: string | undefined): DataPage<DataElementSummary> & { hidden: number } {
  const u = me();
  const o = objectRow(objectId);
  if (!o || !objectAccess(u, o).permissions.length) throw objectNotFound(objectId);
  const scope = elementScopeSql(u);
  const all = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_object_elements WHERE object_id = ?', o.id)!.n);
  const after = decodeCursor(cursor);
  const rows = db().all<ElementRow>(
    `SELECT e.* FROM dp_object_elements oe JOIN dp_elements e ON e.id = oe.element_id WHERE oe.object_id = ? AND ${scope.sql}${after ? ' AND (e.name_norm > ? OR (e.name_norm = ? AND e.id > ?))' : ''}
     ORDER BY e.name_norm, e.id LIMIT ?`,
    o.id,
    ...scope.params,
    ...(after ? [after[0], after[0], after[1]] : []),
    L.page + 1,
  );
  const visible = Number(
    db().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dp_object_elements oe JOIN dp_elements e ON e.id = oe.element_id WHERE oe.object_id = ? AND ${scope.sql}`,
      o.id,
      ...scope.params,
    )!.n,
  );
  const page = rows.slice(0, L.page);
  const platforms = platformNames(
    u,
    page.map((r) => r.platform_id),
  );
  const counts = productCounts(
    u,
    page.map((r) => r.id),
  );
  const last = page[page.length - 1];
  return {
    items: page.map((r) => summaryOf(r, platforms, counts.get(r.id)!)),
    total: visible,
    hidden: all - visible,
    next: rows.length > L.page && last ? encodeCursor(last.name_norm, last.id) : null,
  };
}

/** An element implements a data object (needs edit on the object and view on the element). */
export function addObjectElement(objectId: string, body: unknown): void {
  const o = editableObject(objectId);
  const input = dataObjectElementInput.parse(body);
  visibleElement(input.elementId);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_object_elements (object_id, element_id, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (object_id, element_id) DO UPDATE SET note = excluded.note`,
      o.id,
      input.elementId,
      input.note,
      actorName(),
      nowIso(),
    );
    db().run('UPDATE dp_objects SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), actorName(), o.id);
    audit({
      action: 'dataobject.updated',
      entityType: 'data_object',
      entityId: o.id,
      summary: `Data object "${o.name}": implemented by element ${input.elementId}`,
      details: { elementId: input.elementId, note: input.note },
    });
  });
}

export function removeObjectElement(objectId: string, elementId: string): void {
  const o = editableObject(objectId);
  db().tx(() => {
    const n = db().run('DELETE FROM dp_object_elements WHERE object_id = ? AND element_id = ?', o.id, elementId).changes;
    if (!n) throw elementNotFound(elementId);
    db().run('UPDATE dp_objects SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), actorName(), o.id);
    audit({
      action: 'dataobject.updated',
      entityType: 'data_object',
      entityId: o.id,
      summary: `Data object "${o.name}": no longer implemented by element ${elementId}`,
      details: { elementId, removed: true },
    });
  });
}

/** Whether `u` may see these elements (bulk), by id. */
export function elementsVisible(u: AuthUser | null, ids: readonly string[]): Map<string, boolean> {
  const teams = elementTeamIds(ids);
  return new Map(ids.map((id) => [id, elementAccess(u, teams.get(id) ?? []).permissions.length > 0]));
}
