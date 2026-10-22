import { DEFAULT_RECORD_TYPES, type RecordFieldDef, type RecordType } from '@sm/shared';
import i18n from '../../i18n';
import { setBuiltinFieldLabel } from '../../i18n/errors';

/**
 * Texts of the built-in record types (CR, ADR, DR, SDR) in the UI language.
 *
 * Record types are data: an administrator can change their name, description,
 * template and fields. The built-in types are created in English; the UI shows
 * a text translated (records:builtinTypes, records:builtin.*) only while it is
 * still the English default. Whatever an administrator entered is shown as
 * entered, for everyone. See docs/I18N.md ("Record types").
 */

type TypeRef = Pick<RecordType, 'key'> & Partial<Pick<RecordType, 'builtin'>>;

const defaultType = (key: string) => DEFAULT_RECORD_TYPES.find((d) => d.key === key);
const defaultField = (typeKey: string, fieldKey: string) => defaultType(typeKey)?.fields.find((f) => f.key === fieldKey);
/** False for types an administrator created (built-in is unknown for frozen field definitions: the English text decides). */
const maybeBuiltin = (type: TypeRef) => type.builtin !== false;
const tr = (key: string, fallback: string): string => i18n.t(`records:builtin.${key}` as 'records:title', { defaultValue: fallback }) as string;

/** Description of a type. */
export function typeDescription(type: TypeRef & Pick<RecordType, 'description'>): string {
  const def = defaultType(type.key);
  if (!def || !maybeBuiltin(type) || def.description !== type.description) return type.description;
  return tr(`types.${type.key}.description`, type.description);
}

/** Markdown body of a new record: the translated template of a built-in type while it is unchanged. */
export function typeTemplate(type: TypeRef & Pick<RecordType, 'template'>): string {
  const def = defaultType(type.key);
  if (!def || !maybeBuiltin(type) || def.template !== type.template) return type.template;
  return tr(`types.${type.key}.template`, type.template);
}

/** Label of a field. */
export function fieldLabel(typeKey: string, f: Pick<RecordFieldDef, 'key' | 'label'>): string {
  const def = defaultField(typeKey, f.key);
  if (!def || def.label !== f.label) return f.label;
  return tr(`fields.${f.key}.label`, f.label);
}

/** Label of a field known only by its key (import preview): the built-in label, otherwise the key. */
export function fieldLabelByKey(typeKey: string, key: string): string {
  const def = defaultField(typeKey, key);
  return def ? fieldLabel(typeKey, def) : key;
}

/** Help text of a field. */
export function fieldHelp(typeKey: string, f: Pick<RecordFieldDef, 'key' | 'help'>): string | undefined {
  const def = defaultField(typeKey, f.key);
  if (!f.help || !def || def.help !== f.help) return f.help;
  return tr(`fields.${f.key}.help`, f.help);
}

/** Text of a select option (the stored value stays the same in every language). */
export function optionLabel(typeKey: string, f: Pick<RecordFieldDef, 'key'>, value: string): string {
  const def = defaultField(typeKey, f.key);
  if (!def?.options?.includes(value)) return value;
  return tr(`options.${f.key}.${value}`, value);
}

/** Field definitions with translated labels and help (for display; never send them back to the server). */
export function localizedFields(typeKey: string, defs: RecordFieldDef[]): RecordFieldDef[] {
  return defs.map((f) => ({ ...f, label: fieldLabel(typeKey, f), help: fieldHelp(typeKey, f) }));
}

// Error messages name fields by their label (e.g. "Fill in the required fields first: Reason"): translate those too.
setBuiltinFieldLabel((type, field, label) => fieldLabel(type, { key: field, label }));
