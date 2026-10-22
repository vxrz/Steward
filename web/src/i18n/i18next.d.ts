import 'i18next';
import type { Resources } from './resources';

// Type-safe keys: t('processes:title') is checked against the English JSON files,
// so a typo or a removed key is a compile error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: Resources;
  }
}
