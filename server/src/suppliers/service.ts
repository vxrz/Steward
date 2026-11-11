import {
  CIA_DIMENSIONS,
  SUPPLIER_LIMITS,
  SUPPLIER_LINK_KINDS,
  contractDates,
  dateState,
  isSoc2,
  levelRank,
  soc2ValidUntil,
  supplierCertificateInput,
  supplierContactInput,
  supplierContractInput,
  supplierInput,
  type ServiceContract,
  type ServiceContracts,
  type SupplierContractDetail,
  type SupplierContractServiceInput,
  type AclEntry,
  type PlatformPermission,
  type SupplierCertificate,
  type SupplierCertificateKind,
  type SupplierContact,
  type SupplierContactRole,
  type SupplierContract,
  type SupplierCriticality,
  type SupplierDateState,
  type SupplierDetail,
  type SupplierDpaStatus,
  type SupplierFacts,
  type SupplierLinkKind,
  type SupplierOption,
  type SupplierRenewal,
  type SupplierStatus,
  type SupplierSummary,
  type SupplierType,
  type SupplierUsage,
  type ServiceProtectionNeed,
  hasTeamOwner,
} from '@sm/shared';
import type { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { canCreateServices, canEditService, canReadRecordRow, catalogueVisibleNow, forbid, me } from '../records/access.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { assignCreatorTeams, catalogueTeams, forgetOwningTeams, newResourceTeams } from '../auth/policy.js';
import { currentScale, protectionNeeds, ratingsOf } from '../catalogue/cia.js';
import { ScopeCtx, contractOwnersOf, finishContractScopeUpgrade } from './contract-scope.js';
import { ticketAccess } from '../tickets/service.js';
import { instanceTimeZone, localDate } from '../duties/periods.js';
import { normVendor } from '../plant/advisories/match.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { moduleEnabled } from '../modules/registry.js';
import { supplierVisible, visibleContracts } from './links.js';
import { CaContext, canReadFinding, type FindingRow } from '../compliance/corrective.js';
import { dropSchedules, type ScheduleRow } from '../costs/schedule-model.js';

/**
 * Suppliers (0.17.0, ADR 0029 part 1, docs/SUPPLIERS.md): records with contacts, contracts and certificates, linked
 * from applications, systems, ticket references, page watches, cost plan lines and duties.
 *
 * Permissions like systems: everyone who can sign in reads (team scope, #131); designers and administrators create,
 * confirm, merge, mark "not a supplier" and archive; they and the supplier's owners change a supplier, its contacts,
 * contracts and certificates. Contacts are personal data of people outside Steward: audit entries name the contact,
 * never the e-mail or phone; /api/v1, MCP, datasets and exports leave them out (toPublic()).
 */

export interface SupplierRow {
  id: string;
  name: string;
  norm_name: string;
  type: SupplierType;
  description: string;
  website: string;
  owners: string;
  personal_data: number;
  dpa_status: SupplierDpaStatus | null;
  dpa_since: string | null;
  dpa_link: string;
  status: SupplierStatus;
  aliases: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface ContactRow {
  id: string;
  supplier_id: string;
  name: string;
  role: SupplierContactRole;
  email: string;
  phone: string;
  note: string;
  created_at: string;
}

export interface ContractRow {
  id: string;
  supplier_id: string;
  title: string;
  reference: string;
  starts_on: string | null;
  ends_on: string | null;
  notice_days: number | null;
  renewal: SupplierRenewal;
  renewal_months: number | null;
  sla_availability: number | null;
  sla_support_hours: string;
  sla_response: string;
  rto_hours: number | null;
  rpo_hours: number | null;
  link: string;
  note: string;
  created_at: string;
  updated_at: string;
  /** ADR 0031: owners (JSON subjects), the master agreement, personal data and DPA (null: inherited), who made and changed it */
  owners: string;
  parent_id: string | null;
  personal_data: number | null;
  dpa_status: SupplierDpaStatus | null;
  dpa_since: string | null;
  dpa_link: string | null;
  created_by: string;
  updated_by: string;
}

export interface CertificateRow {
  id: string;
  supplier_id: string;
  kind: SupplierCertificateKind;
  name: string;
  scope: string;
  issuer: string;
  issued_on: string | null;
  valid_until: string | null;
  link: string;
  checked_by: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Today (YYYY-MM-DD) in the instance's time zone: contracts and certificates are calendar dates, as cost plans. */
export function supplierToday(now = Date.now()): string {
  const d = localDate(now, instanceTimeZone());
  return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const ownersOf = (r: Pick<SupplierRow, 'owners'>): string[] => parseJson<string[]>(r.owners, []);
const aliasesOf = (r: Pick<SupplierRow, 'aliases'>): string[] => parseJson<string[]>(r.aliases, []);

/** Change a supplier, its contacts, contracts and certificates: designers, administrators and its owners (team scope). */
export const canEditSupplier = (u: AuthUser | null, r: Pick<SupplierRow, 'id' | 'owners'>): boolean =>
  canEditService(u, { kind: 'supplier', id: r.id, owners: ownersOf(r) });
/** Create, confirm, merge, mark "not a supplier", archive: designers and administrators. */
export const canManageSuppliers = (u: AuthUser | null = currentUser()): boolean => canCreateServices(u);

/** A supplier the reader may see (404 otherwise, like one that does not exist). */
export function supplierRow(id: string): SupplierRow {
  const r = db().get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', id);
  if (!r || !supplierVisible(r)) throw new HttpError(404, `Supplier ${id} not found`, 'SUPPLIER_NOT_FOUND', { id });
  return r;
}

function requireEditable(id: string, what: string): SupplierRow {
  const r = supplierRow(id);
  if (!canEditSupplier(currentUser(), r)) forbid(what, 'changeSupplier');
  if (r.status === 'archived') throw new HttpError(409, `Supplier "${r.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: r.name });
  return r;
}

function requireManager(what: string): AuthUser {
  const u = me();
  if (!canManageSuppliers(u)) forbid(what, 'manageSuppliers');
  return u;
}

// ---------- documents (a URL or a record) ----------

type RecordRef = { id: string; number: string; title: string };
function recordOfLink(link: string, u: AuthUser | null): RecordRef | null {
  if (!link || /^https?:\/\//i.test(link)) return null;
  const r = db().get<{ id: string; number: string; title: string; owner: string; type_id: string; fields: string }>(
    'SELECT id, number, title, owner, type_id, fields FROM records WHERE id = ? OR upper(number) = upper(?)',
    link,
    link,
  );
  return r && canReadRecordRow(u, r) ? { id: r.id, number: r.number, title: r.title } : null;
}

// ---------- reading ----------

/**
 * A contract as the reader sees it (the caller checked that they may: ctx.reads). The covered services the reader may
 * not see are counted only for who owns or may change the contract (ADR 0031 part 2).
 */
function toContract(
  c: ContractRow,
  today: string,
  u: AuthUser | null,
  lines: SupplierContract['costPlanLines'],
  ctx: ScopeCtx,
  supplier: Pick<SupplierRow, 'id' | 'owners' | 'status'>,
): SupplierContract {
  const dates = contractDates({ endsOn: c.ends_on, noticeDays: num(c.notice_days), renewal: c.renewal, renewalMonths: num(c.renewal_months) }, today);
  const owners = contractOwnersOf(c);
  const canEdit = ctx.edits(c, supplier);
  const cover = ctx.servicesOf(c, supplier);
  return {
    id: c.id,
    title: c.title,
    reference: c.reference,
    startsOn: c.starts_on,
    endsOn: c.ends_on,
    noticeDays: num(c.notice_days),
    renewal: c.renewal,
    renewalMonths: num(c.renewal_months),
    termEnd: dates.termEnd,
    noticeBy: dates.noticeBy,
    noticeState: dateState(dates.noticeBy, today),
    link: c.link,
    record: recordOfLink(c.link, u),
    slaAvailability: num(c.sla_availability),
    slaSupportHours: c.sla_support_hours,
    slaResponse: c.sla_response,
    rtoHours: num(c.rto_hours),
    rpoHours: num(c.rpo_hours),
    note: c.note,
    costPlanLines: lines,
    owners,
    teamOwned: hasTeamOwner(owners),
    services: cover.services,
    hiddenServices: canEdit || ctx.ownsContract(c) ? cover.hidden : 0,
    readReason: ctx.readReason(c, supplier) ?? 'supplierReaders',
    canEdit,
    createdBy: c.created_by ?? '',
    updatedBy: c.updated_by ?? '',
  };
}

function toCertificate(c: CertificateRow, today: string, u: AuthUser | null): SupplierCertificate {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    scope: c.scope,
    issuer: c.issuer,
    issuedOn: c.issued_on,
    validUntil: c.valid_until,
    state: dateState(c.valid_until, today),
    link: c.link,
    record: recordOfLink(c.link, u),
    checkedBy: c.checked_by,
    checkedAt: c.checked_at,
  };
}

const toContact = (c: ContactRow): SupplierContact => ({ id: c.id, name: c.name, role: c.role, email: c.email, phone: c.phone, note: c.note });

function groupBy<T extends { supplier_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.supplier_id, [...(out.get(r.supplier_id) ?? []), r]);
  return out;
}

type PlatformAcl = { id: string; acl: string };
const platformSeen = (u: AuthUser | null) => {
  const memo = new Map<string, boolean>();
  return (p: PlatformAcl | undefined): boolean => {
    if (!p) return false;
    if (!u) return true;
    if (!memo.has(p.id)) memo.set(p.id, platformPermissions(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).length > 0);
    return memo.get(p.id)!;
  };
};

/**
 * What links suppliers, as the reader may see it: applications and systems (team scope), ticket references (their
 * access), page watches (the platform), cost plan lines and duties (their service). By supplier.
 */
export function usageOf(ids?: string[]): Map<string, SupplierUsage[]> {
  const u = currentUser();
  const only = ids ? new Set(ids) : null;
  const want = (id: string | null) => !!id && (!only || only.has(id));
  const out = new Map<string, SupplierUsage[]>();
  const add = (sid: string, x: SupplierUsage) => out.set(sid, [...(out.get(sid) ?? []), x]);
  for (const a of db().all<{ id: string; name: string; owners: string; archived: number; supplier_id: string }>(
    'SELECT id, name, owners, archived, supplier_id FROM applications WHERE supplier_id IS NOT NULL ORDER BY name',
  ))
    if (want(a.supplier_id) && catalogueVisibleNow('application', a))
      add(a.supplier_id, { kind: 'application', id: a.id, name: a.name, path: `/applications/${a.id}`, detail: a.archived ? 'archived' : '' });
  for (const s of db().all<{ id: string; name: string; owners: string; kind: string; supplier_id: string }>(
    'SELECT id, name, owners, kind, supplier_id FROM systems WHERE supplier_id IS NOT NULL ORDER BY name',
  ))
    if (want(s.supplier_id) && catalogueVisibleNow('system', s))
      add(s.supplier_id, { kind: 'system', id: s.id, name: s.name, path: `/systems/${s.id}`, detail: s.kind });
  for (const t of db().all<{ id: string; external_number: string; title: string; status: string; responsible: string; supplier_id: string }>(
    'SELECT id, external_number, title, status, responsible, supplier_id FROM ticket_refs WHERE supplier_id IS NOT NULL ORDER BY opened_at DESC',
  ))
    if (want(t.supplier_id) && ticketAccess(u, t).permissions.includes('view'))
      add(t.supplier_id, { kind: 'ticket', id: t.id, name: `${t.external_number} ${t.title}`, path: `/tickets/${t.id}`, detail: t.status });
  const platforms = new Map(
    db()
      .all<PlatformAcl>('SELECT id, acl FROM platforms')
      .map((p) => [p.id, p]),
  );
  const seen = platformSeen(u);
  for (const w of db().all<{ platform_id: string; uuid: string; title: string; url: string; supplier_id: string }>(
    'SELECT platform_id, uuid, title, url, supplier_id FROM cd_watches WHERE supplier_id IS NOT NULL AND removed_at IS NULL ORDER BY title',
  ))
    if (want(w.supplier_id) && seen(platforms.get(w.platform_id)))
      add(w.supplier_id, {
        kind: 'watch',
        id: `${w.platform_id}/${w.uuid}`,
        name: w.title || w.url,
        path: `/platforms/${w.platform_id}?tab=watches`,
        detail: w.url,
      });
  const services = new Map(
    db()
      .all<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM services')
      .map((s) => [s.id, s]),
  );
  const serviceSeen = (id: string) => {
    const s = services.get(id);
    return !!s && catalogueVisibleNow('service', s);
  };
  // an item that names a contract the reader may not see is listed by its own rule and says so (ADR 0031 part 4)
  const lineRows = db().all<{ id: string; service_id: string; fiscal_year: number; title: string; supplier_id: string; supplier_contract_id: string | null }>(
    'SELECT id, service_id, fiscal_year, title, supplier_id, supplier_contract_id FROM cost_plan_lines WHERE supplier_id IS NOT NULL ORDER BY fiscal_year DESC, title',
  );
  const respRows = moduleEnabled('compliance')
    ? db().all<{ service_id: string; area: string; supplier_id: string; contract_id: string | null }>(
        'SELECT service_id, area, supplier_id, contract_id FROM service_responsibilities WHERE supplier_id IS NOT NULL ORDER BY service_id, area',
      )
    : [];
  const named = [...lineRows.map((l) => l.supplier_contract_id), ...respRows.map((r) => r.contract_id)].filter((x): x is string => !!x);
  const seenContracts = visibleContracts(named, u);
  const contractOf = (id: string | null) =>
    !id
      ? {}
      : seenContracts.has(id)
        ? { contract: { id, title: seenContracts.get(id)!.title }, contractHidden: false }
        : { contract: null, contractHidden: true };
  for (const l of lineRows)
    if (want(l.supplier_id) && serviceSeen(l.service_id))
      add(l.supplier_id, {
        kind: 'costPlanLine',
        id: l.id,
        name: l.title,
        path: `/services/${l.service_id}?tab=costs`,
        detail: `${services.get(l.service_id)!.name} · ${Number(l.fiscal_year)}`,
        ...contractOf(l.supplier_contract_id),
      });
  for (const d of db().all<{ id: string; name: string; service_id: string; supplier_id: string }>(
    'SELECT id, name, service_id, supplier_id FROM service_duties WHERE supplier_id IS NOT NULL AND archived = 0 ORDER BY name',
  ))
    if (want(d.supplier_id) && serviceSeen(d.service_id))
      add(d.supplier_id, { kind: 'duty', id: d.id, name: d.name, path: `/duties/${d.id}`, detail: services.get(d.service_id)!.name });
  // the responsibility matrix of services and the rows of statements of applicability (ADR 0029 part 2, Compliance module)
  if (moduleEnabled('compliance')) {
    for (const r of respRows)
      if (want(r.supplier_id) && serviceSeen(r.service_id))
        add(r.supplier_id, {
          kind: 'responsibility',
          id: `${r.service_id}/${r.area}`,
          name: services.get(r.service_id)!.name,
          path: `/services/${r.service_id}/responsibilities`,
          detail: r.area,
          ...contractOf(r.contract_id),
        });
    for (const e of db().all<{ control_id: string; supplier_id: string; ref: string; title: string; key: string }>(
      `SELECT e.control_id, e.supplier_id, c.ref, c.title, k.key FROM soa_entries e JOIN soas s ON s.id = e.soa_id
       JOIN controls c ON c.id = e.control_id JOIN control_catalogues k ON k.id = s.catalogue_id
       WHERE e.supplier_id IS NOT NULL ORDER BY k.key, c.sort, c.ref`,
    ))
      if (want(e.supplier_id))
        add(e.supplier_id, {
          kind: 'soaEntry',
          id: e.control_id,
          name: `${e.key} ${e.ref} ${e.title}`,
          path: `/compliance/soa/${encodeURIComponent(e.key)}?control=${encodeURIComponent(e.control_id)}`,
          detail: e.key,
        });
    // corrective action findings about the supplier (ADR 0029 part 3), those the reader may read
    const ctx = new CaContext();
    for (const f of db().all<FindingRow>('SELECT * FROM ca_findings WHERE supplier_id IS NOT NULL ORDER BY created_at DESC, number DESC'))
      if (want(f.supplier_id) && (!u || canReadFinding(u, f, ctx)))
        add(f.supplier_id!, {
          kind: 'finding',
          id: f.id,
          name: `${f.number} ${f.title}`,
          path: `/compliance/corrective-actions/${f.id}`,
          detail: f.status,
        });
  }
  return out;
}

/**
 * The highest protection need per dimension of the applications linked to each supplier and – since 0.18.0 (ADR 0031)
 * – of the services covered by the contracts the reader may see (their effective protection need). Derived, not stored.
 */
function criticalityOf(usage: Map<string, SupplierUsage[]>, contracts: Map<string, ContractRow[]>, ctx: ScopeCtx): Map<string, SupplierCriticality> {
  const scale = currentScale();
  const appIds = [...new Set([...usage.values()].flat().flatMap((x) => (x.kind === 'application' ? [x.id] : [])))];
  const ratings = appIds.length ? ratingsOf(appIds) : new Map();
  const servicesOf = new Map<string, string[]>();
  for (const [sid, list] of contracts)
    servicesOf.set(sid, [...new Set(list.flatMap((c) => ctx.coverOf(c.id).flatMap((x) => (ctx.seesService(x.service_id) ? [x.service_id] : []))))]);
  const serviceIds = [...new Set([...servicesOf.values()].flat())];
  const needs = serviceIds.length ? protectionNeeds(serviceIds) : new Map<string, ServiceProtectionNeed>();
  const out = new Map<string, SupplierCriticality>();
  for (const sid of new Set([...usage.keys(), ...contracts.keys()])) {
    const c: SupplierCriticality = { confidentiality: null, integrity: null, availability: null };
    const raise = (d: (typeof CIA_DIMENSIONS)[number], level: string | null | undefined) => {
      if (!level) return;
      const levels = scale.levels[d];
      const cur = c[d];
      if (!cur || levelRank(levels, level) > levelRank(levels, cur.level)) c[d] = { level, label: levels.find((l) => l.key === level)?.label ?? level };
    };
    for (const x of usage.get(sid) ?? []) {
      if (x.kind !== 'application') continue;
      const r = ratings.get(x.id);
      for (const d of CIA_DIMENSIONS) raise(d, r?.[d]?.level as string | undefined);
    }
    for (const svc of servicesOf.get(sid) ?? []) for (const d of CIA_DIMENSIONS) raise(d, needs.get(svc)?.[d]?.effective);
    out.set(sid, c);
  }
  return out;
}

const emptyUsage = (): Record<SupplierLinkKind, number> => Object.fromEntries(SUPPLIER_LINK_KINDS.map((k) => [k, 0])) as Record<SupplierLinkKind, number>;

/** The earliest date ahead, else the latest passed one (null: none). */
function nextDate(dates: (string | null)[], today: string): string | null {
  const all = dates.filter((d): d is string => !!d).sort();
  return all.find((d) => d >= today) ?? all.at(-1) ?? null;
}

function toSummary(
  r: SupplierRow,
  x: { contracts: ContractRow[]; certificates: CertificateRow[]; usage: SupplierUsage[]; criticality: SupplierCriticality | undefined; today: string },
): SupplierSummary {
  const usage = emptyUsage();
  for (const u of x.usage) usage[u.kind]++;
  const notice = nextDate(
    x.contracts.map(
      (c) => contractDates({ endsOn: c.ends_on, noticeDays: num(c.notice_days), renewal: c.renewal, renewalMonths: num(c.renewal_months) }, x.today).noticeBy,
    ),
    x.today,
  );
  const expiry = nextDate(
    x.certificates.map((c) => c.valid_until),
    x.today,
  );
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    description: r.description,
    website: r.website,
    owners: ownersOf(r),
    aliases: aliasesOf(r),
    personalData: !!Number(r.personal_data),
    dpaStatus: r.dpa_status,
    dpaSince: r.dpa_since,
    dpaLink: r.dpa_link,
    criticality: x.criticality ?? { confidentiality: null, integrity: null, availability: null },
    contractCount: x.contracts.length,
    certificateCount: x.certificates.length,
    nextNoticeBy: notice,
    noticeState: dateState(notice, x.today),
    nextCertificateExpiry: expiry,
    certificateState: dateState(expiry, x.today),
    usage,
    updatedAt: r.updated_at,
  };
}

/**
 * The contracts of these suppliers that the reader may see (ADR 0031: a team-owned contract only for its owners, the
 * readers of a service it covers, administrators and auditors), by supplier – the covered services read in bulk.
 */
function visibleContractsOf(suppliers: SupplierRow[], all: ContractRow[], ctx: ScopeCtx): Map<string, ContractRow[]> {
  const byId = new Map(suppliers.map((r) => [r.id, r]));
  const mine = all.filter((c) => byId.has(c.supplier_id));
  ctx.load(mine.map((c) => c.id));
  return groupBy(mine.filter((c) => ctx.reads(c, byId.get(c.supplier_id)!)));
}

/** The suppliers the reader may see (all statuses unless one is asked for), ordered by name. */
export function visibleSupplierRows(o: { status?: SupplierStatus | SupplierStatus[] } = {}): SupplierRow[] {
  const want = o.status ? (Array.isArray(o.status) ? o.status : [o.status]) : null;
  return db()
    .all<SupplierRow>('SELECT * FROM suppliers ORDER BY lower(name), id')
    .filter((r) => (!want || want.includes(r.status)) && supplierVisible(r));
}

/**
 * The suppliers the reader may see, with what links them, their contracts' next notice-by date, their certificates'
 * next expiry and the derived criticality. `status` narrows the list (default: every status).
 */
export function listSuppliers(o: { status?: SupplierStatus | SupplierStatus[] } = {}, now = Date.now()): SupplierSummary[] {
  me();
  finishContractScopeUpgrade();
  const rows = visibleSupplierRows(o);
  if (!rows.length) return [];
  const today = supplierToday(now);
  const ctx = new ScopeCtx();
  const contracts = visibleContractsOf(rows, db().all<ContractRow>('SELECT * FROM supplier_contracts'), ctx);
  const certificates = groupBy(db().all<CertificateRow>('SELECT * FROM supplier_certificates'));
  const usage = usageOf(rows.map((r) => r.id));
  const crit = criticalityOf(usage, contracts, ctx);
  return rows.map((r) =>
    toSummary(r, {
      contracts: contracts.get(r.id) ?? [],
      certificates: certificates.get(r.id) ?? [],
      usage: usage.get(r.id) ?? [],
      criticality: crit.get(r.id),
      today,
    }),
  );
}

export function getSupplier(id: string, now = Date.now()): SupplierDetail {
  const u = me();
  const r = supplierRow(id);
  return detailsOf([r], u, now)[0]!;
}

/**
 * Suppliers with their contacts, contracts, certificates, links, duties and migrated texts, read in bulk (one query
 * per table, not per supplier): the supplier page and the exports.
 */
function detailsOf(rows: SupplierRow[], u: AuthUser, now: number): SupplierDetail[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const one = ids.length === 1 ? ids[0]! : null;
  const where = one ? 'WHERE supplier_id = ?' : '';
  const args = one ? [one] : [];
  const today = supplierToday(now);
  const ctx = new ScopeCtx(u);
  const contracts = visibleContractsOf(rows, db().all<ContractRow>(`SELECT * FROM supplier_contracts ${where} ORDER BY lower(title), id`, ...args), ctx);
  const certificates = groupBy(db().all<CertificateRow>(`SELECT * FROM supplier_certificates ${where} ORDER BY kind, valid_until, id`, ...args));
  const contacts = groupBy(db().all<ContactRow>(`SELECT * FROM supplier_contacts ${where} ORDER BY lower(name), id`, ...args));
  const usage = usageOf(ids);
  const crit = criticalityOf(usage, contracts, ctx);
  // the cost plan lines that pay for each contract (services the reader may see)
  const lines = db().all<{ id: string; service_id: string; fiscal_year: number; title: string; supplier_contract_id: string; name: string }>(
    `SELECT l.id, l.service_id, l.fiscal_year, l.title, l.supplier_contract_id, s.name FROM cost_plan_lines l JOIN services s ON s.id = l.service_id
     WHERE ${one ? 'l.supplier_id = ? AND ' : 'l.supplier_id IS NOT NULL AND '}l.supplier_contract_id IS NOT NULL ORDER BY l.fiscal_year DESC, l.title`,
    ...args,
  );
  const migrated = db().all<{ supplier_id: string; table_name: string; spellings: string }>(
    `SELECT supplier_id, table_name, spellings FROM supplier_text_migrations ${where ? `${where} AND` : 'WHERE'} outcome = 'linked' ORDER BY table_name`,
    ...args,
  );
  return rows.map((r) => {
    const used = usage.get(r.id) ?? [];
    const lineIds = new Set(used.filter((x) => x.kind === 'costPlanLine').map((x) => x.id));
    const linesOf = (cid: string) =>
      lines
        .filter((l) => l.supplier_contract_id === cid && lineIds.has(l.id))
        .map((l) => ({ id: l.id, serviceId: l.service_id, serviceName: l.name, fiscalYear: Number(l.fiscal_year), title: l.title }));
    const duties = used
      .filter((x) => x.kind === 'duty')
      .map((d) => {
        const duty = db().get<{ id: string; name: string; service_id: string }>('SELECT id, name, service_id FROM service_duties WHERE id = ?', d.id)!;
        const periods = db()
          .all<{ period_key: string; status: string; period_end: string; grace_end: string }>(
            'SELECT period_key, status, period_end, grace_end FROM duty_periods WHERE duty_id = ? ORDER BY period_start DESC LIMIT 3',
            d.id,
          )
          .map((p) => ({ periodKey: p.period_key, status: p.status, dueAt: p.grace_end }));
        return { id: duty.id, name: duty.name, serviceId: duty.service_id, serviceName: d.detail, periods };
      });
    const mine = contracts.get(r.id) ?? [];
    const certs = certificates.get(r.id) ?? [];
    return {
      ...toSummary(r, { contracts: mine, certificates: certs, usage: used, criticality: crit.get(r.id), today }),
      contacts: (contacts.get(r.id) ?? []).map(toContact),
      contracts: mine.map((c) => toContract(c, today, u, linesOf(c.id), ctx, r)),
      certificates: certs.map((c) => toCertificate(c, today, u)),
      usedBy: used,
      duties,
      migratedFrom: migrated.filter((m) => m.supplier_id === r.id).map((m) => ({ table: m.table_name, spellings: parseJson<string[]>(m.spellings, []) })),
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      canEdit: canEditSupplier(u, r) && r.status !== 'archived',
      canAddContract: mayAddContract(r, ctx),
      canManage: canManageSuppliers(u),
    };
  });
}

/** The supplier picker of the forms: the suppliers the person may see and link (not archived), with their contracts. */
export function supplierOptions(): SupplierOption[] {
  me();
  const rows = visibleSupplierRows({ status: ['active', 'unconfirmed'] });
  const ctx = new ScopeCtx();
  const contracts = visibleContractsOf(rows, db().all<ContractRow>('SELECT * FROM supplier_contracts ORDER BY lower(title), id'), ctx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    aliases: aliasesOf(r),
    contracts: (contracts.get(r.id) ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      reference: c.reference,
      // the pickers offer the contracts covering a service first (ADR 0031 part 4), and those the person may add it to
      services: ctx.coverOf(c.id).map((x) => x.service_id),
      canEdit: ctx.edits(c, byId.get(r.id)!),
    })),
  }));
}

/**
 * What the statement of applicability and the responsibility matrix read of suppliers (ADR 0029 part 2): per contract
 * the SLA and contractual RTO/RPO, and the certificates valid today – of the suppliers the reader may see (all of them
 * for a job). By supplier id; `ids` narrows it.
 */
export function supplierFacts(ids?: readonly string[], now = Date.now()): Map<string, SupplierFacts> {
  const today = supplierToday(now);
  const want = ids ? new Set(ids) : null;
  const rows = visibleSupplierRows().filter((r) => !want || want.has(r.id));
  const ctx = new ScopeCtx();
  // only the contracts the reader may see: a matrix row naming another shows "a contract you may not see" (ADR 0031)
  const contracts = visibleContractsOf(rows, db().all<ContractRow>('SELECT * FROM supplier_contracts ORDER BY lower(title), id'), ctx);
  const certificates = groupBy(db().all<CertificateRow>('SELECT * FROM supplier_certificates ORDER BY kind, valid_until, id'));
  const out = new Map<string, SupplierFacts>();
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      contracts: (contracts.get(r.id) ?? []).map((c) => {
        const x = toContract(c, today, null, [], ctx, r);
        return {
          id: x.id,
          title: x.title,
          reference: x.reference,
          termEnd: x.termEnd,
          noticeBy: x.noticeBy,
          slaAvailability: x.slaAvailability,
          slaSupportHours: x.slaSupportHours,
          slaResponse: x.slaResponse,
          rtoHours: x.rtoHours,
          rpoHours: x.rpoHours,
        };
      }),
      validCertificates: (certificates.get(r.id) ?? [])
        .filter((c) => !c.valid_until || c.valid_until >= today)
        .map((c) => ({ id: c.id, kind: c.kind, name: c.name, scope: c.scope, issuer: c.issuer, validUntil: c.valid_until })),
    });
  }
  return out;
}

// ---------- the public view (no contact e-mail or phone) ----------

export type PublicSupplierContact = Omit<SupplierContact, 'email' | 'phone'>;
export type PublicSupplierContract = Omit<SupplierContract, 'record' | 'services' | 'hiddenServices' | 'readReason' | 'canEdit'> & {
  services: { id: string; name: string; purpose: string; status: SupplierContract['services'][number]['status'] }[];
};
export type PublicSupplier = Omit<SupplierDetail, 'contacts' | 'canEdit' | 'canManage' | 'canAddContract' | 'contracts' | 'certificates'> & {
  contacts: PublicSupplierContact[];
  contracts: PublicSupplierContract[];
  certificates: Omit<SupplierCertificate, 'record'>[];
};

/**
 * A contract for /api/v1, MCP and exports (ADR 0031): the covered services the reader may see, by id, name, purpose
 * and status – no count of the others, no rights.
 */
export function toPublicContract(c: SupplierContract): PublicSupplierContract {
  const { record: _r, services, hiddenServices: _h, readReason: _w, canEdit: _e, ...rest } = c;
  return { ...rest, services: services.map((x) => ({ id: x.id, name: x.name, purpose: x.purpose, status: x.status })) };
}

/**
 * Every supplier the reader may see (all statuses), as toPublic() gives it – contacts without e-mail and phone – read
 * in bulk: the scheduled export (export/parts.ts), in pages of `page` suppliers.
 */
export function* publicSuppliers(page = 100, now = Date.now()): Generator<PublicSupplier[]> {
  const u = me();
  const rows = visibleSupplierRows();
  for (let i = 0; i < rows.length; i += page) yield detailsOf(rows.slice(i, i + page), u, now).map(toPublic);
}

/** A supplier for /api/v1, MCP and exports: contacts without e-mail and phone (ADR 0029, decided 8). */
export function toPublic(d: SupplierDetail): PublicSupplier {
  const { canEdit: _e, canManage: _m, canAddContract: _a, contacts, contracts, certificates, ...rest } = d;
  return {
    ...rest,
    contacts: contacts.map(({ email: _mail, phone: _phone, ...c }) => c),
    contracts: contracts.map(toPublicContract),
    certificates: certificates.map(({ record: _r, ...c }) => c),
  };
}

// ---------- changing the supplier ----------

type Input = z.infer<typeof supplierInput>;

function nameTaken(name: string, except = ''): SupplierRow | undefined {
  return db().get<SupplierRow>("SELECT * FROM suppliers WHERE lower(name) = lower(?) AND id <> ? AND status <> 'archived'", name, except);
}

/**
 * 409 when another supplier has the name (names are unique). A supplier the person may not see (another team's) is
 * neither named nor linked: SUPPLIER_NAME_TAKEN says only that the name cannot be used (security review 0.17.0, L5).
 */
function refuseTakenName(name: string, except = ''): void {
  const clash = nameTaken(name, except);
  if (!clash) return;
  if (!supplierVisible(clash)) throw new HttpError(409, 'This name cannot be used for a supplier – choose another one', 'SUPPLIER_NAME_TAKEN');
  throw new HttpError(409, `A supplier "${name}" exists already`, 'SUPPLIER_EXISTS', { name, id: clash.id });
}

function dpaOf(x: Input): { status: SupplierDpaStatus | null; since: string | null; link: string } {
  if (!x.personalData) return { status: null, since: null, link: '' };
  const status = x.dpaStatus ?? 'missing';
  return status === 'inPlace' ? { status, since: x.dpaSince, link: x.dpaLink } : { status, since: null, link: '' };
}

const touch = (id: string, u: AuthUser) => db().run('UPDATE suppliers SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

/** Creates a supplier (status active), or one from a free-text vendor (status unconfirmed; migrate.ts). */
export function insertSupplier(
  x: { name: string; type?: SupplierType; status: SupplierStatus; aliases?: string[]; owners?: string[] },
  by: string,
  now = nowIso(),
): string {
  const id = newId('sup_');
  db().run(
    `INSERT INTO suppliers (id, name, norm_name, type, owners, status, aliases, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    x.name,
    normVendor(x.name),
    x.type ?? 'other',
    JSON.stringify(x.owners ?? []),
    x.status,
    JSON.stringify((x.aliases ?? []).slice(0, SUPPLIER_LIMITS.aliases)),
    now,
    by,
    now,
    by,
  );
  return id;
}

function checkSupplierLimit(): void {
  const n = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM suppliers WHERE status <> 'archived'")?.n ?? 0);
  if (n >= SUPPLIER_LIMITS.suppliers)
    throw new HttpError(409, `At most ${SUPPLIER_LIMITS.suppliers} suppliers`, 'SUPPLIER_LIMIT', { max: SUPPLIER_LIMITS.suppliers });
}

export function createSupplier(input: Input): SupplierDetail {
  const u = requireManager('create suppliers');
  checkSupplierLimit();
  refuseTakenName(input.name);
  assertKnownSubjects(input.owners);
  const owners = [...new Set(input.owners)];
  const dpa = dpaOf(input);
  let id = '';
  db().tx(() => {
    id = insertSupplier({ name: input.name, type: input.type, status: 'active', owners }, u.username);
    db().run(
      'UPDATE suppliers SET description = ?, website = ?, personal_data = ?, dpa_status = ?, dpa_since = ?, dpa_link = ? WHERE id = ?',
      input.description,
      input.website,
      input.personalData ? 1 : 0,
      dpa.status,
      dpa.since,
      dpa.link,
      id,
    );
    assignCreatorTeams('supplier', id, currentUser());
    audit({
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: id,
      summary: `Supplier "${input.name}" created`,
      details: { name: input.name, type: input.type, owners, personalData: input.personalData, dpaStatus: dpa.status },
    });
  });
  return getSupplier(id);
}

export function updateSupplier(id: string, input: Input): SupplierDetail {
  const u = me();
  const cur = requireEditable(id, 'change this supplier');
  refuseTakenName(input.name, id);
  assertKnownSubjects(input.owners, ownersOf(cur));
  const owners = [...new Set(input.owners)];
  const dpa = dpaOf(input);
  const next = {
    name: input.name,
    type: input.type,
    description: input.description,
    website: input.website,
    owners: JSON.stringify(owners),
    personal_data: input.personalData ? 1 : 0,
    dpa_status: dpa.status,
    dpa_since: dpa.since,
    dpa_link: dpa.link,
  };
  const fields = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (k === 'personal_data' ? Number(cur[k]) : (cur[k] ?? null)));
  if (!fields.length) return getSupplier(id);
  // a renamed supplier keeps its former name as a spelling, so the free texts and the picker still find it
  const aliases = fields.includes('name') ? [...new Set([...aliasesOf(cur), cur.name])].slice(0, SUPPLIER_LIMITS.aliases) : aliasesOf(cur);
  db().tx(() => {
    db().run(
      `UPDATE suppliers SET name = ?, norm_name = ?, type = ?, description = ?, website = ?, owners = ?, personal_data = ?, dpa_status = ?, dpa_since = ?,
         dpa_link = ?, aliases = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      next.name,
      normVendor(next.name),
      next.type,
      next.description,
      next.website,
      next.owners,
      next.personal_data,
      next.dpa_status,
      next.dpa_since,
      next.dpa_link,
      JSON.stringify(aliases),
      nowIso(),
      u.username,
      id,
    );
    audit({
      action: 'supplier.changed',
      entityType: 'supplier',
      entityId: id,
      summary: `Supplier "${input.name}" changed (${fields.join(', ')})`,
      details: {
        changes: fields,
        ...(fields.includes('name') ? { name: { old: cur.name, new: input.name } } : {}),
        ...(fields.includes('type') ? { type: { old: cur.type, new: input.type } } : {}),
        ...(fields.includes('owners') ? { owners: { old: ownersOf(cur), new: owners } } : {}),
        ...(fields.includes('dpa_status') ? { dpaStatus: { old: cur.dpa_status, new: dpa.status } } : {}),
      },
    });
  });
  return getSupplier(id);
}

/** Archive (kept for history and existing links; not offered in pickers) or take back (active). */
export function setSupplierArchived(id: string, archived: boolean): SupplierDetail {
  const u = requireManager('archive suppliers');
  const cur = supplierRow(id);
  if (archived === (cur.status === 'archived')) return getSupplier(id);
  if (!archived) {
    checkSupplierLimit();
    refuseTakenName(cur.name, id);
  }
  db().tx(() => {
    db().run('UPDATE suppliers SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?', archived ? 'archived' : 'active', nowIso(), u.username, id);
    audit({
      action: archived ? 'supplier.archived' : 'supplier.unarchived',
      entityType: 'supplier',
      entityId: id,
      summary: archived ? `Supplier "${cur.name}" archived` : `Supplier "${cur.name}" taken back from the archive`,
      details: { name: cur.name, previousStatus: cur.status },
    });
  });
  return getSupplier(id);
}

function requireUnconfirmedOrActive(r: SupplierRow): void {
  if (r.status === 'archived') throw new HttpError(409, `Supplier "${r.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: r.name });
}

/** An unconfirmed supplier (made from a free-text vendor) becomes an active one. */
export function confirmSupplier(id: string): SupplierDetail {
  const u = requireManager('confirm suppliers');
  const cur = supplierRow(id);
  if (cur.status !== 'unconfirmed')
    throw new HttpError(409, `Supplier "${cur.name}" is not waiting for confirmation`, 'SUPPLIER_NOT_UNCONFIRMED', { name: cur.name });
  db().tx(() => {
    db().run("UPDATE suppliers SET status = 'active', updated_at = ?, updated_by = ? WHERE id = ?", nowIso(), u.username, id);
    audit({
      action: 'supplier.confirmed',
      entityType: 'supplier',
      entityId: id,
      summary: `Supplier "${cur.name}" confirmed`,
      details: { name: cur.name, aliases: aliasesOf(cur) },
    });
  });
  return getSupplier(id);
}

/** The tables whose rows link a supplier (and the cost plan lines' contract). */
export const LINKING_TABLES = [
  'applications',
  'systems',
  'ticket_refs',
  'cd_watches',
  'cost_plan_lines',
  'service_duties',
  // the responsibility matrix and the rows of statements of applicability (ADR 0029 part 2)
  'service_responsibilities',
  'soa_entries',
  // corrective action findings about the supplier (ADR 0029 part 3)
  'ca_findings',
  // cost entries name their supplier (ADR 0030); not listed under "Used by"
  'cost_entries',
] as const;

function countLinks(id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of LINKING_TABLES) {
    const n = Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE supplier_id = ?`, id)?.n ?? 0);
    if (n) out[t] = n;
  }
  return out;
}

/**
 * Merges a supplier into another: its links (in every linking table), contacts, contracts (with the cost plan lines
 * that name them), certificates and spellings move to the target, the free-text migrations name the target, and the
 * merged supplier goes. The target keeps its own name, type and owners; an unconfirmed target stays unconfirmed.
 */
export function mergeSupplier(id: string, intoId: string): SupplierDetail {
  const u = requireManager('merge suppliers');
  if (id === intoId) throw new HttpError(400, 'A supplier cannot be merged into itself', 'SUPPLIER_MERGE_SELF');
  const src = supplierRow(id);
  const dst = supplierRow(intoId);
  requireUnconfirmedOrActive(src);
  requireUnconfirmedOrActive(dst);
  const count = (table: string, sid: string) => Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE supplier_id = ?`, sid)?.n ?? 0);
  const over = (table: string, max: number) => count(table, id) + count(table, intoId) > max;
  if (over('supplier_contacts', SUPPLIER_LIMITS.contacts))
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contacts} contacts`, 'SUPPLIER_CONTACT_LIMIT', { max: SUPPLIER_LIMITS.contacts });
  if (over('supplier_contracts', SUPPLIER_LIMITS.contracts))
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contracts} contracts`, 'SUPPLIER_CONTRACT_LIMIT', { max: SUPPLIER_LIMITS.contracts });
  if (over('supplier_certificates', SUPPLIER_LIMITS.certificates))
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.certificates} certificates`, 'SUPPLIER_CERTIFICATE_LIMIT', {
      max: SUPPLIER_LIMITS.certificates,
    });
  const aliases = [...new Set([...aliasesOf(dst), src.name, ...aliasesOf(src)])].filter((a) => a !== dst.name).slice(0, SUPPLIER_LIMITS.aliases);
  const moved = countLinks(id);
  db().tx(() => {
    for (const t of LINKING_TABLES) db().run(`UPDATE ${t} SET supplier_id = ? WHERE supplier_id = ?`, intoId, id);
    for (const t of ['supplier_contacts', 'supplier_contracts', 'supplier_certificates'])
      db().run(`UPDATE ${t} SET supplier_id = ? WHERE supplier_id = ?`, intoId, id);
    db().run('UPDATE supplier_text_migrations SET supplier_id = ? WHERE supplier_id = ?', intoId, id);
    db().run('UPDATE suppliers SET aliases = ?, updated_at = ?, updated_by = ? WHERE id = ?', JSON.stringify(aliases), nowIso(), u.username, intoId);
    db().run('DELETE FROM suppliers WHERE id = ?', id);
    forgetOwningTeams('supplier', id);
    audit({
      action: 'supplier.merged',
      entityType: 'supplier',
      entityId: intoId,
      summary: `Supplier "${src.name}" merged into "${dst.name}"`,
      details: { from: { id, name: src.name, status: src.status, aliases: aliasesOf(src) }, into: { id: intoId, name: dst.name }, links: moved },
    });
  });
  return getSupplier(intoId);
}

/**
 * "Not a supplier" (`On-premises`, an account name): an unconfirmed supplier goes, the items that link it keep their
 * free text and lose the link, and the free-text migrations remember the outcome, so the text is not made a supplier
 * again.
 */
export function dismissSupplier(id: string): { ok: true; unlinked: Record<string, number> } {
  requireManager('mark suppliers as not a supplier');
  const cur = supplierRow(id);
  if (cur.status !== 'unconfirmed')
    throw new HttpError(409, `Only a supplier waiting for confirmation can be marked "not a supplier"`, 'SUPPLIER_NOT_UNCONFIRMED', { name: cur.name });
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_contracts WHERE supplier_id = ?', id)?.n ?? 0);
  const m = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_certificates WHERE supplier_id = ?', id)?.n ?? 0);
  if (n || m) throw new HttpError(409, `Supplier "${cur.name}" has contracts or certificates`, 'SUPPLIER_HAS_RECORDS', { name: cur.name });
  const unlinked = countLinks(id);
  db().tx(() => {
    for (const t of LINKING_TABLES) db().run(`UPDATE ${t} SET supplier_id = NULL WHERE supplier_id = ?`, id);
    db().run("UPDATE supplier_text_migrations SET outcome = 'notSupplier', supplier_id = NULL WHERE supplier_id = ?", id);
    db().run('DELETE FROM supplier_contacts WHERE supplier_id = ?', id);
    db().run('DELETE FROM suppliers WHERE id = ?', id);
    forgetOwningTeams('supplier', id);
    audit({
      action: 'supplier.dismissed',
      entityType: 'supplier',
      entityId: id,
      summary: `"${cur.name}" marked as not a supplier: ${Object.values(unlinked).reduce((s, x) => s + x, 0)} links cleared, the texts stay`,
      details: { name: cur.name, aliases: aliasesOf(cur), unlinked },
    });
  });
  return { ok: true, unlinked };
}

// ---------- contacts ----------

function contactRow(supplierId: string, contactId: string): ContactRow {
  const c = db().get<ContactRow>('SELECT * FROM supplier_contacts WHERE id = ? AND supplier_id = ?', contactId, supplierId);
  if (!c) throw new HttpError(404, `Contact ${contactId} not found`, 'SUPPLIER_CONTACT_NOT_FOUND', { id: contactId });
  return c;
}

/** What an audit entry says about a contact: name and role, never the e-mail or phone (ADR 0029, decided 8). */
const contactAudit = (c: { name: string; role: string }) => ({ name: c.name, role: c.role });

export function addContact(supplierId: string, input: z.infer<typeof supplierContactInput>): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_contacts WHERE supplier_id = ?', supplierId)?.n ?? 0);
  if (n >= SUPPLIER_LIMITS.contacts)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contacts} contacts`, 'SUPPLIER_CONTACT_LIMIT', { max: SUPPLIER_LIMITS.contacts });
  const id = newId('spc_');
  db().tx(() => {
    db().run(
      'INSERT INTO supplier_contacts (id, supplier_id, name, role, email, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      supplierId,
      input.name,
      input.role,
      input.email,
      input.phone,
      input.note,
      nowIso(),
    );
    touch(supplierId, u);
    audit({
      action: 'supplier.contact_added',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contact "${input.name}" added to supplier "${s.name}"`,
      details: { contactId: id, ...contactAudit(input), email: !!input.email, phone: !!input.phone },
    });
  });
  return getSupplier(supplierId);
}

export function updateContact(supplierId: string, contactId: string, input: z.infer<typeof supplierContactInput>): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const cur = contactRow(supplierId, contactId);
  const fields = (['name', 'role', 'email', 'phone', 'note'] as const).filter((k) => input[k] !== cur[k]);
  if (!fields.length) return getSupplier(supplierId);
  db().tx(() => {
    db().run(
      'UPDATE supplier_contacts SET name = ?, role = ?, email = ?, phone = ?, note = ? WHERE id = ?',
      input.name,
      input.role,
      input.email,
      input.phone,
      input.note,
      contactId,
    );
    touch(supplierId, u);
    audit({
      action: 'supplier.contact_changed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contact "${input.name}" of supplier "${s.name}" changed (${fields.join(', ')})`,
      // which fields changed, never the e-mail or phone values
      details: { contactId, changes: fields, ...contactAudit(input), ...(fields.includes('name') ? { previousName: cur.name } : {}) },
    });
  });
  return getSupplier(supplierId);
}

/** Removing a contact deletes it (personal data of someone outside Steward). */
export function removeContact(supplierId: string, contactId: string): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const cur = contactRow(supplierId, contactId);
  db().tx(() => {
    db().run('DELETE FROM supplier_contacts WHERE id = ?', contactId);
    touch(supplierId, u);
    audit({
      action: 'supplier.contact_removed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contact "${cur.name}" removed from supplier "${s.name}"`,
      details: { contactId, ...contactAudit(cur) },
    });
  });
  return getSupplier(supplierId);
}

