import { Select, type SelectProps } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconLanguage } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AuthStatus, UserInfo } from '@sm/shared';
import { notifyError, patch } from '../api';
import { useMe } from '../auth';
import { currentLanguage, setLanguage } from '../i18n';
import { LANGUAGES, isLocale, type Locale } from '../i18n/languages';

/**
 * Switches the UI language. Signed in, the choice is also stored in the profile
 * (notifications use it); signed out, only on this device (localStorage).
 */
export function useChangeLanguage(): (code: Locale) => Promise<void> {
  const qc = useQueryClient();
  const { me } = useMe();
  return async (code) => {
    try {
      await setLanguage(code);
      if (me && me.user.locale !== code) {
        const user = await patch<UserInfo>('/me', { locale: code });
        qc.setQueryData<AuthStatus>(['auth'], (old) => (old?.me ? { ...old, me: { ...old.me, user } } : old));
      }
    } catch (e) {
      notifyError(e);
    }
  };
}

/** Language picker (native language names, so everyone finds their own). */
export function LanguageSelect(props: Omit<SelectProps, 'data' | 'value' | 'onChange'>) {
  const { t, i18n } = useTranslation('nav');
  const change = useChangeLanguage();
  return (
    <Select
      label={t('language')}
      leftSection={<IconLanguage size={16} />}
      allowDeselect={false}
      comboboxProps={{ withinPortal: true }}
      {...props}
      data={LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName }))}
      // i18n.language keeps this in sync when the language changes elsewhere
      value={i18n.language ? currentLanguage() : null}
      onChange={(v) => isLocale(v) && void change(v)}
    />
  );
}
