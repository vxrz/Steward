import type { z } from 'zod';
import {
  PLANT_DATA_LIMITS,
  type PlantAssetBrief,
  type PlantAssignmentValues,
  type PlantCheck,
  type PlantDataPointDetail,
  type PlantKpiDetail,
  type PlantKpiSummary,
  type PlantKpiValues,
  type PlantPointHit,
  type PlantProfileDetail,
  type PlantProfileSummary,
  type PlantProfileValues,
  type PlantResolvedProfile,
  type Translations,
} from '@sm/shared';
import { db } from '../db.js';
import { refuseAliasId } from './ids.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { canManageCatalogue, siteRights } from './access.js';
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

/**
 * The catalogues of part 2 (#219): device profiles and KPI definitions. They belong to the installation, not to a
 * site: everyone who may see the plant registry sees them (the role "plant" included), whoever may add sites manages
 * them (designers and administrators). Counts and lists of assets in them show only assets of sites the reader may
 * see. Every change is audited (entity types device_profile and kpi_definition).
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

function invalid(kind: 'profile' | 'kpi', problems: { path: string; message: string }[]): HttpError {
  const { path, message } = problems[0]!;
  if (kind === 'profile') return new HttpError(400, `${path}: ${message}`, 'PLANT_PROFILE_INVALID', { path, message });
  return new HttpError(400, `${path}: ${message}`, 'PLANT_KPI_INVALID', { path, message });
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

// ---------- device profiles ----------

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

export function listProfiles(): PlantProfileSummary[] {
  requirePlant();
  const v = visibleAssets();
  const using = assetsByProfile(v);
  const rows = db().all<import('./data-model.js').ProfileRow>('SELECT * FROM plant_profiles ORDER BY name, id');
  const resolved = resolveAll(new Map(rows.map((r) => [r.id, profileValuesOf(r)])));
  return rows.map((r) =>
    profileSummary({ ...resolved.get(r.id)!, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, (using.get(r.id) ?? []).length),
  );
}

export function getProfile(id: string): PlantProfileDetail {
  requirePlant();
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  const own = ownProfiles();
  const resolved = resolveAll(own);
  const values = resolved.get(id)!;
  const v = visibleAssets();
  const assets = (assetsByProfile(v).get(id) ?? []).map((a) => v.briefs.get(a)!).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  // a KPI that reads a base profile reads this one, too (0.11.0); 0.13: any of an input's profiles, with its mapping
  const kpis = [...allKpis().values()]
    .map((k) => ({
      id: k.id,
      name: k.name,
      names: k.names,
      dataPoints: namedInputPoints(k, values),
      reads: readsProfile(k, values),
    }))
    .filter((k) => k.reads)
    .map(({ reads: _r, ...k }) => k);
  const base = values.extends ? resolved.get(values.extends) : undefined;
  const bases = values.chain.slice(1).map((b) => ({ id: b, name: own.get(b)?.name ?? b, exists: true }));
  if (values.extends && !base) bases.push({ id: values.extends, name: values.extends, exists: false });
  return {
    ...profileSummary({ ...values, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, assets.length),
    description: values.description,
    descriptionFrom: values.descriptionFrom,
    notes: values.notes,
    interfaces: values.interfaces,
    own: own.get(id)!,
    bases,
    base: base ? { id: base.id, name: base.name, interfaces: base.interfaces } : null,
    origins: values.origins,
    notPresent: values.notPresent,
    unusedOverrides: values.unusedOverrides,
    extendedBy: [...own.values()].filter((x) => x.extends === id && x.id !== id).map((x) => ({ id: x.id, name: x.name })),
    assets,
    kpis,
    canManage: canManageCatalogue(),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

/**
 * Profile values from the API's input (groups without data points and names are kept as given), checked: its own
 * rules, its base (exists, no cycle) and – for a base – that every profile extending it still resolves (0.11.0).
 */
