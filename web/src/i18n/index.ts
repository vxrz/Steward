import i18n, { type BackendModule, type ReadCallback } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { BUNDLED_NAMESPACES, DEFAULT_LOCALE, LANGUAGES, isLocale, type Locale } from './languages';
import { bundledEnglish } from './resources';

/** localStorage key of the language chosen on this device (sign-in page, before the profile setting is known). */
export const LANGUAGE_STORAGE_KEY = 'steward.language';

// Every locale file except the bundled English ones becomes its own small chunk.
const lazyFiles = import.meta.glob<{ default: Record<string, unknown> }>([
  '../locales/*/*.json',
  '!../locales/en/common.json',
  '!../locales/en/nav.json',
  '!../locales/en/auth.json',
  '!../locales/en/errors.json',
  '!../locales/en/notifications.json',
]);

/** i18next backend that loads web/src/locales/<lng>/<ns>.json with a dynamic import. */
const lazyBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(lng: string, ns: string, callback: ReadCallback) {
    const load = lazyFiles[`../locales/${lng}/${ns}.json`];
    // A language may not have every namespace yet: missing keys fall back to English.
    if (!load) return callback(null, {});
    load().then(
      (m) => callback(null, m.default),
      (err: Error) => callback(err, false),
    );
  },
};

void i18n
  .use(lazyBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: bundledEnglish },
    partialBundledLanguages: true,
    ns: [...BUNDLED_NAMESPACES],
    defaultNS: 'common',
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      // The detector's own localStorage cache guards against blocked storage.
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: true },
    // Development: report keys that exist in no language (typos in dynamic keys).
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: (lngs, ns, key) => console.warn(`[i18n] missing key "${ns}:${key}" (${lngs.join(', ')})`),
  });

const applyToDocument = (lng: string) => {
  document.documentElement.lang = lng;
  document.documentElement.dir = i18n.dir(lng);
};
i18n.on('languageChanged', applyToDocument);
if (i18n.resolvedLanguage) applyToDocument(i18n.resolvedLanguage);

/** The active UI language (one of LANGUAGES). */
export function currentLanguage(): Locale {
  const l = i18n.resolvedLanguage ?? i18n.language;
  return isLocale(l) ? l : DEFAULT_LOCALE;
}

/** Switch the UI language. Loads all namespaces in use first, so the page does not flash a loader. */
export async function setLanguage(code: Locale): Promise<void> {
  if (code === currentLanguage() && i18n.language === code) return;
  await i18n.loadLanguages(code);
  await i18n.changeLanguage(code);
}

/**
 * Locale for Intl formatting: the browser's regional variant when it matches the
 * UI language (de-AT, en-GB …), otherwise the UI language itself.
 */
export function formatLocale(): string {
  const lang = currentLanguage();
  const prefs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  return prefs.find((p) => p?.toLowerCase().split('-')[0] === lang) ?? lang;
}

export default i18n;
