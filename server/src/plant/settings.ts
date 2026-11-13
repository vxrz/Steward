import { z } from 'zod';
import {
  boundedRecord,
  PLANT_FIELD_KEY_RE,
  PLANT_FIELD_KINDS,
  PLANT_LANG_RE,
  PLANT_DOC_REVIEW_LIMITS,
  PLANT_LIMITS,
  PLANT_RECORD_TYPES,
  type FieldValues,
  type PlantFieldDef,
  type PlantRecordType,
  type PlantSettings,
} from '@sm/shared';
import { audit } from '../audit.js';
import { readSetting, writeSetting } from '../settings.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso } from '../util.js';

/**
 * The module switch and the settings of the plant registry (#218): on or off, the enterprise's name, own display
 * names of the record types and own fields per record type. Stored as one internal setting (plant.settings); when the
 * module is off nothing of it is used and its routes answer 404 PLANT_MODULE_OFF – the data stays.
 */

const KEY = 'plant.settings';

const DEFAULTS: PlantSettings = { enabled: false, enterprise: '', labels: {}, fields: {}, documentReview: {}, updatedAt: null, updatedBy: null };

export function plantSettings(): PlantSettings {
  const s = readSetting<Partial<PlantSettings>>(KEY, {});
  return { ...DEFAULTS, ...s, labels: s.labels ?? {}, fields: s.fields ?? {}, documentReview: s.documentReview ?? {} };
}

/** Whether the module is on. */
export const plantEnabled = (): boolean => plantSettings().enabled === true;

/** Every route of the module starts here: 404 while the module is off (as if it did not exist). */
export function requirePlant(): void {
  if (!plantEnabled()) throw new HttpError(404, 'The plant registry is not enabled (Settings → Modules)', 'PLANT_MODULE_OFF');
}

// ---------- input ----------

const langKeyed = <V extends z.ZodType>(v: V) =>
  boundedRecord(v, PLANT_LIMITS.translations).refine((o) => Object.keys(o).every((k) => PLANT_LANG_RE.test(k)), 'Use language codes such as en or de');

const fieldDef = z
  .object({
    key: z.string().regex(PLANT_FIELD_KEY_RE, 'A key is snake_case: lower-case letters, digits and _, starting with a letter (at most 40)'),
    label: z.string().trim().min(1).max(100),
    labels: langKeyed(z.string().trim().min(1).max(100)).default({}),
    kind: z.enum(PLANT_FIELD_KINDS),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(100)).max(PLANT_LIMITS.fieldOptions).default([]),
    help: z.string().trim().max(300).default(''),
  })
  .strict();

const label = z.object({ one: z.string().trim().max(60), other: z.string().trim().max(60) }).strict();

const typeKeyed = <V extends z.ZodType>(v: V) =>
  z.object(Object.fromEntries(PLANT_RECORD_TYPES.map((t) => [t, v.optional()])) as Record<PlantRecordType, z.ZodOptional<V>>).strict();

export const plantSettingsInput = z
  .object({
    enabled: z.boolean(),
    enterprise: z.string().trim().max(PLANT_LIMITS.name).default(''),
    labels: typeKeyed(langKeyed(label)).default({}),
    fields: typeKeyed(z.array(fieldDef).max(PLANT_LIMITS.fieldDefs)).default({}),
    /** 0.14: review intervals of plant documents per document type (record type key → months); missing: unchanged */
    documentReview: boundedRecord(z.number().int().min(1).max(PLANT_DOC_REVIEW_LIMITS.monthsMax), PLANT_DOC_REVIEW_LIMITS.types).optional(),
  })
  .strict();

export function updatePlantSettings(input: z.infer<typeof plantSettingsInput>, onEnabled?: () => void): PlantSettings {
  const u = me();
  const before = plantSettings();
  const fields: PlantSettings['fields'] = {};
  for (const type of PLANT_RECORD_TYPES) {
    const defs = input.fields[type];
    if (!defs?.length) continue;
    const seen = new Set<string>();
    for (const d of defs) {
      if (seen.has(d.key)) throw new HttpError(400, `Own field "${d.key}" is defined twice`, 'PLANT_FIELD_DUPLICATE', { field: d.key });
      seen.add(d.key);
      if (d.kind === 'select' && !d.options.length)
        throw new HttpError(400, `Own field "${d.key}" is a choice and needs options`, 'PLANT_FIELD_OPTIONS', { field: d.key });
    }
    fields[type] = defs.map((d) => ({ ...d, options: d.kind === 'select' ? [...new Set(d.options)] : [] }));
  }
  const labels: PlantSettings['labels'] = {};
  for (const type of PLANT_RECORD_TYPES) {
    const l = Object.fromEntries(Object.entries(input.labels[type] ?? {}).filter(([, v]) => v.one || v.other));
    if (Object.keys(l).length) labels[type] = l;
  }
  for (const k of Object.keys(input.documentReview ?? {}))
    if (!/^[A-Z][A-Z0-9_-]{0,19}$/i.test(k))
      throw new HttpError(400, `"${k.slice(0, 40)}" is not a document type key`, 'PLANT_DOC_TYPE', { type: k.slice(0, 40) });
  const documentReview = input.documentReview ?? before.documentReview ?? {};
  const next: PlantSettings = {
    enabled: input.enabled,
    enterprise: input.enterprise,
    labels,
    fields,
    documentReview,
    updatedAt: nowIso(),
    updatedBy: u.username,
  };
  const changed = (['enabled', 'enterprise', 'labels', 'fields', 'documentReview'] as const).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]),
  );
  if (!changed.length) return before;
  writeSetting(KEY, next);
  if (before.enabled !== next.enabled)
    audit({
      action: next.enabled ? 'plant.module_enabled' : 'plant.module_disabled',
      entityType: 'settings',
      entityId: 'plant',
      summary: next.enabled ? 'Plant registry module turned on' : 'Plant registry module turned off (its data is kept)',
    });
  const other = changed.filter((k) => k !== 'enabled');
  if (other.length)
    audit({
      action: 'plant.settings_changed',
      entityType: 'settings',
      entityId: 'plant',
      summary: `Plant registry settings changed (${other.join(', ')})`,
      details: Object.fromEntries(other.map((k) => [k, { old: before[k] ?? null, new: next[k] }])),
    });
  if (!before.enabled && next.enabled) onEnabled?.();
  return next;
}

