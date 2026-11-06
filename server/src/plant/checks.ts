import type { KpiParamValue, PlantAssignmentValues, PlantCheck, PlantCheckCode, PlantKpiInstance, PlantKpiValues, PlantProfileValues } from '@sm/shared';
import { pointsOf } from './data-model.js';

/**
 * What Steward checks in part 2 of the plant registry (#219), as pure functions over values (the stored ones, or an
 * import's post state):
 *
 * - an asset's **assignment**: its profile, interfaces, overrides and publications name what the profile has;
 * - its **KPI instances**: the definition exists, every data point input is delivered by the asset (the profile has it,
 *   its interface is set up and active, no override says the asset lacks it), and the parameters are the
 *   definition's (known names or aliases, once each, of their type, in their range, required ones given);
 * - a **KPI definition**: a ratio names its numerator and denominator, and they are columns of the definition; its
 *   inputs name profiles and data points that exist.
 *
 * Problems never stop a save: they are shown on the asset, on the KPI definition, on Plant → Checks and in an
 * import's preview.
 */

export type Subject = PlantCheck['subject'];

const check = (code: PlantCheckCode, subject: Subject, message: string, params: Record<string, string | number> = {}, job?: string): PlantCheck => ({
  code,
  subject,
  ...(job !== undefined ? { job } : {}),
  message,
  params,
});

export type Delivery = { delivers: boolean; reason: 'interface_inactive' | 'unavailable' | null; endpoint: string };

/**
 * Which data points of its profile an asset delivers: a data point is delivered when its interface is set up and
 * active in the assignment and no override says the asset lacks it.
 */
export function deliveries(a: PlantAssignmentValues, profile: PlantProfileValues): Map<string, Delivery> {
  const active = new Map(a.interfaces.map((x) => [x.interface, x]));
  const missing = new Set(a.overrides.filter((o) => !o.available).map((o) => o.dataPoint));
  const out = new Map<string, Delivery>();
  for (const { iface, point } of pointsOf(profile)) {
    const set = active.get(iface.id);
    if (!set?.active) out.set(point.id, { delivers: false, reason: 'interface_inactive', endpoint: set?.endpoint ?? '' });
    else if (missing.has(point.id)) out.set(point.id, { delivers: false, reason: 'unavailable', endpoint: set.endpoint });
    else out.set(point.id, { delivers: true, reason: null, endpoint: set.endpoint });
  }
  return out;
}

/** The data point inputs of a KPI definition an asset with this assignment does not deliver (empty: it delivers all). */
function inputGaps(
  def: PlantKpiValues,
  a: PlantAssignmentValues,
  profile: PlantProfileValues | undefined,
): { code: PlantCheckCode; message: string; params: Record<string, string | number> }[] {
  const out: { code: PlantCheckCode; message: string; params: Record<string, string | number> }[] = [];
  const inputs = def.inputs.filter((i) => i.kind === 'data_point');
  if (!inputs.length) return out;
  if (!a.profileId || !profile) {
    out.push({ code: 'kpi_no_profile', message: `KPI "${def.name}" reads data points, but the asset has no device profile`, params: { kpi: def.name } });
    return out;
  }
  const delivered = deliveries(a, profile);
  const ifaceOf = new Map(pointsOf(profile).map((x) => [x.point.id, x.iface]));
  for (const input of inputs) {
    if (input.profile && input.profile !== a.profileId) {
      out.push({
        code: 'kpi_other_profile',
        message: `KPI "${def.name}" reads data points of profile "${input.profile}", the asset has profile "${profile.name}"`,
        params: { kpi: def.name, profile: input.profile, assigned: profile.name },
      });
      continue;
    }
    for (const dp of input.dataPoints) {
      const d = delivered.get(dp);
      if (!d)
        out.push({
          code: 'kpi_point_unknown',
          message: `KPI "${def.name}" reads data point "${dp}", which profile "${profile.name}" does not have`,
          params: { kpi: def.name, point: dp, profile: profile.name },
        });
      else if (d.reason === 'interface_inactive') {
        const iface = ifaceOf.get(dp)!;
        out.push({
          code: 'kpi_interface_inactive',
          message: `KPI "${def.name}" reads data point "${dp}", but interface "${iface.name || iface.id}" is not set up as active on this asset`,
          params: { kpi: def.name, point: dp, interface: iface.name || iface.id },
        });
      } else if (d.reason === 'unavailable')
        out.push({
          code: 'kpi_point_unavailable',
          message: `KPI "${def.name}" reads data point "${dp}", which an override marks as not delivered by this asset`,
          params: { kpi: def.name, point: dp },
        });
    }
  }
  return out;
}

/** Whether an asset with this assignment delivers every data point input of the definition (and it has some). */
export function canHave(def: PlantKpiValues, a: PlantAssignmentValues | undefined, profile: PlantProfileValues | undefined): boolean {
  if (!a || !def.inputs.some((i) => i.kind === 'data_point')) return false;
  return inputGaps(def, a, profile).length === 0;
}

const typeOk = (type: PlantKpiValues['parameters'][number]['type'], v: Exclude<KpiParamValue, null>): boolean =>
  type === 'string'
    ? typeof v === 'string'
    : type === 'boolean'
      ? typeof v === 'boolean'
      : type === 'integer'
        ? typeof v === 'number' && Number.isInteger(v)
        : typeof v === 'number';

