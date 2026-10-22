/**
 * Supported languages. The list itself lives in shared/src/locales.ts (the server
 * validates the per-user setting against it) – this module is the web's entry point.
 *
 * Adding a language = one line in shared/src/locales.ts + a folder web/src/locales/<code>/.
 */
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
export { LOCALES as LANGUAGES, DEFAULT_LOCALE, isLocale, type Locale } from '../../../shared/src/locales';

/** Namespaces (one JSON file per language and namespace). Keep in sync with resources.ts. */
export const NAMESPACES = [
  'common',
  'nav',
  'auth',
  'errors',
  'notifications',
  'access',
  'dashboard',
  'processes',
  'editor',
  'runs',
  'reports',
  'tasks',
  'schedules',
  'triggers',
  'monitors',
  'platforms',
  'dashboards',
  'audit',
  'settings',
  'users',
  'profile',
  'system',
  'credentials',
  'reportSchedules',
  'gatus',
  'mcp',
  'records',
  'services',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** English namespaces bundled with the app shell (sign-in, navigation, notifications). Everything else loads on demand. */
export const BUNDLED_NAMESPACES = ['common', 'nav', 'auth', 'errors', 'notifications'] as const satisfies readonly Namespace[];
