import { useState } from 'react';
import { Avatar, Badge, Group, Menu, Modal, Stack, Text, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import {
  IconActivityHeartbeat,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconInfoCircle,
  IconKey,
  IconLock,
  IconLogout,
  IconMoon,
  IconSun,
  IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifyError, post } from '../api';
import { useMe } from '../auth';
import { ChangePasswordForm } from '../pages/Auth';
import { useInstallPrompt } from '../pwa';
import { currentLanguage } from '../i18n';
import { LANGUAGES } from '../i18n/languages';
import { useChangeLanguage } from './LanguageSwitcher';
import { BRAND } from '../../../shared/src/brand';

export async function signOut(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  try {
    await post('/auth/logout');
  } catch {
    /* ignore */
  }
  await resetToAuth(qc);
}

/**
 * Drop all cached data and re-check the session. (qc.clear() alone detaches the mounted ['auth'] query from
 * the cache, so the app kept showing the signed-in shell after signing out.)
 */
async function resetToAuth(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  await qc.cancelQueries();
  // (the theme is public and stays: it also styles the sign-in page)
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' && q.queryKey[0] !== 'theme' });
  await qc.invalidateQueries({ queryKey: ['auth'] });
}

export function UserMenu() {
  const { t } = useTranslation(['nav', 'common']);
  const { me, isAdmin, caps } = useMe();
  const changeLanguage = useChangeLanguage();
  const qc = useQueryClient();
  const [pwOpen, setPwOpen] = useState(false);
  const navigate = useNavigate();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { canInstall, install } = useInstallPrompt();
  if (!me) return null;
  const initials = me.user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <>
      <Menu position="bottom-end" width={240}>
        <Menu.Target>
          <UnstyledButton aria-label={t('userMenu.label')}>
            <Group gap={6} wrap="nowrap">
              <Avatar size={28} radius="xl" color="brand">
                {initials}
              </Avatar>
              <Text size="sm" visibleFrom="xs" truncate maw={160}>
                {me.user.displayName}
              </Text>
              <IconChevronDown size={14} />
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Stack gap={4} p="xs">
            <Text size="sm" fw={600}>
              {me.user.displayName}
            </Text>
            <Text size="xs" c="dimmed">
              {me.user.username}
              {me.user.email ? ` · ${me.user.email}` : ''}
            </Text>
            <Group gap={4}>
              {me.user.roles.map((r) => (
                <Badge key={r} size="xs" variant="light">
                  {t(`common:roles.${r}`)}
                </Badge>
              ))}
              {me.user.teams.map((t) => (
                <Badge key={t} size="xs" variant="outline" color="gray">
                  {t}
                </Badge>
              ))}
            </Group>
          </Stack>
          <Menu.Divider />
          <Menu.Item leftSection={<IconUser size={14} />} onClick={() => navigate('/profile')}>
            {t('items.profile')}
          </Menu.Item>
          {caps.viewAudit && (
            <Menu.Item leftSection={<IconActivityHeartbeat size={14} />} onClick={() => navigate('/settings/status')}>
              {t('userMenu.systemStatus')}
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconInfoCircle size={14} />} onClick={() => navigate('/about')}>
            {t('userMenu.about', { brand: BRAND.name })}
          </Menu.Item>
          <Menu.Item
            hiddenFrom="xs"
            leftSection={colorScheme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
            onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
          >
            {colorScheme === 'dark' ? t('lightMode') : t('darkMode')}
          </Menu.Item>
          {canInstall && (
            <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => install().catch(() => undefined)}>
              {t('userMenu.installApp')}
            </Menu.Item>
          )}
          {(!me.user.authSource || me.user.authSource === 'local') && (
            <Menu.Item leftSection={<IconKey size={14} />} onClick={() => setPwOpen(true)}>
              {t('userMenu.changePassword')}
            </Menu.Item>
          )}
          {isAdmin && (
            <Menu.Item
              leftSection={<IconLock size={14} />}
              onClick={async () => {
                if (!confirm(t('userMenu.lockVaultConfirm'))) return;
                try {
                  await post('/vault/lock');
                  await resetToAuth(qc);
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              {t('userMenu.lockVault')}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Label>{t('language')}</Menu.Label>
          {LANGUAGES.map((l) => (
            <Menu.Item
              key={l.code}
              lang={l.code}
              leftSection={currentLanguage() === l.code ? <IconCheck size={14} /> : <span style={{ width: 14, display: 'inline-block' }} />}
              onClick={() => void changeLanguage(l.code)}
            >
              {l.nativeName}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item leftSection={<IconLogout size={14} />} color="red" onClick={() => signOut(qc)}>
            {t('userMenu.signOut')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={pwOpen} onClose={() => setPwOpen(false)} title={t('userMenu.changePassword')}>
        <ChangePasswordForm onDone={() => setPwOpen(false)} />
      </Modal>
    </>
  );
}
