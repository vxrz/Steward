import {
  authKindOf,
  dataTypeOf,
  directionOf,
  protocolOf,
  unitCode,
  type KpiParamValue,
  type PlantAssignmentValues,
  type PlantChangeAction,
  type PlantChangeKind,
  type PlantCheck,
  type PlantDataPoint,
  type PlantImportMode,
  type PlantImportProblem,
  type PlantInterface,
  type PlantKpiValues,
  type PlantMissing,
  type PlantPermission,
  type PlantProfileValues,
} from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { canManageCatalogue } from './access.js';
import { changedKeys, type AssetRow, type SiteRow } from './model.js';
import type { AssignmentFile, DataPointFile, InterfaceFile, KpiFile, PlantFile, ProfileFile } from './format.js';
import {
  assignmentProblems,
  assignmentValuesOf,
  cleanParams,
  EMPTY_COMPUTATION,
  kpiProblems,
  kpiValuesOf,
  pointsOf,
  profileProblems,
  profileValuesOf,
  removeAssignmentRow,
  removeKpiRow,
  removeProfileRow,
  upsertAssignment,
  upsertKpi,
  upsertProfile,
  type AssignmentRow,
  type KpiRow,
  type ProfileRow,
} from './data-model.js';
import { assignmentChecks, kpiChecks } from './checks.js';

/**
 * The YAML import and export of part 2 (#219): device profiles, KPI definitions and assignments, in the same file
 * format (version 1, new optional top-level keys) and with the same modes as part 1 (import.ts). Records are matched
 * by their ids – a profile and a KPI definition by their id, an assignment by its asset. Profiles and KPI definitions
 * need the right to manage the catalogues; an assignment the manage right on its asset's site. What Steward checks
 * (checks.ts) is shown in the preview for the records of the files, in the state after the import.
 */

// ---------- writes (shared with import.ts) ----------

export interface Origin {
  file: string;
  path: string;
}

export interface Write {
  kind: PlantChangeKind;
  action: PlantChangeAction;
  siteId: string;
  id: string;
  name: string;
  fields?: string[];
  note?: string;
  /** What to write (add, change, unchanged: adopt; mark: flag) */
  apply: () => void;
}

export function pushWrite<V extends object>(
  writes: Write[],
  mode: PlantImportMode,
  kind: PlantChangeKind,
  siteId: string,
  id: string,
  name: string,
  before: V | null,
  after: V,
  cur: { not_in_source: number } | undefined,
  write: () => void,
  adopt: () => void,
): void {
  if (!before) return void writes.push({ kind, action: 'add', siteId, id, name, apply: write });
  if (mode === 'add') return void writes.push({ kind, action: 'skip', siteId, id, name, note: 'exists (add only)', apply: () => undefined });
  const fields = changedKeys(before, after);
  if (cur?.not_in_source) fields.push('notInSource');
  if (fields.length) writes.push({ kind, action: 'change', siteId, id, name, fields, apply: write });
  else writes.push({ kind, action: 'unchanged', siteId, id, name, apply: adopt });
}

// ---------- the plan: what the files say ----------

const has = <T extends object>(o: T, k: keyof T) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v)).trim();

interface PlannedProfile extends Origin {
  values: Partial<PlantProfileValues> & { id: string; name: string };
  /** The file's place of each group: groupPaths[interface][group] */
  groupPaths: string[][];
}
interface PlannedKpi extends Origin {
  values: Partial<PlantKpiValues> & { id: string; name: string };
}
interface PlannedAssignment extends Origin {
  assetId: string;
  siteId: string | null;
  values: Partial<PlantAssignmentValues>;
}

export interface DataPlan {
  profiles: Map<string, PlannedProfile>;
  kpis: Map<string, PlannedKpi>;
  assignments: Map<string, PlannedAssignment>;
}

export const emptyDataPlan = (): DataPlan => ({ profiles: new Map(), kpis: new Map(), assignments: new Map() });

