import {
  contractReaders,
  hasTeamOwner,
  type AclEntry,
  type PlatformPermission,
  type SupplierContractItemKind,
  type SupplierContractPlatform,
  type SupplierContractProposalSource,
  type SupplierContractReadReason,
  type SupplierContractService,
  type SupplierContractServiceStatus,
  type SupplierStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin, matches, platformPermissions } from '../auth/permissions.js';
import { catalogueAccess, memberships, owningTeams } from '../auth/policy.js';
import { parseJson } from '../util.js';
import { audit } from '../audit.js';
import { readSetting, writeSetting } from '../settings.js';

/**
 * The scope of a supplier contract (0.18.0, ADR 0031 part 2): its owners (users and teams), the services it covers
 * (each with a purpose; confirmed or proposed by the upgrade) and the rules that follow – who reads it and who may
 * change it. Read in bulk: one query per table for a page of contracts (`ScopeCtx.load`), never one per contract.
 * Kept free of the supplier service (links.ts and the Costs module import it without a cycle).
 */

export interface CoverRow {
  contract_id: string;
  service_id: string;
  purpose: string;
  status: SupplierContractServiceStatus;
  proposed_from: string;
  added_by: string;
  added_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

/** A platform a contract covers (0.19.0, ADR 0032). */
export interface PlatformCoverRow {
  contract_id: string;
  platform_id: string;
  purpose: string;
  added_by: string;
  added_at: string;
}

/** An application or system of a covered service the contract is for (0.19.0, ADR 0032), with its name and owners. */
export interface ItemRow {
  contract_id: string;
  service_id: string;
  kind: SupplierContractItemKind;
  item_id: string;
  name: string | null;
  owners: string | null;
}

interface PlatformRow {
  id: string;
  name: string;
  acl: string;
}

/** What the rules need of a contract (a row of supplier_contracts). */
export interface ScopeContract {
  id: string;
  supplier_id: string;
  owners: string;
}

/** What the rules need of its supplier. */
export interface ScopeSupplier {
  id: string;
  owners: string | string[];
  status?: SupplierStatus;
}

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

const listOf = (v: string | string[]): string[] => (Array.isArray(v) ? v : parseJson<string[]>(v, []));
export const contractOwnersOf = (c: Pick<ScopeContract, 'owners'>): string[] => parseJson<string[]>(c.owners ?? '[]', []);

/**
 * One reader's view of contract scopes, with what it read memoised: the services (all, once), the covered services of
 * the contracts loaded and the decisions per supplier. A job passes no reader and sees and may change everything.
 */
export class ScopeCtx {
  private services: Map<string, ServiceRow> | null = null;
  private platforms: Map<string, PlatformRow> | null = null;
  private readonly cover = new Map<string, CoverRow[]>();
  private readonly platformCover = new Map<string, PlatformCoverRow[]>();
  private readonly itemRows = new Map<string, ItemRow[]>();
  private readonly platformView = new Map<string, boolean>();
  private readonly platformManage = new Map<string, boolean>();
  private readonly itemView = new Map<string, boolean>();
  private readonly supplierSeen = new Map<string, boolean>();
  private readonly supplierEdit = new Map<string, boolean>();
  private readonly serviceView = new Map<string, boolean>();
  private readonly serviceEdit = new Map<string, boolean>();

  constructor(readonly u: AuthUser | null = currentUser()) {}

  /** The covered services and platforms (0.19.0) of these contracts, read in one statement per table and 500 ids. */
  load(contractIds: readonly string[]): this {
    const want = [...new Set(contractIds)].filter((id) => !this.cover.has(id));
    for (const id of want) {
      this.cover.set(id, []);
      this.platformCover.set(id, []);
      this.itemRows.set(id, []);
    }
    for (let i = 0; i < want.length; i += 500) {
      const part = want.slice(i, i + 500);
      const marks = part.map(() => '?').join(', ');
      for (const r of db().all<CoverRow>(`SELECT * FROM supplier_contract_services WHERE contract_id IN (${marks}) ORDER BY added_at, service_id`, ...part))
        this.cover.get(r.contract_id)!.push(r);
      for (const r of db().all<PlatformCoverRow>(
        `SELECT * FROM supplier_contract_platforms WHERE contract_id IN (${marks}) ORDER BY added_at, platform_id`,
        ...part,
      ))
        this.platformCover.get(r.contract_id)!.push(r);
      for (const r of db().all<ItemRow>(
        `SELECT i.contract_id, i.service_id, i.kind, i.item_id, COALESCE(a.name, y.name) AS name, COALESCE(a.owners, y.owners) AS owners
           FROM supplier_contract_items i
           LEFT JOIN applications a ON i.kind = 'application' AND a.id = i.item_id
           LEFT JOIN systems y ON i.kind = 'system' AND y.id = i.item_id
          WHERE i.contract_id IN (${marks}) ORDER BY i.added_at, i.item_id`,
        ...part,
      ))
        this.itemRows.get(r.contract_id)!.push(r);
    }
    return this;
  }

