import { ActionIcon, Badge, Box, Button, Center, Drawer, Group, Indicator, Loader, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import { IconBell, IconBellOff, IconChecks, IconSettings } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AppNotification } from '@sm/shared';
import { fmtDate, fmtRelative } from '../../format';
import { useBrowserNotificationBridge, useNotificationActions, useNotifications } from './useNotifications';

const EVENT_COLORS: Record<string, string> = {
  'task.assigned': 'violet',
  'run.failed': 'red',
  'check.failed': 'orange',
  'dataset.stale': 'yellow',
  'schedule.skipped': 'gray',
};

/** Bell with unread badge; opens a drawer with the latest notifications. */
export function NotificationCenter() {
  const { t } = useTranslation('notifications');
  const [opened, { open, close }] = useDisclosure();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const navigate = useNavigate();
  const q = useNotifications();
  const { markRead, markAllRead } = useNotificationActions();
  useBrowserNotificationBridge(q.data);

  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];
  const label = unread ? t('center.labelUnread', { count: unread }) : t('center.title');

  const onItem = (n: AppNotification) => {
    if (!n.read) markRead(n.id);
    if (n.link) {
      close();
      navigate(n.link);
    }
  };

  return (
    <>
      <Tooltip label={label}>
        <Indicator label={unread > 99 ? '99+' : unread} size={16} color="red" disabled={!unread} offset={4} inline>
          <ActionIcon variant="subtle" onClick={open} aria-label={label}>
            <IconBell size={18} />
          </ActionIcon>
        </Indicator>
      </Tooltip>
      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        size={isMobile ? '100%' : 420}
        title={
          <Group gap="xs">
            <Text fw={600}>{t('center.title')}</Text>
            {unread > 0 && (
              <Badge size="sm" color="red" variant="light">
                {t('center.unread', { count: unread })}
              </Badge>
            )}
          </Group>
        }
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Group justify="space-between" mb="sm" gap="xs">
          <Button size="xs" variant="light" leftSection={<IconChecks size={14} />} disabled={!unread} onClick={() => markAllRead()}>
            {t('center.markAllRead')}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<IconSettings size={14} />}
            onClick={() => {
              close();
              navigate('/profile');
            }}
          >
            {t('center.settings')}
          </Button>
        </Group>
        {q.isLoading ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : items.length === 0 ? (
          <Stack align="center" gap={4} py="xl">
            <IconBellOff size={32} stroke={1.4} color="var(--mantine-color-dimmed)" />
            <Text size="sm" c="dimmed" ta="center">
              {q.data?.unavailable ? t('center.unavailable') : t('center.empty')}
            </Text>
          </Stack>
        ) : (
          <Stack gap={4}>
            {items.map((n) => (
              <UnstyledButton
                key={n.id}
                onClick={() => onItem(n)}
                p="sm"
                style={{
                  borderRadius: 8,
                  border: '1px solid var(--mantine-color-default-border)',
                  background: n.read ? undefined : 'var(--mantine-color-blue-light)',
                }}
                aria-label={n.read ? n.title : t('center.unreadItem', { title: n.title })}
              >
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <Box
                    mt={6}
                    w={8}
                    h={8}
                    style={{ borderRadius: '50%', flexShrink: 0, background: n.read ? 'transparent' : 'var(--mantine-color-blue-filled)' }}
                  />
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                      <Text size="sm" fw={n.read ? 500 : 700} style={{ wordBreak: 'break-word' }}>
                        {n.title}
                      </Text>
                      <Tooltip label={fmtDate(n.ts)}>
                        <Text size="xs" c="dimmed" className="nowrap">
                          {fmtRelative(n.ts)}
                        </Text>
                      </Tooltip>
                    </Group>
                    {n.body && (
                      <Text size="xs" c="dimmed" lineClamp={3} style={{ wordBreak: 'break-word' }}>
                        {n.body}
                      </Text>
                    )}
                    <Badge size="xs" variant="light" color={EVENT_COLORS[n.event] ?? 'gray'} mt={4} tt="none">
                      {t(`events.${n.event}.label` as 'events.run.failed.label', { defaultValue: n.event })}
                    </Badge>
                  </Box>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