function pointFromFile(d: DataPointFile, o: Origin, problems: PlantImportProblem[]): PlantDataPoint {
  const addresses = [d.address, d.node_id, d.modbus_address].map((x) => str(x)).filter(Boolean);
  if (new Set(addresses).size > 1) problems.push({ ...o, path: `${o.path}.address`, message: 'Give the address once (address, node_id or modbus_address)' });
  return {
    id: d.id,
    name: str(d.name) || d.id,
    description: str(d.description),
    dataType: d.data_type ? (dataTypeOf(d.data_type) ?? '') : '',
    unit: unitCode(str(d.unit)),
    address: addresses[0] ?? '',
    access: d.access ? (directionOf(d.access) ?? 'read') : 'read',
    updateRateMs: d.update_rate_ms ?? null,
    enumValues: (d.enum_values ?? []).map((x) => String(x).trim()).filter(Boolean),
    notes: str(d.notes),
    publications: (d.publications ?? []).map((x) => ({ target: str(x.target), path: str(x.path), name: str(x.name) })),
  };
}

function interfaceFromFile(f: InterfaceFile, path: string, problems: PlantImportProblem[], file: string): { iface: PlantInterface; groupPaths: string[] } {
  const groups = (f.groups ?? []).map((g, j) => ({
    name: g.name.trim(),
    description: str(g.description),
    dataPoints: (g.data_points ?? []).map((d, k) => pointFromFile(d, { file, path: `${path}.groups[${j}].data_points[${k}]` }, problems)),
  }));
  const groupPaths = groups.map((_, j) => `${path}.groups[${j}]`);
  if (f.data_points?.length) {
    groups.push({
      name: '',
      description: '',
      dataPoints: f.data_points.map((d, k) => pointFromFile(d, { file, path: `${path}.data_points[${k}]` }, problems)),
    });
    groupPaths.push(path);
  }
  return {
    iface: {
      id: f.id,
      name: str(f.name),
      protocol: protocolOf(f.protocol) ?? 'other',
      direction: f.direction ? (directionOf(f.direction) ?? 'read') : 'read',
      description: str(f.description),
      version: str(f.version),
      defaultPort: f.default_port ?? null,
      authentication: f.authentication ? (authKindOf(f.authentication) ?? 'other') : 'none',
      client: str(f.client),
      notes: str(f.notes),
      groups,
      fileSets: (f.file_sets ?? []).map((x) => ({
        id: x.id,
        name: str(x.name),
        description: str(x.description),
        format: str(x.format),
        direction: x.direction ? (directionOf(x.direction) ?? 'read') : 'read',
        pathPattern: str(x.path_pattern),
        producedPer: str(x.produced_per),
        retention: str(x.retention),
        encoding: str(x.encoding),
        notes: str(x.notes),
      })),
    },
    groupPaths,
  };
}

function profileFromFile(p: ProfileFile, o: Origin, problems: PlantImportProblem[]): PlannedProfile {
  const v: PlannedProfile['values'] = { id: p.id, name: p.name.trim() };
  for (const k of ['manufacturer', 'model', 'version', 'category', 'description', 'notes'] as const) if (has(p, k)) v[k] = str(p[k]);
  const groupPaths: string[][] = [];
  if (has(p, 'interfaces'))
    v.interfaces = (p.interfaces ?? []).map((f, i) => {
      // the places of the data points in the file: below the profile's own place
      const x = interfaceFromFile(f, `${o.path}.interfaces[${i}]`, problems, o.file);
      groupPaths.push(x.groupPaths);
      return x.iface;
    });
  return { ...o, values: v, groupPaths };
}