  /** The platforms a contract covers (0.19.0). */
  platformCoverOf(contractId: string): PlatformCoverRow[] {
    if (!this.platformCover.has(contractId)) this.load([contractId]);
    return this.platformCover.get(contractId) ?? [];
  }

  /** The applications and systems of a covered service the contract is for (0.19.0). */
  itemsOf(contractId: string, serviceId: string): ItemRow[] {
    if (!this.itemRows.has(contractId)) this.load([contractId]);
    return (this.itemRows.get(contractId) ?? []).filter((r) => r.service_id === serviceId);
  }

  platform(id: string): PlatformRow | undefined {
    if (!this.platforms)
      this.platforms = new Map(
        db()
          .all<PlatformRow>('SELECT id, name, acl FROM platforms')
          .map((p) => [p.id, p]),
      );
    return this.platforms.get(id);
  }

  /** The reader may see the platform (viewers see none; auditors see every one). */
  seesPlatform(id: string): boolean {
    const p = this.platform(id);
    if (!p) return false;
    if (!this.u) return true;
    if (!this.platformView.has(id))
      this.platformView.set(
        id,
        isAdmin(this.u) ||
          this.u.roles.includes('auditor') ||
          platformPermissions(this.u, { id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).length > 0,
      );
    return this.platformView.get(id)!;
  }

  /**
   * The reader manages the platform or is a member of its owning teams (0.19.0, ADR 0032) – who changes its cost plan
   * and sees a team-owned contract covering it; not every reader of the platform.
   */
  managesPlatform(id: string): boolean {
    const p = this.platform(id);
    if (!p) return false;
    if (!this.u) return true;
    if (!this.platformManage.has(id)) {
      const perms = platformPermissions(this.u, { id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) });
      const mine = memberships(this.u);
      this.platformManage.set(id, perms.includes('manage') || owningTeams('platform', id).some((t) => mine.has(t.id)));
    }
    return this.platformManage.get(id)!;
  }

  /** The reader may see an application or system named on a contract. */
  seesItem(r: Pick<ItemRow, 'kind' | 'item_id' | 'owners' | 'name'>): boolean {
    if (r.name === null) return false;
    if (!this.u) return true;
    const k = `${r.kind}|${r.item_id}`;
    if (!this.itemView.has(k)) this.itemView.set(k, catalogueAccess(this.u, { kind: r.kind, id: r.item_id, owners: listOf(r.owners ?? '[]') }).view);
    return this.itemView.get(k)!;
  }

  coverOf(contractId: string): CoverRow[] {
    if (!this.cover.has(contractId)) this.load([contractId]);
    return this.cover.get(contractId)!;
  }

  service(id: string): ServiceRow | undefined {
    if (!this.services)
      this.services = new Map(
        db()
          .all<ServiceRow>('SELECT id, name, owners, archived FROM services')
          .map((s) => [s.id, s]),
      );
    return this.services.get(id);
  }

  /** The reader sees the service (an archived service gives no rights, ADR 0031 part 2). */
  seesService(id: string, archivedToo = false): boolean {
    const s = this.service(id);
    if (!s || (!archivedToo && Number(s.archived))) return false;
    if (!this.u) return true;
    if (!this.serviceView.has(id)) this.serviceView.set(id, catalogueAccess(this.u, { kind: 'service', id, owners: listOf(s.owners) }).view);
    return this.serviceView.get(id)!;
  }

  /** The reader may edit the service (and it is not archived). */
  editsService(id: string): boolean {
    const s = this.service(id);
    if (!s || Number(s.archived)) return false;
    if (!this.u) return true;
    if (!this.serviceEdit.has(id)) this.serviceEdit.set(id, catalogueAccess(this.u, { kind: 'service', id, owners: listOf(s.owners) }).edit);
    return this.serviceEdit.get(id)!;
  }

  seesSupplier(s: ScopeSupplier): boolean {
    if (!this.u) return true;
    if (!this.supplierSeen.has(s.id)) this.supplierSeen.set(s.id, catalogueAccess(this.u, { kind: 'supplier', id: s.id, owners: listOf(s.owners) }).view);
    return this.supplierSeen.get(s.id)!;
  }

  /** May change the supplier (designers, administrators, its owners – team scope); not archived. */
  editsSupplier(s: ScopeSupplier): boolean {
    if (s.status === 'archived') return false;
    if (!this.u) return true;
    if (!this.supplierEdit.has(s.id)) this.supplierEdit.set(s.id, catalogueAccess(this.u, { kind: 'supplier', id: s.id, owners: listOf(s.owners) }).edit);
    return this.supplierEdit.get(s.id)!;
  }