// ---------- contracts ----------

type ContractInput = z.infer<typeof supplierContractInput>;

function contractRow(supplierId: string, contractId: string): ContractRow {
  const c = db().get<ContractRow>('SELECT * FROM supplier_contracts WHERE id = ? AND supplier_id = ?', contractId, supplierId);
  if (!c) throw new HttpError(404, `Contract ${contractId} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id: contractId });
  return c;
}

/** A contract the reader may see (404 otherwise, like one that does not exist – ADR 0031). */
function visibleContractRow(s: SupplierRow, contractId: string, ctx: ScopeCtx): ContractRow {
  const c = contractRow(s.id, contractId);
  if (!ctx.reads(c, s)) throw new HttpError(404, `Contract ${contractId} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id: contractId });
  return c;
}

/** A contract the person may change (403 for who only reads it; the supplier not archived). */
function editableContractRow(s: SupplierRow, contractId: string, ctx: ScopeCtx): ContractRow {
  const c = visibleContractRow(s, contractId, ctx);
  if (s.status === 'archived') throw new HttpError(409, `Supplier "${s.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: s.name });
  if (!ctx.edits(c, s))
    forbid('change this contract (its owners, designers, administrators, the supplier’s owners, editors of the services it covers)', 'changeContract');
  return c;
}

/**
 * Add a contract (ADR 0031 decided 4): designers, administrators and the supplier's owners; whoever may edit a service
 * the new contract covers and may see the supplier. Not while the supplier is archived.
 */
export function mayAddContract(s: Pick<SupplierRow, 'id' | 'owners' | 'status'>, ctx: ScopeCtx, serviceIds?: readonly string[]): boolean {
  if (s.status === 'archived' || !ctx.u || !ctx.seesSupplier(s)) return false;
  if (ctx.editsSupplier(s)) return true;
  if (serviceIds) return serviceIds.some((id) => ctx.editsService(id));
  return visibleServiceIds(ctx).some((id) => ctx.editsService(id));
}

const visibleServiceIds = (ctx: ScopeCtx): string[] =>
  db()
    .all<{ id: string }>('SELECT id FROM services WHERE archived = 0')
    .map((r) => r.id)
    .filter((id) => ctx.seesService(id));

const contractColumns = (x: ContractInput) => ({
  title: x.title,
  reference: x.reference,
  starts_on: x.startsOn,
  ends_on: x.endsOn,
  notice_days: x.noticeDays,
  renewal: x.renewal,
  renewal_months: x.renewal === 'automatic' ? x.renewalMonths : null,
  sla_availability: x.slaAvailability,
  sla_support_hours: x.slaSupportHours,
  sla_response: x.slaResponse,
  rto_hours: x.rtoHours,
  rpo_hours: x.rpoHours,
  link: x.link,
  note: x.note,
});

const NUMERIC_CONTRACT_COLUMNS = new Set<string>(['notice_days', 'renewal_months', 'sla_availability', 'rto_hours', 'rpo_hours']);

const contractAudit = (c: ReturnType<typeof contractColumns>) => ({
  title: c.title,
  reference: c.reference,
  startsOn: c.starts_on,
  endsOn: c.ends_on,
  noticeDays: c.notice_days,
  renewal: c.renewal,
  renewalMonths: c.renewal_months,
  slaAvailability: c.sla_availability,
  rtoHours: c.rto_hours,
  rpoHours: c.rpo_hours,
});

/** The owners of a new contract: as given, else the creator and the creator's teams for new resources (ADR 0031 decided 13). */
function defaultContractOwners(u: AuthUser): string[] {
  return [`user:${u.username.toLowerCase()}`, ...newResourceTeams(u).teams.map((t) => `team:${t.name.toLowerCase()}`)];
}

/** A change that leaves no team among the owners opens the contract to every reader of the supplier: asked first. */
function checkOpening(before: string[], after: string[], confirmed: boolean | undefined, title: string): void {
  if (hasTeamOwner(before) && !hasTeamOwner(after) && !confirmed)
    throw new HttpError(409, `Without a team among its owners, everyone who sees the supplier sees the contract "${title}"`, 'SUPPLIER_CONTRACT_OPENS', {
      title,
    });
}

export function addContract(supplierId: string, input: ContractInput): SupplierDetail {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  if (s.status === 'archived') throw new HttpError(409, `Supplier "${s.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: s.name });
  const services = [...new Map((input.services ?? []).map((x) => [x.serviceId, x])).values()];
  for (const x of services)
    if (!ctx.seesService(x.serviceId)) throw new HttpError(404, `Service ${x.serviceId} not found`, 'SERVICE_NOT_FOUND', { id: x.serviceId });
  if (
    !mayAddContract(
      s,
      ctx,
      services.map((x) => x.serviceId),
    )
  )
    forbid('add a contract to this supplier (designers, administrators, the supplier’s owners, editors of a service it covers)', 'addContract');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_contracts WHERE supplier_id = ?', supplierId)?.n ?? 0);
  if (n >= SUPPLIER_LIMITS.contracts)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contracts} contracts`, 'SUPPLIER_CONTRACT_LIMIT', { max: SUPPLIER_LIMITS.contracts });
  const owners = [...new Set(input.owners ?? defaultContractOwners(u))].slice(0, SUPPLIER_LIMITS.contractOwners);
  assertKnownSubjects(owners);
  const c = contractColumns(input);
  const id = newId('sct_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO supplier_contracts (id, supplier_id, title, reference, starts_on, ends_on, notice_days, renewal, renewal_months, sla_availability,
         sla_support_hours, sla_response, rto_hours, rpo_hours, link, note, created_at, updated_at, owners, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      supplierId,
      c.title,
      c.reference,
      c.starts_on,
      c.ends_on,
      c.notice_days,
      c.renewal,
      c.renewal_months,
      c.sla_availability,
      c.sla_support_hours,
      c.sla_response,
      c.rto_hours,
      c.rpo_hours,
      c.link,
      c.note,
      now,
      now,
      JSON.stringify(owners),
      u.username,
      u.username,
    );
    for (const x of services)
      db().run(
        `INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, 'confirmed', '[]', ?, ?, ?, ?)`,
        id,
        x.serviceId,
        x.purpose,
        u.username,
        now,
        u.username,
        now,
      );
    touch(supplierId, u);
    audit({
      action: 'supplier.contract_added',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contract "${c.title}" added to supplier "${s.name}"`,
      details: { contractId: id, ...contractAudit(c), owners, services: services.map((x) => ({ serviceId: x.serviceId, purpose: x.purpose })) },
    });
  });
  return getSupplier(supplierId);
}

