/**
 * Supported UI languages – the one place to declare them.
 *
 * Adding a language: add a line here, a folder web/src/locales/<code>/ with one
 * JSON file per namespace, and (optional) server/src/i18n/locales/<code>.json for
 * notification texts. See docs/I18N.md.
 */
export const LOCALES = [
  { code: 'en', nativeName: 'English', englishName: 'English' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

export const LOCALE_CODES = LOCALES.map((l) => l.code) as unknown as readonly [Locale, ...Locale[]];

/** Source language: complete, bundled, and the fallback for every missing key. */
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v);
}

/**
 * A browser or system locale as a valid BCP 47 tag for Intl, or null.
 * POSIX forms are mapped first: "en_US.UTF-8" → "en-US", "en-US@posix" → "en-US".
 * Intl throws a RangeError for tags it cannot parse, so anything else that is
 * not a valid tag ("C", "") gives null.
 */
export function canonicalLocale(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string') return null;
  // a real tag is short; cut at the first "." (charset) or "@" (modifier) without a regular expression
  let t = tag.trim().slice(0, 64);
  for (const sep of ['.', '@']) {
    const i = t.indexOf(sep);
    if (i >= 0) t = t.slice(0, i);
  }
  t = t.split('_').join('-');
  if (!t) return null;
  try {
    return Intl.getCanonicalLocales(t)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Locale for Intl formatting: the first preference (navigator.languages) that is a
 * valid tag and matches the UI language (de-AT, en-GB …), otherwise the UI language.
 */
export function pickFormatLocale(prefs: readonly (string | null | undefined)[], lang: string): string {
  for (const p of prefs) {
    const c = canonicalLocale(p);
    if (c && c.toLowerCase().split('-')[0] === lang) return c;
  }
  return lang;
}