function kpiFromFile(k: KpiFile, o: Origin): PlannedKpi {
  const v: PlannedKpi['values'] = { id: k.id, name: k.name.trim() };
  if (has(k, 'names')) v.names = k.names ?? {};
  for (const key of ['category', 'type', 'description', 'formula', 'strategy', 'implementation', 'notes'] as const) if (has(k, key)) v[key] = str(k[key]);
  if (has(k, 'unit')) v.unit = unitCode(str(k.unit));
  if (has(k, 'range')) {
    v.rangeMin = k.range?.min ?? null;
    v.rangeMax = k.range?.max ?? null;
  }
  if (has(k, 'trend')) v.trend = k.trend ?? null;
  if (has(k, 'timing')) v.timing = k.timing ?? null;
  if (has(k, 'audience')) v.audience = [...new Set(k.audience ?? [])];
  if (has(k, 'methodology')) v.methodology = k.methodology ?? null;
  if (has(k, 'dynamic_columns')) v.dynamicColumns = !!k.dynamic_columns;
  if (has(k, 'inputs'))
    v.inputs = (k.inputs ?? []).map((i) => ({
      kind: (i.kind ?? 'data_point').toLowerCase() === 'other' ? 'other' : 'data_point',
      profile: i.profile ?? '',
      dataPoints: [...new Set(i.data_points ?? [])],
      notes: str(i.notes),
    }));
  if (has(k, 'parameters'))
    v.parameters = (k.parameters ?? []).map((p) => ({
      name: p.name,
      aliases: [...new Set(p.aliases ?? [])],
      type: p.type ?? 'number',
      default: (p.default ?? null) as KpiParamValue,
      required: !!p.required,
      min: p.min ?? null,
      max: p.max ?? null,
      unit: unitCode(str(p.unit)),
      description: str(p.description),
    }));
  if (has(k, 'columns'))
    v.columns = (k.columns ?? []).map((c) => ({
      name: c.name,
      kind: c.kind ?? 'sum',
      scope: str(c.scope),
      unit: unitCode(str(c.unit)),
      numerator: str(c.numerator),
      denominator: str(c.denominator),
      scale: c.scale ?? null,
      description: str(c.description),
    }));
  if (has(k, 'computation'))
    v.computation = {
      summary: str(k.computation?.summary),
      diagram: str(k.computation?.diagram),
      steps: (k.computation?.steps ?? []).map((s) => ({ name: s.name.trim(), does: str(s.does), why: str(s.why) })),
      identities: (k.computation?.identities ?? []).map((x) => ({ relation: x.relation.trim(), note: str(x.note) })),
      limits: (k.computation?.limits ?? []).map((x) => x.trim()).filter(Boolean),
    };
  return { ...o, values: v };
}

function assignmentFromFile(a: AssignmentFile, o: Origin): PlannedAssignment {
  const v: PlannedAssignment['values'] = {};
  if (has(a, 'profile')) v.profileId = a.profile ?? null;
  if (has(a, 'firmware')) v.firmware = str(a.firmware);
  if (has(a, 'notes')) v.notes = str(a.notes);
  if (has(a, 'interfaces'))
    v.interfaces = (a.interfaces ?? []).map((x) => ({ interface: x.interface, active: x.active ?? true, endpoint: str(x.endpoint), notes: str(x.notes) }));
  if (has(a, 'overrides'))
    v.overrides = (a.overrides ?? []).map((x) => ({
      dataPoint: x.data_point,
      available: x.available ?? true,
      address: x.address ? x.address.trim() : null,
      unit: x.unit ? unitCode(x.unit) : null,
      dataType: x.data_type ? dataTypeOf(x.data_type) : null,
      updateRateMs: x.update_rate_ms ?? null,
      notes: str(x.notes),
    }));
  if (has(a, 'publications'))
    v.publications = (a.publications ?? []).map((x) => ({
      dataPoint: x.data_point,
      target: str(x.target),
      path: str(x.path),
      name: str(x.name),
      publishedBy: str(x.published_by),
      notes: str(x.notes),
    }));
  if (has(a, 'kpis'))
    v.kpis = (a.kpis ?? []).map((x) => ({
      kpi: x.kpi,
      job: x.job.trim(),
      active: x.active ?? true,
      params: cleanParams((x.params ?? {}) as Record<string, KpiParamValue>),
      dashboard: x.dashboard ? x.dashboard.trim() : null,
      dataset: x.dataset ? x.dataset.trim() : null,
      notes: str(x.notes),
    }));
  return { ...o, assetId: a.asset, siteId: a.site ?? null, values: v };
}

