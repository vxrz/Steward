import {
  AREA_DEFAULT_REFS,
  RECOVERY_TEST_AREAS,
  RECOVERY_TEST_PARTIES,
  RESPONSIBILITY_AREAS,
  SOA_DEFAULT_CATALOGUE,
  responsibilitiesInput,
  type ResponsibilitiesInput,
  type ResponsibilityArea,
  type ResponsibilityParty,
  type ResponsibilityRow,
  type ServiceResponsibilities,
  type SoaAreaControls,
  type SoaControlRef,
  type SupplierFacts,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { canEditService, canViewCatalogue } from '../records/access.js';
import { supplierFacts } from '../suppliers/service.js';
import { coverChosenContract, resolveSupplierContract, resolveSupplierLink, supplierRefs } from '../suppliers/links.js';
import { coveredPairs } from '../suppliers/contract-scope.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { ensureCatalogues } from './controls.js';
import { forbid, me } from './access.js';

/**
 * The responsibility matrix per service (ADR 0029 part 2, docs/COMPLIANCE.md#responsibility-matrix): for six fixed areas
 * each service says who does it – our team, a supplier (optionally one of its contracts), central IT or group (a name),
 * shared (with a note) or not applicable. A supplier's SLA, contractual RTO/RPO and valid certificates are read from
 * the supplier record, never copied. Where the team does recovery itself (backup, recovery and continuity: our team or
 * shared) the row asks for a recovery-test duty of the service; Steward does not create duties.
 *
 * Who may change it: whoever may edit the service. The statement of applicability reads the matrix of the services in
 * its scope as a derived suggestion of the responsible party (soa.ts) – never stored there.
 */

export interface ResponsibilityDbRow {
  service_id: string;
  area: ResponsibilityArea;
  party: ResponsibilityParty;
  supplier_id: string | null;
  contract_id: string | null;
  central_name: string;
  note: string;
  duty_id: string | null;
  updated_at: string;
  updated_by: string;
}

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

const ownersOf = (s: ServiceRow) => parseJson<string[]>(s.owners, []);
const ref = (s: ServiceRow) => ({ kind: 'service' as const, id: s.id, owners: ownersOf(s) });

/** The controls of a catalogue per area: the stored area controls, else (Annex A) the default identifiers. */
export function areaControlsOf(catalogue: { id: string; key: string }, stored: SoaAreaControls | null): Record<ResponsibilityArea, string[]> {
  const out = Object.fromEntries(RESPONSIBILITY_AREAS.map((a) => [a, [] as string[]])) as Record<ResponsibilityArea, string[]>;
  const known = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM controls WHERE catalogue_id = ?', catalogue.id)
      .map((c) => c.id),
  );
  const own = stored && RESPONSIBILITY_AREAS.some((a) => (stored[a] ?? []).length > 0);
  if (own) {
    for (const a of RESPONSIBILITY_AREAS) out[a] = (stored[a] ?? []).filter((id) => known.has(id));
    return out;
  }
  if (catalogue.key !== SOA_DEFAULT_CATALOGUE) return out;
  const byRef = new Map(
    db()
      .all<{ id: string; ref: string }>('SELECT id, ref FROM controls WHERE catalogue_id = ?', catalogue.id)
      .map((c) => [c.ref, c.id]),
  );
  for (const a of RESPONSIBILITY_AREAS) out[a] = AREA_DEFAULT_REFS[a].map((r) => byRef.get(r)).filter((x): x is string => !!x);
  return out;
}

