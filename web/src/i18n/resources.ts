// English is the source language. Only the namespaces in BUNDLED_NAMESPACES are part of the first download; the
// other English files are loaded on demand like every other language. The key types come from keys.gen.ts,
// generated from the English files by `npm run i18n:types` (see i18next.d.ts).
import auth from '../locales/en/auth.json';
import common from '../locales/en/common.json';
import errors from '../locales/en/errors.json';
import nav from '../locales/en/nav.json';
import notifications from '../locales/en/notifications.json';

export const bundledEnglish = { common, nav, auth, errors, notifications };
