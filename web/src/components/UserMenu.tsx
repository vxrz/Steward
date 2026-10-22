import { useState } from 'react';
import { Avatar, Badge, Group, Menu, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconKey, IconLock, IconLogout } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { notifyError, post } from '../api';
import { useMe } from '../auth';
import { ChangePasswordForm } from '../pages/Auth';

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
          <Menu.Item leftSection={<IconKey size={14} />} onClick={() => setPwOpen(true)}>
            Change password
          </Menu.Item>
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