export function updateContract(supplierId: string, contractId: string, input: ContractInput): SupplierDetail {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  const cur = editableContractRow(s, contractId, ctx);
  const next = contractColumns(input);
  const ownersBefore = contractOwnersOf(cur);
  const owners = input.owners ? [...new Set(input.owners)].slice(0, SUPPLIER_LIMITS.contractOwners) : ownersBefore;
  const ownersChanged = JSON.stringify([...owners].sort()) !== JSON.stringify([...ownersBefore].sort());
  if (ownersChanged) {
    assertKnownSubjects(owners, ownersBefore);
    checkOpening(ownersBefore, owners, input.confirmOpen, cur.title);
  }
  // numbers come back as strings from some drivers: compare them as numbers
  const norm = (k: keyof typeof next, v: unknown) => (v === null || v === undefined ? null : NUMERIC_CONTRACT_COLUMNS.has(k) ? Number(v) : v);
  const fields: string[] = (Object.keys(next) as (keyof typeof next)[]).filter((k) => norm(k, next[k]) !== norm(k, cur[k]));
  if (ownersChanged) fields.push('owners');
  if (!fields.length) return getSupplier(supplierId);
  const plain = fields.filter((f) => f !== 'note' && f !== 'sla_response' && f !== 'owners') as (keyof typeof next)[];
  db().tx(() => {
    db().run(
      `UPDATE supplier_contracts SET title = ?, reference = ?, starts_on = ?, ends_on = ?, notice_days = ?, renewal = ?, renewal_months = ?, sla_availability = ?,
         sla_support_hours = ?, sla_response = ?, rto_hours = ?, rpo_hours = ?, link = ?, note = ?, owners = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      next.title,
      next.reference,
      next.starts_on,
      next.ends_on,
      next.notice_days,
      next.renewal,
      next.renewal_months,
      next.sla_availability,
      next.sla_support_hours,
      next.sla_response,
      next.rto_hours,
      next.rpo_hours,
      next.link,
      next.note,
      JSON.stringify(owners),
      nowIso(),
      u.username,
      contractId,
    );
    touch(supplierId, u);
    audit({
      action: 'supplier.contract_changed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contract "${next.title}" of supplier "${s.name}" changed (${fields.join(', ')})`,
      details: {
        contractId,
        changes: fields,
        old: { ...Object.fromEntries(plain.map((f) => [f, cur[f] ?? null])), ...(ownersChanged ? { owners: ownersBefore } : {}) },
        new: { ...Object.fromEntries(plain.map((f) => [f, next[f] ?? null])), ...(ownersChanged ? { owners } : {}) },
      },
    });
  });
  return getSupplier(supplierId);
}