  ownsContract(c: Pick<ScopeContract, 'owners'>): boolean {
    return !!this.u && contractOwnersOf(c).some((o) => matches(this.u!, o));
  }

  /** Why the reader sees the contract, or null (contractReaders). Jobs see every contract. */
  readReason(c: ScopeContract, s: ScopeSupplier): SupplierContractReadReason | null {
    if (!this.u) return 'admin';
    const owners = contractOwnersOf(c);
    const seesSupplier = this.seesSupplier(s);
    if (!seesSupplier) return null;
    if (!hasTeamOwner(owners)) return 'supplierReaders';
    return contractReaders(
      { owners },
      {
        seesSupplier,
        admin: isAdmin(this.u),
        auditor: this.u.roles.includes('auditor'),
        owner: this.ownsContract(c),
        // proposed covered services count for reading (the upgrade), archived ones give no rights
        seesCoveredService: this.coverOf(c.id).some((x) => this.seesService(x.service_id)),
        // a covered platform (ADR 0032): its managers and the members of its owning teams – not every reader of it
        managesCoveredPlatform: this.platformCoverOf(c.id).some((x) => this.managesPlatform(x.platform_id)),
      },
    );
  }

  reads(c: ScopeContract, s: ScopeSupplier): boolean {
    return this.readReason(c, s) !== null;
  }

  /**
   * Whether the reader may change the contract (ADR 0031 part 2): administrators, its owners, designers and the
   * supplier's owners who may see it, and editors of a confirmed covered service – or (0.19.0, ADR 0032) who manage a
   * covered platform – who see every service and every platform it covers. Not while the supplier is archived.
   */
  edits(c: ScopeContract, s: ScopeSupplier): boolean {
    if (s.status === 'archived') return false;
    if (!this.u) return true;
    if (!this.reads(c, s)) return false;
    if (isAdmin(this.u) || this.ownsContract(c) || this.editsSupplier(s)) return true;
    const cover = this.coverOf(c.id).filter((x) => !Number(this.service(x.service_id)?.archived ?? 1));
    const platforms = this.platformCoverOf(c.id).filter((x) => !!this.platform(x.platform_id));
    const holds = cover.some((x) => x.status === 'confirmed' && this.editsService(x.service_id)) || platforms.some((x) => this.managesPlatform(x.platform_id));
    return holds && cover.every((x) => this.seesService(x.service_id)) && platforms.every((x) => this.seesPlatform(x.platform_id));
  }

  /** May change one covered platform of the contract (purpose, take it off): who changes the contract, or manages that platform (0.19.0). */
  editsPlatformCover(c: ScopeContract, s: ScopeSupplier, platformId: string): boolean {
    if (s.status === 'archived') return false;
    return this.edits(c, s) || (this.reads(c, s) && this.managesPlatform(platformId));
  }

  /** The covered platforms as the reader sees them, and how many they may not see (0.19.0). */
  platformsOf(c: ScopeContract, s: ScopeSupplier): { platforms: SupplierContractPlatform[]; hidden: number } {
    const platforms: SupplierContractPlatform[] = [];
    let hidden = 0;
    for (const x of this.platformCoverOf(c.id)) {
      const p = this.platform(x.platform_id);
      if (!p) continue;
      if (!this.seesPlatform(p.id)) {
        hidden++;
        continue;
      }
      platforms.push({
        id: p.id,
        name: p.name,
        purpose: x.purpose,
        canChange: this.editsPlatformCover(c, s, p.id),
        managesPlatform: !!this.u && this.managesPlatform(p.id),
      });
    }
    return { platforms: platforms.sort((a, b) => a.name.localeCompare(b.name)), hidden };
  }

  /** May change one covered service of the contract (purpose, leave, confirm, dismiss): who changes the contract, or edits that service. */
  editsCover(c: ScopeContract, s: ScopeSupplier, serviceId: string): boolean {
    if (s.status === 'archived') return false;
    return this.edits(c, s) || (this.reads(c, s) && this.editsService(serviceId));
  }

