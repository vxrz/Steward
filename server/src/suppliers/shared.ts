import {
  SUPPLIER_LIMITS,
  hasTeamOwner,
  type SupplierContactChoice,
  type SupplierContactScopeKind,
  type SupplierDetail,
  type SupplierMergePreview,
  type SupplierSharedMergeInput,
  type SupplierSharedSuggestion,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { catalogueAccess, forgetOwningTeams, owningTeams, setOwningTeams, type OwningTeam } from '../auth/policy.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { canViewCatalogue, forbid, me } from '../records/access.js';
import { normVendor } from '../plant/advisories/match.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { ScopeCtx, contractOwnersOf, scopeRowsOf } from './contract-scope.js';
import {
  LINKING_TABLES,
  aliasesOf,
  canManageSuppliers,
  contactViews,
  getSupplier,
  ownersOf,
  supplierRow,
  type CertificateRow,
  type ContactRow,
  type ContractRow,
  type SupplierRow,
} from './service.js';

/**
 * Shared suppliers (0.18.0, ADR 0031 part 8): one company is one record, seen by the whole instance unless an
 * administrator restricts it. Here: the suggestions "Same supplier in several teams" (what the 0.17 migration left),
 * the preview of a merge or an opening, the merge of up to ten suppliers and the opening of a team-scoped supplier.
 *
 * Nothing becomes visible silently. When the result is seen by people who did not see a source:
 *  - a contract without a team owner gets the source's owning teams as owners (so the same teams still see it);
 *  - a company-wide contact gets the source's contracts as its scope – without contracts the applications and systems
 *    that link the source – without those the administrator chooses: company-wide (a widening the preview names) or
 *    remove it;
 *  - the source's personal data and DPA are written onto its moved contracts where they differ from the target's.
 * Such a merge or opening is for administrators; a merge of suppliers with the same owning teams stays with designers.
 */

const teamSubject = (t: OwningTeam) => `team:${t.name.toLowerCase()}`;
const sameTeams = (a: OwningTeam[], b: OwningTeam[]) => a.length === b.length && a.every((t) => b.some((x) => x.id === t.id));

/** The result is seen by someone who did not see the source: the source is team-scoped and the target's teams differ. */
export function widens(source: OwningTeam[], target: OwningTeam[]): boolean {
  if (!source.length) return false;
  return !target.length || target.some((t) => !source.some((x) => x.id === t.id));
}

/**
 * Someone who saw the source does not see the result: the target is team-scoped and the source is instance-wide or
 * has a team the target has not (security review 0.18.0, M2) – their contracts on the source would go out of sight.
 */
export function narrows(source: OwningTeam[], target: OwningTeam[]): boolean {
  if (!target.length) return false;
  return !source.length || source.some((t) => !target.some((x) => x.id === t.id));
}

interface ScopeItem {
  kind: SupplierContactScopeKind;
  id: string;
  name: string;
}

/** The scope a company-wide contact of `src` gets: its contracts; without those, what links it; without that, none. */
function protectiveScope(src: SupplierRow): ScopeItem[] {
  const contracts = db()
    .all<{ id: string; title: string }>('SELECT id, title FROM supplier_contracts WHERE supplier_id = ? ORDER BY lower(title), id', src.id)
    .map((c) => ({ kind: 'contract' as const, id: c.id, name: c.title }));
  if (contracts.length) return contracts.slice(0, SUPPLIER_LIMITS.contactScope);
  const apps = db()
    .all<{ id: string; name: string }>('SELECT id, name FROM applications WHERE supplier_id = ? ORDER BY lower(name), id', src.id)
    .map((a) => ({ kind: 'application' as const, id: a.id, name: a.name }));
  const systems = db()
    .all<{ id: string; name: string }>('SELECT id, name FROM systems WHERE supplier_id = ? ORDER BY lower(name), id', src.id)
    .map((x) => ({ kind: 'system' as const, id: x.id, name: x.name }));
  return [...apps, ...systems].slice(0, SUPPLIER_LIMITS.contactScope);
}

const scopeRows = (contactId: string) =>
  db().all<{ kind: SupplierContactScopeKind; item_id: string }>('SELECT kind, item_id FROM supplier_contact_scopes WHERE contact_id = ?', contactId);

/** Who sees the supplier with these owning teams and owners (active users). */
function readersOf(s: SupplierRow, teams: OwningTeam[], owners: string[] = ownersOf(s)): Set<string> {
  const out = new Set<string>();
  for (const u of listUsers().filter((x) => x.active)) {
    const a = toAuthUser(u);
    // the owning teams as they would be: members of these teams, the named owners, administrators and auditors
    const mine = teams.length ? catalogueAccessWith(a, owners, teams) : catalogueAccess(a, { kind: 'supplier', id: '\u0000none', owners }).view;
    if (mine) out.add(u.username);
  }
  return out;
}

/** catalogueAccess for a supplier as if it had these owning teams and owners (a preview; nothing is stored). */
function catalogueAccessWith(u: AuthUser, owners: string[], teams: OwningTeam[]): boolean {
  if (isAdmin(u) || u.roles.includes('auditor')) return true;
  if (owners.some((o) => subjectMatches(u, o))) return true;
  const ids = new Set(teams.map((t) => t.id));
  return db()
    .all<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = ?', u.id)
    .some((m) => ids.has(m.team_id));
}

function subjectMatches(u: AuthUser, s: string): boolean {
  const x = s.toLowerCase();
  if (x === `user:${u.username.toLowerCase()}`) return true;
  if (!x.startsWith('team:')) return false;
  return !!db().get('SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND lower(t.name) = ?', u.id, x.slice(5));
}

// ---------- the preview ----------

interface Plan {
  preview: SupplierMergePreview;
  target: SupplierRow;
  sources: SupplierRow[];
  /** contract id → its owners after */
  owners: Map<string, string[]>;
  /** contact id → the action and the scope it gets */
  contacts: Map<string, { action: SupplierMergePreview['contacts'][number]['action']; scope: ScopeItem[]; into: string | null }>;
  /** certificate id → the certificate it is combined into */
  certificates: Map<string, string>;
  /** contract id → the columns written onto it (personal data, DPA) */
  dpa: Map<string, Record<string, unknown>>;
}

/**
 * The plan of a merge of `ids` into `intoId` (or of an opening: `ids` empty, `teamsAfter` the new owning teams). Read
 * only; the choices name what happens to company-wide contacts that cannot be scoped.
 */
function plan(target: SupplierRow, sources: SupplierRow[], choices: Record<string, SupplierContactChoice>, teamsAfter?: OwningTeam[]): Plan {
  const opening = teamsAfter !== undefined;
  const targetTeams = opening ? teamsAfter : owningTeams('supplier', target.id);
  const out: Plan = { preview: undefined as never, target, sources, owners: new Map(), contacts: new Map(), certificates: new Map(), dpa: new Map() };
  const preview: SupplierMergePreview = {
    intoId: target.id,
    ids: sources.map((x) => x.id),
    widens: false,
    gainers: [],
    narrows: false,
    losers: [],
    teams: targetTeams.map((t) => t.name),
    contracts: [],
    contacts: [],
    certificates: [],
    dpa: [],
    owners: [...new Set([...ownersOf(target), ...sources.flatMap(ownersOf)])],
    moves: { links: {}, spellings: [], schedules: 0 },
  };
  const targetReaders = readersOf(target, targetTeams);
  // who sees the result: its owners are those of all suppliers merged (the default of the preview)
  const resultReaders = opening ? targetReaders : readersOf(target, targetTeams, preview.owners);
  const all = opening ? [target] : sources;
  const refs = new Set(
    db()
      .all<{ reference: string }>("SELECT reference FROM supplier_contracts WHERE supplier_id = ? AND reference <> ''", target.id)
      .map((r) => r.reference.toLowerCase()),
  );
  // the target's company-wide contacts and certificates: what the sources' are combined into
  const targetContacts = db().all<ContactRow>('SELECT * FROM supplier_contacts WHERE supplier_id = ?', target.id);
  const targetCertificates = db().all<CertificateRow>('SELECT * FROM supplier_certificates WHERE supplier_id = ?', target.id);
  for (const src of all) {
    const srcTeams = owningTeams('supplier', src.id);
    const wide = widens(srcTeams, targetTeams);
    if (wide) {
      preview.widens = true;
      const before = readersOf(src, srcTeams);
      for (const n of targetReaders) if (!before.has(n) && !preview.gainers.includes(n)) preview.gainers.push(n);
    }
    if (narrows(srcTeams, targetTeams)) {
      // its readers who do not see the result lose it, and with it the contracts they saw through it
      preview.narrows = true;
      for (const n of readersOf(src, srcTeams)) if (!resultReaders.has(n) && !preview.losers.includes(n)) preview.losers.push(n);
    }
    // contracts: without a team owner they get the source's owning teams
    for (const c of db().all<ContractRow>('SELECT * FROM supplier_contracts WHERE supplier_id = ? ORDER BY lower(title), id', src.id)) {
      const owners = contractOwnersOf(c);
      const after = wide && !hasTeamOwner(owners) ? [...new Set([...owners, ...srcTeams.map(teamSubject)])] : owners;
      out.owners.set(c.id, after);
      preview.contracts.push({
        supplierId: src.id,
        id: c.id,
        title: c.title,
        reference: c.reference,
        owners,
        ownersAfter: after,
        sameReference: !opening && !!c.reference && refs.has(c.reference.toLowerCase()),
      });
      // personal data and the DPA of the source, where they differ from the target's defaults (merges only)
      if (!opening && !c.parent_id) {
        const set: Record<string, unknown> = {};
        if ((c.personal_data === null || c.personal_data === undefined) && Number(src.personal_data) !== Number(target.personal_data))
          set.personal_data = Number(src.personal_data);
        if (
          !c.dpa_status &&
          (src.dpa_status ?? null) !== (target.dpa_status ?? null) &&
          (src.dpa_status || Number(src.personal_data) !== Number(target.personal_data))
        )
          Object.assign(set, { dpa_status: src.dpa_status ?? 'missing', dpa_since: src.dpa_since, dpa_link: src.dpa_link });
        if (Object.keys(set).length) {
          out.dpa.set(c.id, set);
          preview.dpa.push({
            contractId: c.id,
            title: c.title,
            personalData: set.personal_data === undefined ? null : !!set.personal_data,
            dpaStatus: (set.dpa_status as never) ?? null,
          });
        }
      }
    }
    // contacts: the same person (name and e-mail, letter case aside) becomes one with the wider scope
    for (const k of db().all<ContactRow>('SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY lower(name), id', src.id)) {
      const scoped = scopeRows(k.id).length > 0;
      // a scoped contact of the target never becomes company-wide by a merge (security review 0.18.0, L1; ADR 0031
      // part 6): a company-wide source contact stays a contact of its own beside it
      const twin = opening
        ? undefined
        : targetContacts.find(
            (t) => t.name.toLowerCase() === k.name.toLowerCase() && t.email.toLowerCase() === k.email.toLowerCase() && (scoped || !scopeRows(t.id).length),
          );
      let action: SupplierMergePreview['contacts'][number]['action'] = 'keep';
      let scope: ScopeItem[] = [];
      if (twin) action = 'combined';
      else if (wide && !scoped) {
        scope = protectiveScope(src);
        const choice = choices[k.id];
        action = scope.length && choice !== 'companyWide' && choice !== 'remove' ? 'scope' : (choice ?? 'choose');
        if (action === 'scope' && choice === 'scope' && !scope.length) action = 'choose';
      }
      out.contacts.set(k.id, { action, scope, into: twin?.id ?? null });
      preview.contacts.push({ supplierId: src.id, id: k.id, name: k.name, action, scope, into: twin?.id ?? null });
    }
    // certificates: the same kind, scope and valid until become one
    if (!opening)
      for (const c of db().all<CertificateRow>('SELECT * FROM supplier_certificates WHERE supplier_id = ? ORDER BY id', src.id)) {
        const twin = targetCertificates.find((t) => t.kind === c.kind && t.scope === c.scope && (t.valid_until ?? null) === (c.valid_until ?? null));
        if (!twin) continue;
        out.certificates.set(c.id, twin.id);
        preview.certificates.push({ supplierId: src.id, id: c.id, kind: c.kind, name: c.name, validUntil: c.valid_until, into: twin.id });
      }
    if (!opening) {
      for (const t of LINKING_TABLES) {
        const n = Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE supplier_id = ?`, src.id)?.n ?? 0);
        if (n) preview.moves.links[t] = (preview.moves.links[t] ?? 0) + n;
      }
      preview.moves.spellings.push(src.name, ...aliasesOf(src));
      preview.moves.schedules += Number(
        db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_schedules x JOIN supplier_contracts c ON c.id = x.contract_id WHERE c.supplier_id = ?', src.id)
          ?.n ?? 0,
      );
    }
  }
  preview.gainers.sort();
  preview.losers.sort();
  out.preview = preview;
  return out;
}

function loadMerge(intoId: string, ids: string[]): { target: SupplierRow; sources: SupplierRow[] } {
  const want = [...new Set(ids)].filter((id) => id !== intoId);
  if (!want.length) throw new HttpError(400, 'A supplier cannot be merged into itself', 'SUPPLIER_MERGE_SELF');
  if (want.length > SUPPLIER_LIMITS.merge)
    throw new HttpError(400, `One merge combines at most ${SUPPLIER_LIMITS.merge} suppliers`, 'SUPPLIER_MERGE_LIMIT', { max: SUPPLIER_LIMITS.merge });
  const target = supplierRow(intoId);
  const sources = want.map((id) => supplierRow(id));
  for (const r of [target, ...sources])
    if (r.status === 'archived') throw new HttpError(409, `Supplier "${r.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: r.name });
  return { target, sources };
}

/** POST /api/suppliers/merge/preview: what a merge would change (designers and administrators). */
export function mergePreview(input: SupplierSharedMergeInput): SupplierMergePreview {
  const u = requireManager();
  const { target, sources } = loadMerge(input.intoId, input.ids);
  return forReader(plan(target, sources, (input.contacts ?? {}) as Record<string, SupplierContactChoice>).preview, u, target, sources);
}

/**
 * The preview as the reader may see it (security review 0.18.0, M1): only the contracts they may read (with their DPA
 * rows and the "same contract number" flag counted over the target's contracts they may read), the contacts they may
 * see, and of a contact's scope the items they may see – the others are neither named nor counted, as on the supplier
 * page (ADR 0031 part 2: others do not know a contract exists). The plan itself, and so the merge and its audit entry,
 * keep everything. Administrators read every contract and contact, so their preview is whole.
 */
function forReader(p: SupplierMergePreview, u: AuthUser, target: SupplierRow, sources: SupplierRow[]): SupplierMergePreview {
  const ctx = new ScopeCtx(u);
  const all = [target, ...sources];
  const rows = scopeRowsOf(
    db()
      .all<{ id: string }>(`SELECT id FROM supplier_contracts WHERE supplier_id IN (${all.map(() => '?').join(', ')})`, ...all.map((x) => x.id))
      .map((r) => r.id),
  );
  ctx.load([...rows.keys()]);
  const readable = new Set([...rows.values()].filter((r) => ctx.reads(r, { id: r.supplier_id, owners: r.s_owners, status: r.s_status })).map((r) => r.id));
  const refs = new Set(
    db()
      .all<{ id: string; reference: string }>("SELECT id, reference FROM supplier_contracts WHERE supplier_id = ? AND reference <> ''", target.id)
      .filter((r) => readable.has(r.id))
      .map((r) => r.reference.toLowerCase()),
  );
  const seenContacts = new Set(
    all.flatMap((x) => contactViews(x, db().all<ContactRow>('SELECT * FROM supplier_contacts WHERE supplier_id = ?', x.id), ctx).map((c) => c.id)),
  );
  const items = new Map<string, boolean>();
  const seesItem = (i: ScopeItem): boolean => {
    if (i.kind === 'contract') return readable.has(i.id);
    const k = `${i.kind}:${i.id}`;
    if (!items.has(k)) {
      const r = db().get<{ owners: string }>(`SELECT owners FROM ${i.kind === 'application' ? 'applications' : 'systems'} WHERE id = ?`, i.id);
      items.set(k, !!r && canViewCatalogue(u, { kind: i.kind, id: i.id, owners: parseJson<string[]>(r.owners, []) }));
    }
    return items.get(k)!;
  };
  return {
    ...p,
    contracts: p.contracts
      .filter((c) => readable.has(c.id))
      .map((c) => ({ ...c, sameReference: c.sameReference && !!c.reference && refs.has(c.reference.toLowerCase()) })),
    contacts: p.contacts
      .filter((c) => seenContacts.has(c.id))
      .map((c) => ({ ...c, scope: c.scope.filter(seesItem), into: c.into && seenContacts.has(c.into) ? c.into : null })),
    dpa: p.dpa.filter((x) => readable.has(x.contractId)),
  };
}

function requireManager(): AuthUser {
  const u = me();
  if (!canManageSuppliers(u)) forbid('merge suppliers', 'manageSuppliers');
  return u;
}

// ---------- the merge ----------

/** Applies the protections of a plan to the contracts and contacts of one supplier (merge or opening). */
function protect(p: Plan, supplierId: string): void {
  for (const c of db().all<{ id: string }>('SELECT id FROM supplier_contracts WHERE supplier_id = ?', supplierId)) {
    const after = p.owners.get(c.id);
    if (after) db().run('UPDATE supplier_contracts SET owners = ? WHERE id = ?', JSON.stringify(after), c.id);
    const dpa = p.dpa.get(c.id);
    if (dpa) {
      const cols = Object.keys(dpa);
      db().run(`UPDATE supplier_contracts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => dpa[k]), c.id);
    }
  }
  for (const k of db().all<{ id: string }>('SELECT id FROM supplier_contacts WHERE supplier_id = ?', supplierId)) {
    const x = p.contacts.get(k.id);
    if (!x) continue;
    if (x.action === 'scope')
      for (const i of x.scope) db().run('INSERT INTO supplier_contact_scopes (contact_id, kind, item_id) VALUES (?, ?, ?)', k.id, i.kind, i.id);
    else if (x.action === 'remove') {
      db().run('DELETE FROM supplier_contact_scopes WHERE contact_id = ?', k.id);
      db().run('DELETE FROM supplier_contacts WHERE id = ?', k.id);
    } else if (x.action === 'combined' && x.into) {
      // a company-wide target stays company-wide; two scoped contacts get both scopes together. A company-wide source
      // is never combined into a scoped target (plan): that would show the target's e-mail and phone to everyone
      const mine = scopeRows(k.id);
      const theirs = scopeRows(x.into);
      if (mine.length && theirs.length)
        for (const i of mine)
          db().run('INSERT INTO supplier_contact_scopes (contact_id, kind, item_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', x.into, i.kind, i.item_id);
      db().run('DELETE FROM supplier_contact_scopes WHERE contact_id = ?', k.id);
      db().run('DELETE FROM supplier_contacts WHERE id = ?', k.id);
    }
  }
}

/**
 * POST /api/suppliers/merge: up to ten suppliers into one, in one transaction. Their links (every linking table),
 * spellings, contracts with their schedules, certificates and contacts move; the protections of the plan apply; the
 * owners of the result are `owners` (default: all owners). A merge that changes who sees anything – widening or
 * narrowing – is for administrators; one of suppliers with the same owning teams also for designers.
 */
export function mergeSuppliers(input: SupplierSharedMergeInput): SupplierDetail {
  const u = requireManager();
  const { target, sources } = loadMerge(input.intoId, input.ids);
  const p = plan(target, sources, (input.contacts ?? {}) as Record<string, SupplierContactChoice>);
  // a merge that changes who sees anything – widening or narrowing – changes a team scope: administrators (ADR 0031
  // part 8). Designers merge suppliers with the same owning teams.
  const targetTeams = owningTeams('supplier', target.id);
  if (!isAdmin(u) && sources.some((x) => !sameTeams(owningTeams('supplier', x.id), targetTeams)))
    forbid('merge suppliers with other owning teams into this one (administrators)', 'mergeWidening');
  const choose = p.preview.contacts.find((c) => c.action === 'choose');
  if (choose)
    throw new HttpError(409, `Choose what happens to the contact "${choose.name}": company-wide or removed`, 'SUPPLIER_MERGE_CONTACT_CHOICE', {
      name: choose.name,
    });
  const owners = [...new Set(input.owners ?? p.preview.owners)];
  assertKnownSubjects(owners, [...ownersOf(target), ...sources.flatMap(ownersOf)]);
  const count = (table: string, ids: string[]) =>
    Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE supplier_id IN (${ids.map(() => '?').join(', ')})`, ...ids)?.n ?? 0);
  const ids = [target.id, ...sources.map((x) => x.id)];
  const removedContacts = p.preview.contacts.filter((c) => c.action === 'remove' || c.action === 'combined').length;
  if (count('supplier_contacts', ids) - removedContacts > SUPPLIER_LIMITS.contacts)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contacts} contacts`, 'SUPPLIER_CONTACT_LIMIT', { max: SUPPLIER_LIMITS.contacts });
  if (count('supplier_contracts', ids) > SUPPLIER_LIMITS.contracts)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.contracts} contracts`, 'SUPPLIER_CONTRACT_LIMIT', { max: SUPPLIER_LIMITS.contracts });
  if (count('supplier_certificates', ids) - p.certificates.size > SUPPLIER_LIMITS.certificates)
    throw new HttpError(409, `A supplier has at most ${SUPPLIER_LIMITS.certificates} certificates`, 'SUPPLIER_CERTIFICATE_LIMIT', {
      max: SUPPLIER_LIMITS.certificates,
    });
  const sourceTeams = Object.fromEntries(sources.map((x) => [x.id, owningTeams('supplier', x.id).map((t) => t.name)]));
  const aliases = [...new Set([...aliasesOf(target), ...sources.flatMap((x) => [x.name, ...aliasesOf(x)])])]
    .filter((a) => a !== target.name)
    .slice(0, SUPPLIER_LIMITS.aliases);
  db().tx(() => {
    for (const src of sources) {
      protect(p, src.id);
      for (const t of LINKING_TABLES) db().run(`UPDATE ${t} SET supplier_id = ? WHERE supplier_id = ?`, target.id, src.id);
      // certificates that are the same become one, keeping the latest "looked at"
      for (const [from, into] of p.certificates) {
        const a = db().get<CertificateRow>('SELECT * FROM supplier_certificates WHERE id = ?', from);
        const b = db().get<CertificateRow>('SELECT * FROM supplier_certificates WHERE id = ?', into);
        if (!a || !b || a.supplier_id !== src.id) continue;
        if ((a.checked_at ?? '') > (b.checked_at ?? ''))
          db().run('UPDATE supplier_certificates SET checked_by = ?, checked_at = ? WHERE id = ?', a.checked_by, a.checked_at, into);
        db().run('DELETE FROM supplier_certificates WHERE id = ?', from);
        db().run('DELETE FROM supplier_reminders WHERE item_id = ?', from);
      }
      for (const t of ['supplier_contacts', 'supplier_contracts', 'supplier_certificates'])
        db().run(`UPDATE ${t} SET supplier_id = ? WHERE supplier_id = ?`, target.id, src.id);
      db().run('UPDATE supplier_text_migrations SET supplier_id = ? WHERE supplier_id = ?', target.id, src.id);
      db().run('DELETE FROM suppliers WHERE id = ?', src.id);
      forgetOwningTeams('supplier', src.id);
    }
    db().run(
      'UPDATE suppliers SET aliases = ?, owners = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      JSON.stringify(aliases),
      JSON.stringify(owners),
      nowIso(),
      u.username,
      target.id,
    );
    audit({
      action: 'supplier.merged',
      entityType: 'supplier',
      entityId: target.id,
      summary: `${sources.map((x) => `"${x.name}"`).join(', ')} merged into "${target.name}"${p.preview.widens ? ' (shared: protected)' : ''}`,
      details: {
        // one source keeps the 0.17 shape of the details
        from:
          sources.length === 1
            ? { id: sources[0]!.id, name: sources[0]!.name, status: sources[0]!.status, aliases: aliasesOf(sources[0]!) }
            : sources.map((x) => ({ id: x.id, name: x.name, status: x.status, aliases: aliasesOf(x) })),
        into: { id: target.id, name: target.name },
        sourceTeams,
        links: p.preview.moves.links,
        widens: p.preview.widens,
        ...(p.preview.narrows ? { narrows: true, losers: p.preview.losers } : {}),
        contracts: p.preview.contracts
          .filter((c) => JSON.stringify(c.owners) !== JSON.stringify(c.ownersAfter))
          .map((c) => ({ id: c.id, owners: c.ownersAfter })),
        contacts: p.preview.contacts
          .filter((c) => c.action !== 'keep')
          .map((c) => ({ id: c.id, name: c.name, action: c.action, scope: c.scope.map((i) => ({ kind: i.kind, id: i.id })), into: c.into })),
        certificatesCombined: p.preview.certificates.map((c) => ({ id: c.id, into: c.into })),
        dpa: p.preview.dpa,
        owners,
        teams: p.preview.teams,
      },
    });
  });
  return getSupplier(target.id);
}

/** POST /api/suppliers/:id/merge ("To confirm" → Merge into …): one supplier into another, by the same rules. */
export function mergeOne(id: string, intoId: string): SupplierDetail {
  return mergeSuppliers({ intoId, ids: [id] });
}

// ---------- opening a team-scoped supplier ----------

/** The plan of new owning teams for a supplier (a preview of an opening; administrators). */
function openingPlan(id: string, teamIds: string[], choices: Record<string, SupplierContactChoice>): Plan {
  const s = supplierRow(id);
  const known = new Map(
    db()
      .all<OwningTeam>('SELECT id, name FROM teams')
      .map((t) => [t.id, t]),
  );
  const unknown = teamIds.find((t) => !known.has(t));
  if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { id: unknown });
  return plan(
    s,
    [],
    choices,
    [...new Set(teamIds)].map((t) => known.get(t)!),
  );
}

/** POST /api/suppliers/:id/open/preview */
export function openPreview(id: string, teamIds: string[], choices: Record<string, SupplierContactChoice> = {}): SupplierMergePreview {
  const u = me();
  if (!isAdmin(u)) forbid('change the owning teams of a supplier (administrators)', 'mergeWidening');
  return openingPlan(id, teamIds, choices).preview;
}

/**
 * Applies the protections of an opening inside the caller's transaction (the owning-teams route for suppliers): returns
 * what was protected, for the audit entry `access.owning_teams_changed`. Nothing for a change that widens nothing.
 */
export function protectOpening(id: string, teamIds: string[], choices: Record<string, SupplierContactChoice> = {}): Record<string, unknown> | null {
  const p = openingPlan(id, teamIds, choices);
  if (!p.preview.widens) return null;
  const choose = p.preview.contacts.find((c) => c.action === 'choose');
  if (choose)
    throw new HttpError(409, `Choose what happens to the contact "${choose.name}": company-wide or removed`, 'SUPPLIER_MERGE_CONTACT_CHOICE', {
      name: choose.name,
    });
  protect(p, id);
  return {
    gainers: p.preview.gainers,
    contracts: p.preview.contracts.filter((c) => JSON.stringify(c.owners) !== JSON.stringify(c.ownersAfter)).map((c) => ({ id: c.id, owners: c.ownersAfter })),
    contacts: p.preview.contacts
      .filter((c) => c.action !== 'keep')
      .map((c) => ({ id: c.id, name: c.name, action: c.action, scope: c.scope.map((i) => ({ kind: i.kind, id: i.id })) })),
  };
}

/** POST /api/suppliers/:id/open: new owning teams with the protections (administrators; audited as the owning-teams change). */
export function openSupplier(id: string, teamIds: string[], choices: Record<string, SupplierContactChoice> = {}): SupplierDetail {
  const u = me();
  if (!isAdmin(u)) forbid('change the owning teams of a supplier (administrators)', 'mergeWidening');
  const s = supplierRow(id);
  const before = owningTeams('supplier', s.id);
  const ids = [...new Set(teamIds)];
  db().tx(() => {
    const protectedWhat = protectOpening(s.id, ids, choices);
    setOwningTeams('supplier', s.id, ids);
    const after = owningTeams('supplier', s.id).map((t) => t.name);
    audit({
      action: 'access.owning_teams_changed',
      entityType: 'supplier',
      entityId: s.id,
      summary: `Owning teams of supplier "${s.name}": ${after.length ? after.join(', ') : 'none (the whole instance)'}${before.length ? ` (were: ${before.map((t) => t.name).join(', ')})` : ''}`,
      details: { before: before.map((t) => t.name), after, ...(protectedWhat ? { protected: protectedWhat } : {}) },
    });
  });
  return getSupplier(s.id);
}

// ---------- "Same supplier in several teams" ----------

/** Groups of active or unconfirmed suppliers that look like one company and have different owning teams. */
export function sharedSuggestions(): SupplierSharedSuggestion[] {
  const u = me();
  if (!isAdmin(u)) forbid('see the suppliers of every team (administrators)', 'mergeWidening');
  const rows = db().all<SupplierRow>("SELECT * FROM suppliers WHERE status IN ('active', 'unconfirmed') ORDER BY created_at, id");
  // union-find over "the same normalised name, or a spelling of one matching the other's name"
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const byNorm = new Map<string, string[]>();
  for (const r of rows) byNorm.set(r.norm_name, [...(byNorm.get(r.norm_name) ?? []), r.id]);
  for (const ids of byNorm.values()) for (const id of ids.slice(1)) join(ids[0]!, id);
  for (const r of rows)
    for (const a of aliasesOf(r)) {
      const other = byNorm.get(normVendor(a));
      if (other) for (const id of other) join(r.id, id);
    }
  const groups = new Map<string, SupplierRow[]>();
  for (const r of rows) groups.set(find(r.id), [...(groups.get(find(r.id)) ?? []), r]);
  const dismissed = new Set(
    db()
      .all<{ group_key: string }>('SELECT group_key FROM supplier_merge_dismissals')
      .map((r) => r.group_key),
  );
  const n = (table: string, id: string) => Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE supplier_id = ?`, id)?.n ?? 0);
  const out: SupplierSharedSuggestion[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const teams = new Map(list.map((r) => [r.id, owningTeams('supplier', r.id)]));
    if (list.every((r) => sameTeams(teams.get(r.id)!, teams.get(list[0]!.id)!))) continue;
    const into = list.find((r) => !teams.get(r.id)!.length) ?? list.find((r) => r.status === 'active') ?? list[0]!;
    const key = groupKey(list);
    if (dismissed.has(key)) continue;
    out.push({
      key,
      name: into.name,
      intoId: into.id,
      suppliers: list.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        teams: teams.get(r.id)!.map((t) => t.name),
        contracts: n('supplier_contracts', r.id),
        contacts: n('supplier_contacts', r.id),
        certificates: n('supplier_certificates', r.id),
      })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The key of a group: the normalised name and the suppliers' ids (a new member makes a new group). */
const groupKey = (list: SupplierRow[]) =>
  `${list[0]!.norm_name}:${list
    .map((r) => r.id)
    .sort()
    .join('.')}`;

/** "Keep separate": the group is not suggested again until another supplier joins it. */
export function keepSeparate(key: string): { ok: true } {
  const u = me();
  const group = sharedSuggestions().find((g) => g.key === key);
  if (!group) throw new HttpError(404, 'This group of suppliers is not suggested (any more)', 'SUPPLIER_GROUP_NOT_FOUND');
  db().tx(() => {
    db().run(
      'INSERT INTO supplier_merge_dismissals (group_key, dismissed_by, dismissed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      key,
      u.username,
      nowIso(),
    );
    audit({
      action: 'supplier.merge_kept_separate',
      entityType: 'supplier',
      entityId: group.intoId,
      summary: `Suppliers kept separate: ${group.suppliers.map((x) => `"${x.name}"`).join(', ')}`,
      details: { key, suppliers: group.suppliers.map((x) => ({ id: x.id, name: x.name, teams: x.teams })) },
    });
  });
  return { ok: true };
}

/** The reader may see suppliers of every team: the section is for administrators. */
export const seesSharedSuggestions = (u: AuthUser | null = currentUser()): boolean => isAdmin(u);