/**
 * Removes a contract; the cost plan lines and entries that named it keep their supplier and lose the contract, its
 * payment schedules go (audited on their services) and the lines made from them become ordinary lines (ADR 0030); its
 * covered services go, contacts scoped to it lose the item (ADR 0031).
 */
export function removeContract(supplierId: string, contractId: string): SupplierDetail {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  const cur = editableContractRow(s, contractId, ctx);
  db().tx(() => {
    const lines = db().run('UPDATE cost_plan_lines SET supplier_contract_id = NULL WHERE supplier_contract_id = ?', contractId).changes;
    // cost entries keep their supplier, without the contract; its payment schedules go, the lines made from them
    // become ordinary lines (ADR 0030)
    db().run('UPDATE cost_entries SET supplier_contract_id = NULL WHERE supplier_contract_id = ?', contractId);
    dropSchedules(db().all<ScheduleRow>('SELECT * FROM cost_schedules WHERE contract_id = ?', contractId), 'contractRemoved', cur.title, s.name);
    // a responsibility matrix row keeps its supplier, without the contract
    const responsibilities = db().run('UPDATE service_responsibilities SET contract_id = NULL WHERE contract_id = ?', contractId).changes;
    const services = db()
      .all<{ service_id: string }>('SELECT service_id FROM supplier_contract_services WHERE contract_id = ?', contractId)
      .map((r) => r.service_id);
    db().run('DELETE FROM supplier_contract_services WHERE contract_id = ?', contractId);
    db().run("DELETE FROM supplier_contact_scopes WHERE kind = 'contract' AND item_id = ?", contractId);
    db().run('DELETE FROM supplier_contracts WHERE id = ?', contractId);
    db().run('DELETE FROM supplier_reminders WHERE item_id = ?', contractId);
    touch(supplierId, u);
    audit({
      action: 'supplier.contract_removed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Contract "${cur.title}" removed from supplier "${s.name}"`,
      details: {
        contractId,
        title: cur.title,
        reference: cur.reference,
        owners: contractOwnersOf(cur),
        services,
        costPlanLinesUnlinked: lines,
        responsibilitiesUnlinked: responsibilities,
      },
    });
  });
  return getSupplier(supplierId);
}