/** The area controls per catalogue: Annex A by default, and every catalogue with an SoA (its settings). */
function controlsPerArea(): Record<ResponsibilityArea, SoaControlRef[]> {
  ensureCatalogues();
  const out = Object.fromEntries(RESPONSIBILITY_AREAS.map((a) => [a, [] as SoaControlRef[]])) as Record<ResponsibilityArea, SoaControlRef[]>;
  const soas = new Map(
    db()
      .all<{ catalogue_id: string; area_controls: string }>('SELECT catalogue_id, area_controls FROM soas')
      .map((s) => [s.catalogue_id, parseJson<SoaAreaControls>(s.area_controls, {})]),
  );
  const catalogues = db().all<{ id: string; key: string }>('SELECT id, key FROM control_catalogues ORDER BY builtin DESC, key');
  const controls = new Map(
    db()
      .all<{ id: string; ref: string; title: string }>('SELECT id, ref, title FROM controls')
      .map((c) => [c.id, c]),
  );
  for (const k of catalogues) {
    if (!soas.has(k.id) && k.key !== SOA_DEFAULT_CATALOGUE) continue;
    const per = areaControlsOf(k, soas.get(k.id) ?? null);
    for (const a of RESPONSIBILITY_AREAS)
      for (const id of per[a]) {
        const c = controls.get(id);
        if (c) out[a].push({ catalogueKey: k.key, controlId: c.id, ref: c.ref, title: c.title, soa: soas.has(k.id) });
      }
  }
  return out;
}

function serviceRow(id: string, u: AuthUser): ServiceRow {
  const s = db().get<ServiceRow>('SELECT id, name, owners, archived FROM services WHERE id = ?', id);
  if (!s || !canViewCatalogue(u, ref(s))) throw new HttpError(404, `Service ${id} not found`, 'SERVICE_NOT_FOUND', { id });
  return s;
}

/** Whether a row asks for a recovery-test duty: backup or recovery done by the team (alone or shared). */
export const needsRecoveryTest = (area: ResponsibilityArea, party: ResponsibilityParty | null): boolean =>
  !!party && RECOVERY_TEST_AREAS.includes(area) && RECOVERY_TEST_PARTIES.includes(party);

