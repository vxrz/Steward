import YAML from 'yaml';
import { CIA_DIMENSIONS, type AclEntry, type DataObjectives, type DataStepRunner, type PlatformPermission } from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { contractAccess, platformAccess } from '../auth/policy.js';
import { permissionsFor } from '../processes/service.js';
import { canViewCatalogue } from '../records/access.js';
import { parseJson } from '../util.js';
import { domainAccess, elementAccess, elementScopeSql, objectAccess, productAccess } from './access.js';
import { domainNotFound } from './common.js';
import { sortEnvironments, visibleProduct } from './service.js';
import { productSteps } from './steps.js';
import { ratingsByItem } from './ratings.js';
import {
  bindingsOf,
  consumersOf,
  elementTeamIds,
  elementsByIds,
  environmentsOf,
  marks,
  membersOf,
  portObjectsOf,
  portsOf,
  productsByIds,
  type DomainRow,
  type ElementRow,
  type ObjectRow,
  type PortRow,
  type ProductRow,
} from './store.js';
import {
  DATA_PRODUCT_FORMAT_VERSION,
  DATA_PRODUCT_IMPORT_LIMITS,
  type BindingFile,
  type ConsumerFile,
  type DataProductsFile,
  type DomainFile,
  type ElementFile,
  type ElementRefFile,
  type ObjectFile,
  type PortFile,
  type ProductFile,
  type RunnerFile,
  type StepFile,
} from './format.js';

/**
 * The export in Steward's file format (ADR 0036 part 15): a product, a domain (with its sub-domains) or everything the
 * reader may see, optionally for one environment. Team scope: what the reader may not see is neither written nor
 * named – a hidden domain, successor, data object, contract or consumer is left out of the entry that names it (an
 * import of the file then keeps what Steward has), an element on a platform the reader may not see is left out.
 * Never in a file: credentials, platform variables, discovery run-as users, readouts, check states, costs.
 *
 * The entries are built by the same functions the importer compares with (`Snapshot`), so an export imported again
 * changes nothing.
 */

// ---------- references the reader may see ----------

type Refs = Map<string, ElementRefFile | null>;

/** What an export or an import reads once: platforms, domains, objects, products and elements as `u` may see them. */
export class Snapshot {
  readonly u: AuthUser;
  private platformName = new Map<string, string | null>();
  private elementRows = new Map<string, ElementRow>();
  private elementSeen = new Map<string, boolean>();
  private domains: Map<string, DomainRow> | null = null;
  private objectKeys = new Map<string, string | null>();
  private productKeys = new Map<string, string | null>();

  constructor(u: AuthUser = me()) {
    this.u = u;
  }