/** Adds what a file says about profiles, KPI definitions and assignments to the plan. */
export function planData(p: DataPlan, f: PlantFile, file: string, problems: PlantImportProblem[]): void {
  const twice = (o: Origin, what: string, first: Origin) =>
    problems.push({ ...o, message: `${what} is defined twice (also in ${first.file} at ${first.path})` });
  const profiles: [ProfileFile, string][] = f.device_profile
    ? [[f.device_profile, 'device_profile']]
    : (f.device_profiles ?? []).map((x, i) => [x, `device_profiles[${i}]`]);
  for (const [x, path] of profiles) {
    const o = { file, path };
    const first = p.profiles.get(x.id);
    if (first) {
      twice(o, `Device profile "${x.id}"`, first);
      continue;
    }
    p.profiles.set(x.id, profileFromFile(x, o, problems));
  }
  const kpis: [KpiFile, string][] = f.kpi_definition
    ? [[f.kpi_definition, 'kpi_definition']]
    : (f.kpi_definitions ?? []).map((x, i) => [x, `kpi_definitions[${i}]`]);
  for (const [x, path] of kpis) {
    const o = { file, path };
    const first = p.kpis.get(x.id);
    if (first) twice(o, `KPI definition "${x.id}"`, first);
    else p.kpis.set(x.id, kpiFromFile(x, o));
  }
  const assignments: [AssignmentFile, string][] = f.assignment ? [[f.assignment, 'assignment']] : (f.assignments ?? []).map((x, i) => [x, `assignments[${i}]`]);
  for (const [x, path] of assignments) {
    const o = { file, path };
    const first = p.assignments.get(x.asset);
    if (first) twice(o, `The assignment of asset "${x.asset}"`, first);
    else p.assignments.set(x.asset, assignmentFromFile(x, o));
  }
}

export const dataPlanEmpty = (p: DataPlan) => !p.profiles.size && !p.kpis.size && !p.assignments.size;

// ---------- comparing with what is stored ----------

const PROFILE_DEFAULTS = (id: string): PlantProfileValues => ({
  id,
  name: id,
  manufacturer: '',
  model: '',
  version: '',
  category: '',
  description: '',
  notes: '',
  interfaces: [],
});
const KPI_DEFAULTS = (id: string): PlantKpiValues => ({
  id,
  name: id,
  names: {},
  category: '',
  type: '',
  description: '',
  formula: '',
  unit: '',
  rangeMin: null,
  rangeMax: null,
  trend: null,
  timing: null,
  audience: [],
  methodology: null,
  strategy: '',
  implementation: '',
  dynamicColumns: false,
  inputs: [],
  parameters: [],
  columns: [],
  computation: EMPTY_COMPUTATION,
  notes: '',
});
export const ASSIGNMENT_DEFAULTS = (): PlantAssignmentValues => ({
  profileId: null,
  firmware: '',
  interfaces: [],
  overrides: [],
  publications: [],
  kpis: [],
  notes: '',
});

/** The data points without a group come last (the file lists them below the groups). */
export const normalizeInterfaces = (ifaces: PlantInterface[]): PlantInterface[] =>
  ifaces.map((i) => ({
    ...i,
    groups: [...i.groups.filter((g) => g.name), ...i.groups.filter((g) => !g.name && g.dataPoints.length)],
  }));

export interface DataContext {
  plan: DataPlan;
  mode: PlantImportMode;
  missing: PlantMissing;
  prevId: string | null;
  importId: string;
  meta: { importId: string; notInSource: boolean; at: string; by: string };
  user: AuthUser;
  writes: Write[];
  problems: PlantImportProblem[];
  warnings: PlantImportProblem[];
  rights: Map<string, PlantPermission[]>;
  sites: Map<string, SiteRow>;
  storedAssets: Map<string, AssetRow>;
  /** The site of every asset after the import (stored and not removed, or in the files) */
  postSite: Map<string, string>;
  /** Assets the import removes */
  removedAssets: Set<string>;
  /** Sites the files name themselves (a refused one is named there already) */
  fileSites: Set<string>;
  needManage: (siteId: string, o: Origin) => void;
}

