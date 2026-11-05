import { z } from 'zod';
import {
  addressProblem,
  boundedRecord,
  dataTypeOf,
  KPI_AUDIENCES,
  KPI_COLUMN_KINDS,
  KPI_INPUT_KINDS,
  KPI_METHODOLOGIES,
  KPI_PARAM_TYPES,
  KPI_TIMINGS,
  KPI_TRENDS,
  PLANT_AUTH_KINDS,
  PLANT_DATA_LIMITS as L,
  PLANT_DIRECTIONS,
  PLANT_LIMITS,
  PLANT_PROTOCOLS,
  unitCode,
  type KpiComputation,
  type KpiParamValue,
  type PlantAssignmentValues,
  type PlantDataPoint,
  type PlantInterface,
  type PlantKpiValues,
  type PlantProfileValues,
  type Translations,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { plantId, translations } from './model.js';

/**
 * Part 2 of the plant registry (#219), as stored and as values: device profiles (interfaces, groups, data points),
 * KPI definitions and the assignment of an asset (profile, interfaces, overrides, publications, KPI instances). A
 * profile and a KPI definition are each one record – their interfaces, data points, parameters and columns are values
 * of it, stored as JSON – so an import compares and writes them whole, as part 1 does with a site's contacts.
 *
 * The rules that hold for every save (an edit or an import) are here; what may drift later (a data point a KPI reads
 * is removed from its profile) is not refused but found by the checks (checks.ts).
 */

// ---------- names ----------

/** Ids of data points, interfaces, parameters and columns: devices name them, so capitals are allowed (`voltage_L1`). */
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;
export const NAME_HINT = 'Use letters, digits, ".", "_" and "-", starting with a letter, digit or "_" (at most 120)';
const POISON = new Set(['__proto__', 'constructor', 'prototype']);
export const pointName = z
  .string()
  .trim()
  .regex(NAME_RE, NAME_HINT)
  .refine((v) => !POISON.has(v), 'This name is reserved');

/** A record from input without keys that could reach an object's prototype. */
export const safeEntries = <V>(o: Record<string, V>): Record<string, V> => Object.fromEntries(Object.entries(o).filter(([k]) => !POISON.has(k)));

// ---------- rows ----------

interface Source {
  import_id: string | null;
  not_in_source: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface ProfileRow extends Source {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  version: string;
  category: string;
  description: string;
  notes: string;
  interfaces: string;
}

export interface KpiRow extends Source {
  id: string;
  name: string;
  names: string;
  category: string;
  kind: string;
  description: string;
  formula: string;
  unit: string;
  range_min: number | null;
  range_max: number | null;
  trend: string | null;
  timing: string | null;
  audience: string;
  methodology: string | null;
  strategy: string;
  implementation: string;
  dynamic_columns: number;
  inputs: string;
  parameters: string;
  result_columns: string;
  computation: string;
  notes: string;
}

export interface AssignmentRow extends Source {
  asset_id: string;
  profile_id: string | null;
  firmware: string;
  interfaces: string;
  overrides: string;
  publications: string;
  kpis: string;
  notes: string;
}

export const EMPTY_COMPUTATION: KpiComputation = { summary: '', diagram: '', steps: [], identities: [], limits: [] };

export const profileValuesOf = (r: ProfileRow): PlantProfileValues => ({
  id: r.id,
  name: r.name,
  manufacturer: r.manufacturer,
  model: r.model,
  version: r.version,
  category: r.category,
  description: r.description,
  notes: r.notes,
  interfaces: parseJson<PlantInterface[]>(r.interfaces, []),
});

export const kpiValuesOf = (r: KpiRow): PlantKpiValues => ({
  id: r.id,
  name: r.name,
  names: parseJson<Translations>(r.names, {}),
  category: r.category,
  type: r.kind,
  description: r.description,
  formula: r.formula,
  unit: r.unit,
  rangeMin: r.range_min === null ? null : Number(r.range_min),
  rangeMax: r.range_max === null ? null : Number(r.range_max),
  trend: (r.trend || null) as PlantKpiValues['trend'],
  timing: (r.timing || null) as PlantKpiValues['timing'],
  audience: parseJson<PlantKpiValues['audience']>(r.audience, []),
  methodology: (r.methodology || null) as PlantKpiValues['methodology'],
  strategy: r.strategy,
  implementation: r.implementation,
  dynamicColumns: !!Number(r.dynamic_columns),
  inputs: parseJson<PlantKpiValues['inputs']>(r.inputs, []),
  parameters: parseJson<PlantKpiValues['parameters']>(r.parameters, []),
  columns: parseJson<PlantKpiValues['columns']>(r.result_columns, []),
  computation: { ...EMPTY_COMPUTATION, ...parseJson<Partial<KpiComputation>>(r.computation, {}) },
  notes: r.notes,
});

export const assignmentValuesOf = (r: AssignmentRow): PlantAssignmentValues => ({
  profileId: r.profile_id,
  firmware: r.firmware,
  interfaces: parseJson<PlantAssignmentValues['interfaces']>(r.interfaces, []),
  overrides: parseJson<PlantAssignmentValues['overrides']>(r.overrides, []),
  publications: parseJson<PlantAssignmentValues['publications']>(r.publications, []),
  kpis: parseJson<PlantAssignmentValues['kpis']>(r.kpis, []),
  notes: r.notes,
});

/** Every data point of a profile with its interface and group. */
export function pointsOf(p: Pick<PlantProfileValues, 'interfaces'>): { iface: PlantInterface; group: string; point: PlantDataPoint }[] {
  return p.interfaces.flatMap((iface) => iface.groups.flatMap((g) => g.dataPoints.map((point) => ({ iface, group: g.name, point }))));
}

// ---------- reading ----------

export const profileRowOf = (id: string): ProfileRow | undefined => db().get<ProfileRow>('SELECT * FROM plant_profiles WHERE id = ?', id);
export const kpiRowOf = (id: string): KpiRow | undefined => db().get<KpiRow>('SELECT * FROM plant_kpis WHERE id = ?', id);
export const assignmentRowOf = (assetId: string): AssignmentRow | undefined =>
  db().get<AssignmentRow>('SELECT * FROM plant_assignments WHERE asset_id = ?', assetId);

export function allProfiles(): Map<string, PlantProfileValues> {
  return new Map(
    db()
      .all<ProfileRow>('SELECT * FROM plant_profiles ORDER BY name, id')
      .map((r) => [r.id, profileValuesOf(r)]),
  );
}
export function allKpis(): Map<string, PlantKpiValues> {
  return new Map(
    db()
      .all<KpiRow>('SELECT * FROM plant_kpis ORDER BY name, id')
      .map((r) => [r.id, kpiValuesOf(r)]),
  );
}
export function allAssignments(): Map<string, PlantAssignmentValues> {
  return new Map(
    db()
      .all<AssignmentRow>('SELECT * FROM plant_assignments')
      .map((r) => [r.asset_id, assignmentValuesOf(r)]),
  );
}

// ---------- input (the API, camelCase) ----------

const text = (max: number) => z.string().trim().max(max).default('');
const label = z.string().trim().min(1).max(PLANT_LIMITS.name);
const nullableNumber = z.number().finite().nullable().default(null);
const rate = z
  .number()
  .int()
  .min(0)
  .max(31 * 86_400_000)
  .nullable()
  .default(null);
const dataType = z
  .string()
  .trim()
  .max(40)
  .refine(
    (v) => dataTypeOf(v) !== null,
    'Use an OPC UA data type (Boolean, Int32, Float, Double, String …), an IEC 61131-3 type (BOOL, INT, REAL …) or int, float, bool, string; add [] for an array',
  )
  .transform((v) => dataTypeOf(v)!)
  .default('');
const unit = z
  .string()
  .trim()
  .max(40)
  .transform((v) => unitCode(v))
  .default('');

const publicationTarget = z.object({ target: text(L.text), path: text(L.address), name: text(L.text) }).strict();

export const dataPointInput = z
  .object({
    id: pointName,
    name: label,
    description: text(L.longText),
    dataType,
    unit,
    address: text(L.address),
    access: z.enum(PLANT_DIRECTIONS).default('read'),
    updateRateMs: rate,
    enumValues: z.array(z.string().trim().min(1).max(L.text)).max(L.enumValues).default([]),
    notes: text(L.longText),
    publications: z.array(publicationTarget).max(L.publicationsPerPoint).default([]),
  })
  .strict();

const fileSetInput = z
  .object({
    id: pointName,
    name: z.string().trim().max(PLANT_LIMITS.name).default(''),
    description: text(L.longText),
    format: text(L.text),
    direction: z.enum(PLANT_DIRECTIONS).default('read'),
    pathPattern: text(L.address),
    producedPer: text(L.text),
    retention: text(L.text),
    encoding: text(L.text),
    notes: text(L.longText),
  })
  .strict();

export const interfaceInput = z
  .object({
    id: pointName,
    name: z.string().trim().max(PLANT_LIMITS.name).default(''),
    protocol: z.enum(PLANT_PROTOCOLS),
    direction: z.enum(PLANT_DIRECTIONS).default('read'),
    description: text(L.longText),
    version: text(60),
    defaultPort: z.number().int().min(1).max(65535).nullable().default(null),
    authentication: z.enum(PLANT_AUTH_KINDS).default('none'),
    client: text(L.text),
    notes: text(L.longText),
    groups: z
      .array(
        z
          .object({
            name: text(L.text),
            description: text(L.longText),
            dataPoints: z.array(dataPointInput).max(L.dataPoints).default([]),
          })
          .strict(),
      )
      .max(L.groups)
      .default([]),
    fileSets: z.array(fileSetInput).max(L.fileSets).default([]),
  })
  .strict();

export const profileInput = z
  .object({
    id: plantId,
    name: label,
    manufacturer: text(PLANT_LIMITS.text),
    model: text(PLANT_LIMITS.text),
    version: text(60),
    category: text(100),
    description: text(L.longText),
    notes: text(L.longText),
    interfaces: z.array(interfaceInput).max(L.interfaces).default([]),
  })
  .strict();
export const profileUpdate = profileInput.omit({ id: true });

const paramValue = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);

export const kpiInput = z
  .object({
    id: plantId,
    name: label,
    names: translations,
    category: text(100),
    type: text(100),
    description: text(L.longText),
    formula: text(2000),
    unit,
    rangeMin: nullableNumber,
    rangeMax: nullableNumber,
    trend: z.enum(KPI_TRENDS).nullable().default(null),
    timing: z.enum(KPI_TIMINGS).nullable().default(null),
    audience: z.array(z.enum(KPI_AUDIENCES)).max(KPI_AUDIENCES.length).default([]),
    methodology: z.enum(KPI_METHODOLOGIES).nullable().default(null),
    strategy: text(L.text),
    implementation: text(500),
    dynamicColumns: z.boolean().default(false),
    inputs: z
      .array(
        z
          .object({
            kind: z.enum(KPI_INPUT_KINDS).default('data_point'),
            profile: z.string().trim().max(PLANT_LIMITS.id).default(''),
            dataPoints: z.array(pointName).max(L.inputPoints).default([]),
            notes: text(L.longText),
          })
          .strict(),
      )
      .max(L.inputs)
      .default([]),
    parameters: z
      .array(
        z
          .object({
            name: pointName,
            aliases: z.array(pointName).max(L.aliases).default([]),
            type: z.enum(KPI_PARAM_TYPES).default('number'),
            default: paramValue.default(null),
            required: z.boolean().default(false),
            min: nullableNumber,
            max: nullableNumber,
            unit,
            description: text(L.longText),
          })
          .strict(),
      )
      .max(L.parameters)
      .default([]),
    columns: z
      .array(
        z
          .object({
            name: pointName,
            kind: z.enum(KPI_COLUMN_KINDS).default('sum'),
            scope: text(60),
            unit,
            numerator: text(120),
            denominator: text(120),
            scale: nullableNumber,
            description: text(L.longText),
          })
          .strict(),
      )
      .max(L.columns)
      .default([]),
    computation: z
      .object({
        summary: text(L.longText),
        diagram: text(L.longText),
        steps: z
          .array(z.object({ name: z.string().trim().min(1).max(L.text), does: text(L.longText), why: text(L.longText) }).strict())
          .max(L.steps)
          .default([]),
        identities: z
          .array(z.object({ relation: z.string().trim().min(1).max(1000), note: text(L.longText) }).strict())
          .max(L.identities)
          .default([]),
        limits: z.array(z.string().trim().min(1).max(L.longText)).max(L.limits).default([]),
      })
      .strict()
      .default(EMPTY_COMPUTATION),
    notes: text(L.longText),
  })
  .strict();
export const kpiUpdate = kpiInput.omit({ id: true });

const nullableText = (max: number) => z.string().trim().max(max).nullable().default(null);

export const assignmentInput = z
  .object({
    profileId: plantId.nullable().default(null),
    firmware: text(100),
    interfaces: z
      .array(z.object({ interface: pointName, active: z.boolean().default(true), endpoint: text(2000), notes: text(L.longText) }).strict())
      .max(L.assignmentInterfaces)
      .default([]),
    overrides: z
      .array(
        z
          .object({
            dataPoint: pointName,
            available: z.boolean().default(true),
            address: nullableText(L.address),
            unit: z
              .string()
              .trim()
              .max(40)
              .transform((v) => unitCode(v))
              .nullable()
              .default(null),
            dataType: z
              .string()
              .trim()
              .max(40)
              .refine((v) => !!dataTypeOf(v), 'Use an OPC UA or IEC 61131-3 data type')
              .transform((v) => dataTypeOf(v)!)
              .nullable()
              .default(null),
            updateRateMs: rate,
            notes: text(L.longText),
          })
          .strict(),
      )
      .max(L.overrides)
      .default([]),
    publications: z
      .array(
        z
          .object({
            dataPoint: pointName,
            target: text(L.text),
            path: text(L.address),
            name: text(L.text),
            publishedBy: text(L.text),
            notes: text(L.longText),
          })
          .strict(),
      )
      .max(L.publications)
      .default([]),
    kpis: z
      .array(
        z
          .object({
            kpi: plantId,
            job: z.string().trim().min(1).max(L.text),
            active: z.boolean().default(true),
            params: boundedRecord(paramValue, L.params).default({}),
            dashboard: nullableText(100),
            dataset: nullableText(200),
            notes: text(L.longText),
          })
          .strict(),
      )
      .max(L.kpiInstances)
      .default([]),
    notes: text(L.longText),
  })
  .strict();

// ---------- rules (refused on save and import) ----------

export interface RuleProblem {
  /** Where, in the values (interfaces[0].groups[1].dataPoints[2].address) */
  path: string;
  message: string;
}

/**
 * What a profile may not hold: ids twice (interfaces; data points across the profile; file sets per interface),
 * a group name twice in an interface, an address that does not fit the interface's protocol (OPC UA NodeId,
 * Modbus table and address).
 */
export function profileProblems(p: PlantProfileValues, groupPath = (i: number, j: number) => `interfaces[${i}].groups[${j}]`): RuleProblem[] {
  const out: RuleProblem[] = [];
  const ifaces = new Set<string>();
  const points = new Map<string, string>();
  let count = 0;
  p.interfaces.forEach((iface, i) => {
    const at = `interfaces[${i}]`;
    if (ifaces.has(iface.id)) out.push({ path: `${at}.id`, message: `Interface "${iface.id}" is there twice` });
    ifaces.add(iface.id);
    const groups = new Set<string>();
    iface.groups.forEach((g, j) => {
      if (groups.has(g.name))
        out.push({ path: `${groupPath(i, j)}.name`, message: g.name ? `Group "${g.name}" is there twice` : 'Only one list without a group' });
      groups.add(g.name);
      g.dataPoints.forEach((dp, k) => {
        const pat = `${groupPath(i, j)}.data_points[${k}]`;
        count++;
        const first = points.get(dp.id);
        if (first) out.push({ path: `${pat}.id`, message: `Data point "${dp.id}" is there twice (also at ${first})` });
        else points.set(dp.id, pat);
        const a = addressProblem(iface.protocol, dp.address);
        if (a) out.push({ path: `${pat}.address`, message: a });
      });
    });
    const sets = new Set<string>();
    iface.fileSets.forEach((f, j) => {
      if (sets.has(f.id)) out.push({ path: `${at}.file_sets[${j}].id`, message: `File set "${f.id}" is there twice` });
      sets.add(f.id);
    });
  });
  if (count > L.dataPoints) out.push({ path: 'interfaces', message: `At most ${L.dataPoints} data points per profile` });
  return out;
}

/** What a KPI definition may not hold: a parameter or column name twice (aliases included), a range upside down. */
export function kpiProblems(k: PlantKpiValues): RuleProblem[] {
  const out: RuleProblem[] = [];
  const names = new Set<string>();
  k.parameters.forEach((p, i) => {
    for (const n of [p.name, ...p.aliases]) {
      if (names.has(n)) out.push({ path: `parameters[${i}]`, message: `Parameter name "${n}" is used twice (names and aliases)` });
      names.add(n);
    }
    if (p.min !== null && p.max !== null && p.min > p.max) out.push({ path: `parameters[${i}].min`, message: 'The minimum is above the maximum' });
  });
  const cols = new Set<string>();
  k.columns.forEach((c, i) => {
    if (cols.has(c.name)) out.push({ path: `columns[${i}].name`, message: `Column "${c.name}" is there twice` });
    cols.add(c.name);
  });
  if (k.rangeMin !== null && k.rangeMax !== null && k.rangeMin > k.rangeMax) out.push({ path: 'range', message: 'The lower end is above the upper end' });
  return out;
}

/**
 * What an assignment may not hold when it is saved: a profile, interface, data point or KPI definition that does not
 * exist, an interface or override twice, a job name twice.
 */
export function assignmentProblems(
  a: PlantAssignmentValues,
  profile: PlantProfileValues | null | undefined,
  kpiExists: (id: string) => boolean,
): RuleProblem[] {
  const out: RuleProblem[] = [];
  if (a.profileId && !profile) out.push({ path: 'profile', message: `There is no device profile "${a.profileId}"` });
  const ifaceIds = new Set(profile?.interfaces.map((i) => i.id) ?? []);
  const pointIds = new Map(pointsOf(profile ?? { interfaces: [] }).map((x) => [x.point.id, x]));
  const needProfile = (path: string) => !a.profileId && out.push({ path, message: 'Choose the device profile first' });
  const seen = new Set<string>();
  a.interfaces.forEach((x, i) => {
    if (needProfile(`interfaces[${i}]`)) return;
    if (profile && !ifaceIds.has(x.interface)) out.push({ path: `interfaces[${i}].interface`, message: `The profile has no interface "${x.interface}"` });
    if (seen.has(x.interface)) out.push({ path: `interfaces[${i}].interface`, message: `Interface "${x.interface}" is there twice` });
    seen.add(x.interface);
  });
  const over = new Set<string>();
  a.overrides.forEach((x, i) => {
    if (needProfile(`overrides[${i}]`)) return;
    const p = pointIds.get(x.dataPoint);
    if (profile && !p) out.push({ path: `overrides[${i}].data_point`, message: `The profile has no data point "${x.dataPoint}"` });
    if (over.has(x.dataPoint)) out.push({ path: `overrides[${i}].data_point`, message: `Data point "${x.dataPoint}" is overridden twice` });
    over.add(x.dataPoint);
    if (p && x.address) {
      const ap = addressProblem(p.iface.protocol, x.address);
      if (ap) out.push({ path: `overrides[${i}].address`, message: ap });
    }
  });
  a.publications.forEach((x, i) => {
    if (needProfile(`publications[${i}]`)) return;
    if (profile && !pointIds.has(x.dataPoint)) out.push({ path: `publications[${i}].data_point`, message: `The profile has no data point "${x.dataPoint}"` });
  });
  const jobs = new Set<string>();
  a.kpis.forEach((x, i) => {
    if (!kpiExists(x.kpi)) out.push({ path: `kpis[${i}].kpi`, message: `There is no KPI definition "${x.kpi}"` });
    if (jobs.has(x.job)) out.push({ path: `kpis[${i}].job`, message: `Job "${x.job}" is there twice` });
    jobs.add(x.job);
  });
  return out;
}

/** KPI instance parameters as stored (no keys that reach a prototype). */
export const cleanParams = (p: Record<string, KpiParamValue>): Record<string, KpiParamValue> => safeEntries(p);

// ---------- writing (callers check rights and rules) ----------

interface Meta {
  importId?: string | null;
  notInSource?: boolean;
  at: string;
  by: string;
}
const src = (m: Meta) => [m.importId ?? null, m.notInSource ? 1 : 0] as const;
const keep = (opts: { keepSource?: boolean }) => (opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,');

export function upsertProfile(v: PlantProfileValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_profiles (id, name, manufacturer, model, version, category, description, notes, interfaces, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, manufacturer = excluded.manufacturer, model = excluded.model, version = excluded.version,
       category = excluded.category, description = excluded.description, notes = excluded.notes, interfaces = excluded.interfaces,
       ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    v.id,
    v.name,
    v.manufacturer,
    v.model,
    v.version,
    v.category,
    v.description,
    v.notes,
    JSON.stringify(v.interfaces),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertKpi(v: PlantKpiValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_kpis (id, name, names, category, kind, description, formula, unit, range_min, range_max, trend, timing, audience, methodology, strategy,
       implementation, dynamic_columns, inputs, parameters, result_columns, computation, notes, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, names = excluded.names, category = excluded.category, kind = excluded.kind,
       description = excluded.description, formula = excluded.formula, unit = excluded.unit, range_min = excluded.range_min, range_max = excluded.range_max,
       trend = excluded.trend, timing = excluded.timing, audience = excluded.audience, methodology = excluded.methodology, strategy = excluded.strategy,
       implementation = excluded.implementation, dynamic_columns = excluded.dynamic_columns, inputs = excluded.inputs, parameters = excluded.parameters,
       result_columns = excluded.result_columns, computation = excluded.computation, notes = excluded.notes,
       ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    v.id,
    v.name,
    JSON.stringify(v.names),
    v.category,
    v.type,
    v.description,
    v.formula,
    v.unit,
    v.rangeMin,
    v.rangeMax,
    v.trend,
    v.timing,
    JSON.stringify(v.audience),
    v.methodology,
    v.strategy,
    v.implementation,
    v.dynamicColumns ? 1 : 0,
    JSON.stringify(v.inputs),
    JSON.stringify(v.parameters),
    JSON.stringify(v.columns),
    JSON.stringify(v.computation),
    v.notes,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertAssignment(assetId: string, v: PlantAssignmentValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_assignments (asset_id, profile_id, firmware, interfaces, overrides, publications, kpis, notes, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (asset_id) DO UPDATE SET profile_id = excluded.profile_id, firmware = excluded.firmware, interfaces = excluded.interfaces,
       overrides = excluded.overrides, publications = excluded.publications, kpis = excluded.kpis, notes = excluded.notes,
       ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    assetId,
    v.profileId,
    v.firmware,
    JSON.stringify(v.interfaces),
    JSON.stringify(v.overrides),
    JSON.stringify(v.publications),
    JSON.stringify(v.kpis.map((k) => ({ ...k, params: cleanParams(k.params) }))),
    v.notes,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export const removeProfileRow = (id: string) => {
  db().run("DELETE FROM copied_from WHERE kind = 'device-profile' AND id = ?", id);
  db().run('DELETE FROM plant_profiles WHERE id = ?', id);
};
export const removeKpiRow = (id: string) => {
  db().run("DELETE FROM copied_from WHERE kind = 'kpi-definition' AND id = ?", id);
  db().run('DELETE FROM plant_kpis WHERE id = ?', id);
};
export const removeAssignmentRow = (assetId: string) => db().run('DELETE FROM plant_assignments WHERE asset_id = ?', assetId);