  /** Platforms by id: the name where `u` may see it (null: hidden or gone). */
  platforms(ids: Iterable<string>): void {
    const missing = [...new Set(ids)].filter((id) => id && !this.platformName.has(id));
    if (!missing.length) return;
    for (const id of missing) this.platformName.set(id, null);
    for (let i = 0; i < missing.length; i += 500) {
      const part = missing.slice(i, i + 500);
      for (const p of db().all<{ id: string; name: string; acl: string }>(`SELECT id, name, acl FROM platforms WHERE id IN (${marks(part.length)})`, ...part))
        this.platformName.set(
          p.id,
          platformAccess(this.u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length ? p.name : null,
        );
    }
  }
  platformNameOf(id: string): string | null {
    this.platforms([id]);
    return this.platformName.get(id) ?? null;
  }

  /** Loads elements (and their platforms and parents) for references. */
  elements(ids: Iterable<string>): void {
    const missing = [...new Set(ids)].filter((id) => !this.elementRows.has(id));
    if (!missing.length) return;
    const rows = elementsByIds(missing);
    for (const r of rows.values()) this.elementRows.set(r.id, r);
    const teams = elementTeamIds([...rows.keys()]);
    for (const r of rows.values()) this.elementSeen.set(r.id, elementAccess(this.u, teams.get(r.id) ?? []).permissions.length > 0);
    this.platforms([...rows.values()].map((r) => r.platform_id));
    const parents = [...rows.values()].map((r) => r.parent_id).filter((p): p is string => !!p && !this.elementRows.has(p));
    if (parents.length) this.elements(parents);
  }
  elementRow(id: string): ElementRow | undefined {
    return this.elementRows.get(id);
  }
  /** The reader may see the element itself (not only as a product's content). */
  seesElement(id: string): boolean {
    return !!this.elementSeen.get(id);
  }
  /** A reference to an element (null: unknown, or on a platform the reader may not see – not written). */
  ref(id: string): ElementRefFile | null {
    this.elements([id]);
    const r = this.elementRows.get(id);
    if (!r) return null;
    const platform = r.platform_id ? this.platformName.get(r.platform_id) : null;
    if (r.platform_id && !platform) return null;
    return { ...(platform ? { platform } : {}), kind: r.kind, qualified_name: r.qualified_name, environment: r.environment };
  }
  refs(ids: readonly string[]): Refs {
    this.elements(ids);
    return new Map(ids.map((id) => [id, this.ref(id)]));
  }

  allDomains(): Map<string, DomainRow> {
    this.domains ??= new Map(
      db()
        .all<DomainRow>('SELECT * FROM dp_domains ORDER BY key')
        .map((d) => [d.id, d]),
    );
    return this.domains;
  }
  /** A domain's key where the reader may see it (null: hidden or gone). */
  domainKey(id: string | null): string | null | undefined {
    if (!id) return null;
    const d = this.allDomains().get(id);
    return d && domainAccess(this.u, d).permissions.length ? d.key : undefined;
  }
  seesDomain(d: DomainRow): boolean {
    return domainAccess(this.u, d).permissions.length > 0;
  }

  objectKey(id: string): string | null {
    if (!this.objectKeys.has(id)) {
      const o = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE id = ?', id);
      this.objectKeys.set(id, o && objectAccess(this.u, o).permissions.length ? o.key : null);
    }
    return this.objectKeys.get(id) ?? null;
  }
  noteObject(o: ObjectRow): void {
    this.objectKeys.set(o.id, objectAccess(this.u, o).permissions.length ? o.key : null);
  }
  productKey(id: string): string | null {
    if (!this.productKeys.has(id)) {
      const p = productsByIds([id]).get(id);
      this.productKeys.set(id, p && productAccess(this.u, p).permissions.length ? p.key : null);
    }
    return this.productKeys.get(id) ?? null;
  }
  noteProduct(p: ProductRow): void {
    this.productKeys.set(p.id, productAccess(this.u, p).permissions.length ? p.key : null);
  }

  /** Names of applications, services and processes as the reader may see them (null: hidden or gone). */
  catalogueName(kind: 'application' | 'service', id: string): string | null {
    const r = db().get<{ id: string; name: string; owners: string }>(
      `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'services'} WHERE id = ?`,
      id,
    );
    return r && canViewCatalogue(this.u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }) ? r.name : null;
  }
  processName(id: string): string | null {
    const r = db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id);
    return r && permissionsFor(id).includes('view') ? r.name : null;
  }
  /** A contract's ODCS id where the reader may see it. */
  contractKey(id: string): string | null {
    const r = db().get<{ id: string; contract_key: string }>('SELECT id, contract_key FROM data_contracts WHERE id = ?', id);
    return r && contractAccess(this.u, { id: r.id }).permissions.includes('view') ? r.contract_key : null;
  }
}

// ---------- entries ----------

const strings = (s: string | null | undefined): string[] => parseJson<string[]>(s ?? '[]', []);

/** Objectives in the file's words (only those that are set). */
export function objectivesFile(o: DataObjectives): NonNullable<PortFile['objectives']> {
  const out: NonNullable<PortFile['objectives']> = {};
  if (o.freshnessMinutes != null) out.freshness_minutes = o.freshnessMinutes;
  if (o.availabilityPct != null) out.availability_pct = o.availabilityPct;
  if (o.completeness != null && o.completeness !== '') out.completeness = o.completeness;
  if (o.updateSchedule != null && o.updateSchedule !== '') out.update_schedule = o.updateSchedule;
  if (o.retention != null && o.retention !== '') out.retention = o.retention;
  return out;
}

