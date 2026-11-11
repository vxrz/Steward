import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRAND,
  EVIDENCE_PACK_FORMAT,
  RESPONSIBILITY_AREAS,
  RESPONSIBILITY_PARTIES,
  SOA_DATASET,
  SOA_LIMITS,
  SOA_MANIFEST_KIND,
  SOA_OWNER_FIELDS,
  SOA_PARTIES,
  soaCreateInput,
  soaDecisionInput,
  soaEntryInput,
  soaSettingsInput,
  type ControlCoverage,
  type DatasetRow,
  type ReportLang,
  type ResponsibilityArea,
  type ResponsibilityParty,
  type Soa,
  type SoaAreaControls,
  type SoaCounts,
  type SoaEntry,
  type SoaExportFormat,
  type SoaList,
  type SoaParty,
  type SoaStatus,
  type SoaSuggestion,
  type SoaSummary,
  type SoaVersionContent,
  type SoaVersionDetail,
  type SoaVersionStatus,
  type SoaVersionSummary,
} from '@sm/shared';
import type { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { hasRole, isAdmin, matches } from '../auth/permissions.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { checkFourEyes, fourEyesRequired, samePerson } from '../auth/assurance.js';
import { canViewCatalogue } from '../records/access.js';
import { resolveSupplierLink, supplierRefs } from '../suppliers/links.js';
import { publicKeyFingerprint, publicKeyPem, vault } from '../vault.js';
import { csvTable } from '../csv.js';
import { publishDataset } from '../dashboards/datasets.js';
import { drawPdf } from '../reports/pdf/pool.js';
import { getBranding, logo } from '../reports/branding.js';
import { reportsDir } from '../reports/service.js';
import { defaultLocale } from '../notifications/locale.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { canExportEvidence, forbid, me, readsEverything, SYSTEM_USER } from './access.js';
import { coverage, ensureCatalogues, findCatalogue } from './controls.js';
import { findingsOfControls } from './corrective.js';
import { areaControlsOf, matrixOf } from './responsibilities.js';
import { SOA_SIGNATURE_DOMAIN, type PackManifest } from './evidence-verify.js';
import type { SoaPdfModel } from './soa-pdf.js';
import { ZipWriter } from './zip.js';

/**
 * The statement of applicability (ISO/IEC 27001 clause 6.1.3 d, ADR 0029 part 2, docs/COMPLIANCE.md#statement-of-applicability):
 * one per control catalogue, with an optional scope name and services in scope (none: every service), pre-filled with
 * one undecided row per control.
 *
 * Who may do what (ADR 0029, _Permissions and audit_):
 * - see it: everyone who can sign in – the evidence by the coverage rule of the Controls page (a reader with fewer
 *   rights sees "not visible", never a gap);
 * - change rows and settings, submit a version: designers and administrators; a row's owner changes its status, how it
 *   is met and its last review; the controls per area of other catalogues: administrators;
 * - approve or return a version: approvers and administrators – control point soa.approve (step-up on; a second person
 *   by the SoA's switch, on by default, or by the policy);
 * - export an approved version: who may export evidence packs.
 *
 * Versions freeze the rows, the control texts, the coverage (complete, as an auditor sees it – counts only) and the
 * suggestions into `soa_versions.content` with its SHA-256; the approved PDF is archived under reports/soa/ with its
 * SHA-256 in the audit log. The signed export is the evidence-pack format with its own signature domain.
 */

interface SoaRow {
  id: string;
  catalogue_id: string;
  scope_name: string;
  scope_service_ids: string;
  four_eyes: number;
  area_controls: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface EntryRow {
  id: string;
  soa_id: string;
  control_id: string;
  applicable: number | null;
  justification: string;
  status: SoaStatus | null;
  how_met: string;
  party: SoaParty | null;
  supplier_id: string | null;
  central_name: string;
  owner: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  grc_ref: string;
  grc_url: string;
  evidence_links: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

interface VersionRow {
  id: string;
  soa_id: string;
  number: number;
  status: SoaVersionStatus;
  content: string;
  content_sha256: string;
  submitted_at: string;
  submitted_by: string;
  decided_at: string | null;
  decided_by: string | null;
  comment: string;
  files: string;
  /** A second person approves this version: fixed when it was submitted (the SoA's switch or the policy then) */
  four_eyes: number;
}

interface ControlRow {
  id: string;
  ref: string;
  title: string;
  description: string;
}

interface Catalogue {
  id: string;
  key: string;
  name: string;
  version: string;
}

export const SOA_POINT = 'soa.approve';
const EDITORS = ['admin', 'designer'];
const APPROVERS = ['admin', 'approver'];

export const canEditSoa = (u: AuthUser): boolean => hasRole(u, EDITORS);
export const canApproveSoa = (u: AuthUser): boolean => hasRole(u, APPROVERS);
const ownsRow = (u: AuthUser, e: Pick<EntryRow, 'owner'> | undefined): boolean => !!e?.owner && matches(u, e.owner);

// ---------- reading the stored state ----------

function catalogueOf(idOrKey: string): Catalogue {
  const c = findCatalogue(idOrKey);
  if (!c) throw new HttpError(404, `Control catalogue ${idOrKey} not found`, 'CATALOGUE_NOT_FOUND', { id: idOrKey });
  return { id: c.id, key: c.key, name: c.name, version: c.version };
}

function soaOf(catalogueIdOrKey: string): { cat: Catalogue; soa: SoaRow } {
  const cat = catalogueOf(catalogueIdOrKey);
  const soa = db().get<SoaRow>('SELECT * FROM soas WHERE catalogue_id = ?', cat.id);
  if (!soa) throw new HttpError(404, `No statement of applicability for ${cat.key}`, 'SOA_NOT_FOUND', { catalogue: cat.key });
  return { cat, soa };
}

const controlsOf = (catalogueId: string): ControlRow[] =>
  db().all<ControlRow>('SELECT id, ref, title, description FROM controls WHERE catalogue_id = ? ORDER BY sort, ref', catalogueId);

const entriesOf = (soaId: string): Map<string, EntryRow> =>
  new Map(
    db()
      .all<EntryRow>('SELECT * FROM soa_entries WHERE soa_id = ?', soaId)
      .map((e) => [e.control_id, e]),
  );

function mappedCounts(catalogueId: string): Map<string, number> {
  return new Map(
    db()
      .all<{ control_id: string; n: number }>(
        'SELECT t.control_id, COUNT(*) AS n FROM control_tags t JOIN controls c ON c.id = t.control_id WHERE c.catalogue_id = ? GROUP BY t.control_id',
        catalogueId,
      )
      .map((r) => [r.control_id, Number(r.n)]),
  );
}

const versionsOf = (soaId: string): VersionRow[] => db().all<VersionRow>('SELECT * FROM soa_versions WHERE soa_id = ? ORDER BY number DESC', soaId);

const applicableOf = (e: EntryRow | undefined): boolean | null => (!e || e.applicable === null || e.applicable === undefined ? null : !!Number(e.applicable));

/** Decided: applicable set with a justification (6.1.3 d asks for both inclusions and exclusions), a status where applicable. */
export function isDecided(e: EntryRow | undefined): boolean {
  const a = applicableOf(e);
  return a !== null && !!e!.justification.trim() && (!a || !!e!.status);
}

const linksOf = (e: EntryRow | undefined): { title: string; url: string }[] => (e ? parseJson<{ title: string; url: string }[]>(e.evidence_links, []) : []);

function reviewCutoff(now: number): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - SOA_LIMITS.reviewMonths);
  return d.toISOString();
}

const reviewDueOf = (e: EntryRow | undefined, cutoff: string) => !e?.reviewed_at || e.reviewed_at < cutoff;
const noEvidenceOf = (e: EntryRow | undefined, mapped: number) =>
  applicableOf(e) === true && e!.status === 'implemented' && mapped === 0 && linksOf(e).length === 0;

function countsOf(controls: ControlRow[], entries: Map<string, EntryRow>, mapped: Map<string, number>, now = Date.now()): SoaCounts {
  const c: SoaCounts = {
    controls: controls.length,
    applicable: 0,
    notApplicable: 0,
    undecided: 0,
    implemented: 0,
    partly: 0,
    planned: 0,
    notStarted: 0,
    noStatus: 0,
    reviewDue: 0,
    noEvidence: 0,
  };
  const cutoff = reviewCutoff(now);
  for (const ctl of controls) {
    const e = entries.get(ctl.id);
    const a = applicableOf(e);
    if (a === null) c.undecided++;
    else if (a) {
      c.applicable++;
      if (e!.status) c[e!.status]++;
      else c.noStatus++;
    } else c.notApplicable++;
    if (reviewDueOf(e, cutoff)) c.reviewDue++;
    if (noEvidenceOf(e, mapped.get(ctl.id) ?? 0)) c.noEvidence++;
  }
  return c;
}

/** The services the SoA covers: those in scope, or every service that is not archived. */
function scopeIdsOf(soa: SoaRow): string[] {
  const ids = parseJson<string[]>(soa.scope_service_ids, []);
  if (ids.length) return ids;
  return db()
    .all<{ id: string }>('SELECT id FROM services WHERE archived = 0')
    .map((s) => s.id);
}

/** The name of the supplier of each id (every supplier: frozen content and comparisons name it as it is). */
function supplierNames(ids: (string | null)[]): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE id IN (${part.map(() => '?').join(', ')})`, ...part))
      out.set(r.id, r.name);
  }
  return out;
}

// ---------- the derived suggestion from the matrix ----------

interface RawSuggestion {
  counts: Record<ResponsibilityParty, number>;
  undecided: number;
  party: SoaParty | null;
  supplierId: string | null;
  centralName: string;
}

/**
 * Per control of the SoA: which parties the services in scope name in the matrix for the areas whose controls include
 * it – each service once per party. The most frequent party is the suggestion (a tie: shared); it is shown next to the
 * stored value and never written into it.
 */
function suggestionsOf(
  cat: Catalogue,
  soa: SoaRow,
): { byControl: Map<string, RawSuggestion>; areas: Map<string, ResponsibilityArea[]>; services: number; perArea: Record<ResponsibilityArea, string[]> } {
  const perArea = areaControlsOf(cat, parseJson<SoaAreaControls>(soa.area_controls, {}));
  const areas = new Map<string, ResponsibilityArea[]>();
  for (const a of RESPONSIBILITY_AREAS) for (const id of perArea[a]) areas.set(id, [...(areas.get(id) ?? []), a]);
  const scope = scopeIdsOf(soa);
  const rows = matrixOf(scope);
  const byService = new Map<string, Map<ResponsibilityArea, (typeof rows)[number]>>();
  for (const r of rows) {
    const m = byService.get(r.service_id) ?? new Map();
    m.set(r.area, r);
    byService.set(r.service_id, m);
  }
  const byControl = new Map<string, RawSuggestion>();
  for (const [controlId, list] of areas) {
    const counts = Object.fromEntries(RESPONSIBILITY_PARTIES.map((p) => [p, 0])) as Record<ResponsibilityParty, number>;
    let undecided = 0;
    const suppliers = new Set<string | null>();
    const centrals = new Set<string>();
    for (const sid of scope) {
      const m = byService.get(sid);
      const found = list.map((a) => m?.get(a)).filter((x) => !!x);
      if (!found.length) {
        undecided++;
        continue;
      }
      for (const p of new Set(found.map((x) => x.party))) counts[p]++;
      for (const x of found) {
        if (x.party === 'supplier') suppliers.add(x.supplier_id);
        if (x.party === 'central') centrals.add(x.central_name);
      }
    }
    const best = Math.max(...SOA_PARTIES.map((p) => counts[p]));
    const top = SOA_PARTIES.filter((p) => counts[p] === best);
    const party: SoaParty | null = best === 0 ? null : top.length === 1 ? top[0]! : 'shared';
    byControl.set(controlId, {
      counts,
      undecided,
      party,
      supplierId: party === 'supplier' && suppliers.size === 1 ? [...suppliers][0]! : null,
      centralName: party === 'central' && centrals.size === 1 ? [...centrals][0]! : '',
    });
  }
  return { byControl, areas, services: scope.length, perArea };
}

// ---------- comparing with the latest approved version ----------

/** What a row says, as a comparable text (frozen entries and stored rows alike). */
function fingerprint(x: {
  applicable: boolean | null;
  justification: string;
  status: SoaStatus | null;
  howMet: string;
  party: SoaParty | null;
  supplier: string | null;
  centralName: string;
  owner: string | null;
  grcRef: string;
  grcUrl: string;
  evidenceLinks: { title: string; url: string }[];
}): string {
  return JSON.stringify([
    x.applicable,
    x.justification,
    x.status,
    x.howMet,
    x.party,
    x.supplier,
    x.centralName,
    x.owner,
    x.grcRef,
    x.grcUrl,
    x.evidenceLinks.map((l) => [l.title, l.url]),
  ]);
}

function rowFingerprint(e: EntryRow | undefined, names: Map<string, string>): string {
  return fingerprint({
    applicable: applicableOf(e),
    justification: e?.justification ?? '',
    status: e?.status ?? null,
    howMet: e?.how_met ?? '',
    party: e?.party ?? null,
    supplier: e?.supplier_id ? (names.get(e.supplier_id) ?? null) : null,
    centralName: e?.central_name ?? '',
    owner: e?.owner ?? null,
    grcRef: e?.grc_ref ?? '',
    grcUrl: e?.grc_url ?? '',
    evidenceLinks: linksOf(e),
  });
}

/** The controls (by id) whose row differs from the latest approved version; null when nothing was approved yet. */
function changedSince(soa: SoaRow, controls: ControlRow[], entries: Map<string, EntryRow>): Set<string> | null {
  const approved = db().get<VersionRow>("SELECT * FROM soa_versions WHERE soa_id = ? AND status = 'approved' ORDER BY number DESC LIMIT 1", soa.id);
  if (!approved) return null;
  const content = parseJson<SoaVersionContent | null>(approved.content, null);
  const frozen = new Map((content?.entries ?? []).map((x) => [x.ref, fingerprint(x)]));
  const names = supplierNames([...entries.values()].map((e) => e.supplier_id));
  const out = new Set<string>();
  for (const c of controls) if (frozen.get(c.ref) !== rowFingerprint(entries.get(c.id), names)) out.add(c.id);
  return out;
}

// ---------- what the API returns ----------

function versionSummary(v: VersionRow, u: AuthUser): SoaVersionSummary {
  const content = parseJson<SoaVersionContent | null>(v.content, null);
  const files = parseJson<{ pdf?: { sha256: string } }>(v.files, {});
  return {
    number: Number(v.number),
    status: v.status,
    contentSha256: v.content_sha256,
    submittedAt: v.submitted_at,
    submittedBy: v.submitted_by,
    decidedAt: v.decided_at,
    decidedBy: v.decided_by,
    comment: v.comment,
    pdfSha256: files.pdf?.sha256 ?? null,
    fourEyes: versionFourEyes(v),
    counts: content?.counts ?? countsOf([], new Map(), new Map()),
    // the signed files hold every name: only for who may see them all (L1)
    canExport: (v.status === 'approved' || v.status === 'superseded') && canExportEvidence(u) && !!content && seesAllOf(content, u),
  };
}

function summaryOf(cat: Catalogue, soa: SoaRow, controls = controlsOf(cat.id), entries = entriesOf(soa.id), now = Date.now()): SoaSummary {
  const versions = versionsOf(soa.id);
  const approved = versions.find((v) => v.status === 'approved');
  const waiting = versions.find((v) => v.status === 'submitted');
  const changed = changedSince(soa, controls, entries);
  return {
    id: soa.id,
    catalogueId: cat.id,
    catalogueKey: cat.key,
    catalogueName: cat.name,
    scopeName: soa.scope_name,
    scopeServiceIds: parseJson<string[]>(soa.scope_service_ids, []),
    fourEyes: !!Number(soa.four_eyes),
    counts: countsOf(controls, entries, mappedCounts(cat.id), now),
    latestApproved: approved ? { number: Number(approved.number), decidedAt: approved.decided_at!, decidedBy: approved.decided_by! } : null,
    waiting: waiting ? { number: Number(waiting.number), submittedAt: waiting.submitted_at, submittedBy: waiting.submitted_by } : null,
    changedSinceApproved: changed?.size ?? 0,
    createdAt: soa.created_at,
    updatedAt: soa.updated_at,
  };
}

/** Every SoA, and the catalogues without one (everyone who can sign in). */
export function listSoas(): SoaList {
  const u = me();
  ensureCatalogues();
  const soas = db().all<SoaRow>('SELECT * FROM soas');
  const cats = db().all<Catalogue & { builtin: number }>('SELECT id, key, name, version, builtin FROM control_catalogues ORDER BY builtin DESC, key');
  const byCat = new Map(soas.map((s) => [s.catalogue_id, s]));
  const items: SoaSummary[] = [];
  const free: SoaList['catalogues'] = [];
  for (const c of cats) {
    const s = byCat.get(c.id);
    if (s) items.push(summaryOf(c, s));
    else
      free.push({
        id: c.id,
        key: c.key,
        name: c.name,
        controls: Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM controls WHERE catalogue_id = ?', c.id)!.n),
      });
  }
  return { items, catalogues: free, canCreate: canEditSoa(u), fourEyesOff: canSwitchFourEyesOff(u) };
}

const coveragePeriod = (now = Date.now()) => {
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - SOA_LIMITS.coverageMonths);
  return { from: from.toISOString(), to: new Date(now).toISOString() };
};

/** The rows as the reader sees them (all controls, or `only`). */
function buildEntries(
  cat: Catalogue,
  soa: SoaRow,
  u: AuthUser,
  only?: string[],
): { entries: SoaEntry[]; services: number; perArea: Record<ResponsibilityArea, string[]> } {
  let controls = controlsOf(cat.id);
  if (only) controls = controls.filter((c) => only.includes(c.id));
  const entries = entriesOf(soa.id);
  const cov = new Map<string, ControlCoverage>(coverage(coveragePeriod(), { catalogue: cat.id, controlIds: only }).map((c) => [c.control.id, c]));
  const sug = suggestionsOf(cat, soa);
  const changed = changedSince(soa, controls, entries);
  const supplierIds = [...entries.values()].map((e) => e.supplier_id);
  for (const s of sug.byControl.values()) supplierIds.push(s.supplierId);
  const refs = supplierRefs(supplierIds);
  const findings = new Map<string, { open: number; total: number }>();
  for (const f of findingsOfControls(
    controls.map((c) => c.id),
    u,
  ))
    for (const c of f.controls) {
      const x = findings.get(c.id) ?? { open: 0, total: 0 };
      x.total++;
      if (f.status === 'open' || f.status === 'inProgress' || f.status === 'implemented') x.open++;
      findings.set(c.id, x);
    }
  const cutoff = reviewCutoff(Date.now());
  const full = canEditSoa(u);
  const list = controls.map((c): SoaEntry => {
    const e = entries.get(c.id);
    const cv = cov.get(c.id);
    const tags = cv?.control.tags ?? [];
    const raw = sug.byControl.get(c.id);
    const suggestion: SoaSuggestion | null = raw
      ? {
          counts: raw.counts,
          undecided: raw.undecided,
          party: raw.party,
          supplier: raw.supplierId ? (refs.get(raw.supplierId) ?? null) : null,
          centralName: raw.centralName,
        }
      : null;
    return {
      controlId: c.id,
      ref: c.ref,
      title: c.title,
      description: c.description,
      applicable: applicableOf(e),
      justification: e?.justification ?? '',
      status: e?.status ?? null,
      howMet: e?.how_met ?? '',
      party: e?.party ?? null,
      supplier: e?.supplier_id ? (refs.get(e.supplier_id) ?? null) : null,
      supplierHidden: !!e?.supplier_id && !refs.has(e.supplier_id),
      centralName: e?.central_name ?? '',
      owner: e?.owner ?? null,
      reviewedAt: e?.reviewed_at ?? null,
      reviewedBy: e?.reviewed_by ?? null,
      reviewDue: reviewDueOf(e, cutoff),
      grcRef: e?.grc_ref ?? '',
      grcUrl: e?.grc_url ?? '',
      evidenceLinks: linksOf(e),
      areas: sug.areas.get(c.id) ?? [],
      suggestion,
      evidence: {
        status: cv?.status ?? 'unmapped',
        mapped: tags.length,
        items: cv ? cv.evidence.length + cv.truncated : 0,
        hidden: cv?.hidden ?? 0,
        tags: tags.slice(0, 20).map((t) => ({ kind: t.kind, label: t.visible ? t.label : '', path: t.visible ? t.path : null, visible: t.visible })),
      },
      noEvidence: noEvidenceOf(e, tags.length),
      findings: findings.get(c.id) ?? { open: 0, total: 0 },
      decided: isDecided(e),
      changed: changed?.has(c.id) ?? false,
      updatedAt: e?.updated_at ?? null,
      updatedBy: e?.updated_by ?? null,
      canEdit: full,
      canEditOwn: full || ownsRow(u, e),
    };
  });
  return { entries: list, services: sug.services, perArea: sug.perArea };
}

/** One SoA with its rows, evidence, suggestions, findings and versions, as the reader sees it. */
export function getSoa(catalogueIdOrKey: string): Soa {
  const u = me();
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const controls = controlsOf(cat.id);
  const stored = entriesOf(soa.id);
  const summary = summaryOf(cat, soa, controls, stored);
  const { entries, services, perArea } = buildEntries(cat, soa, u);
  const scope = parseJson<string[]>(soa.scope_service_ids, []);
  const scopeServices = scope.length
    ? db()
        .all<{ id: string; name: string; owners: string }>(
          `SELECT id, name, owners FROM services WHERE id IN (${scope.map(() => '?').join(', ')}) ORDER BY name`,
          ...scope,
        )
        .filter((s) => canViewCatalogue(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) }))
        .map((s) => ({ id: s.id, name: s.name }))
    : [];
  const fourEyes = fourEyesRequired(SOA_POINT, !!Number(soa.four_eyes));
  const waiting = summary.waiting;
  const waitingRow = waiting ? versionsOf(soa.id).find((v) => v.status === 'submitted') : undefined;
  const edit = canEditSoa(u);
  const undecided = entries.filter((e) => !e.decided).length;
  // a waiting version keeps the rule it was submitted with (switching the second person off later does not apply to it)
  const ownSubmission = !!waitingRow && versionFourEyes(waitingRow) && samePerson(waitingRow.submitted_by, u);
  const storedAreas = parseJson<SoaAreaControls>(soa.area_controls, {});
  return {
    ...summary,
    catalogueVersion: cat.version,
    scopeServices,
    servicesInScope: services,
    areaControls: perArea,
    areaControlsDefault: !RESPONSIBILITY_AREAS.some((a) => (storedAreas[a] ?? []).length > 0),
    entries,
    versions: versionsOf(soa.id).map((v) => versionSummary(v, u)),
    permissions: {
      edit,
      areaControls: isAdmin(u),
      submit: edit && !waiting && undecided === 0,
      submitBlocked: waiting ? 'waiting' : undecided ? 'undecided' : null,
      decide: !!waiting && canApproveSoa(u) && !ownSubmission,
      decideBlocked: waiting && canApproveSoa(u) && ownSubmission ? 'ownSubmission' : null,
      fourEyes,
      fourEyesRequiredByPolicy: fourEyesRequired(SOA_POINT, false),
      fourEyesOff: canSwitchFourEyesOff(u),
      export: canExportEvidence(u),
    },
  };
}

/** One row as the reader sees it. */
export function getEntry(catalogueIdOrKey: string, controlId: string): SoaEntry {
  const u = me();
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const e = buildEntries(cat, soa, u, [controlId]).entries[0];
  if (!e) throw new HttpError(404, `Control ${controlId} not found`, 'CONTROL_NOT_FOUND', { id: controlId });
  return e;
}

// ---------- creating and changing ----------

function checkServices(ids: string[]): void {
  const u = me();
  for (const id of ids) {
    const s = db().get<{ id: string; owners: string }>('SELECT id, owners FROM services WHERE id = ?', id);
    if (!s || !canViewCatalogue(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) }))
      throw new HttpError(400, `Service ${id} not found`, 'SOA_SERVICE_UNKNOWN', { id });
  }
}

/** One SoA per catalogue, pre-filled with one undecided row per control (designers, administrators). */
export function createSoa(input: z.input<typeof soaCreateInput>): Soa {
  const u = me();
  if (!canEditSoa(u)) forbid('create statements of applicability (designers, administrators)', 'editSoa');
  const v = soaCreateInput.parse(input);
  if (!v.fourEyes) assertFourEyesOff(u);
  const cat = catalogueOf(v.catalogueId);
  if (db().get('SELECT 1 FROM soas WHERE catalogue_id = ?', cat.id))
    throw new HttpError(409, `There is a statement of applicability for ${cat.key} already`, 'SOA_EXISTS', { catalogue: cat.key });
  const controls = controlsOf(cat.id);
  if (controls.length > SOA_LIMITS.controls)
    throw new HttpError(400, `A statement of applicability covers at most ${SOA_LIMITS.controls} controls`, 'SOA_CONTROL_LIMIT', { max: SOA_LIMITS.controls });
  const scope = [...new Set(v.scopeServiceIds)];
  checkServices(scope);
  const id = newId('soa_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO soas (id, catalogue_id, scope_name, scope_service_ids, four_eyes, area_controls, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
      id,
      cat.id,
      v.scopeName,
      JSON.stringify(scope),
      v.fourEyes ? 1 : 0,
      now,
      u.username,
      now,
      u.username,
    );
    for (const c of controls) db().run('INSERT INTO soa_entries (id, soa_id, control_id) VALUES (?, ?, ?)', newId('soae_'), id, c.id);
    audit({
      action: 'soa.created',
      entityType: 'soa',
      entityId: id,
      summary: `Statement of applicability for ${cat.key} created with ${controls.length} rows${v.scopeName ? ` (scope "${v.scopeName}")` : ''}`,
      details: { catalogue: cat.key, controls: controls.length, scopeName: v.scopeName, scopeServiceIds: scope, fourEyes: v.fourEyes },
    });
  });
  return getSoa(cat.id);
}

/** Scope, the second person and (administrators) the controls per area. */
export function updateSettings(catalogueIdOrKey: string, input: z.input<typeof soaSettingsInput>): Soa {
  const u = me();
  if (!canEditSoa(u)) forbid('change statements of applicability (designers, administrators)', 'editSoa');
  const v = soaSettingsInput.parse(input);
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const before = {
    scopeName: soa.scope_name,
    scopeServiceIds: parseJson<string[]>(soa.scope_service_ids, []),
    fourEyes: !!Number(soa.four_eyes),
    areaControls: parseJson<SoaAreaControls>(soa.area_controls, {}),
  };
  const after = { ...before };
  if (v.scopeName !== undefined) after.scopeName = v.scopeName;
  if (v.scopeServiceIds !== undefined) {
    after.scopeServiceIds = [...new Set(v.scopeServiceIds)];
    const added = after.scopeServiceIds.filter((x) => !before.scopeServiceIds.includes(x));
    checkServices(added);
  }
  if (v.fourEyes !== undefined) after.fourEyes = v.fourEyes;
  // switching the second person off loosens the control point soa.approve: administrators only, with the confirmation of
  // approving (the route), and never while the policy requires it. Versions waiting keep the rule they were submitted with
  if (before.fourEyes && !after.fourEyes) assertFourEyesOff(u);
  if (v.areaControls !== undefined) {
    const next = Object.fromEntries(RESPONSIBILITY_AREAS.map((a) => [a, [...new Set(v.areaControls![a] ?? [])]])) as SoaAreaControls;
    if (JSON.stringify(next) !== JSON.stringify(Object.fromEntries(RESPONSIBILITY_AREAS.map((a) => [a, before.areaControls[a] ?? []])))) {
      if (!isAdmin(u)) forbid('name the controls per area (administrators)', 'manageCatalogues');
      const known = new Set(controlsOf(cat.id).map((c) => c.id));
      for (const a of RESPONSIBILITY_AREAS)
        for (const id of next[a] ?? []) if (!known.has(id)) throw new HttpError(400, `Control ${id} is not in ${cat.key}`, 'SOA_CONTROL_UNKNOWN', { id });
      after.areaControls = next;
    }
  }
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return getSoa(cat.id);
  db().tx(() => {
    db().run(
      'UPDATE soas SET scope_name = ?, scope_service_ids = ?, four_eyes = ?, area_controls = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      after.scopeName,
      JSON.stringify(after.scopeServiceIds),
      after.fourEyes ? 1 : 0,
      JSON.stringify(after.areaControls),
      nowIso(),
      u.username,
      soa.id,
    );
    audit({
      action: 'soa.settings_changed',
      entityType: 'soa',
      entityId: soa.id,
      summary: `Settings of the statement of applicability for ${cat.key} changed: ${changed.join(', ')}`,
      details: {
        catalogue: cat.key,
        fields: changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
    });
  });
  return getSoa(cat.id);
}

type EntryFields = Pick<
  EntryRow,
  | 'applicable'
  | 'justification'
  | 'status'
  | 'how_met'
  | 'party'
  | 'supplier_id'
  | 'central_name'
  | 'owner'
  | 'reviewed_at'
  | 'reviewed_by'
  | 'grc_ref'
  | 'grc_url'
  | 'evidence_links'
>;

const ENTRY_FIELDS: Record<keyof EntryFields, string> = {
  applicable: 'applicable',
  justification: 'justification',
  status: 'status',
  how_met: 'howMet',
  party: 'party',
  supplier_id: 'supplierId',
  central_name: 'centralName',
  owner: 'owner',
  reviewed_at: 'reviewedAt',
  reviewed_by: 'reviewedBy',
  grc_ref: 'grcRef',
  grc_url: 'grcUrl',
  evidence_links: 'evidenceLinks',
};

/**
 * Changes one row: designers and administrators every field; the row's owner its status, how it is met and the last
 * review. The responsible party is what a person chose – the suggestion of the matrix is only shown next to it.
 */
export function updateEntry(catalogueIdOrKey: string, controlId: string, input: z.input<typeof soaEntryInput>): SoaEntry {
  const u = me();
  const v = soaEntryInput.parse(input);
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const control = db().get<ControlRow>('SELECT id, ref, title, description FROM controls WHERE id = ? AND catalogue_id = ?', controlId, cat.id);
  if (!control) throw new HttpError(404, `Control ${controlId} not found`, 'CONTROL_NOT_FOUND', { id: controlId });
  let e = db().get<EntryRow>('SELECT * FROM soa_entries WHERE soa_id = ? AND control_id = ?', soa.id, control.id);
  const full = canEditSoa(u);
  const keys = Object.keys(v);
  if (!full && !(ownsRow(u, e) && keys.every((k) => (SOA_OWNER_FIELDS as readonly string[]).includes(k))))
    forbid(
      ownsRow(u, e)
        ? 'change this row: its owner changes the status, how it is met and the last review'
        : 'change statements of applicability (designers, administrators; a row’s owner its status and review)',
      'editSoa',
    );
  if (!e) {
    // a control added to the catalogue after the SoA was created
    db().run(
      'INSERT INTO soa_entries (id, soa_id, control_id) VALUES (?, ?, ?) ON CONFLICT (soa_id, control_id) DO NOTHING',
      newId('soae_'),
      soa.id,
      control.id,
    );
    e = db().get<EntryRow>('SELECT * FROM soa_entries WHERE soa_id = ? AND control_id = ?', soa.id, control.id)!;
  }
  if (v.owner) assertKnownSubjects([v.owner], e.owner ? [e.owner] : []);
  const now = nowIso();
  const applicable = v.applicable === undefined ? applicableOf(e) : v.applicable;
  const party = v.party === undefined ? e.party : v.party;
  const next: EntryFields = {
    applicable: applicable === null ? null : applicable ? 1 : 0,
    justification: v.justification ?? e.justification,
    // a status only where the control applies
    status: applicable === false ? null : v.status === undefined ? e.status : v.status,
    how_met: v.howMet ?? e.how_met,
    party,
    supplier_id: party === 'supplier' ? resolveSupplierLink(v.supplierId, e.party === 'supplier' ? e.supplier_id : null) : null,
    central_name: party === 'central' ? (v.centralName ?? e.central_name) : '',
    owner: v.owner === undefined ? e.owner : v.owner,
    reviewed_at: v.reviewed ? now : e.reviewed_at,
    reviewed_by: v.reviewed ? u.username : e.reviewed_by,
    grc_ref: v.grcRef ?? e.grc_ref,
    grc_url: v.grcUrl ?? e.grc_url,
    evidence_links: v.evidenceLinks ? JSON.stringify(v.evidenceLinks) : e.evidence_links,
  };
  const cur = e;
  const norm = (k: keyof EntryFields, x: unknown) => (k === 'applicable' && x !== null && x !== undefined ? Number(x) : (x ?? null));
  const changed = (Object.keys(ENTRY_FIELDS) as (keyof EntryFields)[]).filter((k) => norm(k, next[k]) !== norm(k, cur[k]));
  if (!changed.length) return getEntry(cat.id, control.id);
  const show = (k: keyof EntryFields, x: unknown) =>
    k === 'applicable' ? (x === null || x === undefined ? null : !!Number(x)) : k === 'evidence_links' ? parseJson<unknown[]>(String(x), []) : (x ?? null);
  db().tx(() => {
    db().run(
      `UPDATE soa_entries SET ${changed.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...changed.map((k) => next[k]),
      now,
      u.username,
      cur.id,
    );
    db().run('UPDATE soas SET updated_at = ?, updated_by = ? WHERE id = ?', now, u.username, soa.id);
    audit({
      action: 'soa.entry_changed',
      entityType: 'soa',
      entityId: soa.id,
      summary: `SoA ${cat.key} ${control.ref} changed: ${changed.map((k) => ENTRY_FIELDS[k]).join(', ')}`,
      details: {
        catalogue: cat.key,
        controlId: control.id,
        ref: control.ref,
        fields: changed.map((k) => ENTRY_FIELDS[k]),
        before: Object.fromEntries(changed.map((k) => [ENTRY_FIELDS[k], show(k, cur[k])])),
        after: Object.fromEntries(changed.map((k) => [ENTRY_FIELDS[k], show(k, next[k])])),
        byOwner: !full,
      },
    });
  });
  return getEntry(cat.id, control.id);
}