/** Compares the part-2 records of the files with what is stored; returns what Steward checks in them. */
export function computeData(c: DataContext): PlantCheck[] {
  const { plan: p, mode, prevId, writes, problems, warnings } = c;
  const full = mode === 'replace';
  const fromPrev = (r: { import_id: string | null } | undefined) => !!prevId && r?.import_id === prevId;
  const storedProfiles = new Map(
    db()
      .all<ProfileRow>('SELECT * FROM plant_profiles')
      .map((r) => [r.id, r]),
  );
  const storedKpis = new Map(
    db()
      .all<KpiRow>('SELECT * FROM plant_kpis')
      .map((r) => [r.id, r]),
  );
  const storedAssignments = new Map(
    db()
      .all<AssignmentRow>('SELECT * FROM plant_assignments')
      .map((r) => [r.asset_id, r]),
  );
  const visibleSite = (siteId: string) => !c.sites.has(siteId) || !!c.rights.get(siteId)?.includes('view');

  // ---- rights on the catalogues
  if ((p.profiles.size || p.kpis.size) && !canManageCatalogue(c.user)) {
    const first = [...p.profiles.values(), ...p.kpis.values()][0]!;
    problems.push({ ...first, message: 'You may not add or change device profiles and KPI definitions' });
  }

  // ---- what goes (replace, remove)
  const removing = { profiles: new Set<string>(), kpis: new Set<string>(), assignments: new Set<string>() };
  if (full && c.missing === 'remove' && prevId) {
    for (const r of storedProfiles.values()) if (fromPrev(r) && !p.profiles.has(r.id)) removing.profiles.add(r.id);
    for (const r of storedKpis.values()) if (fromPrev(r) && !p.kpis.has(r.id)) removing.kpis.add(r.id);
    for (const r of storedAssignments.values()) if (fromPrev(r) && !p.assignments.has(r.asset_id)) removing.assignments.add(r.asset_id);
  }

  // ---- profiles
  const postProfiles = new Map<string, PlantProfileValues>();
  for (const [id, r] of storedProfiles) if (!removing.profiles.has(id)) postProfiles.set(id, profileValuesOf(r));
  for (const pp of p.profiles.values()) {
    const cur = storedProfiles.get(pp.values.id);
    const before = cur ? profileValuesOf(cur) : null;
    const after: PlantProfileValues = { ...(before && !full ? before : PROFILE_DEFAULTS(pp.values.id)), ...pp.values };
    after.interfaces = normalizeInterfaces(after.interfaces);
    // the group paths are the file's (data points without a group are listed on their interface)
    if (pp.values.interfaces)
      for (const pr of profileProblems(after, (i, j) => (pp.groupPaths[i]?.[j] ?? `${pp.path}.interfaces[${i}]`).slice(pp.path.length + 1)))
        problems.push({ file: pp.file, path: `${pp.path}.${pr.path}`, message: pr.message });
    postProfiles.set(after.id, after);
    pushWrite(
      writes,
      mode,
      'profile',
      '',
      after.id,
      after.name,
      before,
      after,
      cur,
      () => upsertProfile(after, c.meta),
      () => db().run('UPDATE plant_profiles SET import_id = ?, not_in_source = 0 WHERE id = ?', c.importId, after.id),
    );
  }

  // ---- KPI definitions
  const postKpis = new Map<string, PlantKpiValues>();
  for (const [id, r] of storedKpis) if (!removing.kpis.has(id)) postKpis.set(id, kpiValuesOf(r));
  for (const pk of p.kpis.values()) {
    const cur = storedKpis.get(pk.values.id);
    const before = cur ? kpiValuesOf(cur) : null;
    const after: PlantKpiValues = { ...(before && !full ? before : KPI_DEFAULTS(pk.values.id)), ...pk.values };
    for (const pr of kpiProblems(after)) problems.push({ file: pk.file, path: `${pk.path}.${pr.path}`, message: pr.message });
    postKpis.set(after.id, after);
    pushWrite(
      writes,
      mode,
      'kpi',
      '',
      after.id,
      after.name,
      before,
      after,
      cur,
      () => upsertKpi(after, c.meta),
      () => db().run('UPDATE plant_kpis SET import_id = ?, not_in_source = 0 WHERE id = ?', c.importId, after.id),
    );
  }

  // ---- assignments
  const postAssignments = new Map<string, PlantAssignmentValues>();
  for (const [assetId, r] of storedAssignments)
    if (!removing.assignments.has(assetId) && !c.removedAssets.has(assetId)) postAssignments.set(assetId, assignmentValuesOf(r));
  const checked: { assetId: string; siteId: string; name: string; values: PlantAssignmentValues }[] = [];
  for (const pa of p.assignments.values()) {
    const siteId = c.postSite.get(pa.assetId);
    const o = { file: pa.file, path: `${pa.path}.asset` };
    if (siteId === undefined) {
      problems.push({ ...o, message: `There is no asset "${pa.assetId}"` });
      continue;
    }
    // an asset in a site the caller may not see reads like one they may not change (its site is named only where
    // the files name it themselves)
    if (!visibleSite(siteId)) {
      if (c.fileSites.has(siteId)) c.needManage(siteId, pa);
      else problems.push({ ...o, message: `You may not add or change asset "${pa.assetId}"` });
      continue;
    }
    if (pa.siteId && pa.siteId !== siteId)
      problems.push({ ...pa, path: `${pa.path}.site`, message: `Asset "${pa.assetId}" is in site "${siteId}", not "${pa.siteId}"` });
    c.needManage(siteId, pa);
    const cur = storedAssignments.get(pa.assetId);
    const before = cur ? assignmentValuesOf(cur) : null;
    const after: PlantAssignmentValues = { ...(before && !full ? before : ASSIGNMENT_DEFAULTS()), ...pa.values };
    const profile = after.profileId ? postProfiles.get(after.profileId) : null;
    for (const pr of assignmentProblems(after, profile, (id) => postKpis.has(id)))
      problems.push({ file: pa.file, path: `${pa.path}.${pr.path}`, message: pr.message });
    postAssignments.set(pa.assetId, after);
    const name = c.storedAssets.get(pa.assetId)?.name ?? pa.assetId;
    checked.push({ assetId: pa.assetId, siteId, name, values: after });
    pushWrite(
      writes,
      mode,
      'assignment',
      siteId,
      pa.assetId,
      name,
      before,
      after,
      cur,
      () => upsertAssignment(pa.assetId, after, c.meta),
      () => db().run('UPDATE plant_assignments SET import_id = ?, not_in_source = 0 WHERE asset_id = ?', c.importId, pa.assetId),
    );
  }

  // ---- what the earlier import wrote and the files no longer have
  if (full && prevId) {
    const catalogue = canManageCatalogue(c.user);
    const gone = (kind: 'profile' | 'kpi', id: string, name: string, notInSource: number, remove: () => void, mark: () => void) => {
      if (!catalogue) {
        warnings.push({
          file: '(files)',
          path: kind,
          message: `${kind === 'profile' ? 'Device profile' : 'KPI definition'} "${id}" is not in the files, but you may not change the catalogues: it stays`,
        });
        removing[kind === 'profile' ? 'profiles' : 'kpis'].delete(id);
        return;
      }
      if (c.missing === 'remove') writes.push({ kind, action: 'remove', siteId: '', id, name, apply: remove });
      else if (notInSource) writes.push({ kind, action: 'unchanged', siteId: '', id, name, note: 'not in source', apply: mark });
      else writes.push({ kind, action: 'mark', siteId: '', id, name, note: 'kept, marked "not in source"', apply: mark });
    };
    for (const r of storedProfiles.values())
      if (fromPrev(r) && !p.profiles.has(r.id))
        gone(
          'profile',
          r.id,
          r.name,
          r.not_in_source,
          () => removeProfileRow(r.id),
          () => db().run('UPDATE plant_profiles SET not_in_source = 1, import_id = ? WHERE id = ?', c.importId, r.id),
        );
    for (const r of storedKpis.values())
      if (fromPrev(r) && !p.kpis.has(r.id))
        gone(
          'kpi',
          r.id,
          r.name,
          r.not_in_source,
          () => removeKpiRow(r.id),
          () => db().run('UPDATE plant_kpis SET not_in_source = 1, import_id = ? WHERE id = ?', c.importId, r.id),
        );
    for (const r of storedAssignments.values()) {
      if (!fromPrev(r) || p.assignments.has(r.asset_id) || c.removedAssets.has(r.asset_id)) continue;
      const siteId = c.storedAssets.get(r.asset_id)?.site_id ?? '';
      // assignments of assets in sites the caller may not see are not theirs to hear of
      if (!c.rights.get(siteId)?.includes('view')) {
        removing.assignments.delete(r.asset_id);
        continue;
      }
      const name = c.storedAssets.get(r.asset_id)?.name ?? r.asset_id;
      if (!c.rights.get(siteId)?.includes('manage')) {
        warnings.push({
          file: '(files)',
          path: 'assignment',
          message: `The assignment of asset "${r.asset_id}" is not in the files, but you may not change its site: it stays`,
        });
        removing.assignments.delete(r.asset_id);
        postAssignments.set(r.asset_id, assignmentValuesOf(r));
        continue;
      }
      const mark = () => db().run('UPDATE plant_assignments SET not_in_source = 1, import_id = ? WHERE asset_id = ?', c.importId, r.asset_id);
      if (c.missing === 'remove')
        writes.push({ kind: 'assignment', action: 'remove', siteId, id: r.asset_id, name, apply: () => removeAssignmentRow(r.asset_id) });
      else if (r.not_in_source) writes.push({ kind: 'assignment', action: 'unchanged', siteId, id: r.asset_id, name, note: 'not in source', apply: mark });
      else writes.push({ kind: 'assignment', action: 'mark', siteId, id: r.asset_id, name, note: 'kept, marked "not in source"', apply: mark });
    }
    // a profile or KPI definition that goes while an assignment that stays still names it: the import stops
    if (c.missing === 'remove')
      for (const [assetId, a] of postAssignments) {
        const siteId = c.postSite.get(assetId) ?? '';
        const who = visibleSite(siteId) ? `asset "${assetId}"` : 'an asset';
        if (a.profileId && removing.profiles.has(a.profileId))
          problems.push({
            file: '(files)',
            path: 'device_profiles',
            message: `Device profile "${a.profileId}" is removed, but ${who} still has it – add it to the files, or keep and mark the missing records`,
          });
        for (const k of a.kpis)
          if (removing.kpis.has(k.kpi))
            problems.push({
              file: '(files)',
              path: 'kpi_definitions',
              message: `KPI definition "${k.kpi}" is removed, but ${who} still has a KPI instance of it – add it to the files, or keep and mark the missing records`,
            });
      }
  }

  // ---- what Steward checks in the records of the files, after the import
  const checks: PlantCheck[] = [];
  for (const x of checked) checks.push(...assignmentChecks({ kind: 'asset', id: x.assetId, name: x.name, siteId: x.siteId }, x.values, postProfiles, postKpis));
  for (const pk of p.kpis.values()) {
    const k = postKpis.get(pk.values.id);
    if (k) checks.push(...kpiChecks(k, postProfiles));
  }
  return checks.slice(0, 500);
}

