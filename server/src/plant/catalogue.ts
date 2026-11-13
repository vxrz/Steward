import type { z } from 'zod';
import {
  PLANT_DATA_LIMITS,
  type PlantAssetBrief,
  type PlantAssignmentValues,
  type PlantCheck,
  type PlantCataloguePermission,
  type PlantDataPointDetail,
  type PlantKpiDetail,
  type PlantKpiSummary,
  type PlantKpiValues,
  type PlantPointExplore,
  type PlantPointHit,
  type PlantProfileDetail,
  type PlantProfileSummary,
  type PlantProfileValues,
  type PlantResolvedProfile,
  type Translations,
} from '@sm/shared';
import { db } from '../db.js';
import { aliasTarget, refuseAliasId } from './ids.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { canManageCatalogue, plantProposesSome, siteRights } from './access.js';
import { requirePlant } from './settings.js';
import { changedKeys, type AssetRow, type SiteRow } from './model.js';
import {
  allAssignments,
  allKpis,
  allProfiles,
  kpiInput,
  kpiProblems,
  kpiRowOf,
  normalizeKpiInputs,
  kpiUpdate,
  kpiValuesOf,
  ownProfiles,
  pointsOf,
  profileInput,
  profileProblems,
  profileRowOf,
  profileUpdate,
  profileValuesOf,
  removeKpiRow,
  removeProfileRow,
  upsertKpi,
  upsertProfile,
} from './data-model.js';
import { assignmentChecks, canHave, deliveries, kpiChecks, kpiProfiles, namedInputPoints, readsProfile, unitMismatches } from './checks.js';
import { collectedPoints, isCollected, partsByAsset } from './potential.js';
import { descendantsOf, extendsProblems, isOrExtends, normalizeOwnPart, ownPartProblems, resolveAll, resolvedProblems } from './resolve.js';
import {
  HiddenRefs,
  catalogueScope,
  idUnavailable,
  keptInputs,
  keptRef,
  kpiRefs,
  presentInputs,
  presentKpis,
  presentProfiles,
  presentResolved,
  requireEntry,
  requireRight,
  type CatalogueScope,
} from './catalogue-access.js';
import { PLANT_HIDDEN } from '@sm/shared';

/**
 * The catalogues of part 2 (#219): device profiles and KPI definitions. They belong to the installation, not to a
 * site: without owning teams everyone who may see the plant registry sees them (the role "plant" included), whoever
 * may add sites manages them (designers and administrators). Since 0.21.0 (#293) an entry may have owning teams and
 * shares (plant/catalogue-access.ts): an entry the reader may not see is left out of lists (and counted), answers 404
 * like an unknown one, and is not named where a visible entry or asset names it. Counts and lists of assets in them
 * show only assets of sites the reader may see. Every change is audited (entity types device_profile and kpi_definition).
 */

// ---------- the assets the reader may see ----------

export interface Visible {
  assets: Map<string, AssetRow>;
  sites: Map<string, SiteRow>;
  briefs: Map<string, PlantAssetBrief>;
}

/** The assets of the sites the caller may see, read once. */
export function visibleAssets(): Visible {
  const sites = db().all<SiteRow>('SELECT id, code, name, names, acl FROM plant_sites');
  const rights = siteRights(sites);
  const siteById = new Map(sites.filter((s) => rights.get(s.id)!.includes('view')).map((s) => [s.id, s]));
  const assets = new Map(
    db()
      .all<AssetRow>('SELECT id, name, status, site_id FROM plant_assets ORDER BY name, id')
      .filter((a) => siteById.has(a.site_id))
      .map((a) => [a.id, a]),
  );
  const briefs = new Map([...assets.values()].map((a) => [a.id, briefOf(a, siteById.get(a.site_id)!)]));
  return { assets, sites: siteById, briefs };
}

export const briefOf = (a: Pick<AssetRow, 'id' | 'name' | 'status' | 'site_id'>, s: Pick<SiteRow, 'id' | 'name' | 'names' | 'code'>): PlantAssetBrief => ({
  id: a.id,
  name: a.name,
  status: a.status,
  siteId: a.site_id,
  site: { id: s.id, name: s.name, names: parseJson<Translations>(s.names, {}), code: s.code },
});

function requireCatalogue(what: string): string {
  requirePlant();
  const u = me();
  if (!canManageCatalogue(u)) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: 'managePlantCatalogue' });
  return u.username;
}

/** An existing entry the caller may see (404 like an unknown one otherwise) and may change as `need` says (403). */
function requireEntryRight(
  scope: CatalogueScope,
  kind: 'device_profile' | 'kpi_definition',
  id: string,
  need: PlantCataloguePermission,
  what: string,
): string {
  requirePlant();
  const u = me();
  const rights = requireEntry(scope, kind, id, kind === 'device_profile' ? profileNotFound : kpiNotFound);
  requireRight(rights, need, what);
  return u.username;
}