export function domainEntry(s: Snapshot, d: DomainRow): DomainFile {
  const parent = d.parent_id ? s.domainKey(d.parent_id) : null;
  return {
    key: d.key,
    name: d.name,
    description: d.description,
    ...(parent !== undefined ? { parent } : {}),
    colour: (d.colour as DomainFile['colour']) ?? null,
    owners: strings(d.owners),
  };
}

function ratingFile(r: ReturnType<typeof ratingsByItem> extends Map<string, infer R> ? R : never) {
  return Object.fromEntries(CIA_DIMENSIONS.map((d) => [d, r[d] ? { level: r[d]!.level, justification: r[d]!.justification } : null]));
}

export function objectEntry(
  s: Snapshot,
  o: ObjectRow,
  rating: ReturnType<typeof ratingsByItem> extends Map<string, infer R> ? R : never,
  implemented: { element_id: string; note: string }[],
): ObjectFile {
  const domain = s.domainKey(o.domain_id);
  const elements = implemented
    .map((i) => ({ ref: s.seesElement(i.element_id) ? s.ref(i.element_id) : null, note: i.note }))
    .filter((x): x is { ref: ElementRefFile; note: string } => !!x.ref)
    .map((x) => ({ element: x.ref, note: x.note }));
  return {
    key: o.key,
    name: o.name,
    definition: o.definition,
    synonyms: strings(o.synonyms),
    ...(domain !== undefined ? { domain } : {}),
    lifecycle: o.lifecycle as ObjectFile['lifecycle'],
    classification: (o.classification as ObjectFile['classification']) ?? null,
    personal_data: o.personal_data as ObjectFile['personal_data'],
    categories: strings(o.categories),
    special_categories: strings(o.special_categories) as ObjectFile['special_categories'],
    subjects: strings(o.subjects),
    legal_basis: (o.legal_basis as ObjectFile['legal_basis']) ?? null,
    legal_note: o.legal_note,
    purposes: strings(o.purposes),
    retention: o.retention,
    deletion_rule: o.deletion_rule,
    regulatory_flags: strings(o.regulatory_flags),
    attributes: parseJson<{ name: string; description: string; personal: boolean }[]>(o.attributes, []).map((a) => ({
      name: a.name,
      description: a.description ?? '',
      personal: !!a.personal,
    })),
    owner: o.owner,
    stewards: strings(o.stewards),
    custodians: strings(o.custodians),
    external_refs: parseJson(o.external_refs, []),
    rating: ratingFile(rating),
    elements: elements.sort((a, b) => elementSort(a.element, b.element)),
  };
}

/** An element as the file writes it (null: the reader may not see it, or its platform). */
export function elementEntry(s: Snapshot, r: ElementRow): ElementFile | null {
  if (!s.seesElement(r.id)) return null;
  const ref = s.ref(r.id);
  if (!ref) return null;
  const parent = r.parent_id ? s.elementRow(r.parent_id) : undefined;
  const api = parseJson<{ url?: string; operations?: string[] } | null>(r.api_ref, null);
  return {
    ...ref,
    display_name: r.display_name,
    parent: parent ? parent.qualified_name : null,
    layer: r.layer,
    description: r.description,
    type_label: r.type_label,
    api_ref:
      api && (api.url || api.operations?.length)
        ? { ...(api.url ? { url: api.url } : {}), ...(api.operations?.length ? { operations: api.operations } : {}) }
        : null,
    flags: parseJson<Record<string, string | number | boolean>>(r.flags, {}),
  };
}

const elementKey = (r: ElementRefFile): string => [r.platform ?? '', r.kind, r.qualified_name.toLowerCase(), r.environment ?? ''].join('\u0000');
export const elementSort = (a: ElementRefFile, b: ElementRefFile): number => (elementKey(a) < elementKey(b) ? -1 : elementKey(a) > elementKey(b) ? 1 : 0);
export { elementKey };

function runnerFile(s: Snapshot, raw: DataStepRunner | null): RunnerFile | null | undefined {
  if (!raw) return null;
  if (raw.kind === 'tool') return { kind: 'tool', tool: raw.tool, text: raw.text };
  if (raw.kind === 'connector') {
    const platform = s.platformNameOf(raw.platformId);
    return platform ? { kind: 'connector', platform, name: raw.name } : undefined;
  }
  if (raw.kind === 'element') {
    const element = s.ref(raw.id);
    return element ? { kind: 'element', element } : undefined;
  }
  const name = raw.kind === 'platform' ? s.platformNameOf(raw.id) : raw.kind === 'process' ? s.processName(raw.id) : s.catalogueName('application', raw.id);
  return name ? { kind: raw.kind, name } : undefined;
}

