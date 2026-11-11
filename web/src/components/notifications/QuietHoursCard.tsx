import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Divider, Group, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconArrowBackUp, IconMoon } from '@tabler/icons-react';
import { DIGEST_GROUPS, type NotificationPrefs, type NotificationPrefsState, type QuietHoursAdmin } from '@sm/shared';
import { del, get, getOptional, notifyError, notifyOk, put } from '../../api';
import { useSaveSection } from '../settings/SaveBar';
import { browserZone, zones } from './DailySummaryCard';
import { DigestFields, QuietHoursFields } from './QuietHoursFields';
import { TableScroll } from '../TableScroll';

const KEY = ['notification-prefs'];
const ADMIN_KEY = ['quiet-hours-admin'];

/** The time zone list with the current one first when the browser does not know it. */
export function useZoneList(current: string | undefined): string[] {
  return useMemo(() => {
    const list = zones();
    return current && !list.includes(current) ? [current, ...list] : list;
  }, [current]);
}

/** Profile → Quiet hours and digests (ADR 0012): the person's own settings, else a team default. */
export function QuietHoursCard() {
  const { t } = useTranslation(['notifications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => get<NotificationPrefsState>('/me/notification-prefs') });
  const [d, setD] = useState<NotificationPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const zoneList = useZoneList(d?.quietHours.timeZone);
  useEffect(() => {
    if (!q.data) return;
    const p = q.data.prefs;
    // a first visit starts in the browser's time zone
    const fresh = q.data.source.from === 'instance' && p.quietHours.timeZone === 'UTC';
    setD(fresh ? { quietHours: { ...p.quietHours, timeZone: browserZone() }, digests: { ...p.digests, timeZone: browserZone() } } : p);
  }, [q.data]);
  if (!q.data || !d) return null;
  const st = q.data;
  const run = async (fn: () => Promise<NotificationPrefsState>, ok: string) => {
    setBusy(true);
    try {
      qc.setQueryData(KEY, await fn());
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      notifyOk(ok);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const anyDigest = DIGEST_GROUPS.some((g) => d.digests.groups[g]);
  return (
    <Card withBorder data-testid="quiet-hours-card">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Title order={5}>{t('quiet.title')}</Title>
        <Badge variant="light" color={st.source.from === 'own' ? 'blue' : 'gray'} data-testid="quiet-source">
          {st.source.from === 'team' ? t('quiet.source.team', { team: st.source.team }) : t(`quiet.source.${st.source.from}`)}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('quiet.intro')}
      </Text>
      <Stack gap="sm">
        {!st.allowed && (
          <Alert color="gray" variant="light">
            {t('quiet.notAllowed')}
          </Alert>
        )}
        {st.quiet.active && (
          <Group gap={6} wrap="nowrap">
            <IconMoon size={14} color="var(--mantine-color-dimmed)" aria-hidden />
            <Text size="sm" data-testid="quiet-now">
              {st.quiet.until ? t('center.quietUntil', { time: st.quiet.until, count: st.quiet.held }) : t('center.quiet', { count: st.quiet.held })}
            </Text>
          </Group>
        )}
        <QuietHoursFields value={d.quietHours} onChange={(quietHours) => setD({ ...d, quietHours })} zoneList={zoneList} />
        <Divider />
        <div>
          <Text fw={600} size="sm">
            {t('quiet.digests')}
          </Text>
          <Text size="xs" c="dimmed">
            {t(anyDigest ? 'quiet.digestsIntro' : 'quiet.digestsOff')}
          </Text>
        </div>
        <DigestFields value={d.digests} onChange={(digests) => setD({ ...d, digests })} zoneList={zoneList} />
        <Group justify="flex-end" gap="xs" wrap="wrap">
          {st.source.from === 'own' && (
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconArrowBackUp size={14} />}
              loading={busy}
              onClick={() => void run(() => del<NotificationPrefsState>('/me/notification-prefs'), t('quiet.resetDone'))}
            >
              {t('quiet.backToDefault')}
            </Button>
          )}
          <Button size="xs" loading={busy} onClick={() => void run(() => put<NotificationPrefsState>('/me/notification-prefs', d), t('quiet.saved'))}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

/** Settings → Notifications: the switch for everyone and who uses quiet hours and digests (never the content). */
export function QuietHoursAdminCard() {
  const { t } = useTranslation(['notifications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ADMIN_KEY, queryFn: () => getOptional<QuietHoursAdmin | null>('/settings/quiet-hours', null) });
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setAllowed(q.data.allowed);
  }, [q.data]);
  const dirty = !!q.data && allowed !== null && allowed !== q.data.allowed;
  const save = async () => {
    if (allowed === null) return;
    setBusy(true);
    try {
      qc.setQueryData(ADMIN_KEY, await put<QuietHoursAdmin>('/settings/quiet-hours', { allowed }));
      notifyOk(t('quiet.admin.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('quietHours', { dirty, save, reset: () => q.data && setAllowed(q.data.allowed) });
  if (!q.data || allowed === null) return null;
  const d = q.data;
  return (
    <Card withBorder data-testid="quiet-hours-admin">
      <Title order={5} mb="xs">
        {t('quiet.admin.title')}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('quiet.admin.description')}
      </Text>
      <Switch label={t('quiet.admin.allowed')} checked={allowed} onChange={(e) => setAllowed(e.currentTarget.checked)} mb="sm" />
      {!inBar && dirty && (
        <Group justify="flex-end" mb="sm">
          <Button size="xs" onClick={() => void save()} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      )}
      {d.users.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('quiet.admin.none')}
        </Text>
      ) : (
        <TableScroll>
          <Table fz="sm" aria-label={t('quiet.admin.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('quiet.admin.user')}</Table.Th>
                <Table.Th>{t('quiet.admin.quietHours')}</Table.Th>
                <Table.Th>{t('quiet.digests')}</Table.Th>
                <Table.Th>{t('quiet.admin.held')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.users.map((u) => (
                <Table.Tr key={u.username}>
                  <Table.Td>
                    {u.displayName}
                    <Text size="xs" c="dimmed">
                      {u.username}
                      {u.source === 'team' ? ` · ${t('quiet.admin.fromTeam')}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>{u.quietHours ? u.timeZone : t('quiet.admin.off')}</Table.Td>
                  <Table.Td>
                    {Object.entries(u.digests)
                      .map(([g, r]) => `${t(`quiet.groups.${g as (typeof DIGEST_GROUPS)[number]}`)}: ${t(`quiet.rhythms.${r}`)}`)
                      .join(', ') || t('quiet.rhythms.immediately')}
                  </Table.Td>
                  <Table.Td>{u.held}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      {d.channels.length > 0 && (
        <Text size="xs" c="dimmed" mt="sm">
          {t('quiet.admin.channelsHeld', { count: d.channels.reduce((n, c) => n + c.held, 0) })}
        </Text>
      )}
    </Card>
  );
}
