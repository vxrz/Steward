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
  type PlantFieldDiff,
  type PlantImportMode,
  type PlantImportProblem,
  type PlantInterface,
  type PlantKpiValues,
  type PlantMissing,
  type PlantPermission,
  type PlantProfileValues,
  type PlantInterfaceOverride,
  type PlantProfilePointOverride,
  type PlantResolvedProfile,
  type PlantAssetPointAddition,
} from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { canManageCatalogue } from './access.js';
import { changedKeys, type AssetRow, type SiteRow } from './model.js';
import { droppedItems, fieldDiff } from './diff.js';
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
  safeEntries,
  upsertAssignment,
  upsertKpi,
  upsertProfile,
  type AssignmentRow,
  type KpiRow,
  type ProfileRow,
} from './data-model.js';
import { assignmentChecks, kpiChecks } from './checks.js';
import { descendantsOf, extendsProblems, normalizeOwnPart, ownPartProblems, resolveAll, resolveChain, resolvedProblems } from './resolve.js';

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
  /** 0.12.0: a change's differences, field by field (computed for the preview's first changes only) */
  diff?: () => PlantFieldDiff[];
  /** 0.12.0: the items a change drops from lists inside the entry */
  drops?: () => string[];
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
  if (fields.length)
    writes.push({
      kind,
      action: 'change',
      siteId,
      id,
      name,
      fields,
      apply: write,
      diff: () => fieldDiff(before, after),
      drops: () => droppedItems(before, after),
    });
  else writes.push({ kind, action: 'unchanged', siteId, id, name, apply: adopt });
}

// ---------- the plan: what the files say ----------

const has = <T extends object>(o: T, k: keyof T) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v)).trim();

interface PlannedProfile extends Origin {
  values: Partial<PlantProfileValues> & { id: string; name: string };
  /** The file's place of each group: groupPaths[interface][group] */
  groupPaths: string[][];
  /** The file's interfaces as written: split into own interfaces and overrides once the base is known (0.11.0) */
  raw: InterfaceFile[] | null;
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
    aliases: [...new Set((d.aliases ?? []).map((x) => x.trim()).filter(Boolean))],
    notes: str(d.notes),
    publications: (d.publications ?? []).map((x) => ({ target: str(x.target), path: str(x.path), name: str(x.name) })),
  };
}

/** The keys an inherited data point's entry gives (0.11.0): what the derived profile changes. */
function pointOverrideFromFile(d: DataPointFile, o: Origin, problems: PlantImportProblem[]): PlantProfilePointOverride {
  const x: PlantProfilePointOverride = { dataPoint: d.id, present: d.present ?? true };
  if (d.present === false) return x;
  const full = pointFromFile(d, o, problems);
  if (has(d, 'name')) x.name = full.name;
  if (has(d, 'description')) x.description = full.description;
  if (has(d, 'data_type')) x.dataType = full.dataType;
  if (has(d, 'unit')) x.unit = full.unit;
  if (has(d, 'address') || has(d, 'node_id') || has(d, 'modbus_address')) x.address = full.address;
  if (has(d, 'access')) x.access = full.access;
  if (has(d, 'update_rate_ms')) x.updateRateMs = full.updateRateMs;
  if (has(d, 'enum_values')) x.enumValues = full.enumValues;
  if (has(d, 'aliases')) x.aliases = full.aliases;
  if (has(d, 'notes')) x.notes = full.notes;
  if (has(d, 'publications')) x.publications = full.publications;
  return x;
}

/**
 * A derived profile's `interfaces` as written, against its base's effective model: an entry with an inherited id
 * changes that interface (the keys it gives, `present: false`, data points it adds or changes); any other entry is an
 * own interface (0.11.0). Without a base every entry is an own interface, as before.
 */