// ---------- versions ----------

/** The frozen content of a version: rows, control texts, complete coverage (counts only) and suggestions. */
function freeze(cat: Catalogue, soa: SoaRow, number: number, u: AuthUser, at: string): SoaVersionContent {
  const controls = controlsOf(cat.id);
  const entries = entriesOf(soa.id);
  // as an auditor sees it: the status and counts only, no item is named
  const cov = new Map(runAs(SYSTEM_USER, () => coverage(coveragePeriod(Date.parse(at)), { catalogue: cat.id })).map((c) => [c.control.id, c]));
  const sug = suggestionsOf(cat, soa);
  const names = supplierNames([...entries.values()].map((e) => e.supplier_id));
  const scope = parseJson<string[]>(soa.scope_service_ids, []);
  const scopeNames = scope.length
    ? db()
        .all<{ name: string }>(`SELECT name FROM services WHERE id IN (${scope.map(() => '?').join(', ')}) ORDER BY name`, ...scope)
        .map((s) => s.name)
    : [];
  return {
    format: 'steward-soa',
    version: 1,
    catalogue: { key: cat.key, name: cat.name, version: cat.version },
    scope: { name: soa.scope_name, services: scopeNames },
    number,
    submittedAt: at,
    submittedBy: u.username,
    counts: countsOf(controls, entries, mappedCounts(cat.id), Date.parse(at)),
    entries: controls.map((c) => {
      const e = entries.get(c.id);
      const cv = cov.get(c.id);
      const s = sug.byControl.get(c.id);
      return {
        ref: c.ref,
        title: c.title,
        description: c.description,
        applicable: applicableOf(e),
        justification: e?.justification ?? '',
        status: e?.status ?? null,
        howMet: e?.how_met ?? '',
        party: e?.party ?? null,
        supplier: e?.supplier_id ? (names.get(e.supplier_id) ?? null) : null,
        centralName: e?.central_name ?? '',
        owner: e?.owner ?? null,
        reviewedAt: e?.reviewed_at ?? null,
        reviewedBy: e?.reviewed_by ?? null,
        grcRef: e?.grc_ref ?? '',
        grcUrl: e?.grc_url ?? '',
        evidenceLinks: linksOf(e),
        coverage: { status: cv?.status ?? 'unmapped', mapped: cv?.control.tags.length ?? 0, items: cv ? cv.evidence.length + cv.truncated : 0 },
        suggestion: s ? { party: s.party, counts: s.counts } : null,
      };
    }),
  };
}

