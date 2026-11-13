import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Drawer,
  Group,
  Indicator,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import { IconBell, IconBellOff, IconCheck, IconChecks, IconMoon, IconSettings } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NOTIFICATION_CATEGORIES, notificationCategory, type AppNotification, type NotificationCategory } from '@sm/shared';
import { fmtDate, fmtRelative } from '../../format';
import { NOTIFICATION_LIMIT, useBrowserNotificationBridge, useNotificationActions, useNotifications } from './useNotifications';
import { ShowAll, useShowMore } from '../page/ShowAll';

/** Items a group shows before "Show all" (decision groups always show everything). */
const GROUP_PREVIEW = 3;

interface Group {
  event: string;
  category: NotificationCategory;
  items: AppNotification[];
  unread: number;
}

/**
 * The notifications grouped by event (U9 of the 0.10 review): decision requests first, then the groups with unread
 * entries, newest first – so one decision never drowns among dozens of check alerts.
 */
export function groupNotifications(items: AppNotification[]): Group[] {
  const by = new Map<string, Group>();
  for (const n of items) {
    const g = by.get(n.event) ?? { event: n.event, category: notificationCategory(n.event), items: [], unread: 0 };
    g.items.push(n);
    if (!n.read) g.unread++;
    by.set(n.event, g);
  }
  const rank = (g: Group) => (g.category === 'decision' ? 0 : 1);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || Number(b.unread > 0) - Number(a.unread > 0) || (b.items[0]!.ts > a.items[0]!.ts ? 1 : -1));
}

const EVENT_COLORS: Record<string, string> = {
  'task.assigned': 'violet',
  'run.failed': 'red',
  'check.failed': 'orange',
  'dataset.stale': 'yellow',
  'schedule.skipped': 'gray',
  'platform.failing': 'red',
  'ai.budget': 'orange',
  'cost.budget': 'orange',
  'cost.booking_due': 'orange',
  'cost.volume': 'orange',
  'cost.price_review_due': 'yellow',
  'contract.failed': 'red',
  'plant.advisory_matched': 'red',
  'monitor.state': 'gray',
  'plant.change_proposed': 'violet',
  'plant.change_decided': 'blue',
  'soa.approval_waiting': 'violet',
  'dataproduct.deprecated': 'orange',
  'dataproduct.elements_missing': 'yellow',
  'dataproduct.discovery_failed': 'red',
  'dataproduct.contract_breaking': 'orange',
};

/** Bell with unread badge; opens a drawer with the latest notifications. */
export function NotificationCenter() {
  const { t } = useTranslation('notifications');
  const [opened, { open, close }] = useDisclosure();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const navigate = useNavigate();
  const q = useNotifications();
  const { markRead, markAllRead, markEventsRead } = useNotificationActions();
  const [category, setCategory] = useState<'all' | NotificationCategory>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  useBrowserNotificationBridge(q.data);

  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];
  const counts = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, items.filter((n) => notificationCategory(n.event) === c).length]));
  const capped = items.length >= NOTIFICATION_LIMIT;
  const shown = items.filter((n) => (category === 'all' || notificationCategory(n.event) === category) && (!unreadOnly || !n.read));
  const groups = groupNotifications(shown);
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
        {q.data?.quiet && (
          <Group gap={6} mb="sm" wrap="nowrap" data-testid="quiet-hours-line">
            <IconMoon size={14} color="var(--mantine-color-dimmed)" aria-hidden />
            <Text size="xs" c="dimmed">
              {q.data.quiet.until
                ? t('center.quietUntil', { time: q.data.quiet.until, count: q.data.quiet.held })
                : t('center.quiet', { count: q.data.quiet.held })}
            </Text>
          </Group>
        )}
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
          <>
            <Group gap="xs" mb="sm" wrap="wrap" justify="space-between">
              <SegmentedControl
                size="xs"
                aria-label={t('center.filter')}
                value={category}
                onChange={(v) => setCategory(v as typeof category)}
                data={[
                  // the bell loads the latest messages only: "Latest 50", not "All 50" next to "68 unread"
                  { value: 'all', label: t(capped ? 'center.latest' : 'center.all', { count: items.length }) },
                  ...NOTIFICATION_CATEGORIES.map((c) => ({ value: c, label: t(`center.category.${c}`, { count: counts[c] }) })),
                ]}
                data-testid="notification-filter"
              />
              <Switch size="xs" label={t('center.unreadOnly')} checked={unreadOnly} onChange={(e) => setUnreadOnly(e.currentTarget.checked)} />
            </Group>
            {groups.length === 0 && (
              <Text size="sm" c="dimmed" ta="center" py="md">
                {t('center.noneHere')}
              </Text>
            )}
            <Stack gap="md">
              {groups.map((g) => (
                <NotificationGroupView key={g.event} g={g} onItem={onItem} onMarkRead={() => void markEventsRead([g.event])} />
              ))}
            </Stack>
            {capped && (
              <Text size="xs" c="dimmed" ta="center" mt="md" data-testid="notifications-capped">
                {t('center.cappedHint', { count: items.length })}
              </Text>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

/** One group of the drawer: its first entries, "Show all N" for the rest (decision requests: all of them). */
function NotificationGroupView({ g, onItem, onMarkRead }: { g: Group; onItem: (n: AppNotification) => void; onMarkRead: () => void }) {
  const { t } = useTranslation('notifications');
  // decision requests always in full; a group with one entry more than the preview, too
  const list = useShowMore(g.items, g.category === 'decision' || g.items.length <= GROUP_PREVIEW + 1 ? g.items.length : GROUP_PREVIEW);
  const name = t(`events.${g.event}.label` as 'events.run.failed.label', { defaultValue: g.event });
  return (
    <Box component="section" aria-label={name} data-testid={`notification-group-${g.event}`} data-category={g.category}>
      <Group justify="space-between" gap="xs" mb={4} wrap="nowrap">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Badge size="sm" variant={g.category === 'decision' ? 'filled' : 'light'} color={EVENT_COLORS[g.event] ?? 'gray'} tt="none">
            {name}
          </Badge>
          <Text size="xs" c="dimmed" className="nowrap">
            {g.unread ? t('center.groupCountUnread', { count: g.items.length, unread: g.unread }) : t('center.groupCount', { count: g.items.length })}
          </Text>
        </Group>
        {g.unread > 0 && (
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconCheck size={12} />}
            onClick={onMarkRead}
            aria-label={t('center.markGroupReadNamed', { name })}
          >
            {t('center.markGroupRead')}
          </Button>
        )}
      </Group>
      <Stack gap={4}>
        {list.items.map((n) => (
          <UnstyledButton
            key={n.id}
            onClick={() => onItem(n)}
            p="sm"
            style={{
              borderRadius: 8,
              border: '1px solid var(--mantine-color-default-border)',
              background: n.read ? undefined : 'var(--mantine-color-blue-light)',
            }}
          >
            {/* the visible text is the accessible name (WCAG 2.5.3); unread ones are marked for screen readers */}
            {!n.read && <VisuallyHidden>{t('center.unreadPrefix')}</VisuallyHidden>}
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Box mt={6} w={8} h={8} style={{ borderRadius: '50%', flexShrink: 0, background: n.read ? 'transparent' : 'var(--mantine-color-blue-filled)' }} />
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
              </Box>
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
      <ShowAll state={list} id={`notifications-${g.event}`} />
    </Box>
  );
}
