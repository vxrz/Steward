import {
  DATA_GOVERNANCE_LIMITS as G,
  dataRopaQuery,
  type AclEntry,
  type DataClassification,
  type DataConsumerKind,
  type DataProductLifecycle,
  type DataRopa,
  type DataRopaEntry,
  type DataRopaProcessor,
  type DataRopaRecipient,
  type LegalBasis,
  type Locale,
  type PersonalDataLevel,
  type PlatformPermission,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { likeEscape } from '../database/sql.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformAccess } from '../auth/policy.js';
import { csvTable } from '../csv.js';
import { canViewCatalogue } from '../records/access.js';
import { visibleContracts } from '../suppliers/links.js';
import { parseJson } from '../util.js';
import { domainAccess, objectAccess, productAccess } from './access.js';
import { HIDDEN, refOf } from './common.js';
import { t } from './governance-notices.js';
import { bindingsOf, chunks, consumersOf, consumingPorts, marks, portsOf, productsByIds, type ObjectRow, type PortRow, type ProductRow } from './store.js';

/**
 * The GDPR Art. 30 view (ADR 0036 part 17, decision 29): _Data → Records of processing_ – a working view for the data
 * protection officer, not the register itself. Per data object with personal data: the products that **process** it
 * (a member element implements it, or an output port declares it), their purposes, the legal basis, the categories of
 * data and of data subjects, the special categories, the **recipients** (the registered consumers – still in force –
 * and the consuming products of the output ports that expose it), retention and deletion, and the **processors**: the
 * platforms its elements live on with the suppliers whose contracts cover them, the contract's (else the supplier's)
 * personal-data answer and data processing agreement.
 *
 * Team scope: only data objects the reader may see; products, recipients and platforms they may not see are counted
 * (never named); suppliers and contracts only where they may see them. Read in bulk – a fixed number of statements
 * whatever the number of objects (IN lists chunked). Exported as CSV and as a PDF (the report infrastructure).
 */

export const ropaRequest = dataRopaQuery.extend({ lang: z.enum(['en', 'de']).optional() });

interface ObjectLink {
  object_id: string;
  element_id: string;
}
interface ElementBits {
  id: string;
  platform_id: string;
  application_id: string | null;
}

export function recordsOfProcessing(raw: unknown, u: AuthUser = me()): DataRopa {
  const q = dataRopaQuery.parse(raw ?? {});
  const where: string[] = ["personal_data <> 'none'"];
  const params: unknown[] = [];
  if (q.personalData) (where.push('personal_data = ?'), params.push(q.personalData));
  if (q.domain) {
    where.push('(domain_id = ? OR domain_id IN (SELECT id FROM dp_domains WHERE parent_id = ?))');
    params.push(q.domain, q.domain);
  }
  if (q.q) {
    where.push("(lower(name_norm) LIKE ? ESCAPE '\\' OR lower(key) LIKE ? ESCAPE '\\')");
    const like = `%${likeEscape(q.q.toLowerCase())}%`;
    params.push(like, like);
  }
  const objects = db()
    .all<ObjectRow>(`SELECT * FROM dp_objects WHERE ${where.join(' AND ')} ORDER BY name_norm, id LIMIT ?`, ...params, G.ropaObjects)
    .filter((o) => objectAccess(u, o).permissions.length > 0);
  const objectIds = objects.map((o) => o.id);
  // elements that implement the objects, their memberships and platforms
  const links: ObjectLink[] = [];
  for (const part of chunks(objectIds))
    links.push(...db().all<ObjectLink>(`SELECT object_id, element_id FROM dp_object_elements WHERE object_id IN (${marks(part.length)})`, ...part));
  const elementIds = [...new Set(links.map((l) => l.element_id))];
  const elements = new Map<string, ElementBits>();
  const members: { product_id: string; element_id: string }[] = [];
  for (const part of chunks(elementIds)) {
    for (const e of db().all<ElementBits>(`SELECT id, platform_id, application_id FROM dp_elements WHERE id IN (${marks(part.length)})`, ...part))
      elements.set(e.id, e);
    members.push(
      ...db().all<{ product_id: string; element_id: string }>(
        `SELECT product_id, element_id FROM dp_members WHERE element_id IN (${marks(part.length)})`,
        ...part,
      ),
    );
  }
  // output ports that declare the objects
  const declared: { port_id: string; object_id: string }[] = [];
  for (const part of chunks(objectIds))
    declared.push(
      ...db().all<{ port_id: string; object_id: string }>(`SELECT port_id, object_id FROM dp_port_objects WHERE object_id IN (${marks(part.length)})`, ...part),
    );
  const declaredPorts = new Map<string, PortRow>();
  for (const part of chunks([...new Set(declared.map((d) => d.port_id))]))
    for (const p of db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(part.length)})`, ...part)) declaredPorts.set(p.id, p);
  const productIds = [
    ...new Set([...members.map((m) => m.product_id), ...[...declaredPorts.values()].filter((p) => p.direction === 'output').map((p) => p.product_id)]),
  ];
  const products = productsByIds(productIds);
  const visibleProducts = new Set([...products.values()].filter((p) => productAccess(u, p).permissions.length > 0).map((p) => p.id));
  // the output ports of the processing products, with their bindings, consumers and consuming products
  const ports = portsOf(productIds).filter((p) => p.direction === 'output' && p.lifecycle !== 'retired');
  const bindings = bindingsOf(ports.map((p) => p.id));
  const today = new Date().toISOString().slice(0, 10);
  const consumers = consumersOf(ports.map((p) => p.id)).filter((c) => !c.end_date || c.end_date >= today);
  const consuming = consumingPorts(ports.map((p) => p.id));
  const consumingProducts = productsByIds([
    ...consuming.map((c) => c.product_id),
    ...consumers.filter((c) => c.consumer_kind === 'product' && c.ref_id).map((c) => c.ref_id!),
  ]);
  const catalogueNames = refNames(u, consumers);
  // platforms (processors) and their suppliers
  const platformIds = [...new Set([...elements.values()].map((e) => e.platform_id).filter(Boolean))];
  const platforms = new Map<string, { name: string; visible: boolean }>();
  for (const part of chunks(platformIds))
    for (const p of db().all<{ id: string; name: string; acl: string }>(`SELECT id, name, acl FROM platforms WHERE id IN (${marks(part.length)})`, ...part))
      platforms.set(p.id, {
        name: p.name,
        visible: platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length > 0,
      });
  const covering: { contract_id: string; platform_id: string }[] = [];
  for (const part of chunks(platformIds))
    covering.push(
      ...db().all<{ contract_id: string; platform_id: string }>(
        `SELECT contract_id, platform_id FROM supplier_contract_platforms WHERE platform_id IN (${marks(part.length)})`,
        ...part,
      ),
    );
  const contracts = visibleContracts(
    covering.map((c) => c.contract_id),
    u,
  );
  const answers = contractAnswers([...contracts.keys()]);
  const domains = new Map(
    db()
      .all<{ id: string; key: string; name: string; owners: string }>('SELECT id, key, name, owners FROM dp_domains')
      .map((d) => [d.id, d]),
  );

  const items: DataRopaEntry[] = objects.map((o) => {
    const implementedBy = new Set(links.filter((l) => l.object_id === o.id).map((l) => l.element_id));
    const how = new Map<string, Set<'implements' | 'exposes'>>();
    const mark = (pid: string, h: 'implements' | 'exposes') => how.set(pid, (how.get(pid) ?? new Set()).add(h));
    for (const m of members) if (implementedBy.has(m.element_id)) mark(m.product_id, 'implements');
    const exposingPorts = new Set<string>();
    for (const d of declared.filter((x) => x.object_id === o.id)) {
      const port = declaredPorts.get(d.port_id);
      if (port?.direction === 'output') {
        mark(port.product_id, 'exposes');
        exposingPorts.add(port.id);
      }
    }
    // ports whose bound elements implement the object expose it too
    for (const b of bindings) if (b.elementIds.some((id) => implementedBy.has(id))) exposingPorts.add(b.port_id);
    const processing = [...how.keys()];
    const shown = processing.filter((id) => visibleProducts.has(id) && products.get(id));
    // recipients: consumers of the exposing ports of processing products
    const recipients: DataRopaRecipient[] = [];
    let hiddenRecipients = 0;
    for (const port of ports.filter((p) => exposingPorts.has(p.id) && how.has(p.product_id))) {
      const owner = products.get(port.product_id)!;
      if (!visibleProducts.has(owner.id)) {
        hiddenRecipients += consumers.filter((c) => c.port_id === port.id).length + consuming.filter((c) => c.source_port_id === port.id).length;
        continue;
      }
      const via = `${owner.name} / ${port.name}${port.version ? ` ${port.version}` : ''}`;
      for (const c of consumers.filter((x) => x.port_id === port.id)) {
        const label = consumerLabel(u, c, catalogueNames, consumingProducts);
        if (label === null) hiddenRecipients++;
        else recipients.push({ kind: c.consumer_kind as DataConsumerKind, label, via });
      }
      for (const c of consuming.filter((x) => x.source_port_id === port.id)) {
        const cp = consumingProducts.get(c.product_id);
        if (!cp || cp.lifecycle === 'retired') continue;
        if (productAccess(u, cp).permissions.length) recipients.push({ kind: 'product', label: cp.name, via });
        else hiddenRecipients++;
      }
    }
    // processors: the platforms of the implementing elements and the contracts covering them
    const processors: DataRopaProcessor[] = [];
    let hiddenProcessors = 0;
    for (const pid of [...new Set([...implementedBy].map((id) => elements.get(id)?.platform_id).filter((x): x is string => !!x))]) {
      const pl = platforms.get(pid);
      if (!pl?.visible) {
        hiddenProcessors++;
        continue;
      }
      const cs = covering.filter((c) => c.platform_id === pid && contracts.has(c.contract_id));
      if (!cs.length) processors.push({ platform: pl.name, supplier: null, contract: null, personalData: null, dpa: null });
      for (const c of cs) {
        const info = contracts.get(c.contract_id)!;
        const a = answers.get(c.contract_id);
        processors.push({ platform: pl.name, supplier: info.supplierName, contract: info.title, personalData: a?.personalData ?? null, dpa: a?.dpa ?? null });
      }
    }
    const domain = o.domain_id ? domains.get(o.domain_id) : undefined;
    return {
      object: { id: o.id, key: o.key, name: o.name },
      domain: domain ? (domainAccess(u, domain).permissions.length ? refOf(domain) : HIDDEN) : null,
      classification: (o.classification as DataClassification | null) ?? null,
      personalData: o.personal_data as PersonalDataLevel,
      categories: parseJson<string[]>(o.categories, []),
      specialCategories: parseJson<string[]>(o.special_categories, []),
      subjects: parseJson<string[]>(o.subjects, []),
      legalBasis: (o.legal_basis as LegalBasis | null) ?? null,
      legalNote: o.legal_note,
      purposes: parseJson<string[]>(o.purposes, []),
      retention: o.retention,
      deletionRule: o.deletion_rule,
      regulatoryFlags: parseJson<string[]>(o.regulatory_flags, []),
      owner: o.owner,
      stewards: parseJson<string[]>(o.stewards, []),
      products: shown
        .map((id) => {
          const p = products.get(id)!;
          return {
            product: { id: p.id, key: p.key, name: p.name },
            purpose: p.purpose,
            lifecycle: p.lifecycle as DataProductLifecycle,
            how: [...how.get(id)!].sort(),
          };
        })
        .sort((a, b) => a.product.name.localeCompare(b.product.name)),
      hiddenProducts: processing.length - shown.length,
      recipients: dedupe(recipients),
      hiddenRecipients,
      processors: dedupe(processors),
      hiddenProcessors,
    };
  });
  return { items, generatedAt: new Date().toISOString(), suppliers: true };
}

const dedupe = <T>(xs: T[]): T[] => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];

/** Names of the applications and services registrations name, as `u` may see them (bulk). */
function refNames(u: AuthUser, rows: { consumer_kind: string; ref_id: string | null }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const kind of ['application', 'service'] as const) {
    const ids = [...new Set(rows.filter((r) => r.consumer_kind === kind && r.ref_id).map((r) => r.ref_id!))];
    for (const part of chunks(ids))
      for (const r of db().all<{ id: string; name: string; owners: string }>(
        `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'services'} WHERE id IN (${marks(part.length)})`,
        ...part,
      ))
        out.set(`${kind}:${r.id}`, canViewCatalogue(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }) ? r.name : null);
  }
  return out;
}

function consumerLabel(
  u: AuthUser,
  c: { consumer_kind: string; ref_id: string | null; consumer_subjects: string; consumer_text: string },
  names: Map<string, string | null>,
  products: Map<string, ProductRow>,
): string | null {
  if (c.consumer_kind === 'text') return c.consumer_text;
  if (c.consumer_kind === 'team' || c.consumer_kind === 'user') return parseJson<string[]>(c.consumer_subjects, [])[0] ?? null;
  if (!c.ref_id) return null;
  if (c.consumer_kind === 'product') {
    const p = products.get(c.ref_id);
    return p && productAccess(u, p).permissions.length ? p.name : null;
  }
  return names.get(`${c.consumer_kind}:${c.ref_id}`) ?? null;
}

/** The personal-data answer and DPA state of contracts: the contract's own, else its master agreement's, else the supplier's. */
function contractAnswers(ids: string[]): Map<string, { personalData: boolean | null; dpa: string | null }> {
  const rows = new Map<string, { id: string; parent_id: string | null; supplier_id: string; personal_data: number | null; dpa_status: string | null }>();
  const load = (want: string[]) => {
    for (const part of chunks(want.filter((x) => !rows.has(x))))
      for (const r of db().all<{ id: string; parent_id: string | null; supplier_id: string; personal_data: number | null; dpa_status: string | null }>(
        `SELECT id, parent_id, supplier_id, personal_data, dpa_status FROM supplier_contracts WHERE id IN (${marks(part.length)})`,
        ...part,
      ))
        rows.set(r.id, r);
  };
  load(ids);
  load([...rows.values()].map((r) => r.parent_id).filter((x): x is string => !!x));
  const suppliers = new Map<string, { personal_data: number; dpa_status: string | null }>();
  for (const part of chunks([...new Set([...rows.values()].map((r) => r.supplier_id))]))
    for (const s of db().all<{ id: string; personal_data: number; dpa_status: string | null }>(
      `SELECT id, personal_data, dpa_status FROM suppliers WHERE id IN (${marks(part.length)})`,
      ...part,
    ))
      suppliers.set(s.id, s);
  const out = new Map<string, { personalData: boolean | null; dpa: string | null }>();
  for (const id of ids) {
    const c = rows.get(id);
    if (!c) continue;
    const parent = c.parent_id ? rows.get(c.parent_id) : undefined;
    const s = suppliers.get(c.supplier_id);
    const pd = c.personal_data ?? parent?.personal_data ?? s?.personal_data ?? null;
    out.set(id, { personalData: pd === null || pd === undefined ? null : !!Number(pd), dpa: c.dpa_status ?? parent?.dpa_status ?? s?.dpa_status ?? null });
  }
  return out;
}

// ---------- exports ----------

/** The words of the exports in one language (the server's own texts). */
export function ropaWords(l: Locale) {
  const k = (key: string, values?: Record<string, string | number>) => t(l, `dataProductGovernance.ropa.${key}`, values);
  return {
    title: k('title'),
    subtitle: k('subtitle'),
    disclaimer: k('disclaimer'),
    head: {
      object: k('head.object'),
      key: k('head.key'),
      domain: k('head.domain'),
      personalData: k('head.personalData'),
      categories: k('head.categories'),
      specialCategories: k('head.specialCategories'),
      subjects: k('head.subjects'),
      legalBasis: k('head.legalBasis'),
      purposes: k('head.purposes'),
      products: k('head.products'),
      recipients: k('head.recipients'),
      processors: k('head.processors'),
      retention: k('head.retention'),
      deletion: k('head.deletion'),
      owner: k('head.owner'),
      flags: k('head.flags'),
    },
    personal: (v: string) => k(`personal.${v}`),
    basis: (v: string | null) => (v ? k(`basis.${v}`) : '–'),
    hidden: (n: number) => (n ? k('hidden', { count: n }) : ''),
    dpa: (v: string | null) => (v ? k(`dpa.${v}`) : k('dpa.unknown')),
    pd: (v: boolean | null) => (v === null ? k('pd.unknown') : v ? k('pd.yes') : k('pd.no')),
    domainHidden: k('domainHidden'),
  };
}

/** One row of words per data object (the CSV and the PDF write the same). */
export function ropaRows(r: DataRopa, l: Locale): { head: string[]; rows: string[][] } {
  const w = ropaWords(l);
  const join = (xs: string[], hidden = 0) => [...xs, ...(hidden ? [w.hidden(hidden)] : [])].join('; ');
  const head = [
    w.head.object,
    w.head.key,
    w.head.domain,
    w.head.personalData,
    w.head.categories,
    w.head.specialCategories,
    w.head.subjects,
    w.head.legalBasis,
    w.head.purposes,
    w.head.products,
    w.head.recipients,
    w.head.processors,
    w.head.retention,
    w.head.deletion,
    w.head.owner,
    w.head.flags,
  ];
  const rows = r.items.map((e) => [
    e.object.name,
    e.object.key,
    e.domain ? (e.domain.hidden ? w.domainHidden : e.domain.name) : '',
    w.personal(e.personalData),
    e.categories.join('; '),
    e.specialCategories.join('; '),
    e.subjects.join('; '),
    [w.basis(e.legalBasis), e.legalNote].filter((x) => x && x !== '–').join(' – ') || '–',
    join([...e.purposes, ...e.products.filter((p) => p.purpose).map((p) => `${p.product.name}: ${p.purpose.slice(0, 300)}`)]),
    join(
      e.products.map((p) => p.product.name),
      e.hiddenProducts,
    ),
    join(
      e.recipients.map((x) => `${x.label} (${x.via})`),
      e.hiddenRecipients,
    ),
    join(
      e.processors.map((p) => [p.platform, p.supplier, p.contract, p.supplier ? `${w.pd(p.personalData)}, ${w.dpa(p.dpa)}` : ''].filter(Boolean).join(' – ')),
      e.hiddenProcessors,
    ),
    e.retention,
    e.deletionRule,
    e.owner ?? '',
    e.regulatoryFlags.join('; '),
  ]);
  return { head, rows };
}

export function ropaCsv(r: DataRopa, l: Locale): string {
  const { head, rows } = ropaRows(r, l);
  return csvTable(head, rows, { bom: true });
}

/** Exports are audited (personal-data processing records leave Steward). */
export function auditRopaExport(format: 'csv' | 'pdf', count: number): void {
  audit({
    action: 'dataproduct.ropa_exported',
    entityType: 'data_product',
    entityId: 'records-of-processing',
    summary: `Records of processing exported as ${format.toUpperCase()} (${count} data object(s))`,
    details: { format, objects: count },
  });
}
