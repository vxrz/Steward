import { DEFAULT_LOCALE, isLocale, type Locale } from '@sm/shared';
import en from './locales/en.json' with { type: 'json' };
import de from './locales/de.json' with { type: 'json' };

/**
 * Server-side message catalog for texts that leave the server in a person's
 * language: in-app notifications, e-mails, Teams cards and webhook messages.
 *
 * Same conventions as the web UI (docs/I18N.md): English is the source of truth,
 * `{{name}}` placeholders, plurals with `_one` / `_other` and a numeric `count`.
 * API errors, logs and audit entries stay English on purpose.
 */
type Catalog = { [key: string]: string | Catalog };

/** Languages with a server catalog; others fall back to English. */
const CATALOGS: Partial<Record<Locale, Catalog>> = { en, de };

/** Dotted paths to the leaves of the English catalog, with plural suffixes removed. */
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K extends `${infer B}_${'one' | 'other'}` ? B : K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<typeof en>;

export type Vars = Record<string, string | number | null | undefined>;

function lookup(cat: Catalog | undefined, key: string): string | undefined {
  let cur: string | Catalog | undefined = cat;
  for (const part of key.split('.')) {
    if (!cur || typeof cur === 'string') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Resolves a locale preference (user setting, setting value, anything) to a supported language. */
export function resolveLocale(...candidates: unknown[]): Locale {
  for (const c of candidates) if (isLocale(c)) return c;
  return DEFAULT_LOCALE;
}

/** Translate `key` into `locale` (falls back to English, then to the key itself). */
export function t(locale: Locale, key: MessageKey, vars: Vars = {}): string {
  const cats = [CATALOGS[locale], CATALOGS[DEFAULT_LOCALE]];
  let text: string | undefined;
  if (typeof vars.count === 'number') {
    const form = new Intl.PluralRules(locale).select(vars.count);
    for (const c of cats) {
      text = lookup(c, `${key}_${form}`) ?? lookup(c, `${key}_other`);
      if (text) break;
    }
  }
  for (const c of cats) {
    if (text) break;
    text = lookup(c, key);
  }
  return (text ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? '' : typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : v;
  });
}

/** Date and time in the given language (server time zone), e.g. for message bodies. */
export function formatDateTime(locale: Locale, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