function profileValues(id: string, b: z.infer<typeof profileUpdate>): PlantProfileValues {
  const v: PlantProfileValues = { id, ...b };
  return checkedProfile(v, ownProfiles(), (problems) => {
    throw invalid('profile', problems);
  });
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
  if (profileRowOf(input.id)) throw new HttpError(409, `A device profile with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('profile', '', input.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_profiles')!.n) >= PLANT_DATA_LIMITS.profiles)
    throw new HttpError(409, `At most ${PLANT_DATA_LIMITS.profiles} device profiles`, 'PLANT_LIMIT', { max: PLANT_DATA_LIMITS.profiles });
  const { id, ...rest } = input;
  const v = profileValues(id, rest);
  db().tx(() => {
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
  const by = requireCatalogue('change device profiles');
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  const before = profileValuesOf(r);
  const v = profileValues(id, input);
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
  const by = requireCatalogue('delete device profiles');
  const r = profileRowOf(id);
  if (!r) throw profileNotFound(id);
  // an assignment names it: refused – with the count only when the caller sees every asset that has it
  const users = db().all<{ asset_id: string }>('SELECT asset_id FROM plant_assignments WHERE profile_id = ?', id);
  // a base that another profile extends stays (like a profile in use)
  const children = db().all<{ id: string; name: string }>('SELECT id, name FROM plant_profiles WHERE base_id = ? AND id <> ? ORDER BY name, id', id, id);
  if (children.length)
    throw new HttpError(
      409,
      `The profile is extended by ${children.map((c) => `"${c.name}"`).join(', ')} – change or delete those first`,
      'PLANT_PROFILE_EXTENDED',
      { count: children.length, profiles: children.map((c) => c.id).join(', ') },
    );
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
export function getDataPoint(profileId: string, pointId: string): PlantDataPointDetail {
  requirePlant();
  if (!profileRowOf(profileId)) throw profileNotFound(profileId);
  const profiles = allProfiles();
  const p = profiles.get(profileId)!;
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
  const kpis = [...allKpis().values()].filter((k) => namedInputPoints(k, p).includes(pointId)).map((k) => ({ id: k.id, name: k.name, names: k.names }));
  return {
    profile: { id: p.id, name: p.name, manufacturer: p.manufacturer, model: p.model },
    interface: { id: found.iface.id, name: found.iface.name, protocol: found.iface.protocol, direction: found.iface.direction },
    group: found.group,
    point: found.point,
    origin: p.origins.points[pointId] ?? { kind: 'own', from: p.id, fields: [], changedBy: [], descriptionFrom: p.id },
    assets,
    kpis,
  };
}

/** Data points across every profile whose id, name, address or description contains the text (no pattern: a plain match). */
export function explorePoints(q: string): PlantPointHit[] {
  requirePlant();
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const v = visibleAssets();
  const assignments = [...allAssignments()].filter(([id]) => v.assets.has(id));
  const out: PlantPointHit[] = [];
  for (const p of allProfiles().values()) {
    const using = assignments.filter(([, a]) => a.profileId === p.id).map(([, a]) => deliveries(a, p));
    for (const { iface, group, point } of pointsOf(p)) {
      if (![point.id, point.name, point.address, point.description].some((x) => x.toLowerCase().includes(needle))) continue;
      out.push({
        profile: { id: p.id, name: p.name },
        interface: { id: iface.id, name: iface.name, protocol: iface.protocol },
        group,
        point: { id: point.id, name: point.name, dataType: point.dataType, unit: point.unit, address: point.address },
        deliveredBy: using.filter((d) => d.get(point.id)?.delivers).length,
      });
      if (out.length >= 500) return out;
    }
  }
  return out;
}

// ---------- KPI definitions ----------

export function kpiNotFound(id: string): HttpError {
  return new HttpError(404, `KPI definition ${id} not found`, 'PLANT_KPI_NOT_FOUND', { id });
}

function kpiSummary(
  k: PlantKpiValues & { importId: string | null; notInSource: boolean; updatedAt: string },
  instanceCount: number,
  problemCount: number,
): PlantKpiSummary {
  return {
    id: k.id,
    name: k.name,
    names: k.names,
    category: k.category,
    unit: k.unit,
    trend: k.trend,
    profiles: kpiProfiles(k),
    parameterCount: k.parameters.length,
    columnCount: k.columns.length,
    instanceCount,
    problemCount,
    importId: k.importId,
    notInSource: k.notInSource,
    updatedAt: k.updatedAt,
  };
}

export function listKpis(): PlantKpiSummary[] {
  requirePlant();
  const v = visibleAssets();
  const profiles = allProfiles();
  const counts = new Map<string, number>();
  for (const [assetId, a] of allAssignments()) if (v.assets.has(assetId)) for (const k of a.kpis) counts.set(k.kpi, (counts.get(k.kpi) ?? 0) + 1);
  return db()
    .all<import('./data-model.js').KpiRow>('SELECT * FROM plant_kpis ORDER BY name, id')
    .map((r) => {
      const k = kpiValuesOf(r);
      return kpiSummary(
        { ...k, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at },
        counts.get(k.id) ?? 0,
        kpiChecks(k, profiles).length,
      );
    });
}

export function getKpi(id: string): PlantKpiDetail {
  requirePlant();
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
  const k = kpiValuesOf(r);
  const profiles = allProfiles();
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
  const profileNames: Record<string, string | null> = Object.fromEntries(kpiProfiles(k).map((p) => [p, profiles.get(p)?.name ?? null]));
  return {
    ...k,
    ...kpiSummary({ ...k, importId: r.import_id, notInSource: !!r.not_in_source, updatedAt: r.updated_at }, instances.length, checks.length),
    profileNames,
    checks,
    instances,
    candidates,
    candidateInfo,
    canManage: canManageCatalogue(),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

function kpiValues(id: string, b: z.infer<typeof kpiUpdate>): PlantKpiValues {
  const v: PlantKpiValues = { id, ...b };
  // 0.13: a mapping to a data point a profile lacks is refused
  const problems = kpiProblems(v, allProfiles());
  if (problems.length) throw invalid('kpi', problems);
  return { ...v, inputs: normalizeKpiInputs(v.inputs) };
}

export function createKpi(input: z.infer<typeof kpiInput>): PlantKpiDetail {
  const by = requireCatalogue('add KPI definitions');
  if (kpiRowOf(input.id)) throw new HttpError(409, `A KPI definition with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('kpi', '', input.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_kpis')!.n) >= PLANT_DATA_LIMITS.kpis)
    throw new HttpError(409, `At most ${PLANT_DATA_LIMITS.kpis} KPI definitions`, 'PLANT_LIMIT', { max: PLANT_DATA_LIMITS.kpis });
  const { id, ...rest } = input;
  const v = kpiValues(id, rest);
  db().tx(() => {
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
  const by = requireCatalogue('change KPI definitions');
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
  const before = kpiValuesOf(r);
  const v = kpiValues(id, input);
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
  requireCatalogue('delete KPI definitions');
  const r = kpiRowOf(id);
  if (!r) throw kpiNotFound(id);
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

/** Every check of the assets the caller may see (by asset name) and then of the KPI definitions (by name), unlimited. */
export function allChecks(): CheckWithKpi[] {
  requirePlant();
  const v = visibleAssets();
  const profiles = allProfiles();
  const kpis = allKpis();
  const out: CheckWithKpi[] = [];
  const assignments: [string, PlantAssignmentValues][] = [...allAssignments()].filter(([id]) => v.assets.has(id));
  assignments.sort(([a], [b]) => v.briefs.get(a)!.name.localeCompare(v.briefs.get(b)!.name) || a.localeCompare(b));
  for (const [assetId, a] of assignments) {
    const b = v.briefs.get(assetId)!;
    const kpiOfJob = new Map(a.kpis.map((k) => [k.job, k.kpi]));
    for (const c of assignmentChecks({ kind: 'asset', id: assetId, name: b.name, siteId: b.siteId }, a, profiles, kpis))
      out.push({ ...c, kpiId: c.job !== undefined ? (kpiOfJob.get(c.job) ?? null) : null });
  }
  for (const k of kpis.values()) for (const c of kpiChecks(k, profiles)) out.push({ ...c, kpiId: k.id });
  return out;
}

/** Every check of the assets the caller may see and of the KPI definitions: Plant → Checks. */
export function listChecks(): PlantCheck[] {
  return allChecks()
    .slice(0, 2000)
    .map(({ kpiId: _k, ...c }) => c);
}

export { profileInput, profileUpdate, kpiInput, kpiUpdate };