/** The matrix of a service as the reader sees it (six rows in a fixed order). */
export function getResponsibilities(serviceId: string, u = me()): ServiceResponsibilities {
  const s = serviceRow(serviceId, u);
  const stored = new Map(
    db()
      .all<ResponsibilityDbRow>('SELECT * FROM service_responsibilities WHERE service_id = ?', s.id)
      .map((r) => [r.area, r]),
  );
  const duties = db().all<{ id: string; name: string }>('SELECT id, name FROM service_duties WHERE service_id = ? AND archived = 0 ORDER BY name', s.id);
  const dutyNames = new Map(duties.map((d) => [d.id, d.name]));
  const supplierIds = [...stored.values()].map((r) => r.supplier_id).filter((x): x is string => !!x);
  const refs = supplierRefs(supplierIds);
  const facts: Map<string, SupplierFacts> = supplierIds.length ? supplierFacts(supplierIds) : new Map();
  const covered = coveredPairs([...stored.values()].flatMap((r) => (r.contract_id ? [{ contractId: r.contract_id, serviceId: s.id }] : [])));
  const perArea = controlsPerArea();
  const rows: ResponsibilityRow[] = RESPONSIBILITY_AREAS.map((area) => {
    const r = stored.get(area);
    const party = r?.party ?? null;
    const f = r?.supplier_id ? facts.get(r.supplier_id) : undefined;
    const c = f && r?.contract_id ? f.contracts.find((x) => x.id === r.contract_id) : undefined;
    const duty = r?.duty_id && dutyNames.has(r.duty_id) ? { id: r.duty_id, name: dutyNames.get(r.duty_id)! } : null;
    const needs = needsRecoveryTest(area, party);
    return {
      area,
      party,
      supplier: r?.supplier_id ? (refs.get(r.supplier_id) ?? null) : null,
      supplierHidden: !!r?.supplier_id && !refs.has(r.supplier_id),
      contract: c
        ? {
            id: c.id,
            title: c.title,
            reference: c.reference,
            termEnd: c.termEnd,
            noticeBy: c.noticeBy,
            slaAvailability: c.slaAvailability,
            slaSupportHours: c.slaSupportHours,
            slaResponse: c.slaResponse,
            rtoHours: c.rtoHours,
            rpoHours: c.rpoHours,
          }
        : null,
      // a contract the reader may not see: the neutral text without its values; the supplier's certificates stay (ADR 0031)
      contractHidden: !!r?.contract_id && !!f && !c,
      contractUncovered: !!c && !covered.has(`${c.id}|${s.id}`),
      certificates: f ? f.validCertificates.map((x) => ({ kind: x.kind, name: x.name, validUntil: x.validUntil })) : [],
      centralName: r?.central_name ?? '',
      note: r?.note ?? '',
      duty,
      recoveryTest: !needs ? 'notNeeded' : duty ? 'linked' : 'missing',
      controls: perArea[area],
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  });
  return {
    serviceId: s.id,
    serviceName: s.name,
    rows,
    duties,
    canEdit: !s.archived && canEditService(u, ref(s)),
    undecided: rows.filter((r) => !r.party).length,
  };
}

const AUDITED = ['party', 'supplier_id', 'contract_id', 'central_name', 'note', 'duty_id'] as const;

/**
 * Sets areas of a service's matrix (whoever may edit the service). A supplier must be one the person may see; its
 * contract must be the supplier's; a recovery-test duty must be a duty of the service, only where the team does
 * recovery itself; shared needs a note saying who does what.
 */
export function setResponsibilities(serviceId: string, input: ResponsibilitiesInput): ServiceResponsibilities {
  const u = me();
  const v = responsibilitiesInput.parse(input);
  const s = serviceRow(serviceId, u);
  if (s.archived || !canEditService(u, ref(s))) forbid('change the responsibilities of this service (whoever may edit the service)', 'changeService');
  const stored = new Map(
    db()
      .all<ResponsibilityDbRow>('SELECT * FROM service_responsibilities WHERE service_id = ?', s.id)
      .map((r) => [r.area, r]),
  );
  const now = nowIso();
  const changes: { area: ResponsibilityArea; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[] = [];
  const next: (ResponsibilityDbRow | { area: ResponsibilityArea; remove: true })[] = [];
  for (const a of v.areas) {
    const cur = stored.get(a.area) ?? null;
    if (!a.party) {
      if (cur) {
        next.push({ area: a.area, remove: true });
        changes.push({ area: a.area, before: pick(cur), after: null });
      }
      continue;
    }
    const supplier = a.party === 'supplier' ? resolveSupplierLink(a.supplierId === undefined ? undefined : a.supplierId, cur?.supplier_id ?? null) : null;
    const contract =
      a.party === 'supplier' ? resolveSupplierContract(supplier, a.contractId, supplier === cur?.supplier_id ? (cur?.contract_id ?? null) : null, s.id) : null;
    if (a.party === 'central' && !a.centralName)
      throw new HttpError(400, 'Name the central IT or group that does it', 'RESPONSIBILITY_CENTRAL_NAME', { area: a.area });
    if (a.party === 'shared' && !a.note) throw new HttpError(400, 'Say in the note who does what', 'RESPONSIBILITY_NOTE_REQUIRED', { area: a.area });
    let duty: string | null = null;
    if (a.dutyId && needsRecoveryTest(a.area, a.party)) {
      if (!db().get('SELECT 1 FROM service_duties WHERE id = ? AND service_id = ? AND archived = 0', a.dutyId, s.id))
        throw new HttpError(400, `Duty ${a.dutyId} is not a duty of this service`, 'RESPONSIBILITY_DUTY_UNKNOWN', { id: a.dutyId });
      duty = a.dutyId;
    }
    const row: ResponsibilityDbRow = {
      service_id: s.id,
      area: a.area,
      party: a.party,
      supplier_id: supplier,
      contract_id: contract,
      central_name: a.party === 'central' ? a.centralName : '',
      note: a.note,
      duty_id: duty,
      updated_at: now,
      updated_by: u.username,
    };
    if (cur && AUDITED.every((k) => (cur[k] ?? null) === (row[k] ?? null))) continue;
    next.push(row);
    changes.push({ area: a.area, before: cur ? pick(cur) : null, after: pick(row) });
  }
  if (!changes.length) return getResponsibilities(s.id, u);
  db().tx(() => {
    for (const r of next) {
      if ('remove' in r) {
        db().run('DELETE FROM service_responsibilities WHERE service_id = ? AND area = ?', s.id, r.area);
        continue;
      }
      db().run(
        `INSERT INTO service_responsibilities (service_id, area, party, supplier_id, contract_id, central_name, note, duty_id, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id, area) DO UPDATE SET party = excluded.party, supplier_id = excluded.supplier_id, contract_id = excluded.contract_id,
           central_name = excluded.central_name, note = excluded.note, duty_id = excluded.duty_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        r.service_id,
        r.area,
        r.party,
        r.supplier_id,
        r.contract_id,
        r.central_name,
        r.note,
        r.duty_id,
        r.updated_at,
        r.updated_by,
      );
      // a contract chosen for the area covers the service from now on (ADR 0031 part 4)
      const before = stored.get(r.area);
      coverChosenContract(r.contract_id, before && before.supplier_id === r.supplier_id ? before.contract_id : null, s.id, u.username);
    }
    audit({
      action: 'responsibility.changed',
      entityType: 'service',
      entityId: s.id,
      summary:
        `Responsibilities of service "${s.name}" changed: ${changes.map((c) => `${c.area} ${String(c.before?.party ?? 'undecided')} → ${String(c.after?.party ?? 'undecided')}`).join(', ')}`.slice(
          0,
          1000,
        ),
      details: { service: s.name, changes },
    });
  });
  return getResponsibilities(s.id, u);
}

const pick = (r: ResponsibilityDbRow) => ({
  party: r.party,
  supplierId: r.supplier_id,
  contractId: r.contract_id,
  centralName: r.central_name,
  note: r.note,
  dutyId: r.duty_id,
});

/** The matrix rows of these services (all areas), for the SoA's derived suggestion. */
export function matrixOf(serviceIds: readonly string[]): ResponsibilityDbRow[] {
  const out: ResponsibilityDbRow[] = [];
  for (let i = 0; i < serviceIds.length; i += 500) {
    const part = serviceIds.slice(i, i + 500);
    if (part.length)
      out.push(...db().all<ResponsibilityDbRow>(`SELECT * FROM service_responsibilities WHERE service_id IN (${part.map(() => '?').join(', ')})`, ...part));
  }
  return out;
}

/**
 * Services with gaps in their matrix, for summaries (the ISMS summary, ADR 0029 part 4): areas not decided, and backup
 * or recovery done by the team without an active recovery-test duty. `serviceIds` narrows it (default: every service
 * that is not archived); services without a gap are left out.
 */
export function matrixGaps(
  serviceIds?: readonly string[],
): { serviceId: string; serviceName: string; undecided: ResponsibilityArea[]; noRecoveryTest: ResponsibilityArea[] }[] {
  const services = db()
    .all<{ id: string; name: string }>('SELECT id, name FROM services WHERE archived = 0 ORDER BY name')
    .filter((s) => !serviceIds || serviceIds.includes(s.id));
  const rows = matrixOf(services.map((s) => s.id));
  const active = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM service_duties WHERE archived = 0')
      .map((d) => d.id),
  );
  const out: { serviceId: string; serviceName: string; undecided: ResponsibilityArea[]; noRecoveryTest: ResponsibilityArea[] }[] = [];
  for (const s of services) {
    const mine = new Map(rows.filter((r) => r.service_id === s.id).map((r) => [r.area, r]));
    const undecided = RESPONSIBILITY_AREAS.filter((a) => !mine.has(a));
    const noRecoveryTest = RESPONSIBILITY_AREAS.filter((a) => {
      const r = mine.get(a);
      return !!r && needsRecoveryTest(a, r.party) && !(r.duty_id && active.has(r.duty_id));
    });
    if (undecided.length || noRecoveryTest.length) out.push({ serviceId: s.id, serviceName: s.name, undecided, noRecoveryTest });
  }
  return out;
}