/** The parameters of a KPI instance against its definition. */
function paramChecks(def: PlantKpiValues, k: PlantKpiInstance): { code: PlantCheckCode; message: string; params: Record<string, string | number> }[] {
  const out: { code: PlantCheckCode; message: string; params: Record<string, string | number> }[] = [];
  const byName = new Map<string, PlantKpiValues['parameters'][number]>();
  for (const p of def.parameters) for (const n of [p.name, ...p.aliases]) byName.set(n, p);
  const given = new Map<string, string>();
  for (const [key, v] of Object.entries(k.params)) {
    const p = byName.get(key);
    if (!p) {
      out.push({ code: 'param_unknown', message: `Parameter "${key}" is not a parameter of KPI "${def.name}"`, params: { param: key, kpi: def.name } });
      continue;
    }
    const first = given.get(p.name);
    if (first !== undefined)
      out.push({
        code: 'param_twice',
        message: `"${key}" and "${first}" both set parameter "${p.name}"`,
        params: { param: p.name, a: first, b: key },
      });
    given.set(p.name, key);
    if (v === null) continue;
    if (!typeOk(p.type, v)) out.push({ code: 'param_type', message: `Parameter "${key}" must be of type ${p.type}`, params: { param: key, type: p.type } });
    else if (typeof v === 'number' && ((p.min !== null && v < p.min) || (p.max !== null && v > p.max)))
      out.push({
        code: 'param_range',
        message: `Parameter "${key}" is ${v}, outside ${p.min ?? '…'} to ${p.max ?? '…'}`,
        params: { param: key, value: v, min: p.min ?? '…', max: p.max ?? '…' },
      });
  }
  for (const p of def.parameters)
    if (p.required && p.default === null && !(given.has(p.name) && k.params[given.get(p.name)!] !== null))
      out.push({ code: 'param_required', message: `Parameter "${p.name}" is required and has no default`, params: { param: p.name } });
  return out;
}

/** The checks of one asset: its assignment and its KPI instances. */
export function assignmentChecks(
  subject: Extract<Subject, { kind: 'asset' }>,
  a: PlantAssignmentValues,
  profiles: Map<string, PlantProfileValues>,
  kpis: Map<string, PlantKpiValues>,
): PlantCheck[] {
  const out: PlantCheck[] = [];
  const profile = a.profileId ? profiles.get(a.profileId) : undefined;
  if (a.profileId && !profile)
    out.push(check('profile_unknown', subject, `The device profile "${a.profileId}" does not exist (any more)`, { profile: a.profileId }));
  if (profile) {
    const ifaces = new Set(profile.interfaces.map((i) => i.id));
    for (const x of a.interfaces)
      if (!ifaces.has(x.interface))
        out.push(
          check('interface_unknown', subject, `Profile "${profile.name}" has no interface "${x.interface}"`, { interface: x.interface, profile: profile.name }),
        );
    const points = new Set(pointsOf(profile).map((x) => x.point.id));
    for (const id of new Set([...a.overrides.map((o) => o.dataPoint), ...a.publications.map((p) => p.dataPoint)]))
      if (!points.has(id))
        out.push(check('point_unknown', subject, `Profile "${profile.name}" has no data point "${id}"`, { point: id, profile: profile.name }));
  }
  for (const k of a.kpis) {
    const def = kpis.get(k.kpi);
    if (!def) {
      out.push(check('kpi_unknown', subject, `The KPI definition "${k.kpi}" of job "${k.job}" does not exist (any more)`, { kpi: k.kpi }, k.job));
      continue;
    }
    for (const g of [...inputGaps(def, a, profile), ...paramChecks(def, k)]) out.push(check(g.code, subject, g.message, g.params, k.job));
  }
  return out;
}

/** The checks of a KPI definition: its ratios and its inputs. */
export function kpiChecks(def: PlantKpiValues, profiles: Map<string, PlantProfileValues>): PlantCheck[] {
  const subject: Subject = { kind: 'kpi', id: def.id, name: def.name };
  const out: PlantCheck[] = [];
  const cols = new Set(def.columns.map((c) => c.name));
  for (const c of def.columns) {
    if (c.kind !== 'ratio') continue;
    if (!c.denominator)
      out.push(
        check('ratio_no_denominator', subject, `Column "${c.name}" is a ratio without a denominator: it cannot be combined over a longer period`, {
          column: c.name,
        }),
      );
    if (!c.numerator) out.push(check('ratio_no_numerator', subject, `Column "${c.name}" is a ratio without a numerator`, { column: c.name }));
    if (!def.dynamicColumns)
      for (const ref of [c.numerator, c.denominator])
        if (ref && !cols.has(ref))
          out.push(
            check('ratio_column_unknown', subject, `Ratio "${c.name}" names column "${ref}", which the definition does not have`, { column: c.name, ref }),
          );
  }
  for (const input of def.inputs) {
    if (input.kind !== 'data_point' || !input.profile) continue;
    const p = profiles.get(input.profile);
    if (!p) {
      out.push(
        check('input_profile_unknown', subject, `An input names the device profile "${input.profile}", which does not exist`, { profile: input.profile }),
      );
      continue;
    }
    const points = new Set(pointsOf(p).map((x) => x.point.id));
    for (const dp of input.dataPoints)
      if (!points.has(dp))
        out.push(
          check('input_point_unknown', subject, `An input names data point "${dp}", which profile "${p.name}" does not have`, { point: dp, profile: p.name }),
        );
  }
  return out;
}