// ---------- covered services (ADR 0031) ----------

function serviceName(id: string): string {
  return db().get<{ name: string }>('SELECT name FROM services WHERE id = ?', id)?.name ?? id;
}

/**
 * Adds a service to a contract (who may change the contract and may see the service), changes its purpose or confirms
 * a proposed one (who may change the contract, or who may edit that service).
 */
export function setContractService(supplierId: string, contractId: string, serviceId: string, input: SupplierContractServiceInput): SupplierContractDetail {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  const c = visibleContractRow(s, contractId, ctx);
  if (s.status === 'archived') throw new HttpError(409, `Supplier "${s.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: s.name });
  // a service the person may not see reads as missing – also whether the contract covers it
  if (!ctx.seesService(serviceId, true)) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  const cur = ctx.coverOf(c.id).find((x) => x.service_id === serviceId);
  const name = serviceName(serviceId);
  const now = nowIso();
  if (!cur) {
    if (!ctx.seesService(serviceId)) throw new HttpError(409, `Service "${name}" is archived`, 'SUPPLIER_CONTRACT_SERVICE_ARCHIVED', { name });
    if (!ctx.edits(c, s)) forbid('add a service to this contract (who may change the contract)', 'changeContract');
    if (ctx.coverOf(c.id).length >= SUPPLIER_LIMITS.contractServices)
      throw new HttpError(409, `A contract covers at most ${SUPPLIER_LIMITS.contractServices} services`, 'SUPPLIER_CONTRACT_SERVICE_LIMIT', {
        max: SUPPLIER_LIMITS.contractServices,
      });
    const purpose = input.purpose ?? '';
    db().tx(() => {
      db().run(
        `INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, 'confirmed', '[]', ?, ?, ?, ?)`,
        c.id,
        serviceId,
        purpose,
        u.username,
        now,
        u.username,
        now,
      );
      touch(supplierId, u);
      audit({
        action: 'supplier.contract_service_added',
        entityType: 'supplier',
        entityId: supplierId,
        summary: `Service "${name}" added to the contract "${c.title}" of supplier "${s.name}"`,
        details: { contractId: c.id, serviceId, service: name, purpose },
      });
    });
    return getContract(supplierId, contractId);
  }
  if (!ctx.editsCover(c, s, serviceId)) forbid('change this covered service (who may change the contract, or edit the service)', 'changeContract');
  const purposeChanged = input.purpose !== undefined && input.purpose !== cur.purpose;
  const confirming = !!input.confirm && cur.status === 'proposed';
  if (!purposeChanged && !confirming) return getContract(supplierId, contractId);
  db().tx(() => {
    if (purposeChanged) {
      db().run('UPDATE supplier_contract_services SET purpose = ? WHERE contract_id = ? AND service_id = ?', input.purpose, c.id, serviceId);
      audit({
        action: 'supplier.contract_service_changed',
        entityType: 'supplier',
        entityId: supplierId,
        summary: `Purpose of service "${name}" in the contract "${c.title}" changed`,
        details: { contractId: c.id, serviceId, service: name, purpose: { old: cur.purpose, new: input.purpose } },
      });
    }
    if (confirming) {
      db().run(
        "UPDATE supplier_contract_services SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE contract_id = ? AND service_id = ?",
        u.username,
        now,
        c.id,
        serviceId,
      );
      audit({
        action: 'supplier.contract_service_confirmed',
        entityType: 'supplier',
        entityId: supplierId,
        summary: `Service "${name}" confirmed for the contract "${c.title}" of supplier "${s.name}"`,
        details: { contractId: c.id, serviceId, service: name, proposedFrom: parseJson<string[]>(cur.proposed_from, []) },
      });
    }
    touch(supplierId, u);
  });
  return getContract(supplierId, contractId);
}

/**
 * Leave the contract (a confirmed service) or "Not this service" (a proposed one): who may change the contract, or
 * who may edit that service. Refused while the service pays a payment schedule of the contract – move or remove it
 * first. Plan lines, matrix rows, duties and findings that name the contract keep it (with the hint that it no longer
 * covers the service).
 */
export function removeContractService(supplierId: string, contractId: string, serviceId: string): SupplierContractDetail | { ok: true } {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  const c = visibleContractRow(s, contractId, ctx);
  if (s.status === 'archived') throw new HttpError(409, `Supplier "${s.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: s.name });
  if (!ctx.seesService(serviceId, true)) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  const cur = ctx.coverOf(c.id).find((x) => x.service_id === serviceId);
  if (!cur) throw new HttpError(404, `The contract does not cover service ${serviceId}`, 'SUPPLIER_CONTRACT_SERVICE_NOT_FOUND', { id: serviceId });
  if (!ctx.editsCover(c, s, serviceId)) forbid('take this service off the contract (who may change the contract, or edit the service)', 'changeContract');
  const schedules = db().all<{ id: string; title: string }>('SELECT id, title FROM cost_schedules WHERE contract_id = ? AND service_id = ?', c.id, serviceId);
  if (schedules.length)
    throw new HttpError(
      409,
      `The service pays ${schedules.length} payment schedule(s) of this contract – move or remove them first`,
      'SUPPLIER_CONTRACT_SERVICE_HAS_SCHEDULES',
      { count: schedules.length, schedules: schedules.map((x) => x.title).join(', ') },
    );
  const name = serviceName(serviceId);
  const proposed = cur.status === 'proposed';
  db().tx(() => {
    db().run('DELETE FROM supplier_contract_services WHERE contract_id = ? AND service_id = ?', c.id, serviceId);
    touch(supplierId, u);
    audit({
      action: proposed ? 'supplier.contract_service_dismissed' : 'supplier.contract_service_removed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: proposed
        ? `Proposed service "${name}" dismissed for the contract "${c.title}" of supplier "${s.name}"`
        : `Service "${name}" left the contract "${c.title}" of supplier "${s.name}"`,
      details: {
        contractId: c.id,
        serviceId,
        service: name,
        purpose: cur.purpose,
        ...(proposed ? { proposedFrom: parseJson<string[]>(cur.proposed_from, []) } : {}),
      },
    });
  });
  // who could see the contract only through the service no longer does
  return new ScopeCtx(u).reads(c, s) ? getContract(supplierId, contractId) : { ok: true };
}