/** Submit for approval: every control decided, every applicable one with a status; one version waits at a time. */
export function submitVersion(catalogueIdOrKey: string): Soa {
  const u = me();
  if (!canEditSoa(u)) forbid('submit statements of applicability (designers, administrators)', 'editSoa');
  const { cat, soa } = soaOf(catalogueIdOrKey);
  if (db().get("SELECT 1 FROM soa_versions WHERE soa_id = ? AND status = 'submitted'", soa.id))
    throw new HttpError(409, 'A version is waiting for approval already', 'SOA_VERSION_WAITING');
  const controls = controlsOf(cat.id);
  const entries = entriesOf(soa.id);
  const open = controls.filter((c) => !isDecided(entries.get(c.id))).length;
  if (open) throw new HttpError(409, `${open} row(s) are not decided yet`, 'SOA_UNDECIDED', { count: open });
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM soa_versions WHERE soa_id = ?', soa.id)!.n);
  if (count >= SOA_LIMITS.versions) throw new HttpError(400, `At most ${SOA_LIMITS.versions} versions`, 'SOA_VERSION_LIMIT', { max: SOA_LIMITS.versions });
  const at = nowIso();
  const number = Number(db().get<{ n: number | null }>('SELECT MAX(number) AS n FROM soa_versions WHERE soa_id = ?', soa.id)?.n ?? 0) + 1;
  // frozen before the transaction (the coverage reads a lot); the unique number guards against a second submission
  const content = freeze(cat, soa, number, u, at);
  const text = JSON.stringify(content);
  const hash = sha256(text);
  // fixed now: the switch or the policy as they are at submission (security review 0.17.0, M1)
  const fourEyes = fourEyesRequired(SOA_POINT, !!Number(soa.four_eyes));
  db().tx(() => {
    if (db().get("SELECT 1 FROM soa_versions WHERE soa_id = ? AND status = 'submitted'", soa.id))
      throw new HttpError(409, 'A version is waiting for approval already', 'SOA_VERSION_WAITING');
    db().run(
      `INSERT INTO soa_versions (id, soa_id, number, status, content, content_sha256, submitted_at, submitted_by, four_eyes)
       VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
      newId('soav_'),
      soa.id,
      number,
      text,
      hash,
      at,
      u.username,
      fourEyes ? 1 : 0,
    );
    audit({
      action: 'soa.version_submitted',
      entityType: 'soa',
      entityId: soa.id,
      summary: `Version ${number} of the statement of applicability for ${cat.key} submitted for approval (sha256 ${hash.slice(0, 16)}…)`,
      details: { catalogue: cat.key, number, contentSha256: hash, counts: content.counts, fourEyes },
    });
  });
  notifyApprovalWaiting(cat, soa, number, u.username, content.counts.applicable);
  return getSoa(cat.id);
}

/**
 * soa.approval_waiting (docs/NOTIFICATIONS.md): a submitted version waits – to the approvers and administrators who may
 * decide it (not who submitted it). The text names the catalogue and the version, nothing of its rows. Never fails the
 * submission: a message that cannot go out is logged.
 */
function notifyApprovalWaiting(cat: Catalogue, soa: SoaRow, number: number, submittedBy: string, applicable: number): void {
  void (async () => {
    const { listUsers, toAuthUser } = await import('../auth/users.js');
    const { notify } = await import('../notifications/service.js');
    const { t } = await import('../i18n/index.js');
    const recipients = listUsers().filter((x) => x.active && canApproveSoa(toAuthUser(x)) && !samePerson(submittedBy, toAuthUser(x)));
    if (!recipients.length) return;
    const params = { catalogue: cat.key, number, by: submittedBy, scope: soa.scope_name || cat.name, applicable };
    notify({
      event: 'soa.approval_waiting',
      text: (l) => ({ title: t(l, 'soa.waiting.title', params), body: t(l, 'soa.waiting.body', params) }),
      link: `/compliance/soa/${encodeURIComponent(cat.key)}`,
      recipients,
      inAppKey: `soa:${soa.id}:${number}:waiting`,
      externalKey: `soa:${soa.id}:${number}:waiting`,
      data: { catalogue: cat.key, number, submittedBy },
    });
  })().catch((err: unknown) => logger.warn({ err, catalogue: cat.key, number }, 'statement of applicability: the approvers could not be told'));
}

/** Whether a second person approves a version: fixed at submission, or required by the policy now. */
const versionFourEyes = (v: Pick<VersionRow, 'four_eyes'>): boolean => fourEyesRequired(SOA_POINT, !!Number(v.four_eyes));

/** Switch an SoA's second person off: administrators, while the assurance policy does not require it for every SoA. */
export const canSwitchFourEyesOff = (u: AuthUser): boolean => isAdmin(u) && !fourEyesRequired(SOA_POINT, false);

/** The step-up rule of the settings route: the request switches the stored second person off (the route checks the rest). */
export function switchesFourEyesOff(catalogueIdOrKey: string, body: unknown): boolean {
  if ((body as { fourEyes?: unknown } | null)?.fourEyes !== false || fourEyesRequired(SOA_POINT, false)) return false;
  return !!Number(soaOf(catalogueIdOrKey).soa.four_eyes);
}

function assertFourEyesOff(u: AuthUser): void {
  if (fourEyesRequired(SOA_POINT, false))
    throw new HttpError(409, 'The assurance policy requires a second person for every statement of applicability', 'SOA_FOUR_EYES_POLICY');
  if (!isAdmin(u)) forbid('switch off the approval by a second person (administrators)', 'changeSoaApproval');
}

/**
 * The frozen content of a version, checked against its recorded SHA-256 before it is approved, signed, exported or put
 * into an evidence pack (security review 0.17.0, L3): content changed in the database or brought by a migration package
 * is never signed under the original approval. 409 SOA_CONTENT_CHANGED otherwise (fail closed).
 */
function checkedContent(v: Pick<VersionRow, 'content' | 'content_sha256' | 'number'>): SoaVersionContent {
  if (sha256(v.content) !== v.content_sha256)
    throw new HttpError(409, 'The stored content of this version does not match its recorded SHA-256 – it was changed outside Steward', 'SOA_CONTENT_CHANGED', {
      number: Number(v.number),
    });
  return JSON.parse(v.content) as SoaVersionContent;
}

function versionRow(soa: SoaRow, n: number): VersionRow {
  const v = db().get<VersionRow>('SELECT * FROM soa_versions WHERE soa_id = ? AND number = ?', soa.id, n);
  if (!v) throw new HttpError(404, `Version ${n} not found`, 'SOA_VERSION_NOT_FOUND', { number: n });
  return v;
}

/**
 * The suppliers and services a frozen version names that the reader may not see (security review 0.17.0, L1). The
 * content holds names, not ids (it is what was approved and signed), so they are matched by name: a name no supplier
 * or service the reader may see has now – one of another team, or one renamed or removed since – counts as hidden.
 * Administrators and auditors see everything.
 */
export function hiddenNamesOf(c: SoaVersionContent, u: AuthUser): { suppliers: Set<string>; services: Set<string> } {
  const out = { suppliers: new Set<string>(), services: new Set<string>() };
  if (readsEverything(u)) return out;
  const seen = (table: 'suppliers' | 'services', kind: 'supplier' | 'service', name: string) =>
    db()
      .all<{ id: string; owners: string }>(`SELECT id, owners FROM ${table} WHERE name = ?`, name)
      .some((r) => canViewCatalogue(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }));
  for (const name of new Set((c.entries ?? []).map((e) => e.supplier).filter((x): x is string => !!x)))
    if (!seen('suppliers', 'supplier', name)) out.suppliers.add(name);
  for (const name of new Set(c.scope?.services ?? [])) if (!seen('services', 'service', name)) out.services.add(name);
  return out;
}

/**
 * One version with its frozen content (everyone who can sign in, like the SoA) – as the reader may see it, like the live
 * SoA and evidence packs: a supplier or service the reader may not see is left out of what is shown (`supplierHidden`,
 * `servicesHidden`); the stored content and its SHA-256 stay as they are.
 */
export function getVersion(catalogueIdOrKey: string, n: number): SoaVersionDetail {
  const u = me();
  const { soa } = soaOf(catalogueIdOrKey);
  const v = versionRow(soa, n);
  const content = JSON.parse(v.content) as SoaVersionContent;
  const hidden = hiddenNamesOf(content, u);
  if (!hidden.suppliers.size && !hidden.services.size) return { ...versionSummary(v, u), content };
  return {
    ...versionSummary(v, u),
    content: {
      ...content,
      scope: { ...content.scope, services: content.scope.services.filter((x) => !hidden.services.has(x)), servicesHidden: hidden.services.size },
      entries: content.entries.map((e) => (e.supplier && hidden.suppliers.has(e.supplier) ? { ...e, supplier: null, supplierHidden: true } : e)),
    },
  };
}

function seesAllOf(c: SoaVersionContent, u: AuthUser): boolean {
  const h = hiddenNamesOf(c, u);
  return !h.suppliers.size && !h.services.size;
}

/**
 * The frozen files hold names the person may not see (an evidence pack or export holds what its creator may see; the
 * signed bytes cannot be filtered): 403 SOA_EXPORT_HIDDEN – an auditor or administrator exports it.
 */
function assertSeesAll(c: SoaVersionContent, u: AuthUser, n: number): void {
  const hidden = hiddenNamesOf(c, u);
  if (hidden.suppliers.size || hidden.services.size)
    throw new HttpError(403, `Version ${n} names suppliers or services you may not see – an auditor or administrator exports it`, 'SOA_EXPORT_HIDDEN', {
      number: n,
      suppliers: hidden.suppliers.size,
      services: hidden.services.size,
    });
}

const soaPdfDir = () => path.join(reportsDir(), 'soa');
const pdfLang = (): ReportLang => (defaultLocale() === 'de' ? 'de' : 'en');

/** The archived PDF of an approved version (drawn in the PDF worker, PDF/A). */
async function renderVersionPdf(cat: Catalogue, v: VersionRow, decidedBy: string, decidedAt: string, comment: string): Promise<Buffer> {
  const content = checkedContent(v);
  const model: SoaPdfModel = {
    lang: pdfLang(),
    catalogue: content.catalogue,
    scope: content.scope,
    number: content.number,
    contentSha256: v.content_sha256,
    submittedAt: v.submitted_at,
    submittedBy: v.submitted_by,
    approvedAt: decidedAt,
    approvedBy: decidedBy,
    comment,
    counts: content.counts,
    entries: content.entries,
    catalogueKey: cat.key,
  };
  return drawPdf('soa', model, { branding: getBranding(), logo: logo().data });
}

/**
 * Approve (the PDF is archived, an approved version before is superseded) or return with a comment: approvers and
 * administrators – not the submitter while a second person is required (the SoA's switch or the policy). The route
 * asks for a fresh confirmation (control point soa.approve).
 */
export async function decideVersion(catalogueIdOrKey: string, n: number, input: z.input<typeof soaDecisionInput>): Promise<Soa> {
  const u = me();
  if (!canApproveSoa(u)) forbid('approve statements of applicability (approvers, administrators)', 'approveSoa');
  const d = soaDecisionInput.parse(input);
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const v = versionRow(soa, n);
  if (v.status !== 'submitted')
    throw new HttpError(409, `Version ${n} is not waiting for approval`, 'SOA_VERSION_NOT_WAITING', { number: n, status: v.status });
  // the rule the version was submitted with, or the policy now if it is stricter – never the switch as it is now
  const fe = checkFourEyes(SOA_POINT, [v.submitted_by], u, { itemRequires: !!Number(v.four_eyes) });
  if (!fe.ok) throw new HttpError(403, 'A second person approves: not who submitted the version', 'SOA_FOUR_EYES');
  const at = nowIso();
  if (!d.approve) {
    if (!d.comment) throw new HttpError(400, 'Say why the version goes back', 'SOA_COMMENT_REQUIRED');
    db().tx(() => {
      if (
        !db().run(
          "UPDATE soa_versions SET status = 'returned', decided_at = ?, decided_by = ?, comment = ? WHERE id = ? AND status = 'submitted'",
          at,
          u.username,
          d.comment,
          v.id,
        ).changes
      )
        throw new HttpError(409, `Version ${n} is not waiting for approval`, 'SOA_VERSION_NOT_WAITING', { number: n });
      audit({
        action: 'soa.version_returned',
        entityType: 'soa',
        entityId: soa.id,
        summary: `Version ${n} of the statement of applicability for ${cat.key} returned: ${d.comment}`.slice(0, 1000),
        details: { catalogue: cat.key, number: n, contentSha256: v.content_sha256, comment: d.comment, fourEyes: fe.required },
      });
    });
    return getSoa(cat.id);
  }
  const pdf = await renderVersionPdf(cat, v, u.username, at, d.comment);
  const pdfSha = sha256(pdf);
  fs.mkdirSync(soaPdfDir(), { recursive: true, mode: 0o700 });
  const rel = path.posix.join('soa', `${v.id}.pdf`);
  const file = path.join(reportsDir(), rel);
  fs.writeFileSync(file, pdf, { mode: 0o600 });
  try {
    db().tx(() => {
      if (
        !db().run(
          "UPDATE soa_versions SET status = 'approved', decided_at = ?, decided_by = ?, comment = ?, files = ? WHERE id = ? AND status = 'submitted'",
          at,
          u.username,
          d.comment,
          JSON.stringify({ pdf: { path: rel, sha256: pdfSha, size: pdf.length } }),
          v.id,
        ).changes
      )
        throw new HttpError(409, `Version ${n} is not waiting for approval`, 'SOA_VERSION_NOT_WAITING', { number: n });
      const superseded = db().run("UPDATE soa_versions SET status = 'superseded' WHERE soa_id = ? AND status = 'approved' AND id <> ?", soa.id, v.id).changes;
      audit({
        action: 'soa.version_approved',
        entityType: 'soa',
        entityId: soa.id,
        summary: `Version ${n} of the statement of applicability for ${cat.key} approved (content sha256 ${v.content_sha256.slice(0, 16)}…, PDF sha256 ${pdfSha.slice(0, 16)}…)`,
        details: { catalogue: cat.key, number: n, contentSha256: v.content_sha256, pdfSha256: pdfSha, comment: d.comment, superseded, fourEyes: fe.required },
      });
    });
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  publishSoaDataset(true);
  return getSoa(cat.id);
}

// ---------- the export ----------

const CSV_HEAD = [
  'Control',
  'Title',
  'Applicable',
  'Justification',
  'Status',
  'How it is met',
  'Responsible party',
  'Supplier',
  'Central IT or group',
  'Owner',
  'Last review',
  'Reviewed by',
  'GRC reference',
  'GRC URL',
  'Evidence links',
  'Coverage',
  'Mapped items',
  'Evidence items (12 months)',
];

function versionCsv(c: SoaVersionContent): string {
  return csvTable(
    CSV_HEAD,
    c.entries.map((e) => [
      e.ref,
      e.title,
      e.applicable === null ? '' : e.applicable ? 'yes' : 'no',
      e.justification,
      e.status ?? '',
      e.howMet,
      e.party ?? '',
      e.supplier ?? '',
      e.centralName,
      e.owner ?? '',
      e.reviewedAt ? e.reviewedAt.slice(0, 10) : '',
      e.reviewedBy ?? '',
      e.grcRef,
      e.grcUrl,
      e.evidenceLinks.map((l) => `${l.title} <${l.url}>`),
      e.coverage.status,
      e.coverage.mapped,
      e.coverage.items,
    ]),
    { bom: true },
  );
}

function archivedPdf(v: VersionRow): Buffer {
  const files = parseJson<{ pdf?: { path: string; sha256: string } }>(v.files, {});
  const file = files.pdf ? path.join(reportsDir(), files.pdf.path) : null;
  if (!file || !path.resolve(file).startsWith(path.resolve(reportsDir()) + path.sep) || !fs.existsSync(file))
    throw new HttpError(404, 'The archived PDF of this version is missing in the data folder', 'SOA_PDF_MISSING', { number: Number(v.number) });
  const buf = fs.readFileSync(file);
  if (sha256(buf) !== files.pdf!.sha256)
    throw new HttpError(409, 'The archived PDF does not match its recorded SHA-256 – it was changed outside Steward', 'SOA_PDF_CHANGED', {
      number: Number(v.number),
    });
  return buf;
}

export interface SoaExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

/**
 * An approved (or superseded) version as a file: the archived PDF, the CSV, or the signed ZIP in the evidence-pack
 * format – soa.pdf, soa.csv, soa.json (the frozen content: its SHA-256 is the version's), manifest.json signed with
 * the installation's key under the domain steward-soa-manifest-v1, and public-key.pem. `steward evidence verify`
 * checks it offline.
 */
export async function exportVersion(catalogueIdOrKey: string, n: number, format: SoaExportFormat): Promise<SoaExport> {
  const u = me();
  if (!canExportEvidence(u)) forbid('export statements of applicability (who may export evidence packs)', 'exportEvidence');
  const { cat, soa } = soaOf(catalogueIdOrKey);
  const v = versionRow(soa, n);
  if (v.status !== 'approved' && v.status !== 'superseded')
    throw new HttpError(409, `Version ${n} is not approved`, 'SOA_VERSION_NOT_APPROVED', { number: n, status: v.status });
  const content = checkedContent(v);
  assertSeesAll(content, u, n);
  const base = `soa-${cat.key.replace(/[^A-Za-z0-9._-]+/g, '_')}-v${n}`;
  let out: SoaExport;
  if (format === 'pdf') out = { filename: `${base}.pdf`, contentType: 'application/pdf', body: archivedPdf(v) };
  else if (format === 'csv') out = { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(versionCsv(content), 'utf8') };
  else out = { filename: `${base}.zip`, contentType: 'application/zip', body: await signedZip(cat, v, content, u) };
  audit({
    action: 'soa.exported',
    entityType: 'soa',
    entityId: soa.id,
    summary: `Version ${n} of the statement of applicability for ${cat.key} exported (${format}, sha256 ${sha256(out.body).slice(0, 16)}…)`,
    details: { catalogue: cat.key, number: n, format, sha256: sha256(out.body), size: out.body.length, contentSha256: v.content_sha256 },
  });
  return out;
}

async function signedZip(cat: Catalogue, v: VersionRow, content: SoaVersionContent, u: AuthUser): Promise<Buffer> {
  const pub = vault().signingPublicKey();
  if (!vault().unlocked || !pub) throw new HttpError(423, 'The vault is locked or has no signing key', 'VAULT_LOCKED');
  const pdf = archivedPdf(v);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-soa-'));
  const file = path.join(dir, 'soa.zip');
  try {
    const zip = await ZipWriter.create(file, 256 * 1024 * 1024);
    const files = [
      await zip.add('soa.pdf', pdf, { compress: false }),
      await zip.add('soa.csv', Buffer.from(versionCsv(content), 'utf8'), { compress: true }),
      // byte for byte the stored content: its SHA-256 is the version's content_sha256
      await zip.add('soa.json', Buffer.from(v.content, 'utf8'), { compress: true }),
    ];
    const manifest: PackManifest = {
      format: EVIDENCE_PACK_FORMAT,
      version: 2,
      kind: SOA_MANIFEST_KIND,
      pack: {
        id: v.id,
        title: `Statement of applicability ${cat.key}, version ${Number(v.number)}`,
        from: v.submitted_at,
        to: v.decided_at ?? v.submitted_at,
        createdAt: nowIso(),
        createdBy: u.username,
        product: BRAND.name,
        productVersion: config.version,
        catalogue: content.catalogue,
        scope: content.scope,
        number: Number(v.number),
        contentSha256: v.content_sha256,
        submittedBy: v.submitted_by,
        approvedBy: v.decided_by,
        approvedAt: v.decided_at,
      },
      keyFingerprint: publicKeyFingerprint(pub),
      files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await zip.add('manifest.json', manifestBytes, { compress: true });
    // its own domain: a signed SoA is never taken for an evidence pack, nor the other way round
    await zip.add('manifest.sig', Buffer.from(vault().sign(Buffer.concat([Buffer.from(SOA_SIGNATURE_DOMAIN, 'utf8'), manifestBytes])) + '\n'), {
      compress: false,
    });
    await zip.add('public-key.pem', Buffer.from(publicKeyPem(pub)), { compress: false });
    await zip.finish();
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- for evidence packs and scheduled exports (ADR 0029 part 4) ----------

export interface ApprovedSoaFiles {
  catalogueId: string;
  catalogueKey: string;
  number: number;
  approvedAt: string;
  approvedBy: string;
  contentSha256: string;
  /** File names without extension: soa-<catalogue>-v<n> */
  base: string;
  /** The frozen content, byte for byte (its SHA-256 is contentSha256) */
  json: string;
  csv: string;
  /** The archived PDF in the data folder and its recorded SHA-256 (null: none recorded) */
  pdf: { file: string; sha256: string } | null;
  /** The version names suppliers or services `reader` may not see (always false without a reader) */
  hidden: boolean;
}

/**
 * The latest approved version of the SoA of each catalogue (`catalogueIds` narrows it) as files: the frozen JSON,
 * its CSV and the archived PDF. Catalogues without an approved version are left out. With a `reader` (evidence packs:
 * their creator), `hidden` says whether the version names suppliers or services the reader may not see – the files are
 * signed bytes that cannot be filtered, so the caller leaves them out then.
 *
 * `asOf` (an ISO time, 0.18.0): the version that was valid then instead – the one approved latest on or before it,
 * also when a later approval has superseded it since. An evidence pack of a past period holds the statement that was
 * in force at its end; a catalogue whose first approval came later is left out.
 */
export function latestApprovedFiles(catalogueIds?: readonly string[], reader?: AuthUser, asOf?: string): ApprovedSoaFiles[] {
  const out: ApprovedSoaFiles[] = [];
  for (const r of db().all<VersionRow & { key: string; catalogue_id: string }>(
    asOf === undefined
      ? `SELECT v.*, k.key, k.id AS catalogue_id FROM soa_versions v JOIN soas s ON s.id = v.soa_id JOIN control_catalogues k ON k.id = s.catalogue_id
         WHERE v.status = 'approved' ORDER BY k.key, v.number DESC`
      : `SELECT v.*, k.key, k.id AS catalogue_id FROM soa_versions v JOIN soas s ON s.id = v.soa_id JOIN control_catalogues k ON k.id = s.catalogue_id
         WHERE v.status IN ('approved', 'superseded') AND v.decided_at IS NOT NULL AND v.decided_at <= ? ORDER BY k.key, v.decided_at DESC, v.number DESC`,
    ...(asOf === undefined ? [] : [asOf]),
  )) {
    if (catalogueIds && !catalogueIds.includes(r.catalogue_id)) continue;
    if (out.some((x) => x.catalogueId === r.catalogue_id)) continue;
    const files = parseJson<{ pdf?: { path: string; sha256: string } }>(r.files, {});
    const file = files.pdf ? path.join(reportsDir(), files.pdf.path) : null;
    const inside = !!file && path.resolve(file).startsWith(path.resolve(reportsDir()) + path.sep);
    const content = checkedContent(r);
    out.push({
      catalogueId: r.catalogue_id,
      catalogueKey: r.key,
      number: Number(r.number),
      approvedAt: r.decided_at ?? r.submitted_at,
      approvedBy: r.decided_by ?? '',
      contentSha256: r.content_sha256,
      base: `soa-${r.key.replace(/[^A-Za-z0-9._-]+/g, '_')}-v${Number(r.number)}`,
      json: r.content,
      csv: versionCsv(content),
      pdf: inside && files.pdf ? { file: file!, sha256: files.pdf.sha256 } : null,
      hidden:
        !!reader &&
        (() => {
          const h = hiddenNamesOf(content, reader);
          return h.suppliers.size + h.services.size > 0;
        })(),
    });
  }
  return out;
}

/** The catalogues (of `catalogueIds`) whose SoA has an approved version now – evidence packs name those that had none at their period end. */
export function cataloguesWithApprovedSoa(catalogueIds: readonly string[]): { catalogueId: string; catalogueKey: string; firstApprovedAt: string }[] {
  if (!catalogueIds.length) return [];
  return db()
    .all<{ catalogue_id: string; key: string; first_at: string }>(
      `SELECT k.id AS catalogue_id, k.key, MIN(v.decided_at) AS first_at FROM soa_versions v JOIN soas s ON s.id = v.soa_id
       JOIN control_catalogues k ON k.id = s.catalogue_id WHERE v.status IN ('approved', 'superseded') AND v.decided_at IS NOT NULL
       AND k.id IN (${catalogueIds.map(() => '?').join(', ')}) GROUP BY k.id, k.key`,
      ...catalogueIds,
    )
    .map((r) => ({ catalogueId: r.catalogue_id, catalogueKey: r.key, firstApprovedAt: r.first_at }));
}

// ---------- for the ISMS summary (ADR 0029 part 4) and the dataset ----------

/**
 * The state of the SoA of a catalogue for summaries: counts, the latest approved version, a waiting one and the rows
 * changed since. null when the catalogue has no SoA. Read as Steward (jobs) or the reader – the counts name nothing.
 */
export function soaStatusOf(catalogueIdOrKey: string, now = Date.now()): SoaSummary | null {
  const c = findCatalogue(catalogueIdOrKey);
  if (!c) return null;
  const soa = db().get<SoaRow>('SELECT * FROM soas WHERE catalogue_id = ?', c.id);
  return soa ? summaryOf({ id: c.id, key: c.key, name: c.name, version: c.version }, soa, undefined, undefined, now) : null;
}

/** The decisions on SoA versions in a period (approved, returned), newest first – for summaries. */
export function soaDecisions(
  from: string,
  to: string,
): { catalogueKey: string; number: number; status: SoaVersionStatus; decidedAt: string; decidedBy: string; contentSha256: string }[] {
  return db()
    .all<{ key: string; number: number; status: SoaVersionStatus; decided_at: string; decided_by: string; content_sha256: string }>(
      `SELECT k.key, v.number, v.status, v.decided_at, v.decided_by, v.content_sha256 FROM soa_versions v JOIN soas s ON s.id = v.soa_id
       JOIN control_catalogues k ON k.id = s.catalogue_id WHERE v.decided_at IS NOT NULL AND v.decided_at >= ? AND v.decided_at <= ? ORDER BY v.decided_at DESC`,
      from,
      to,
    )
    .map((r) => ({
      catalogueKey: r.key,
      number: Number(r.number),
      status: r.status,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      contentSha256: r.content_sha256,
    }));
}

let lastPublished = 0;
const COLUMNS = ['Catalogue', 'Control', 'Title', 'Applicable', 'Status', 'Responsible party', 'Owner', 'Last review', 'Review due', 'No evidence', 'Changed'];

/**
 * The built-in dataset "Statement of applicability" (compliance.soa): one row per row of every SoA. It names
 * suppliers and owners, so administrators and auditors read it (like costs.plans). At most hourly, and only once
 * there is an SoA.
 */
export function publishSoaDataset(force = false, now = Date.now()): boolean {
  if (!force && now - lastPublished < 3600_000) return false;
  if (!db().get('SELECT id FROM soas LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', SOA_DATASET)) return false;
  lastPublished = now;
  const rows: DatasetRow[] = [];
  const metrics = { rows: 0, applicable: 0, implemented: 0, undecided: 0, reviewDue: 0, noEvidence: 0 };
  const cutoff = reviewCutoff(now);
  try {
    for (const soa of db().all<SoaRow>('SELECT * FROM soas')) {
      const k = db().get<Catalogue>('SELECT id, key, name, version FROM control_catalogues WHERE id = ?', soa.catalogue_id);
      if (!k) continue;
      const controls = controlsOf(k.id);
      const entries = entriesOf(soa.id);
      const mapped = mappedCounts(k.id);
      const changed = changedSince(soa, controls, entries);
      for (const c of controls) {
        const e = entries.get(c.id);
        const a = applicableOf(e);
        const due = reviewDueOf(e, cutoff);
        const none = noEvidenceOf(e, mapped.get(c.id) ?? 0);
        metrics.rows++;
        if (a) metrics.applicable++;
        if (a && e!.status === 'implemented') metrics.implemented++;
        if (!isDecided(e)) metrics.undecided++;
        if (due) metrics.reviewDue++;
        if (none) metrics.noEvidence++;
        rows.push({
          Catalogue: k.key,
          Control: c.ref,
          Title: c.title,
          Applicable: a === null ? '' : a ? 'yes' : 'no',
          Status: e?.status ?? '',
          'Responsible party': e?.party ?? '',
          Owner: e?.owner ?? '',
          'Last review': e?.reviewed_at ? e.reviewed_at.slice(0, 10) : '',
          'Review due': due ? 'yes' : 'no',
          'No evidence': none ? 'yes' : 'no',
          Changed: changed?.has(c.id) ? 'yes' : 'no',
          _key: `${k.key}:${c.id}`,
          _status: !isDecided(e) ? 'warning' : none ? 'serious' : 'good',
          _reason: !isDecided(e) ? 'Not decided' : none ? 'Implemented without evidence' : '',
        });
      }
    }
    publishDataset({
      key: SOA_DATASET,
      title: 'Statement of applicability',
      processId: 'compliance:soa',
      processName: 'Statement of applicability (built in)',
      runId: '',
      dryRun: false,
      columns: COLUMNS,
      rows,
      metrics,
      limits: {},
      staleAfterMinutes: 24 * 60 * 2,
      staleAfterFixed: true,
    });
  } catch (err) {
    logger.warn({ err }, 'statement of applicability: the dataset could not be published');
    return false;
  }
  return true;
}

/** The job of the SoA (Compliance module): the dataset, at most hourly. */
export async function runSoaJob(now = Date.now()): Promise<{ published: boolean }> {
  return { published: publishSoaDataset(false, now) };
}