  /** The covered services as the reader sees them, and how many they may not see. */
  servicesOf(c: ScopeContract, s: ScopeSupplier): { services: SupplierContractService[]; hidden: number } {
    const services: SupplierContractService[] = [];
    let hidden = 0;
    for (const x of this.coverOf(c.id)) {
      const svc = this.service(x.service_id);
      if (!svc) continue;
      if (!this.seesService(x.service_id, true)) {
        hidden++;
        continue;
      }
      services.push({
        id: svc.id,
        name: svc.name,
        archived: !!Number(svc.archived),
        purpose: x.purpose,
        status: x.status,
        proposedFrom: parseJson<SupplierContractProposalSource[]>(x.proposed_from, []),
        canChange: this.editsCover(c, s, svc.id),
        editsService: !!this.u && this.editsService(svc.id),
        items: this.itemsOf(c.id, svc.id)
          .filter((r) => this.seesItem(r))
          .map((r) => ({ kind: r.kind, id: r.item_id, name: r.name! })),
      });
    }
    return { services: services.sort((a, b) => a.name.localeCompare(b.name)), hidden };
  }
}

/** The contract rows (owners) and their suppliers for these ids, in bulk. */
export function scopeRowsOf(
  ids: readonly (string | null | undefined)[],
): Map<string, ScopeContract & { s_owners: string; s_status: SupplierStatus; parent_id: string | null }> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, ScopeContract & { s_owners: string; s_status: SupplierStatus; parent_id: string | null }>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<ScopeContract & { s_owners: string; s_status: SupplierStatus; parent_id: string | null }>(
      `SELECT c.id, c.supplier_id, c.owners, c.parent_id, s.owners AS s_owners, s.status AS s_status
         FROM supplier_contracts c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    ))
      out.set(r.id, r);
  }
  return out;
}

/**
 * Whether the contract covers the service (confirmed or proposed) – or, since 0.19.0, the platform (`serviceId` may
 * name either: their ids never collide): the hint "This contract no longer covers the service".
 */
export function coveredPairs(pairs: readonly { contractId: string; serviceId: string }[]): Set<string> {
  const ids = [...new Set(pairs.map((p) => p.contractId))];
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db().all<{ contract_id: string; service_id: string }>(
      `SELECT contract_id, service_id FROM supplier_contract_services WHERE contract_id IN (${part.map(() => '?').join(', ')})
       UNION SELECT contract_id, platform_id AS service_id FROM supplier_contract_platforms WHERE contract_id IN (${part.map(() => '?').join(', ')})`,
      ...part,
      ...part,
    ))
      out.add(`${r.contract_id}|${r.service_id}`);
  }
  return out;
}

// ---------- the upgrade to 0.18 (ADR 0031 part 9) ----------

const UPGRADE_KEY = 'catalogue.supplierContractScope';
interface UpgradeState {
  pending?: boolean;
  /** Contracts that became team-owned: may now be seen by fewer people */
  narrowed?: number;
  /** The administrators' notice on the supplier list is open */
  notice?: boolean;
}

/**
 * Finishes the upgrade the migration suppliers-003 made (owners copied, covered services proposed): audits it once
 * (`supplier.contracts_scoped`, system) and opens the administrators' notice when contracts became team-owned. Called
 * by the supplier job and the supplier list; does nothing once done.
 */
export function finishContractScopeUpgrade(): void {
  const st = readSetting<UpgradeState>(UPGRADE_KEY, {});
  if (!st.pending) return;
  const n = (sql: string) => Number(db().get<{ n: number }>(sql)?.n ?? 0);
  const owned = n("SELECT COUNT(*) AS n FROM supplier_contracts WHERE owners <> '[]'");
  const narrowed = n("SELECT COUNT(*) AS n FROM supplier_contracts WHERE lower(owners) LIKE '%\"team:%'");
  const proposed = n("SELECT COUNT(*) AS n FROM supplier_contract_services WHERE status = 'proposed'");
  const confirmed = n("SELECT COUNT(*) AS n FROM supplier_contract_services WHERE status = 'confirmed' AND added_by = 'system'");
  db().tx(() => {
    audit({
      actor: 'system',
      action: 'supplier.contracts_scoped',
      entityType: 'supplier',
      entityId: null,
      summary: `Supplier contracts got the owners of their supplier (${owned}); ${proposed} covered service(s) proposed, ${confirmed} confirmed from payment schedules`,
      details: { contractsWithOwners: owned, teamOwned: narrowed, servicesProposed: proposed, servicesConfirmed: confirmed },
    });
    writeSetting(UPGRADE_KEY, { pending: false, narrowed, notice: narrowed > 0 } satisfies UpgradeState);
  });
}

/** The administrators' one-time notice "Contracts now seen only by their owners and services" (null: none, or not an administrator). */
export function contractScopeNotice(u: AuthUser | null = currentUser()): { narrowed: number } | null {
  if (!isAdmin(u)) return null;
  const st = readSetting<UpgradeState>(UPGRADE_KEY, {});
  return st.notice ? { narrowed: st.narrowed ?? 0 } : null;
}

/** An administrator closes the notice (for every administrator). */
export function dismissContractScopeNotice(): { ok: true } {
  const st = readSetting<UpgradeState>(UPGRADE_KEY, {});
  if (st.notice) writeSetting(UPGRADE_KEY, { ...st, notice: false });
  return { ok: true };
}