// ---------- the contract page and the service's contracts (ADR 0031) ----------

/** The contract with its supplier and who sees it (404 for who may not). */
export function getContract(supplierId: string, contractId: string, now = Date.now()): SupplierContractDetail {
  const u = me();
  const s = supplierRow(supplierId);
  const ctx = new ScopeCtx(u);
  const c = visibleContractRow(s, contractId, ctx);
  const today = supplierToday(now);
  const lines = db()
    .all<{ id: string; service_id: string; fiscal_year: number; title: string; name: string }>(
      `SELECT l.id, l.service_id, l.fiscal_year, l.title, s.name FROM cost_plan_lines l JOIN services s ON s.id = l.service_id
        WHERE l.supplier_contract_id = ? ORDER BY l.fiscal_year DESC, l.title`,
      c.id,
    )
    .filter((l) => ctx.seesService(l.service_id, true))
    .map((l) => ({ id: l.id, serviceId: l.service_id, serviceName: l.name, fiscalYear: Number(l.fiscal_year), title: l.title }));
  const contract = toContract(c, today, u, lines, ctx, s);
  const owners = contract.owners;
  return {
    supplier: { id: s.id, name: s.name, status: s.status, owners: ownersOf(s), teams: catalogueTeams('supplier', s.id).map((t) => t.name) },
    contract,
    visibility: {
      open: !contract.teamOwned,
      teams: owners.filter((o) => o.startsWith('team:')).map((o) => o.slice(5)),
      users: owners.filter((o) => o.startsWith('user:')).map((o) => o.slice(5)),
      services: contract.services.filter((x) => !x.archived).map((x) => ({ id: x.id, name: x.name })),
      hiddenServices: contract.hiddenServices,
    },
  };
}

