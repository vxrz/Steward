import { useState } from 'react';
import { Avatar, Badge, Group, Menu, Modal, Stack, Text, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { IconChevronDown, IconDownload, IconKey, IconLock, IconLogout, IconMoon, IconSun, IconUser } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notifyError, post } from '../api';
import { useMe } from '../auth';
import { ChangePasswordForm } from '../pages/Auth';
import { useInstallPrompt } from '../pwa';

export async function signOut(qc: ReturnType<typeof useQueryClient>): Promise<void> {
  try {
    await post('/auth/logout');
  } catch {
    /* ignore */
  }
  qc.clear();
  await qc.invalidateQueries();
}

export function UserMenu() {
  const { me, isAdmin } = useMe();
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
          <UnstyledButton aria-label="User menu">
            <Group gap={6} wrap="nowrap">
              <Avatar size={28} radius="xl" color="blue">
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
                  {r}
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
            Profile &amp; API tokens
          </Menu.Item>
          <Menu.Item
            hiddenFrom="xs"
            leftSection={colorScheme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
            onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
          >
            {colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Menu.Item>
          {canInstall && (
            <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => install().catch(() => undefined)}>
              Install app
            </Menu.Item>
          )}
          {(!me.user.authSource || me.user.authSource === 'local') && (
            <Menu.Item leftSection={<IconKey size={14} />} onClick={() => setPwOpen(true)}>
              Change password
            </Menu.Item>
          )}
          {isAdmin && (
            <Menu.Item
              leftSection={<IconLock size={14} />}
              onClick={async () => {
                if (!confirm('Lock the vault? Schedules stop and everybody waits until an administrator unlocks it again.')) return;
                try {
                  await post('/vault/lock');
                  qc.clear();
                  await qc.invalidateQueries();
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              Lock vault
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconLogout size={14} />} color="red" onClick={() => signOut(qc)}>
            Sign out
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={pwOpen} onClose={() => setPwOpen(false)} title="Change password">
        <ChangePasswordForm onDone={() => setPwOpen(false)} />
      </Modal>
    </>
  );
}