export function splitInterfaces(
  raw: InterfaceFile[],
  base: PlantResolvedProfile | null,
  path: string,
  file: string,
  problems: PlantImportProblem[],
): { interfaces: PlantInterface[]; interfaceOverrides: PlantInterfaceOverride[]; pointOverrides: PlantProfilePointOverride[]; groupPaths: string[][] } {
  const interfaces: PlantInterface[] = [];
  const interfaceOverrides: PlantInterfaceOverride[] = [];
  const pointOverrides: PlantProfilePointOverride[] = [];
  const groupPaths: string[][] = [];
  const inheritedPoint = new Map<string, string>();
  for (const i of base?.interfaces ?? []) for (const g of i.groups) for (const d of g.dataPoints) inheritedPoint.set(d.id, i.id);
  raw.forEach((f, i) => {
    const at = `${path}.interfaces[${i}]`;
    const inherited = base?.interfaces.find((x) => x.id === f.id);
    if (!inherited) {
      if (!f.protocol) problems.push({ file, path: `${at}.protocol`, message: 'Required (a new interface needs its protocol)' });
      if (f.present !== undefined)
        problems.push({
          file,
          path: `${at}.present`,
          message: base ? `The base has no interface "${f.id}"` : 'Only a profile that extends another marks inherited interfaces',
        });
      const x = interfaceFromFile(f, at, problems, file);
      for (const [j, g] of x.iface.groups.entries())
        for (const [k, d] of g.dataPoints.entries())
          if ((f.groups?.[j]?.data_points?.[k] ?? f.data_points?.[k])?.present !== undefined)
            problems.push({ file, path: `${x.groupPaths[j]}`, message: `Data point "${d.id}": "present" marks only inherited data points` });
      interfaces.push(x.iface);
      groupPaths.push(x.groupPaths);
      return;
    }
    // 0.13: an inherited interface of protocol "other" (a base across protocols) gets its protocol here
    const protocol = f.protocol ? protocolOf(f.protocol) : null;
    if (protocol && protocol !== inherited.protocol && inherited.protocol !== 'other')
      problems.push({ file, path: `${at}.protocol`, message: `Interface "${f.id}" is inherited: its protocol stays ${inherited.protocol}` });
    const o: PlantInterfaceOverride = { interface: f.id, present: f.present ?? true, groups: [], fileSets: [] };
    if (f.present !== false) {
      const x = interfaceFromFile({ ...f, protocol: inherited.protocol, groups: [], data_points: [] }, at, problems, file).iface;
      if (protocol && protocol !== inherited.protocol && inherited.protocol === 'other') o.protocol = protocol;
      if (has(f, 'name')) o.name = x.name;
      if (has(f, 'direction')) o.direction = x.direction;
      if (has(f, 'description')) o.description = x.description;
      if (has(f, 'version')) o.version = x.version;
      if (has(f, 'default_port')) o.defaultPort = x.defaultPort;
      if (has(f, 'authentication')) o.authentication = x.authentication;
      if (has(f, 'client')) o.client = x.client;
      if (has(f, 'notes')) o.notes = x.notes;
      o.fileSets = x.fileSets;
      const inheritedGroups = new Set(inherited.groups.map((g) => g.name));
      const groups: [string, string, DataPointFile[], string][] = [
        ...(f.groups ?? []).map(
          (g, j) => [g.name.trim(), str(g.description), g.data_points ?? [], `${at}.groups[${j}]`] as [string, string, DataPointFile[], string],
        ),
        ...(f.data_points?.length ? [['', '', f.data_points, at] as [string, string, DataPointFile[], string]] : []),
      ];
      for (const [name, description, points, gat] of groups) {
        const added: PlantDataPoint[] = [];
        points.forEach((d, k) => {
          const dat = name || gat !== at ? `${gat}.data_points[${k}]` : `${at}.data_points[${k}]`;
          const on = inheritedPoint.get(d.id);
          if (on && on !== f.id)
            problems.push({ file, path: `${dat}.id`, message: `Data point "${d.id}" is inherited on interface "${on}" – change it there` });
          else if (on) pointOverrides.push(pointOverrideFromFile(d, { file, path: dat }, problems));
          else if (d.present !== undefined) problems.push({ file, path: `${dat}.present`, message: `The base has no data point "${d.id}"` });
          else added.push(pointFromFile(d, { file, path: dat }, problems));
        });
        // an inherited group's entry with a description describes it anew (0.12.0); empty: the inherited description
        if (added.length || description || !inheritedGroups.has(name)) o.groups.push({ name, description, dataPoints: added });
      }
    }
    interfaceOverrides.push(o);
  });
  return { interfaces: normalizeInterfaces(interfaces), interfaceOverrides, pointOverrides, groupPaths };
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
      protocol: (f.protocol ? protocolOf(f.protocol) : null) ?? 'other',
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

function profileFromFile(p: ProfileFile, o: Origin): PlannedProfile {
  const v: PlannedProfile['values'] = { id: p.id, name: p.name.trim() };
  for (const k of ['manufacturer', 'model', 'version', 'category', 'description', 'notes'] as const) if (has(p, k)) v[k] = str(p[k]);
  if (has(p, 'extends')) v.extends = p.extends ?? null;
  if (has(p, 'template')) v.template = !!p.template;
  // the interfaces are read once the base is known (computeData): an entry may change an inherited interface
  return { ...o, values: v, groupPaths: [], raw: has(p, 'interfaces') ? (p.interfaces ?? []) : null };
}

/** A KPI input's expected units (0.12.0) as stored: UCUM codes, empty ones left out, no field when none is left. */
function unitsFromFile(units: Record<string, string | null | undefined> | null | undefined): { units?: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(safeEntries(units ?? {}))) if (str(v)) out[k] = unitCode(str(v));
  return Object.keys(out).length ? { units: out } : {};
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
      ...unitsFromFile(i.units),
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

function assignmentFromFile(a: AssignmentFile, o: Origin, pending: PlantImportProblem[]): PlannedAssignment {
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
  if (has(a, 'additions')) {
    const at = `${o.path}.additions`;
    const problems: PlantImportProblem[] = [];
    v.additions = {
      interfaces: (a.additions?.interfaces ?? []).map((f, i) => {
        if (!f.protocol) problems.push({ file: o.file, path: `${at}.interfaces[${i}].protocol`, message: 'Required (a new interface needs its protocol)' });
        return interfaceFromFile(f, `${at}.interfaces[${i}]`, problems, o.file).iface;
      }),
      dataPoints: (a.additions?.data_points ?? []).map((d, i): PlantAssetPointAddition => ({
        ...pointFromFile(d, { file: o.file, path: `${at}.data_points[${i}]` }, problems),
        interface: d.interface,
        group: str(d.group),
      })),
    };
    pending.push(...problems);
  }
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
    p.profiles.set(x.id, profileFromFile(x, o));
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
    else p.assignments.set(x.asset, assignmentFromFile(x, o, problems));
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
  extends: null,
  template: false,
  interfaceOverrides: [],
  pointOverrides: [],
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
  additions: { interfaces: [], dataPoints: [] },
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
  /** 0.12: the assignments and resolved profiles after the import (the OT network's data collections read them) */
  onPost?: (assignments: Map<string, PlantAssignmentValues>, profiles: Map<string, PlantResolvedProfile>) => void;
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

  // ---- profiles: bases first, so a derived profile's interfaces are read against its base's model (0.11.0)
  const postOwn = new Map<string, PlantProfileValues>();
  for (const [id, r] of storedProfiles) if (!removing.profiles.has(id)) postOwn.set(id, profileValuesOf(r));
  const settled = new Map<string, PlantProfileValues>();
  const settling = new Set<string>();
  const settle = (pp: PlannedProfile): PlantProfileValues => {
    const done = settled.get(pp.values.id);
    if (done) return done;
    settling.add(pp.values.id);
    const cur = storedProfiles.get(pp.values.id);
    const before = cur ? profileValuesOf(cur) : null;
    const after: PlantProfileValues = { ...(before && !full ? before : PROFILE_DEFAULTS(pp.values.id)), ...pp.values };
    const baseId = after.extends;
    const planned = baseId ? p.profiles.get(baseId) : undefined;
    // a base in the files is read first (a cycle is refused below)
    if (planned && !settling.has(baseId!)) settle(planned);
    const base = baseId && !settling.has(baseId) ? resolveChain(baseId, (x) => postOwn.get(x)) : null;
    if (pp.raw) {
      const x = splitInterfaces(pp.raw, base, pp.path, pp.file, problems);
      after.interfaces = x.interfaces;
      after.interfaceOverrides = x.interfaceOverrides;
      after.pointOverrides = x.pointOverrides;
      pp.groupPaths = x.groupPaths;
    }
    after.interfaces = normalizeInterfaces(after.interfaces);
    for (const pr of extendsProblems(after.id, after.extends, new Map([...postOwn, [after.id, after]])))
      problems.push({ file: pp.file, path: `${pp.path}.${pr.path}`, message: pr.message });
    const normalized = normalizeOwnPart(after, base);
    if (!after.extends) {
      // the group paths are the file's (data points without a group are listed on their interface)
      if (pp.raw)
        for (const pr of profileProblems(normalized, (i, j) => (pp.groupPaths[i]?.[j] ?? `${pp.path}.interfaces[${i}]`).slice(pp.path.length + 1)))
          problems.push({ file: pp.file, path: `${pp.path}.${pr.path}`, message: pr.message });
    } else if (base) for (const pr of ownPartProblems(normalized, base)) problems.push({ file: pp.file, path: `${pp.path}.${pr.path}`, message: pr.message });
    settling.delete(pp.values.id);
    settled.set(normalized.id, normalized);
    postOwn.set(normalized.id, normalized);
    return normalized;
  };
  for (const pp of p.profiles.values()) {
    const cur = storedProfiles.get(pp.values.id);
    const before = cur ? profileValuesOf(cur) : null;
    const after = settle(pp);
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
  // every profile that extends one of the files' still resolves; the checks read the resolved profiles
  const postProfiles = resolveAll(postOwn);
  // 0.12.0: what a changed profile drops is also what its model in effect loses (an inherited known-as name replaced …)
  const preProfiles = resolveAll(new Map([...storedProfiles].map(([id, r]) => [id, profileValuesOf(r)])));
  for (const w of writes)
    if (w.kind === 'profile' && w.action === 'change') {
      const own = w.drops;
      const was = preProfiles.get(w.id);
      const now = postProfiles.get(w.id);
      w.drops = () => [
        ...new Set([...(own?.() ?? []), ...(was ? droppedItems(was.interfaces, now?.interfaces ?? []).map((x) => `in effect: interfaces${x}`) : [])]),
      ];
    }
  const told = new Set<string>();
  for (const pp of p.profiles.values())
    for (const d of descendantsOf(pp.values.id, postOwn)) {
      if (told.has(d) || p.profiles.has(d)) continue;
      told.add(d);
      const pr = resolvedProblems(postProfiles.get(d)!);
      if (pr.length) problems.push({ file: pp.file, path: `${pp.path}.interfaces`, message: `Device profile "${d}" extends this one: ${pr[0]!.message}` });
    }
  for (const pp of p.profiles.values())
    if (postOwn.get(pp.values.id)?.extends) {
      const pr = resolvedProblems(postProfiles.get(pp.values.id)!);
      if (pr.length && !problems.some((x) => x.file === pp.file && x.path.startsWith(pp.path)))
        problems.push({ file: pp.file, path: `${pp.path}.interfaces`, message: pr[0]!.message });
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

  // 0.12.0: a profile of the files that is a template while an asset (not in the files) has it: the import stops
  for (const pp of p.profiles.values()) {
    if (!postOwn.get(pp.values.id)?.template) continue;
    // (no count: assets in sites the caller may not see count, too)
    if ([...postAssignments].some(([assetId, a]) => a.profileId === pp.values.id && !p.assignments.has(assetId)))
      problems.push({
        file: pp.file,
        path: `${pp.path}.template`,
        message: `Device profile "${pp.values.id}" is a template, but assets have it – give them a profile that extends it first`,
      });
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
    // a base that goes while a profile that stays extends it: the import stops (0.11.0)
    if (c.missing === 'remove')
      for (const x of postOwn.values())
        if (x.extends && removing.profiles.has(x.extends))
          problems.push({
            file: '(files)',
            path: 'device_profiles',
            message: `Device profile "${x.extends}" is removed, but profile "${x.id}" extends it – add it to the files, or keep and mark the missing records`,
          });
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
  c.onPost?.(postAssignments, postProfiles);
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
    aliases: d.aliases,
    notes: d.notes,
    publications: d.publications.map((x) => clean({ target: x.target, path: x.path, name: x.name })),
  });

/** An inherited data point's entry: only what the derived profile changes (0.11.0). */
const pointOverrideOut = (o: PlantProfilePointOverride): Record<string, unknown> => {
  if (!o.present) return { id: o.dataPoint, present: false };
  const out: Record<string, unknown> = { id: o.dataPoint };
  const keys: [keyof PlantProfilePointOverride, string][] = [
    ['name', 'name'],
    ['description', 'description'],
    ['dataType', 'data_type'],
    ['unit', 'unit'],
    ['address', 'address'],
    ['access', 'access'],
    ['updateRateMs', 'update_rate_ms'],
    ['enumValues', 'enum_values'],
    ['aliases', 'aliases'],
    ['notes', 'notes'],
    ['publications', 'publications'],
  ];
  for (const [k, f] of keys) if (o[k] !== undefined) out[f] = o[k];
  return out;
};

const fileSetOut = (f: PlantInterface['fileSets'][number]) =>
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
  });

/**
 * A derived profile's changes to inherited interfaces as `interfaces` entries (0.11.0): per inherited interface the keys
 * it changes, `present: false`, and in its groups the inherited data points it changes and the ones it adds – in the
 * base's order, so the file imports back unchanged. Overrides of items the base no longer has are left out.
 */
function inheritedOut(p: PlantProfileValues, base: PlantResolvedProfile): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const overrides = new Map(p.pointOverrides.map((o) => [o.dataPoint, o]));
  for (const iface of base.interfaces) {
    const io = p.interfaceOverrides.find((o) => o.interface === iface.id);
    if (io && !io.present) {
      out.push({ id: iface.id, present: false });
      continue;
    }
    const groups = new Map<string, { description: string; points: Record<string, unknown>[] }>();
    for (const g of iface.groups)
      for (const d of g.dataPoints) {
        const o = overrides.get(d.id);
        if (!o) continue;
        const x = groups.get(g.name) ?? { description: '', points: [] };
        x.points.push(pointOverrideOut(o));
        groups.set(g.name, x);
      }
    const order = iface.groups.map((g) => g.name);
    for (const g of io?.groups ?? []) {
      const x = groups.get(g.name) ?? { description: '', points: [] };
      // an own group's description, or the one this profile gives an inherited group (0.12.0)
      if (g.description) x.description = g.description;
      x.points.push(...g.dataPoints.map(pointOut));
      groups.set(g.name, x);
    }
    if (!io && !groups.size) continue;
    const named = [...order.filter((n) => groups.has(n)), ...[...groups.keys()].filter((n) => !order.includes(n))].filter((n) => n);
    const entry: Record<string, unknown> = { id: iface.id };
    const keys: [keyof PlantInterfaceOverride, string][] = [
      ['name', 'name'],
      ['protocol', 'protocol'],
      ['direction', 'direction'],
      ['description', 'description'],
      ['version', 'version'],
      ['defaultPort', 'default_port'],
      ['authentication', 'authentication'],
      ['client', 'client'],
      ['notes', 'notes'],
    ];
    for (const [k, f] of keys) if (io && io[k] !== undefined) entry[f] = io[k];
    if (named.length)
      entry.groups = named.map((n) => ({
        name: n,
        ...clean({ description: groups.get(n)!.description }),
        ...(groups.get(n)!.points.length ? { data_points: groups.get(n)!.points } : {}),
      }));
    if (groups.get('')?.points.length) entry.data_points = groups.get('')!.points;
    if (io?.fileSets.length) entry.file_sets = io.fileSets.map(fileSetOut);
    out.push(entry);
  }
  return out;
}