function invalid(kind: 'profile' | 'kpi', problems: { path: string; message: string }[]): HttpError {
  const { path, message } = problems[0]!;
  if (kind === 'profile') return new HttpError(400, `${path}: ${message}`, 'PLANT_PROFILE_INVALID', { path, message });
  return new HttpError(400, `${path}: ${message}`, 'PLANT_KPI_INVALID', { path, message });
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

// ---------- device profiles ----------

/** A new entry's id that is taken: named when the caller sees the entry that has it, neutral otherwise (0.21.0). */
function idTaken(kind: 'profile' | 'kpi', id: string, visible: boolean): HttpError {
  if (!visible) return idUnavailable(id);
  return new HttpError(409, `A ${kind === 'profile' ? 'device profile' : 'KPI definition'} with the id ${id} exists already`, 'PLANT_ID_TAKEN', { id });
}

/** An old id of a renamed entry still leads there (0.11.0): it is not free – said neutrally when the entry is hidden. */
function refuseCatalogueAlias(kind: 'profile' | 'kpi', id: string, scope: CatalogueScope): void {
  const to = aliasTarget(kind, '', id);
  if (to && !(kind === 'profile' ? scope.profile(to) : scope.kpi(to))) throw idUnavailable(id);
  refuseAliasId(kind, '', id);
}

export function profileNotFound(id: string): HttpError {
  return new HttpError(404, `Device profile ${id} not found`, 'PLANT_PROFILE_NOT_FOUND', { id });
}

const countPoints = (p: Pick<PlantProfileValues, 'interfaces'>) => pointsOf(p).length;

function profileSummary(
  r: PlantResolvedProfile & { importId: string | null; notInSource: boolean; updatedAt: string },
  assetCount: number,
): PlantProfileSummary {
  return {
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    model: r.model,
    version: r.version,
    category: r.category,
    protocols: [...new Set(r.interfaces.map((i) => i.protocol))],
    interfaceCount: r.interfaces.length,
    dataPointCount: countPoints(r),
    assetCount,
    extends: r.extends,
    template: r.template,
    importId: r.importId,
    notInSource: r.notInSource,
    updatedAt: r.updatedAt,
  };
}

/** Visible assets per profile id. */
function assetsByProfile(v: Visible): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db().all<{ asset_id: string; profile_id: string }>('SELECT asset_id, profile_id FROM plant_assignments WHERE profile_id IS NOT NULL'))
    if (v.assets.has(r.asset_id)) out.set(r.profile_id, [...(out.get(r.profile_id) ?? []), r.asset_id]);
  return out;
}