// ---------- export ----------

export const clean = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        v !== '' &&
        v !== false &&
        !(Array.isArray(v) && !v.length) &&
        !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length),
    ),
  ) as Partial<T>;

const pointOut = (d: PlantDataPoint) =>
  clean({
    id: d.id,
    name: d.name === d.id ? '' : d.name,
    description: d.description,
    data_type: d.dataType,
    unit: d.unit,
    address: d.address,
    access: d.access === 'read' ? '' : d.access,
    update_rate_ms: d.updateRateMs,
    enum_values: d.enumValues,
    notes: d.notes,
    publications: d.publications.map((x) => clean({ target: x.target, path: x.path, name: x.name })),
  });

export function profileOut(p: PlantProfileValues): Record<string, unknown> {
  return clean({
    id: p.id,
    name: p.name,
    manufacturer: p.manufacturer,
    model: p.model,
    version: p.version,
    category: p.category,
    description: p.description,
    notes: p.notes,
    interfaces: normalizeInterfaces(p.interfaces).map((i) =>
      clean({
        id: i.id,
        name: i.name,
        protocol: i.protocol,
        direction: i.direction === 'read' ? '' : i.direction,
        description: i.description,
        version: i.version,
        default_port: i.defaultPort,
        authentication: i.authentication === 'none' ? '' : i.authentication,
        client: i.client,
        notes: i.notes,
        groups: i.groups.filter((g) => g.name).map((g) => clean({ name: g.name, description: g.description, data_points: g.dataPoints.map(pointOut) })),
        data_points: (i.groups.find((g) => !g.name)?.dataPoints ?? []).map(pointOut),
        file_sets: i.fileSets.map((f) =>
          clean({
            id: f.id,
            name: f.name,
            description: f.description,
            format: f.format,
            direction: f.direction === 'read' ? '' : f.direction,
            path_pattern: f.pathPattern,
            produced_per: f.producedPer,
            retention: f.retention,
            encoding: f.encoding,
            notes: f.notes,
          }),
        ),
      }),
    ),
  });
}