/** A profile's own part in the file format; a derived profile needs its base's effective model (0.11.0). */
export function profileOut(p: PlantProfileValues, base: PlantResolvedProfile | null = null): Record<string, unknown> {
  return clean({
    id: p.id,
    name: p.name,
    extends: p.extends,
    template: p.template,
    manufacturer: p.manufacturer,
    model: p.model,
    version: p.version,
    category: p.category,
    description: p.description,
    notes: p.notes,
    interfaces: [...(p.extends && base ? inheritedOut(p, base) : []), ...normalizeInterfaces(p.interfaces).map(interfaceOut)],
  });
}

const interfaceOut = (i: PlantInterface): Record<string, unknown> =>
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
    file_sets: i.fileSets.map(fileSetOut),
  });

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
    inputs: k.inputs.map((i) =>
      clean({ kind: i.kind === 'data_point' ? '' : i.kind, profile: i.profile, data_points: i.dataPoints, units: i.units ?? {}, notes: i.notes }),
    ),
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
    additions: clean({
      interfaces: a.additions.interfaces.map((i) => interfaceOut({ ...i, groups: normalizeInterfaces([i])[0]!.groups })),
      data_points: a.additions.dataPoints.map((d) => ({ interface: d.interface, ...clean({ group: d.group }), ...pointOut(d) })),
    }),
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