/** The device profiles the caller may see (0.21.0: entries of other teams are counted – GET /plant/catalogue/hidden). */
export function listProfiles(scope: CatalogueScope = catalogueScope()): PlantProfileSummary[] {
  requirePlant();
  const v = visibleAssets();
  const using = assetsByProfile(v);
  const rows = db().all<import('./data-model.js').ProfileRow>('SELECT * FROM plant_profiles ORDER BY name, id');
  const resolved = resolveAll(new Map(rows.map((r) => [r.id, profileValuesOf(r)])));
  return rows
    .filter((r) => scope.profile(r.id))
    .map((r) => {
      // a base the caller may not see: its placeholder (part 4)
      const x = resolved.get(r.id)!;
      const values = x.extends && !scope.profile(x.extends) ? { ...x, extends: new HiddenRefs(scope.profile, [x.extends]).ref(x.extends) } : x;
      return profileSummary({ ...values, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, (using.get(r.id) ?? []).length);
    });
}

export function getProfile(id: string, scope: CatalogueScope = catalogueScope()): PlantProfileDetail {
  requirePlant();
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  const rights = requireEntry(scope, 'device_profile', id, profileNotFound);
  const own = ownProfiles();
  const resolved = resolveAll(own);
  const whole = resolved.get(id)!;
  // part 4: bases the caller may not see stay its model, unnamed ("Inherited from a base profile you may not see")
  const refs = new HiddenRefs(scope.profile, whole.chain.slice(1));
  const values = presentResolved(whole, refs);
  const v = visibleAssets();
  const assets = (assetsByProfile(v).get(id) ?? []).map((a) => v.briefs.get(a)!).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  // a KPI that reads a base profile reads this one, too (0.11.0); 0.13: any of an input's profiles, with its mapping
  const kpis = [...allKpis().values()]
    .filter((k) => scope.kpi(k.id))
    .map((k) => ({
      id: k.id,
      name: k.name,
      names: k.names,
      dataPoints: namedInputPoints(k, whole),
      reads: readsProfile(k, whole),
    }))
    .filter((k) => k.reads)
    .map(({ reads: _r, ...k }) => k);
  const base = whole.extends ? resolved.get(whole.extends) : undefined;
  const bases = whole.chain
    .slice(1)
    .map((b) => (refs.hides(b) ? { id: refs.ref(b), name: PLANT_HIDDEN, exists: true, hidden: true } : { id: b, name: own.get(b)?.name ?? b, exists: true }));
  if (whole.extends && !base) bases.push({ id: whole.extends, name: whole.extends, exists: false });
  const ownPart = own.get(id)!;
  return {
    ...profileSummary({ ...values, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, assets.length),
    description: values.description,
    descriptionFrom: values.descriptionFrom,
    notes: values.notes,
    interfaces: values.interfaces,
    own: { ...ownPart, extends: refs.ref(ownPart.extends) },
    bases,
    base: base ? { id: refs.ref(base.id), name: refs.hides(base.id) ? PLANT_HIDDEN : base.name, interfaces: base.interfaces } : null,
    origins: values.origins,
    notPresent: values.notPresent,
    unusedOverrides: values.unusedOverrides,
    // 0.21.0: profiles the caller may not see that extend it are counted, not named
    extendedBy: [...own.values()].filter((x) => x.extends === id && x.id !== id && scope.profile(x.id)).map((x) => ({ id: x.id, name: x.name })),
    extendedByHidden: [...own.values()].filter((x) => x.extends === id && x.id !== id && !scope.profile(x.id)).length,
    assets,
    kpis,
    canManage: rights.includes('edit'),
    // 0.13.0: who may propose keeps drafts of changes to it (0.21.0: on this entry – its owning teams and shares)
    canPropose: rights.includes('propose'),
    permissions: [...rights],
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

/**
 * Profile values from the API's input (groups without data points and names are kept as given), checked: its own
 * rules, its base (exists, no cycle) and – for a base – that every profile extending it still resolves (0.11.0).
 */
function profileValues(id: string, b: z.infer<typeof profileUpdate>, scope: CatalogueScope): PlantProfileValues {
  const own = ownProfiles();
  // 0.21.0 (#293): a base the caller may not see is kept as its placeholder; choosing one anew reads like an unknown one
  const stored = own.get(id);
  const refs = new HiddenRefs(scope.profile, stored ? (resolveAll(own).get(id)?.chain.slice(1) ?? []) : []);
  const v: PlantProfileValues = { id, ...b, extends: b.extends ? keptRef(b.extends, refs, scope.profile, profileNotFound) : null };
  return checkedProfile(v, own, (problems) => {
    // a message naming a profile the caller may not see (a base, a profile that extends this one) names its placeholder
    throw invalid(
      'profile',
      problems.map((x) => ({ path: x.path, message: hideDescendants(refs.redact(x.message), own, scope) })),
    );
  });
}

/** `Device profile "<id>" extends this one: …` for a profile the caller may not see: "A device profile you may not see …". */
function hideDescendants(message: string, own: Map<string, PlantProfileValues>, scope: CatalogueScope): string {
  const m = /^Device profile "([^"]+)" extends this one: (.*)$/s.exec(message);
  return m && own.has(m[1]!) && !scope.profile(m[1]!) ? `A device profile you may not see extends this one: ${m[2]}` : message;
}

/** The rules of a profile's save against the other profiles (`own`, which gets the profile); returns it normalised. */
export function checkedProfile(
  v: PlantProfileValues,
  own: Map<string, PlantProfileValues>,
  fail: (problems: { path: string; message: string }[]) => void,
): PlantProfileValues {
  own.set(v.id, v);
  const ext = extendsProblems(v.id, v.extends, own);
  if (ext.length) {
    fail(ext);
    return v;
  }
  const base = v.extends ? (resolveAll(own).get(v.extends) ?? null) : null;
  const normalized = normalizeOwnPart(v, base);
  const problems = v.extends ? ownPartProblems(normalized, base) : [...ownPartProblems(v, null), ...profileProblems(v)];
  if (problems.length) {
    fail(problems);
    return v;
  }
  own.set(v.id, normalized);
  const below = descendantsOf(v.id, own);
  if (below.length) {
    const after = resolveAll(own);
    for (const d of below) {
      const pr = resolvedProblems(after.get(d)!);
      if (pr.length) {
        fail([{ path: 'interfaces', message: `Device profile "${d}" extends this one: ${pr[0]!.message}` }]);
        break;
      }
    }
  }
  return normalized;
}

export function createProfile(input: z.infer<typeof profileInput>): PlantProfileDetail {
  const by = requireCatalogue('add device profiles');
  const scope = catalogueScope();
  // an id taken by an entry the caller may not see is refused neutrally (part 4: "This id cannot be used")
  if (profileRowOf(input.id)) throw idTaken('profile', input.id, scope.profile(input.id));
  refuseCatalogueAlias('profile', input.id, scope);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_profiles')!.n) >= PLANT_DATA_LIMITS.profiles)
    throw new HttpError(409, `At most ${PLANT_DATA_LIMITS.profiles} device profiles`, 'PLANT_LIMIT', { max: PLANT_DATA_LIMITS.profiles });
  const { id, ...rest } = input;
  const v = profileValues(id, rest, scope);
  db().tx(() => {
    // decision 9: a new profile belongs to no team, whoever adds it (like suppliers); teams restrict it deliberately
    upsertProfile(v, { at: nowIso(), by });
    audit({
      action: 'device_profile.created',
      entityType: 'device_profile',
      entityId: v.id,
      summary: `Device profile "${v.name}" (${v.id}) added with ${v.interfaces.length} interfaces and ${countPoints(v)} data points`,
      details: { manufacturer: v.manufacturer, model: v.model, interfaces: v.interfaces.map((i) => i.id) },
    });
  });
  return getProfile(v.id);
}

/** What changed in a profile, for the audit entry: its own keys, and interfaces and data points by id. */
function profileChanges(before: PlantProfileValues, after: PlantProfileValues) {
  const keys = changedKeys(before, after, ['interfaces']);
  const bi = new Map(before.interfaces.map((i) => [i.id, i]));
  const ai = new Map(after.interfaces.map((i) => [i.id, i]));
  const bp = new Map(pointsOf(before).map((x) => [x.point.id, x]));
  const ap = new Map(pointsOf(after).map((x) => [x.point.id, x]));
  const ifaces = {
    added: [...ai.keys()].filter((k) => !bi.has(k)),
    removed: [...bi.keys()].filter((k) => !ai.has(k)),
    changed: [...ai.keys()].filter((k) => bi.has(k) && JSON.stringify({ ...bi.get(k), groups: [] }) !== JSON.stringify({ ...ai.get(k), groups: [] })),
  };
  const points = {
    added: [...ap.keys()].filter((k) => !bp.has(k)),
    removed: [...bp.keys()].filter((k) => !ap.has(k)),
    changed: [...ap.keys()].filter((k) => {
      const b = bp.get(k);
      const a = ap.get(k)!;
      return !!b && (JSON.stringify(b.point) !== JSON.stringify(a.point) || b.group !== a.group || b.iface.id !== a.iface.id);
    }),
  };
  const any = keys.length || Object.values(ifaces).some((x) => x.length) || Object.values(points).some((x) => x.length);
  // the order of interfaces or groups alone is a change, too
  const reordered = !any && JSON.stringify(before.interfaces) !== JSON.stringify(after.interfaces);
  return { keys: reordered ? [...keys, 'interfaces'] : keys, ifaces, points, changed: !!any || reordered };
}

export function updateProfile(id: string, input: z.infer<typeof profileUpdate>): PlantProfileDetail {
  const scope = catalogueScope();
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  const by = requireEntryRight(scope, 'device_profile', id, 'edit', 'change this device profile');
  const before = profileValuesOf(r);
  const v = profileValues(id, input, scope);
  if (v.template && !before.template) refuseTemplateInUse(id);
  const c = profileChanges(before, v);
  if (!c.changed) return getProfile(id);
  db().tx(() => {
    upsertProfile(v, { at: nowIso(), by }, { keepSource: true });
    const parts = [
      ...c.keys,
      ...(c.ifaces.added.length + c.ifaces.removed.length + c.ifaces.changed.length ? ['interfaces'] : []),
      ...(c.points.added.length + c.points.removed.length + c.points.changed.length ? ['data points'] : []),
    ];
    audit({
      action: 'device_profile.updated',
      entityType: 'device_profile',
      entityId: id,
      summary: `Device profile "${v.name}" changed (${[...new Set(parts)].join(', ')})`,
      details: { changes: c.keys, old: pick(before, c.keys), new: pick(v, c.keys), interfaces: c.ifaces, dataPoints: c.points },
    });
  });
  return getProfile(id);
}

/**
 * 0.12.0: a profile that assets have cannot become a template – with the count only when the caller sees every asset
 * that has it (as deleteProfile).
 */
function refuseTemplateInUse(id: string): void {
  const users = db().all<{ asset_id: string }>('SELECT asset_id FROM plant_assignments WHERE profile_id = ?', id);
  if (!users.length) return;
  const seen = visibleAssets().assets;
  if (users.some((u) => !seen.has(u.asset_id)))
    throw new HttpError(409, 'Assets have the profile – it cannot become a template', 'PLANT_PROFILE_TEMPLATE_IN_USE_HIDDEN');
  throw new HttpError(
    409,
    `${users.length} assets have the profile – give them another profile (one that extends it) before it becomes a template`,
    'PLANT_PROFILE_TEMPLATE_IN_USE',
    { count: users.length },
  );
}

export function deleteProfile(id: string): void {
  const scope = catalogueScope();
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  const by = requireEntryRight(scope, 'device_profile', id, 'manage', 'delete this device profile');
  // an assignment names it: refused – with the count only when the caller sees every asset that has it
  const users = db().all<{ asset_id: string }>('SELECT asset_id FROM plant_assignments WHERE profile_id = ?', id);
  // a base that another profile extends stays (like a profile in use)
  const children = db().all<{ id: string; name: string }>('SELECT id, name FROM plant_profiles WHERE base_id = ? AND id <> ? ORDER BY name, id', id, id);
  if (children.length) {
    // profiles the caller may not see are counted, not named (0.21.0)
    const named = children.filter((c) => scope.profile(c.id));
    const hidden = children.length - named.length;
    const list = [...named.map((c) => `"${c.name}"`), ...(hidden ? [`${hidden} device profile(s) you may not see`] : [])].join(', ');
    throw new HttpError(409, `The profile is extended by ${list} – change or delete those first`, 'PLANT_PROFILE_EXTENDED', {
      count: children.length,
      profiles: named.map((c) => c.id).join(', '),
    });
  }
  // 0.12: records link to it – the removal core takes them along only when asked ("also remove what belongs to it")
  const links = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM item_links WHERE to_kind = 'device-profile' AND to_id = ?", id)?.n ?? 0);
  if (links)
    throw new HttpError(
      409,
      `${links} records link to the profile – remove the links first, or remove it with "Remove selected" and what belongs to it`,
      'PLANT_PROFILE_LINKED',
      {
        count: links,
      },
    );
  if (users.length) {
    const seen = visibleAssets().assets;
    if (users.some((u) => !seen.has(u.asset_id))) throw new HttpError(409, 'The profile is in use – it cannot be deleted', 'PLANT_PROFILE_IN_USE_HIDDEN');
    throw new HttpError(409, `The profile is assigned to ${users.length} assets – remove those assignments first`, 'PLANT_PROFILE_IN_USE', {
      count: users.length,
    });
  }
  db().tx(() => {
    removeProfileRow(id);
    audit({
      action: 'device_profile.deleted',
      entityType: 'device_profile',
      entityId: id,
      summary: `Device profile "${r.name}" (${id}) deleted`,
      details: { by },
    });
  });
}

export function pointNotFound(id: string): HttpError {
  return new HttpError(404, `Data point ${id} not found`, 'PLANT_POINT_NOT_FOUND', { id });
}

/** A data point of a profile, and which assets (that the caller may see) deliver it. */
export function getDataPoint(profileId: string, pointId: string, scope: CatalogueScope = catalogueScope()): PlantDataPointDetail {
  requirePlant();
  if (!profileRowOf(profileId)) throw profileNotFound(profileId);
  requireEntry(scope, 'device_profile', profileId, profileNotFound);
  const profiles = allProfiles();
  const p = profiles.get(profileId)!;
  const refs = new HiddenRefs(scope.profile, p.chain.slice(1));
  const found = pointsOf(p).find((x) => x.point.id === pointId);
  if (!found) throw pointNotFound(pointId);
  const v = visibleAssets();
  const assignments = allAssignments();
  const assets: PlantDataPointDetail['assets'] = [];
  for (const [assetId, a] of assignments) {
    const brief = v.briefs.get(assetId);
    // assets of a profile that extends this one deliver its data points, too (unless that profile drops it)
    const theirs = a.profileId ? profiles.get(a.profileId) : undefined;
    if (!brief || !theirs || !isOrExtends(theirs, profileId)) continue;
    const d = deliveries(a, theirs).get(pointId);
    if (!d) continue;
    assets.push({
      asset: brief,
      delivers: d.delivers,
      reason: d.reason,
      endpoint: d.endpoint,
      override: a.overrides.find((o) => o.dataPoint === pointId) ?? null,
      publications: a.publications.filter((x) => x.dataPoint === pointId),
    });
  }
  assets.sort((a, b) => Number(b.delivers) - Number(a.delivers) || a.asset.name.localeCompare(b.asset.name) || a.asset.id.localeCompare(b.asset.id));
  const kpis = [...allKpis().values()]
    .filter((k) => scope.kpi(k.id) && namedInputPoints(k, p).includes(pointId))
    .map((k) => ({ id: k.id, name: k.name, names: k.names }));
  return {
    profile: { id: p.id, name: p.name, manufacturer: p.manufacturer, model: p.model },
    interface: { id: found.iface.id, name: found.iface.name, protocol: found.iface.protocol, direction: found.iface.direction },
    group: found.group,
    point: found.point,
    // a base the caller may not see: "Inherited from a base profile you may not see" (part 4)
    origin: presentResolved(p, refs).origins.points[pointId] ?? { kind: 'own', from: p.id, fields: [], changedBy: [], descriptionFrom: p.id },
    assets,
    kpis,
  };
}

/**
 * Data points across every profile the caller may see whose id, name, address or description contains the text (no
 * pattern: a plain match). 0.21.0: profiles the caller may not see are left out – counted by hiddenPointMatches().
 */
export function explorePoints(q: string, scope: CatalogueScope = catalogueScope()): PlantPointHit[] {
  return pointSearch(q, scope).hits;
}

/** How many profiles the caller may not see have data points that match (GET /plant/catalogue/hidden?q=). */
export const hiddenPointMatches = (q: string, scope: CatalogueScope = catalogueScope()): number => pointSearch(q, scope).hiddenProfiles;

function pointSearch(q: string, scope: CatalogueScope): PlantPointExplore {
  requirePlant();
  const needle = q.trim().toLowerCase();
  if (!needle) return { hits: [], hiddenProfiles: 0 };
  const v = visibleAssets();
  const assignments = [...allAssignments()].filter(([id]) => v.assets.has(id));
  const out: PlantPointHit[] = [];
  const matches = (point: { id: string; name: string; address: string; description: string }) =>
    [point.id, point.name, point.address, point.description].some((x) => x.toLowerCase().includes(needle));
  let hiddenProfiles = 0;
  for (const p of allProfiles().values()) {
    if (!scope.profile(p.id)) {
      if (pointsOf(p).some((x) => matches(x.point))) hiddenProfiles++;
      continue;
    }
    const using = assignments.filter(([, a]) => a.profileId === p.id).map(([, a]) => deliveries(a, p));
    for (const { iface, group, point } of pointsOf(p)) {
      if (!matches(point)) continue;
      out.push({
        profile: { id: p.id, name: p.name },
        interface: { id: iface.id, name: iface.name, protocol: iface.protocol },
        group,
        point: { id: point.id, name: point.name, dataType: point.dataType, unit: point.unit, address: point.address },
        deliveredBy: using.filter((d) => d.get(point.id)?.delivers).length,
      });
      if (out.length >= 500) return { hits: out, hiddenProfiles };
    }
  }
  return { hits: out, hiddenProfiles };
}

// ---------- KPI definitions ----------

export function kpiNotFound(id: string): HttpError {
  return new HttpError(404, `KPI definition ${id} not found`, 'PLANT_KPI_NOT_FOUND', { id });
}

function kpiSummary(
  k: PlantKpiValues & { importId: string | null; notInSource: boolean; updatedAt: string },
  instanceCount: number,
  problemCount: number,
  refs: HiddenRefs,
): PlantKpiSummary {
  return {
    id: k.id,
    name: k.name,
    names: k.names,
    category: k.category,
    unit: k.unit,
    trend: k.trend,
    profiles: kpiProfiles(k).map((p) => refs.ref(p)),
    parameterCount: k.parameters.length,
    columnCount: k.columns.length,
    instanceCount,
    problemCount,
    importId: k.importId,
    notInSource: k.notInSource,
    updatedAt: k.updatedAt,
  };
}

/** The KPI definitions the caller may see (0.21.0: others are counted – GET /plant/catalogue/hidden). */
export function listKpis(scope: CatalogueScope = catalogueScope()): PlantKpiSummary[] {
  requirePlant();
  const v = visibleAssets();
  const profiles = allProfiles();
  const counts = new Map<string, number>();
  for (const [assetId, a] of allAssignments()) if (v.assets.has(assetId)) for (const k of a.kpis) counts.set(k.kpi, (counts.get(k.kpi) ?? 0) + 1);
  return db()
    .all<import('./data-model.js').KpiRow>('SELECT * FROM plant_kpis ORDER BY name, id')
    .filter((r) => scope.kpi(r.id))
    .map((r) => {
      const k = kpiValuesOf(r);
      return kpiSummary(
        { ...k, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at },
        counts.get(k.id) ?? 0,
        kpiChecks(k, profiles).length,
        kpiRefs(k, scope),
      );
    });
}

export function getKpi(id: string, scope: CatalogueScope = catalogueScope()): PlantKpiDetail {
  requirePlant();
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
  const rights = requireEntry(scope, 'kpi_definition', id, kpiNotFound);
  const k = kpiValuesOf(r);
  const whole = allProfiles();
  // checks name profiles the caller may not see as "~hidden" (part 4); the computation reads every profile
  const profiles = presentProfiles(whole, scope);
  const refs = kpiRefs(k, scope);
  const kpis = new Map([[k.id, k]]);
  const v = visibleAssets();
  const instances: PlantKpiDetail['instances'] = [];
  const candidates: PlantKpiDetail['candidates'] = [];
  const candidateInfo: NonNullable<PlantKpiDetail['candidateInfo']> = {};
  const collected = collectedPoints();
  for (const [assetId, a] of allAssignments()) {
    const brief = v.briefs.get(assetId);
    if (!brief) continue;
    const mine = a.kpis.filter((x) => x.kpi === id);
    const profile = a.profileId ? profiles.get(a.profileId) : undefined;
    if (mine.length) {
      const checks = assignmentChecks({ kind: 'asset', id: assetId, name: brief.name, siteId: brief.siteId }, { ...a, kpis: mine }, profiles, kpis).filter(
        (c) => c.job !== undefined,
      );
      for (const x of mine) instances.push({ asset: brief, job: x.job, active: x.active, problems: checks.filter((c) => c.job === x.job).length });
    } else if (canHave(k, a, profile)) {
      candidates.push(brief);
      // 0.12.0: KPI potential – whether its data is collected already, and inputs in another unit
      candidateInfo[assetId] = { collected: isCollected(k, collected.get(assetId), profile), units: unitMismatches(k, a, profile, profiles) };
    }
  }
  // 0.13: a KPI that rolls up from parts – an asset without an instance whose part could have it (or has one) counts
  if (k.rollUp === 'parts') {
    const withJob = new Set(instances.map((x) => x.asset.id));
    const could = new Set(candidates.map((x) => x.id));
    for (const [assetId, parts] of partsByAsset(new Set(v.assets.keys()))) {
      if (withJob.has(assetId) || could.has(assetId) || parts.some((p) => withJob.has(p.id))) continue;
      const part = parts.find((p) => candidateInfo[p.id]?.collected) ?? parts.find((p) => could.has(p.id));
      if (!part) continue;
      candidates.push(v.briefs.get(assetId)!);
      candidateInfo[assetId] = { ...candidateInfo[part.id]!, via: part };
    }
  }
  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  instances.sort((a, b) => byName(a.asset, b.asset) || a.job.localeCompare(b.job));
  candidates.sort(byName);
  const checks = kpiChecks(k, profiles);
  const profileNames: Record<string, string | null> = Object.fromEntries(kpiProfiles(k).map((p) => [refs.ref(p), profiles.get(p)?.name ?? null]));
  return {
    ...k,
    inputs: presentInputs(k, refs),
    ...kpiSummary({ ...k, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, instances.length, checks.length, refs),
    profileNames,
    checks,
    instances,
    candidates,
    candidateInfo,
    canManage: rights.includes('edit'),
    canPropose: rights.includes('propose'),
    permissions: [...rights],
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

function kpiValues(id: string, b: z.infer<typeof kpiUpdate>, scope: CatalogueScope): PlantKpiValues {
  const stored = kpiRowOf(id);
  const v: PlantKpiValues = { id, ...b, inputs: keptInputs(b.inputs, stored ? kpiValuesOf(stored) : null, scope, profileNotFound) };
  // 0.13: a mapping to a data point a profile lacks is refused – naming a profile the caller may not see by its placeholder
  const problems = kpiProblems(v, presentProfiles(allProfiles(), scope));
  if (problems.length) {
    const refs = kpiRefs(v, scope);
    throw invalid(
      'kpi',
      problems.map((x) => ({ path: x.path, message: refs.redact(x.message) })),
    );
  }
  return { ...v, inputs: normalizeKpiInputs(v.inputs) };
}

export function createKpi(input: z.infer<typeof kpiInput>): PlantKpiDetail {
  const by = requireCatalogue('add KPI definitions');
  const scope = catalogueScope();
  if (kpiRowOf(input.id)) throw idTaken('kpi', input.id, scope.kpi(input.id));
  refuseCatalogueAlias('kpi', input.id, scope);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_kpis')!.n) >= PLANT_DATA_LIMITS.kpis)
    throw new HttpError(409, `At most ${PLANT_DATA_LIMITS.kpis} KPI definitions`, 'PLANT_LIMIT', { max: PLANT_DATA_LIMITS.kpis });
  const { id, ...rest } = input;
  const v = kpiValues(id, rest, scope);
  db().tx(() => {
    // decision 9: a new KPI definition belongs to no team, whoever adds it
    upsertKpi(v, { at: nowIso(), by });
    audit({
      action: 'kpi_definition.created',
      entityType: 'kpi_definition',
      entityId: v.id,
      summary: `KPI definition "${v.name}" (${v.id}) added with ${v.inputs.length} inputs, ${v.parameters.length} parameters and ${v.columns.length} columns`,
      details: { category: v.category, profiles: kpiProfiles(v) },
    });
  });
  return getKpi(v.id);
}

export function updateKpi(id: string, input: z.infer<typeof kpiUpdate>): PlantKpiDetail {
  const scope = catalogueScope();
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
  const by = requireEntryRight(scope, 'kpi_definition', id, 'edit', 'change this KPI definition');
  const before = kpiValuesOf(r);
  const v = kpiValues(id, input, scope);
  const changes = changedKeys(before, v);
  if (!changes.length) return getKpi(id);
  db().tx(() => {
    upsertKpi(v, { at: nowIso(), by }, { keepSource: true });
    audit({
      action: 'kpi_definition.updated',
      entityType: 'kpi_definition',
      entityId: id,
      summary: `KPI definition "${v.name}" changed (${changes.join(', ')})`,
      details: { changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return getKpi(id);
}

export function deleteKpi(id: string): void {
  const scope = catalogueScope();
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
  requireEntryRight(scope, 'kpi_definition', id, 'manage', 'delete this KPI definition');
  const v = visibleAssets();
  const users = [...allAssignments()].filter(([, a]) => a.kpis.some((k) => k.kpi === id));
  // with the count only when the caller sees every asset that has an instance (see deleteProfile)
  if (users.length) {
    if (users.some(([assetId]) => !v.assets.has(assetId)))
      throw new HttpError(409, 'The KPI definition is in use – it cannot be deleted', 'PLANT_KPI_IN_USE_HIDDEN');
    throw new HttpError(409, `${users.length} assets have a KPI instance of it – remove those first`, 'PLANT_KPI_IN_USE', { count: users.length });
  }
  db().tx(() => {
    removeKpiRow(id);
    audit({ action: 'kpi_definition.deleted', entityType: 'kpi_definition', entityId: id, summary: `KPI definition "${r.name}" (${id}) deleted` });
  });
}

// ---------- checks ----------

/** A check with the KPI definition it concerns: an asset check of a KPI instance names the instance's definition. */
export type CheckWithKpi = PlantCheck & { kpiId: string | null };

/**
 * Every check of the assets the caller may see (by asset name) and then of the KPI definitions they may see (by name),
 * unlimited. 0.21.0: a check naming a profile or KPI definition the caller may not see names it "~hidden"; `kpiId` is
 * then null (the instance's definition is not named).
 */
export function allChecks(scope: CatalogueScope = catalogueScope()): CheckWithKpi[] {
  requirePlant();
  const v = visibleAssets();
  const profiles = presentProfiles(allProfiles(), scope);
  const kpis = presentKpis(allKpis(), scope);
  const out: CheckWithKpi[] = [];
  const assignments: [string, PlantAssignmentValues][] = [...allAssignments()].filter(([id]) => v.assets.has(id));
  assignments.sort(([a], [b]) => v.briefs.get(a)!.name.localeCompare(v.briefs.get(b)!.name) || a.localeCompare(b));
  for (const [assetId, a] of assignments) {
    const b = v.briefs.get(assetId)!;
    const kpiOfJob = new Map(a.kpis.map((k) => [k.job, k.kpi]));
    for (const c of assignmentChecks({ kind: 'asset', id: assetId, name: b.name, siteId: b.siteId }, a, profiles, kpis))
      out.push({ ...c, kpiId: c.job !== undefined ? (scopeKpi(scope, kpiOfJob.get(c.job)) ?? null) : null });
  }
  for (const k of kpis.values()) if (scope.kpi(k.id)) for (const c of kpiChecks(k, profiles)) out.push({ ...c, kpiId: k.id });
  return out;
}

/** A KPI definition's id when the caller may see it. */
const scopeKpi = (scope: CatalogueScope, id: string | undefined): string | undefined => (id && scope.kpi(id) ? id : undefined);

/** Every check of the assets the caller may see and of the KPI definitions: Plant → Checks. */
export function listChecks(): PlantCheck[] {
  return allChecks()
    .slice(0, 2000)
    .map(({ kpiId: _k, ...c }) => c);
}

export { profileInput, profileUpdate, kpiInput, kpiUpdate };