function consumerFile(s: Snapshot, c: ReturnType<typeof consumersOf>[number]): ConsumerFile | null {
  const kind = c.consumer_kind as ConsumerFile['kind'];
  const base = {
    purpose: c.purpose,
    since: c.since,
    end_date: c.end_date,
    agreement: parseJson<ConsumerFile['agreement']>(c.agreement, null),
    contacts: strings(c.contacts),
  };
  if (kind === 'team' || kind === 'user') {
    const subject = strings(c.consumer_subjects)[0];
    return subject ? { kind, subject, ...base } : null;
  }
  if (kind === 'text') return { kind, text: c.consumer_text, ...base };
  if (!c.ref_id) return null;
  const ref = kind === 'product' ? s.productKey(c.ref_id) : s.catalogueName(kind, c.ref_id);
  return ref ? { kind, ref, ...base } : null;
}

/** Identity of a consumer in a file: its kind and whom it names. */
export const consumerIdentity = (c: Pick<ConsumerFile, 'kind' | 'subject' | 'ref' | 'text'>): string =>
  `${c.kind}:${(c.kind === 'team' || c.kind === 'user' ? c.subject : c.kind === 'text' ? c.text : c.ref) ?? ''}`.toLowerCase();

/**
 * A product as the file writes it, with its environments, members, ports (bindings, consumers) and steps – what the
 * reader may see; `environment`: only that environment's elements, bindings and environment entry.
 */