// ---------- the settings of the plant registry's managers (ADR 0034 decision 11, 0.23.0) ----------

/** The manager settings: the content of the registry's settings, never its switch (enterprise, labels, own fields, review intervals). */
export const plantManagerSettingsInput = plantSettingsInput.omit({ enabled: true });

/** GET /api/plant/settings: what the plant registry's managers change, and which of it this person may change. */
export function plantManagerSettings(): PlantSettings {
  return plantSettings();
}

/**
 * Changes the manager settings (PUT /api/plant/settings): administrators, and whoever is granted the plant registry's
 * manager role (`managerSettings` of the module – a manager role from core roles does not count). The switch stays with
 * administrators (PUT /api/settings/plant). Audited as plant.settings_changed.
 */
export function updatePlantManagerSettings(input: z.infer<typeof plantManagerSettingsInput>, may: (key: string) => boolean): PlantSettings {
  const before = plantSettings();
  const changed = (['enterprise', 'labels', 'fields', 'documentReview'] as const).filter(
    (k) => input[k] !== undefined && JSON.stringify(before[k] ?? {}) !== JSON.stringify(input[k]),
  );
  const refused = changed.filter((k) => !may(k));
  if (refused.length)
    throw new HttpError(403, `Only administrators change ${refused.join(', ')} of the plant registry`, 'MODULE_SETTING_ADMIN_ONLY', {
      module: 'plant',
      setting: refused[0]!,
    });
  return updatePlantSettings({ ...input, enabled: before.enabled });
}

// ---------- own fields ----------

export const fieldValuesInput = boundedRecord(z.union([z.string().max(PLANT_LIMITS.fieldText), z.number(), z.boolean(), z.null()]), PLANT_LIMITS.fieldDefs);

export const fieldDefs = (type: PlantRecordType, s: PlantSettings = plantSettings()): PlantFieldDef[] => s.fields[type] ?? [];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: string): boolean =>
  DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
export const isHttpUrl = (v: string): boolean => {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false; // not a URL at all
  }
};

/** What is wrong with the own field values of a record (empty: they are fine); values are cleaned in place. */
export function fieldProblems(type: PlantRecordType, values: Record<string, unknown>, s?: PlantSettings): { field: string; message: string }[] {
  const defs = fieldDefs(type, s);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: { field: string; message: string }[] = [];
  for (const [k, v] of Object.entries(values)) {
    const d = byKey.get(k);
    if (!d) {
      out.push({ field: k, message: `"${k}" is not an own field of this record type (Settings → Modules → Plant registry)` });
      continue;
    }
    if (v === null || v === '') continue;
    const bad = (m: string) => out.push({ field: k, message: `${d.label}: ${m}` });
    if (d.kind === 'number' && typeof v !== 'number') bad('expected a number');
    else if (d.kind === 'boolean' && typeof v !== 'boolean') bad('expected true or false');
    else if (d.kind === 'date' && (typeof v !== 'string' || !isDate(v))) bad('expected a date (YYYY-MM-DD)');
    else if (d.kind === 'url' && (typeof v !== 'string' || !isHttpUrl(v))) bad('expected an http or https address');
    else if (d.kind === 'select' && !d.options.includes(String(v))) bad(`expected one of ${d.options.join(', ')}`);
    else if (d.kind === 'text' && typeof v !== 'string' && typeof v !== 'number') bad('expected text');
  }
  for (const d of defs)
    if (d.required && (values[d.key] === undefined || values[d.key] === null || values[d.key] === ''))
      out.push({ field: d.key, message: `${d.label}: required` });
  return out;
}

/** Own field values as stored: checked against the schema (400 PLANT_FIELD_INVALID), empty values left out. */
export function cleanFields(type: PlantRecordType, values: Record<string, unknown> | undefined): FieldValues {
  const v = values ?? {};
  const problems = fieldProblems(type, v);
  if (problems.length) throw new HttpError(400, problems[0]!.message, 'PLANT_FIELD_INVALID', { field: problems[0]!.field, message: problems[0]!.message });
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => x !== null && x !== '')
      .map(([k, x]) => [k, typeof x === 'number' && fieldDefs(type).find((d) => d.key === k)?.kind === 'text' ? String(x) : (x as string | number | boolean)]),
  );
}
