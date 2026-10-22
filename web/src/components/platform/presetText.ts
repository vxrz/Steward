import type { PlatformPreset } from '@sm/shared';
import i18n from '../../i18n';

/** Key of a built-in preset (two presets can share a kind, so the English label identifies it). */
const presetKey = (p: Pick<PlatformPreset, 'label'>) =>
  p.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const tx = (key: string, defaultValue: string) => i18n.t(key as 'platforms:title', { defaultValue }) as string;

/**
 * Texts of built-in connector presets come from the server in English and are translated here;
 * custom connector types are user content and stay as written.
 */
export function presetDescription(p: Pick<PlatformPreset, 'label' | 'description' | 'custom'>): string {
  return p.custom ? p.description : tx(`platforms:presets.${presetKey(p)}.description`, p.description);
}

export function presetSecretLabel(p: Pick<PlatformPreset, 'label' | 'custom'>, f: { key: string; label: string }): string {
  return p.custom ? f.label : tx(`platforms:presets.${presetKey(p)}.secrets.${f.key}`, f.label);
}

export function presetSecretHelp(p: Pick<PlatformPreset, 'label' | 'custom'>, f: { key: string; help?: string }): string | undefined {
  if (!f.help) return undefined;
  return p.custom ? f.help : tx(`platforms:presets.${presetKey(p)}.secretHelp.${f.key}`, f.help);
}

export type AuthType = 'none' | 'basic' | 'bearer' | 'apiKey' | 'oauth2_client_credentials' | 'token_request';
const AUTH_TYPES: AuthType[] = ['none', 'basic', 'bearer', 'apiKey', 'oauth2_client_credentials', 'token_request'];

export function authLabel(type: string | undefined): string {
  const t = (type ?? 'none') as AuthType;
  return AUTH_TYPES.includes(t) ? i18n.t(`platforms:auth.${t}`) : (type ?? '');
}
