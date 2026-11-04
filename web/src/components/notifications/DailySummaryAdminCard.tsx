import { useEffect, useState } from 'react';
import { Button, Card, Group, Switch, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DailySummaryAdmin } from '@sm/shared';
import { getOptional, notifyError, notifyOk, put } from '../../api';
import { fmtRelative } from '../../format';
import { useSaveSection } from '../settings/SaveBar';

/**
 * Settings → Daily summaries (administrators): the global switch and who subscribed – never the content. The switch is
 * saved with the area's save bar like the other settings (0.4.0; before, it saved at once).
 */
export function DailySummaryAdminCard() {
  const { t } = useTranslation(['settings', 'profile', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['daily-summary-admin'], queryFn: () => getOptional<DailySummaryAdmin | null>('/settings/daily-summary', null) });
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
      qc.setQueryData(['daily-summary-admin'], await put<DailySummaryAdmin>('/settings/daily-summary', { allowed }));
      notifyOk(t('dailySummary.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('dailySummary', { dirty, save, reset: () => q.data && setAllowed(q.data.allowed) });
  if (!q.data || allowed === null) return null;
  const d = q.data;
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {t('dailySummary.title')}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('dailySummary.description')}
      </Text>
      <Switch label={t('dailySummary.allowed')} checked={allowed} onChange={(e) => setAllowed(e.currentTarget.checked)} mb="sm" />
      {!inBar && dirty && (
        <Group justify="flex-end" mb="sm">
          <Button size="xs" onClick={() => void save()} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      )}
      {d.subscribers.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('dailySummary.none')}
        </Text>
      ) : (
        <>
          <Text size="sm" mb={4}>
            {t('dailySummary.subscribers', { count: d.subscribers.length })}
          </Text>
          <div className="table-scroll">
            <Table fz="sm" aria-label={t('dailySummary.title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('dailySummary.user')}</Table.Th>
                  <Table.Th>{t('dailySummary.when')}</Table.Th>
                  <Table.Th>{t('dailySummary.channel')}</Table.Th>
                  <Table.Th>{t('dailySummary.lastSent')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {d.subscribers.map((s) => (
                  <Table.Tr key={s.username}>
                    <Table.Td>
                      {s.displayName}
                      <Text size="xs" c="dimmed">
                        {s.username}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {t('dailySummary.whenValue', { time: s.time, timeZone: s.timeZone, days: t(`profile:dailySummary.daysOptions.${s.days}`) })}
                    </Table.Td>
                    <Table.Td>{t(`profile:dailySummary.channelOptions.${s.channel}`)}</Table.Td>
                    <Table.Td>{s.lastSentAt ? fmtRelative(s.lastSentAt) : t('dailySummary.never')}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        </>
      )}
    </Card>
  );
}
