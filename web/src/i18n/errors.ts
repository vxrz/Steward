import { ApiError } from '../api';
import i18n from './index';

/**
 * Text to show for an error. API messages are English (they are logged and
 * audited); for errors with a known `code` the UI shows a translated text instead.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code) {
    const key = `errors:codes.${e.code}`;
    if (i18n.exists(key)) return i18n.t(key as 'errors:codes.WRONG_CREDENTIALS');
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