/**
 * The contracts covering a service that the reader may see (the service page's "Suppliers" section), and the suppliers
 * its applications and systems link without such a contract.
 */
export function serviceContracts(serviceId: string, now = Date.now()): ServiceContracts {
  const u = me();
  const ctx = new ScopeCtx(u);
  if (!ctx.seesService(serviceId, true)) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  const today = supplierToday(now);
  const ids = db()
    .all<{ contract_id: string }>('SELECT contract_id FROM supplier_contract_services WHERE service_id = ?', serviceId)
    .map((r) => r.contract_id);
  const rows: ContractRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(...db().all<ContractRow>(`SELECT * FROM supplier_contracts WHERE id IN (${part.map(() => '?').join(', ')}) ORDER BY lower(title), id`, ...part));
  }
  const suppliers = new Map(visibleSupplierRows().map((r) => [r.id, r]));
  ctx.load(rows.map((c) => c.id));
  const contracts: ServiceContract[] = [];
  for (const c of rows) {
    const s = suppliers.get(c.supplier_id);
    if (!s || !ctx.reads(c, s)) continue;
    const cover = ctx.coverOf(c.id).find((x) => x.service_id === serviceId)!;
    contracts.push({
      supplier: { id: s.id, name: s.name, status: s.status },
      contract: toContract(c, today, u, [], ctx, s),
      purpose: cover.purpose,
      status: cover.status,
      canChange: ctx.editsCover(c, s, serviceId),
    });
  }
  contracts.sort((a, b) => a.supplier.name.localeCompare(b.supplier.name) || a.contract.title.localeCompare(b.contract.title));
  const covered = new Set(contracts.map((x) => x.supplier.id));
  const via = new Map<string, { kind: 'application' | 'system'; id: string; name: string }[]>();
  for (const a of db().all<{ id: string; name: string; owners: string; supplier_id: string }>(
    `SELECT a.id, a.name, a.owners, a.supplier_id FROM applications a JOIN service_applications sa ON sa.application_id = a.id
      WHERE sa.service_id = ? AND a.supplier_id IS NOT NULL AND a.archived = 0`,
    serviceId,
  ))
    if (catalogueVisibleNow('application', a)) via.set(a.supplier_id, [...(via.get(a.supplier_id) ?? []), { kind: 'application', id: a.id, name: a.name }]);
  for (const x of db().all<{ id: string; name: string; owners: string; supplier_id: string }>(
    `SELECT DISTINCT y.id, y.name, y.owners, y.supplier_id FROM systems y JOIN application_systems ay ON ay.system_id = y.id
       JOIN service_applications sa ON sa.application_id = ay.application_id WHERE sa.service_id = ? AND y.supplier_id IS NOT NULL`,
    serviceId,
  ))
    if (catalogueVisibleNow('system', x)) via.set(x.supplier_id, [...(via.get(x.supplier_id) ?? []), { kind: 'system', id: x.id, name: x.name }]);
  const uncovered = [...via.entries()]
    .filter(([sid]) => !covered.has(sid) && suppliers.has(sid))
    .map(([sid, items]) => ({ id: sid, name: suppliers.get(sid)!.name, status: suppliers.get(sid)!.status, via: items }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { serviceId, contracts, uncovered, canEdit: ctx.editsService(serviceId) };
}

// ---------- certificates ----------

type CertificateInput = z.infer<typeof supplierCertificateInput>;

function certificateRow(supplierId: string, certificateId: string): CertificateRow {
  const c = db().get<CertificateRow>('SELECT * FROM supplier_certificates WHERE id = ? AND supplier_id = ?', certificateId, supplierId);
  if (!c) throw new HttpError(404, `Certificate ${certificateId} not found`, 'SUPPLIER_CERTIFICATE_NOT_FOUND', { id: certificateId });
  return c;
}

/** A SOC 2 report without a valid-until date: the end of its period plus twelve months. */
const validUntilOf = (x: CertificateInput): string | null => x.validUntil ?? (isSoc2(x.kind) && x.issuedOn ? soc2ValidUntil(x.issuedOn) : null);

export function addCertificate(supplierId: string, input: CertificateInput): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM supplier_certificates WHERE supplier_id = ?', supplierId)?.n ?? 0);
  if (n >= SUPPLIER_LIMITS.certificates)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.certificates} certificates`, 'SUPPLIER_CERTIFICATE_LIMIT', {
      max: SUPPLIER_LIMITS.certificates,
    });
  const id = newId('scf_');
  const now = nowIso();
  const validUntil = validUntilOf(input);
  db().tx(() => {
    db().run(
      `INSERT INTO supplier_certificates (id, supplier_id, kind, name, scope, issuer, issued_on, valid_until, link, checked_by, checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      supplierId,
      input.kind,
      input.name,
      input.scope,
      input.issuer,
      input.issuedOn,
      validUntil,
      input.link,
      input.checked ? u.username : null,
      input.checked ? now : null,
      now,
      now,
    );
    touch(supplierId, u);
    audit({
      action: 'supplier.certificate_added',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Certificate ${input.kind}${input.name ? ` "${input.name}"` : ''} added to supplier "${s.name}" (valid until ${validUntil ?? '–'})`,
      details: { certificateId: id, kind: input.kind, name: input.name, issuer: input.issuer, issuedOn: input.issuedOn, validUntil, checked: input.checked },
    });
  });
  return getSupplier(supplierId);
}

export function updateCertificate(supplierId: string, certificateId: string, input: CertificateInput): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const cur = certificateRow(supplierId, certificateId);
  const next = {
    kind: input.kind,
    name: input.name,
    scope: input.scope,
    issuer: input.issuer,
    issued_on: input.issuedOn,
    valid_until: validUntilOf(input),
    link: input.link,
  };
  const fields = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (cur[k] ?? null));
  if (!fields.length && !input.checked) return getSupplier(supplierId);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `UPDATE supplier_certificates SET kind = ?, name = ?, scope = ?, issuer = ?, issued_on = ?, valid_until = ?, link = ?, checked_by = ?, checked_at = ?,
         updated_at = ? WHERE id = ?`,
      next.kind,
      next.name,
      next.scope,
      next.issuer,
      next.issued_on,
      next.valid_until,
      next.link,
      input.checked ? u.username : cur.checked_by,
      input.checked ? now : cur.checked_at,
      now,
      certificateId,
    );
    // a new date: the reminders of the old one do not hold back those of the new one
    if (fields.includes('valid_until')) db().run('DELETE FROM supplier_reminders WHERE item_id = ?', certificateId);
    touch(supplierId, u);
    audit({
      action: 'supplier.certificate_changed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Certificate ${next.kind} of supplier "${s.name}" ${fields.length ? `changed (${fields.join(', ')})` : 'looked at'}${input.checked ? ', looked at now' : ''}`,
      details: {
        certificateId,
        changes: fields,
        old: Object.fromEntries(fields.map((f) => [f, cur[f] ?? null])),
        new: Object.fromEntries(fields.map((f) => [f, next[f] ?? null])),
        checked: input.checked,
      },
    });
  });
  return getSupplier(supplierId);
}

