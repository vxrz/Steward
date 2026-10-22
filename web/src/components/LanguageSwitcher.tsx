import { Button, Menu } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconLanguage } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AuthStatus, UserInfo } from '@sm/shared';
import { notifyError, patch } from '../api';
import { useMe } from '../auth';
import { currentLanguage, setLanguage } from '../i18n';
import { LANGUAGES, type Locale } from '../i18n/languages';

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

/** Compact language menu for the sign-in pages (Menu is part of the app shell already – no extra download). */
export function LanguageMenu() {
  const { t } = useTranslation('nav');
  const change = useChangeLanguage();
  const active = currentLanguage();
  return (
    <Menu position="bottom-end" width={180}>
      <Menu.Target>
        <Button variant="subtle" color="gray" size="xs" leftSection={<IconLanguage size={16} />} aria-label={t('language')}>
          {LANGUAGES.find((l) => l.code === active)?.nativeName}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('language')}</Menu.Label>
        {LANGUAGES.map((l) => (
          <Menu.Item
            key={l.code}
            lang={l.code}
            leftSection={active === l.code ? <IconCheck size={14} /> : <span style={{ width: 14, display: 'inline-block' }} />}
            onClick={() => void change(l.code)}
          >
            {l.nativeName}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