export function productEntry(s: Snapshot, p: ProductRow, environment?: string): ProductFile {
  const rating = ratingsByItem('product', [p.id]).get(p.id)!;
  const reasons = parseJson<Record<string, string>>(p.rating_reason, {});
  const inEnv = (r: ElementRefFile | null) => !!r && (environment === undefined || (r.environment ?? '') === environment);
  const envRows = environmentsOf([p.id]).filter((e) => environment === undefined || e.environment === environment);
  const members = membersOf([p.id]);
  const ports = portsOf([p.id]);
  const portIds = ports.map((x) => x.id);
  const bindings = bindingsOf(portIds).filter((b) => environment === undefined || b.environment === environment);
  const declared = portObjectsOf(portIds);
  const consumers = consumersOf(portIds);
  const steps = productSteps(p.id);
  s.elements([...members.map((m) => m.element_id), ...bindings.flatMap((b) => b.elementIds), ...steps.flatMap((x) => [...x.inputs, ...x.outputs])]);
  const sourcePorts = new Map<string, PortRow>();
  const sourceIds = ports.map((x) => x.source_port_id).filter((x): x is string => !!x);
  if (sourceIds.length)
    for (const r of db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(sourceIds.length)})`, ...sourceIds)) sourcePorts.set(r.id, r);
  const byId = new Map(ports.map((x) => [x.id, x]));
  const domain = s.domainKey(p.domain_id);
  const successor = p.successor_id ? s.productKey(p.successor_id) : null;
  const support = { channel: '', url: '', hours: '', ...parseJson<Record<string, string>>(p.support, {}) };
  const portEntry = (x: PortRow): PortFile => {
    let source: PortFile['source'] = null;
    let keepSource = true;
    if (x.source_kind === 'port' && x.source_port_id) {
      const sp = sourcePorts.get(x.source_port_id);
      const key = sp ? s.productKey(sp.product_id) : null;
      if (sp && key) source = { product: key, port: sp.name, version: sp.version };
      else keepSource = false;
    } else if (x.source_kind === 'element' && x.source_element_id) {
      const ref = s.ref(x.source_element_id);
      if (ref) source = { element: ref };
      else keepSource = false;
    } else if (x.source_kind === 'text') source = { text: x.source_text };
    const succ = x.successor_id ? byId.get(x.successor_id) : undefined;
    const objects = declared
      .filter((d) => d.port_id === x.id)
      .map((d) => s.objectKey(d.object_id))
      .filter((k): k is string => !!k)
      .sort();
    return {
      direction: x.direction,
      name: x.name,
      version: x.version,
      type: x.port_type as PortFile['type'],
      description: x.description,
      lifecycle: x.lifecycle as PortFile['lifecycle'],
      sunset_date: x.sunset_date,
      successor: succ ? { name: succ.name, version: succ.version } : null,
      objectives: objectivesFile(parseJson<DataObjectives>(x.objectives, {})),
      ...(keepSource ? { source } : {}),
      data_objects: objects,
      bindings: bindings
        .filter((b) => b.port_id === x.id)
        .map((b): BindingFile => {
          const contract = b.contract_id ? s.contractKey(b.contract_id) : null;
          return {
            environment: b.environment,
            elements: b.elementIds
              .map((e) => s.ref(e))
              .filter((r): r is ElementRefFile => !!r)
              .sort(elementSort),
            // a contract the reader may not see is left out (an import keeps it)
            ...(b.contract_id && !contract
              ? {}
              : { contract, contract_version: b.contract_version === null ? null : Number(b.contract_version), contract_server: b.contract_server }),
            objectives: objectivesFile(parseJson<DataObjectives>(b.objectives, {})),
          };
        })
        .sort((a, b) => a.environment.localeCompare(b.environment)),
      consumers:
        x.direction === 'output'
          ? consumers
              .filter((c) => c.port_id === x.id)
              .map((c) => consumerFile(s, c))
              .filter((c): c is ConsumerFile => !!c)
          : [],
    };
  };
  const memberEntries = members
    .map((m) => ({ m, ref: s.ref(m.element_id) }))
    .filter((x) => inEnv(x.ref))
    .map((x) => ({ element: x.ref!, role: x.m.role, include_descendants: !!x.m.include_descendants, note: x.m.note }))
    .sort((a, b) => elementSort(a.element, b.element));
  const stepEntries = steps
    .map((st): StepFile | null => {
      const outputs = st.outputs.map((e) => s.ref(e)).filter(inEnv) as ElementRefFile[];
      if (!outputs.length) return null;
      const runner = st.runnerHidden ? undefined : runnerFile(s, st.runner);
      return {
        name: st.name,
        kind: st.kind,
        ...(runner !== undefined ? { runner } : {}),
        schedule: st.schedule,
        description: st.description,
        notes: st.notes,
        inputs: (st.inputs.map((e) => s.ref(e)).filter(inEnv) as ElementRefFile[]).sort(elementSort),
        outputs: outputs.sort(elementSort),
      };
    })
    .filter((x): x is StepFile => !!x)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    purpose: p.purpose,
    type: (p.type as ProductFile['type']) ?? null,
    ...(domain !== undefined ? { domain } : {}),
    owners: strings(p.owners),
    support: { channel: support.channel ?? '', url: support.url ?? '', hours: support.hours ?? '' },
    criticality: (p.criticality as ProductFile['criticality']) ?? null,
    tier: (p.tier === null ? null : Number(p.tier)) as ProductFile['tier'],
    version: p.version,
    value_statement: p.value_statement,
    value_tier: (p.value_tier as ProductFile['value_tier']) ?? null,
    value_amount: p.value_amount === null ? null : Number(p.value_amount) / 1e6,
    value_currency: p.value_currency,
    ...(p.successor_id && !successor ? {} : { successor }),
    tags: strings(p.tags),
    external_refs: parseJson(p.external_refs, []),
    lifecycle: p.lifecycle as ProductFile['lifecycle'],
    sunset_date: p.sunset_date,
    rating: {
      ...ratingFile(rating),
      classification: (p.classification as NonNullable<ProductFile['rating']>['classification']) ?? null,
      reasons: Object.fromEntries(Object.entries(reasons).filter(([, v]) => !!v)),
    },
    environments: sortEnvironments(envRows.map((e) => e.environment)).map((env) => ({
      environment: env,
      state: envRows.find((e) => e.environment === env)!.state as 'planned' | 'available' | 'withdrawn',
    })),
    members: memberEntries,
    ports: ports.map(portEntry),
    steps: stepEntries,
  };
}

// ---------- the document ----------

export interface ExportScope {
  productId?: string;
  domainId?: string;
  environment?: string;
}

export interface ExportResult {
  document: DataProductsFile;
  /** Elements left out above the import limit (an import takes at most that many) */
  elementsLeftOut: number;
  name: string;
}

/** Empty values are left out of a file (an import keeps what Steward has for a key it leaves out). */
export function compact<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x)) {
      const c = walk(y);
      if (
        c === undefined ||
        c === null ||
        c === '' ||
        (Array.isArray(c) && !c.length) ||
        (typeof c === 'object' && c && !Array.isArray(c) && !Object.keys(c).length)
      )
        continue;
      out[k] = c;
    }
    return out;
  };
  return walk(v) as T;
}

/** Every element id an entry names (members, bindings, sources, steps, runners). */
function elementIdsOf(productIds: string[]): string[] {
  const ids = new Set<string>();
  for (const m of membersOf(productIds)) ids.add(m.element_id);
  const ports = portsOf(productIds);
  for (const b of bindingsOf(ports.map((p) => p.id))) for (const e of b.elementIds) ids.add(e);
  for (const p of ports) if (p.source_element_id) ids.add(p.source_element_id);
  return [...ids];
}

/**
 * The document of an export. Everything: the domains, data objects and products the reader may see, the elements they
 * name, and the entered and imported elements of the catalogue (discovered ones come back with their discovery).
 */
export function exportDocument(scope: ExportScope = {}): ExportResult {
  const s = new Snapshot();
  const u = s.u;
  const env = scope.environment;
  let products: ProductRow[];
  let domainIds: Set<string> | null = null;
  let name = 'data-products';
  if (scope.productId) {
    const { row } = visibleProduct(scope.productId, u);
    products = [row];
    name = row.key;
  } else {
    if (scope.domainId) {
      const d = s.allDomains().get(scope.domainId);
      if (!d || !s.seesDomain(d)) throw domainNotFound(scope.domainId);
      domainIds = new Set([d.id, ...[...s.allDomains().values()].filter((x) => x.parent_id === d.id).map((x) => x.id)]);
      name = `domain-${d.key}`;
    }
    products = db()
      .all<ProductRow>('SELECT * FROM dp_products ORDER BY key')
      .filter((p) => (!domainIds || (p.domain_id && domainIds.has(p.domain_id))) && productAccess(u, p).permissions.length > 0);
    if (env !== undefined) {
      const inEnv = new Set(
        environmentsOf(products.map((p) => p.id))
          .filter((e) => e.environment === env)
          .map((e) => e.product_id),
      );
      products = products.filter((p) => inEnv.has(p.id));
    }
  }
  for (const p of products) s.noteProduct(p);
  const productIds = products.map((p) => p.id);
  const entries = products.map((p) => productEntry(s, p, env));

  // data objects: those of the scope, and those the products' ports name
  const declared = new Set(portObjectsOf(portsOf(productIds).map((p) => p.id)).map((d) => d.object_id));
  const objectRows = db()
    .all<ObjectRow>('SELECT * FROM dp_objects ORDER BY key')
    .filter((o) => (scope.productId ? declared.has(o.id) : !domainIds || declared.has(o.id) || (o.domain_id && domainIds.has(o.domain_id))))
    .filter((o) => objectAccess(u, o).permissions.length > 0);
  for (const o of objectRows) s.noteObject(o);
  const ratings = ratingsByItem(
    'object',
    objectRows.map((o) => o.id),
  );
  const links = objectRows.length
    ? db().all<{ object_id: string; element_id: string; note: string }>(
        `SELECT object_id, element_id, note FROM dp_object_elements WHERE object_id IN (${marks(objectRows.length)})`,
        ...objectRows.map((o) => o.id),
      )
    : [];
  s.elements(links.map((l) => l.element_id));
  const objectEntries = objectRows.map((o) =>
    objectEntry(
      s,
      o,
      ratings.get(o.id)!,
      links.filter((l) => l.object_id === o.id && (env === undefined || s.elementRow(l.element_id)?.environment === env)),
    ),
  );

  // elements: those named, and (everything) the entered and imported ones
  const named = new Set([...elementIdsOf(productIds), ...links.map((l) => l.element_id)]);
  for (const st of productIds.flatMap((id) => productSteps(id))) for (const e of [...st.inputs, ...st.outputs]) named.add(e);
  if (!scope.productId && !scope.domainId) {
    const scopeSql = elementScopeSql(u);
    for (const r of db().all<{ id: string }>(
      `SELECT e.id FROM dp_elements e WHERE e.source <> 'discovered' AND ${scopeSql.sql}${env !== undefined ? ' AND e.environment = ?' : ''} ORDER BY e.id LIMIT ?`,
      ...scopeSql.params,
      ...(env !== undefined ? [env] : []),
      DATA_PRODUCT_IMPORT_LIMITS.elements + 1,
    ))
      named.add(r.id);
  }
  s.elements(named);
  // parents come along (an element names its parent by its qualified name)
  const withParents = new Set<string>();
  const addWithParents = (id: string) => {
    for (let cur: string | null | undefined = id, n = 0; cur && n < 10 && !withParents.has(cur); n++) {
      withParents.add(cur);
      cur = s.elementRow(cur)?.parent_id;
    }
  };
  for (const id of named) addWithParents(id);
  let elementEntries = [...withParents]
    .map((id) => s.elementRow(id))
    .filter((r): r is ElementRow => !!r && (env === undefined || r.environment === env))
    .map((r) => elementEntry(s, r))
    .filter((e): e is ElementFile => !!e)
    .sort(elementSort);
  let elementsLeftOut = 0;
  if (elementEntries.length > DATA_PRODUCT_IMPORT_LIMITS.elements) {
    elementsLeftOut = elementEntries.length - DATA_PRODUCT_IMPORT_LIMITS.elements;
    elementEntries = elementEntries.slice(0, DATA_PRODUCT_IMPORT_LIMITS.elements);
  }

  // domains: those of the scope, and those the entries name (with their parents)
  const domainKeys = new Set<string>();
  for (const e of [...entries, ...objectEntries]) if (e.domain) domainKeys.add(e.domain);
  const domainRows = [...s.allDomains().values()].filter(
    (d) => s.seesDomain(d) && (domainIds ? domainIds.has(d.id) || domainKeys.has(d.key) : scope.productId ? domainKeys.has(d.key) : true),
  );
  for (const d of [...domainRows]) {
    const parent = d.parent_id ? s.allDomains().get(d.parent_id) : undefined;
    if (parent && s.seesDomain(parent) && !domainRows.includes(parent)) domainRows.push(parent);
  }
  const domainEntries = domainRows.sort((a, b) => Number(!!a.parent_id) - Number(!!b.parent_id) || a.key.localeCompare(b.key)).map((d) => domainEntry(s, d));

  const document: DataProductsFile = {
    version: DATA_PRODUCT_FORMAT_VERSION,
    ...(domainEntries.length ? { domains: domainEntries } : {}),
    ...(objectEntries.length ? { data_objects: objectEntries } : {}),
    ...(elementEntries.length ? { elements: elementEntries } : {}),
    ...(entries.length ? { data_products: entries } : {}),
  };
  return { document: compact(document), elementsLeftOut, name: env !== undefined ? `${name}-${env || 'none'}` : name };
}

export const FILE_HEADER =
  '# Steward data products, format 1 (docs/DATA-PRODUCTS.md, docs/data-products/data-products-1.schema.json)\n# Never in this file: credentials, platform variables, discovery run-as users, readouts, check states, costs.\n';

/** The export as YAML (or JSON) with a file name. */
export function exportFile(scope: ExportScope, format: 'yaml' | 'json' = 'yaml'): { fileName: string; body: string; elementsLeftOut: number } {
  const r = exportDocument(scope);
  const safe = r.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100) || 'data-products';
  if (format === 'json')
    return { fileName: `${safe}.data-products.json`, body: `${JSON.stringify(r.document, null, 2)}\n`, elementsLeftOut: r.elementsLeftOut };
  return { fileName: `${safe}.data-products.yaml`, body: FILE_HEADER + YAML.stringify(r.document, { lineWidth: 0 }), elementsLeftOut: r.elementsLeftOut };
}
