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
