/**
 * Translations for metadata that lives in the language-neutral shared package
 * (node palette, field labels, notification events, widget types, roles …).
 *
 * The shared package keeps the English text; the web translates it with keys
 * derived from ids (editor:steps.http.label …) and falls back to the English
 * default when a key is missing. A server test keeps web/src/locales/en in sync
 * with the shared defaults.
 */
import type { FieldMeta, NodeCategory, NodeType, StepMeta } from '@sm/shared';
import i18n from './index';

/** Dynamic key lookup (the key is built from an id, so it cannot be checked at compile time). */
const tx = (key: string, defaultValue: string): string => i18n.t(key as 'common:add', { defaultValue }) as string;

export const stepLabel = (type: NodeType, meta: Pick<StepMeta, 'label'>): string => tx(`editor:steps.${type}.label`, meta.label);
export const stepDescription = (type: NodeType, meta: Pick<StepMeta, 'description'>): string => tx(`editor:steps.${type}.description`, meta.description);
export const categoryLabel = (c: NodeCategory): string => tx(`editor:categories.${c}`, c);
export const portLabel = (id: string, fallback: string): string => (fallback ? tx(`editor:ports.${id}`, fallback) : '');
export const browserActionLabel = (action: string, fallback: string): string => tx(`editor:browserActions.${action}`, fallback);
/** Display text of a select option value (e.g. onError "continue"); unknown values are shown as they are. */
export const optionLabel = (value: string): string => tx(`editor:options.${value}`, value);

/** A field description with its texts in the UI language. */
export interface LocalizedField extends FieldMeta {
  optionLabels?: Record<string, string>;
}

/** Field of a node type (or of the "common" execution fields) with translated label, help and option labels. */
export function localizeField(scope: NodeType | 'common', f: FieldMeta): LocalizedField {
  const base = scope === 'common' ? `editor:commonFields.${f.key}` : `editor:steps.${scope}.fields.${f.key}`;
  return {
    ...f,
    label: tx(`${base}.label`, f.label),
    help: f.help ? tx(`${base}.help`, f.help) : undefined,
    optionLabels: f.options ? Object.fromEntries(f.options.map((o) => [o, optionLabel(o)])) : undefined,
  };
}

/** Validation issue in the UI language (rules with a code are translated, others keep the English message). */
export function issueText(i: { code?: string; params?: Record<string, string | number>; message: string }): string {
  return i.code ? (i18n.t(`editor:validation.${i.code}` as 'common:add', { ...i.params, defaultValue: i.message }) as string) : i.message;
}
