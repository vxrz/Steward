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
  // own properties only: "constructor", "__proto__" and the like never resolve to Object.prototype
  const value = key
    .split('.')
    .reduce<string | Catalog | undefined>((cur, part) => (cur && typeof cur !== 'string' && Object.hasOwn(cur, part) ? cur[part] : undefined), cat);
  return typeof value === 'string' ? value : undefined;
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
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(
    d,
  );
}

/** English dates read the British way (11 Dec 2026), as in the UI's English style (docs/I18N.md). */
const dateLocale = (locale: Locale): string => (locale === 'en' ? 'en-GB' : locale);

/** A calendar day (`YYYY-MM-DD`) in the given language for message bodies: "11 Dec 2026", "11.12.2026". Anything else is returned as it is. */
export function formatDay(locale: Locale, day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  // noon UTC, formatted in UTC: the same calendar day whatever the server's time zone
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

/** A month (`YYYY-MM`) in the given language: "November 2026". Anything else is returned as it is. */
export function formatMonth(locale: Locale, month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15, 12));
  return new Intl.DateTimeFormat(dateLocale(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
