import 'i18next';
import type { DefaultNamespace, Namespace, ParseKeys, TOptions } from 'i18next';
import type { Resources } from './keys.gen';

// Type-safe keys: t('processes:title') is checked against the English JSON files, so a typo or a removed key is a
// compile error. Two things keep this affordable for TypeScript (the web typecheck needed about a third more memory
// before 0.13 and a 4 GB heap):
// - the keys come flat ("a.b.c": string per namespace) from keys.gen.ts, generated from web/src/locales/en by
//   `npm run i18n:types` (run by `npm run typecheck`, checked in CI with --check), instead of the nested JSON that
//   i18next walks key by key;
// - t() gets a first, non-generic overload: a key (or keys) of the hook's namespaces and the options. Ordinary calls
//   stop there; only calls it does not cover (a `context` option, a key outside the list with a `defaultValue`) reach
//   i18next's generic signatures – which still check them as before. The result is a string either way.
// Interpolation values are not typed (they were not before either: the JSON texts are plain `string` types).
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: Resources;
    parseInterpolation: false;
  }
  interface TFunction<Ns extends Namespace = DefaultNamespace, KPrefix = undefined> {
    // `{}`: i18next's own "no options", so the key list is the one i18next computes (and caches) for the namespaces
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    (key: ParseKeys<Ns, {}, KPrefix> | ParseKeys<Ns, {}, KPrefix>[], options?: TOptions): string;
  }
}