export function kpiOut(k: PlantKpiValues): Record<string, unknown> {
  return clean({
    id: k.id,
    name: k.name,
    names: k.names,
    category: k.category,
    type: k.type,
    description: k.description,
    formula: k.formula,
    unit: k.unit,
    range: clean({ min: k.rangeMin, max: k.rangeMax }),
    trend: k.trend,
    timing: k.timing,
    audience: k.audience,
    methodology: k.methodology,
    strategy: k.strategy,
    implementation: k.implementation,
    dynamic_columns: k.dynamicColumns,
    inputs: k.inputs.map((i) => clean({ kind: i.kind === 'data_point' ? '' : i.kind, profile: i.profile, data_points: i.dataPoints, notes: i.notes })),
    parameters: k.parameters.map((p) =>
      // a default of 0 or false is a value: kept
      ({
        ...clean({ name: p.name, aliases: p.aliases, description: p.description, type: p.type === 'number' ? '' : p.type }),
        ...(p.default !== null ? { default: p.default } : {}),
        ...clean({ required: p.required, min: p.min, max: p.max, unit: p.unit }),
      }),
    ),
    columns: k.columns.map((x) =>
      clean({
        name: x.name,
        kind: x.kind === 'sum' ? '' : x.kind,
        scope: x.scope,
        unit: x.unit,
        numerator: x.numerator,
        denominator: x.denominator,
        scale: x.scale,
        description: x.description,
      }),
    ),
    computation: clean({
      summary: k.computation.summary,
      diagram: k.computation.diagram,
      steps: k.computation.steps.map((s) => clean({ name: s.name, does: s.does, why: s.why })),
      identities: k.computation.identities.map((x) => clean({ relation: x.relation, note: x.note })),
      limits: k.computation.limits,
    }),
    notes: k.notes,
  });
}

