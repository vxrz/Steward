import type { ErrorParam, ErrorParams } from '@sm/shared';
import { ApiError } from '../api';
import { fmtNumber, listFormat } from '../format';
import i18n from './index';

/**
 * Values the UI translates itself when the server names them in an error (nested parameter
 * `{ message, code, params }` with one of these codes).
 */
const VALUE_TEXTS: Record<string, (p: ErrorParams, message: string) => string> = {
  RECORD_STATUS: (p, m) => i18n.t(`records:status.${String(p.status)}` as 'records:status.draft', { defaultValue: m }),
  RECORD_FIELD: (p, m) => builtinFieldLabel(String(p.type ?? ''), String(p.field ?? ''), m),
};

let builtinFieldLabel = (_type: string, _field: string, label: string): string => label;
/** Set by the records module: translated labels of the built-in record types' fields. */
export function setBuiltinFieldLabel(fn: typeof builtinFieldLabel): void {
  builtinFieldLabel = fn;
}

/**
 * Translated text of an error code, or null when the UI has none. `params` fill the placeholders
 * (numbers in the UI's format, lists joined in the UI language); `params.context` picks a variant
 * (`<CODE>_<context>`, falling back to `<CODE>`); nested errors are translated the same way.
 */
export function codeText(code: string | undefined, params?: ErrorParams, message?: string): string | null {
  if (!code) return null;
  const value = VALUE_TEXTS[code];
  if (value) return value(params ?? {}, message ?? '');
  const key = `errors:codes.${code}`;
  const values: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(params ?? {})) values[k] = k === 'context' ? (typeof v === 'string' && v ? v : undefined) : paramText(v);
  // a numeric `count` selects the plural form
  if (typeof params?.count === 'number') values.count = params.count;
  if (!i18n.exists(key, values)) return null;
  return i18n.t(key as 'errors:codes.WRONG_CREDENTIALS', { ...values, defaultValue: message }) as string;
}

function paramText(v: ErrorParam): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return listFormat().format(v.map(paramText));
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'object') return codeText(v.code, v.params, v.message) ?? v.message;
  return String(v);
}

/**
 * Text to show for an error. API messages are English (they are logged and
 * audited); for errors with a known `code` the UI shows a translated text instead.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code) {
    const text = codeText(e.code, e.params, e.message);
    if (text) return text;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
