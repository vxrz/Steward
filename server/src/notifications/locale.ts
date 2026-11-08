import type { Locale, UserInfo } from '@sm/shared';
import { getSettings } from '../settings.js';
import { resolveLocale } from '../i18n/index.js';

/** The language of messages: the instance default, or the recipient's own (its own module, so cards need not load the service). */
export const defaultLocale = (): Locale => resolveLocale(getSettings().defaultLocale);
/** The recipient's chosen language, else the default language. */
export const userLocale = (u: UserInfo, fallback = defaultLocale()): Locale => resolveLocale(u.locale, fallback);