export function assignmentOut(assetId: string, a: PlantAssignmentValues): Record<string, unknown> {
  return clean({
    asset: assetId,
    profile: a.profileId,
    firmware: a.firmware,
    interfaces: a.interfaces.map((x) => ({
      interface: x.interface,
      ...(x.active ? {} : { active: false }),
      ...clean({ endpoint: x.endpoint, notes: x.notes }),
    })),
    overrides: a.overrides.map((x) => ({
      data_point: x.dataPoint,
      ...(x.available ? {} : { available: false }),
      ...clean({ address: x.address, unit: x.unit, data_type: x.dataType, update_rate_ms: x.updateRateMs, notes: x.notes }),
    })),
    publications: a.publications.map((x) =>
      clean({ data_point: x.dataPoint, target: x.target, path: x.path, name: x.name, published_by: x.publishedBy, notes: x.notes }),
    ),
    kpis: a.kpis.map((x) => ({
      kpi: x.kpi,
      job: x.job,
      ...(x.active ? {} : { active: false }),
      ...(Object.keys(x.params).length ? { params: x.params } : {}),
      ...clean({ dashboard: x.dashboard, dataset: x.dataset, notes: x.notes }),
    })),
    notes: a.notes,
  });
}

/** Points of a profile by id (exports and checks). */
export const pointIds = (p: PlantProfileValues) => new Set(pointsOf(p).map((x) => x.point.id));