export function removeCertificate(supplierId: string, certificateId: string): SupplierDetail {
  const u = me();
  const s = requireEditable(supplierId, 'change this supplier');
  const cur = certificateRow(supplierId, certificateId);
  db().tx(() => {
    db().run('DELETE FROM supplier_certificates WHERE id = ?', certificateId);
    db().run('DELETE FROM supplier_reminders WHERE item_id = ?', certificateId);
    touch(supplierId, u);
    audit({
      action: 'supplier.certificate_removed',
      entityType: 'supplier',
      entityId: supplierId,
      summary: `Certificate ${cur.kind} removed from supplier "${s.name}"`,
      details: { certificateId, kind: cur.kind, name: cur.name, validUntil: cur.valid_until },
    });
  });
  return getSupplier(supplierId);
}

// ---------- expiring (reminders, dataset, daily summary) ----------

export interface ExpiringItem {
  kind: 'certificate' | 'notice';
  itemId: string;
  supplierId: string;
  supplierName: string;
  status: SupplierStatus;
  owners: string[];
  /** The certificate's kind and name, or the contract's title */
  title: string;
  date: string;
  days: number;
  state: SupplierDateState;
  /** A notice-by date: the contract's owners and the services it covers by name and purpose (ADR 0031) */
  contractOwners: string[];
  services: { id: string; name: string; purpose: string }[];
}

/**
 * Certificates that run out and notice-by dates within `days` (and those passed since `pastDays`) of suppliers the
 * reader may see (every supplier for a job). Unconfirmed and archived suppliers are left out unless asked for.
 */
export function expiringItems(o: { days?: number; pastDays?: number; includeUnconfirmed?: boolean } = {}, now = Date.now()): ExpiringItem[] {
  const today = supplierToday(now);
  const days = o.days ?? 90;
  const past = o.pastDays ?? 30;
  const rows = visibleSupplierRows({ status: o.includeUnconfirmed ? ['active', 'unconfirmed'] : 'active' });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ExpiringItem[] = [];
  const ctx = new ScopeCtx();
  const push = (
    kind: ExpiringItem['kind'],
    itemId: string,
    sid: string,
    title: string,
    date: string | null,
    contract?: { owners: string[]; services: ExpiringItem['services'] },
  ) => {
    const s = byId.get(sid);
    if (!s || !date) return;
    const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (d > days || d < -past) return;
    out.push({
      kind,
      itemId,
      supplierId: sid,
      supplierName: s.name,
      status: s.status,
      owners: ownersOf(s),
      title,
      date,
      days: d,
      state: dateState(date, today),
      contractOwners: contract?.owners ?? [],
      services: contract?.services ?? [],
    });
  };
  for (const c of db().all<CertificateRow>('SELECT * FROM supplier_certificates WHERE valid_until IS NOT NULL'))
    push('certificate', c.id, c.supplier_id, c.name ? `${c.kind} ${c.name}` : c.kind, c.valid_until);
  const contracts = db()
    .all<ContractRow>('SELECT * FROM supplier_contracts WHERE ends_on IS NOT NULL')
    .filter((c) => byId.has(c.supplier_id));
  ctx.load(contracts.map((c) => c.id));
  for (const c of contracts) {
    // a notice-by date only of a contract the reader may see (ADR 0031 part 4)
    if (!ctx.reads(c, byId.get(c.supplier_id)!)) continue;
    const d = contractDates({ endsOn: c.ends_on, noticeDays: num(c.notice_days), renewal: c.renewal, renewalMonths: num(c.renewal_months) }, today);
    const services = ctx.servicesOf(c, byId.get(c.supplier_id)!).services.map((x) => ({ id: x.id, name: x.name, purpose: x.purpose }));
    push('notice', c.id, c.supplier_id, c.title, d.noticeBy, { owners: contractOwnersOf(c), services });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.supplierName.localeCompare(b.supplierName));
}
