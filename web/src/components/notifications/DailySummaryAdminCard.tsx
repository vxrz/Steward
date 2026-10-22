import { Card, Switch, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { DailySummaryAdmin } from '@sm/shared';
import { getOptional, notifyError, notifyOk, put } from '../../api';
import { fmtRelative } from '../../format';

/** Settings → Daily summaries (administrators): the global switch and who subscribed – never the content. */
export function DailySummaryAdminCard() {
  const { t } = useTranslation(['settings', 'profile']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['daily-summary-admin'], queryFn: () => getOptional<DailySummaryAdmin | null>('/settings/daily-summary', null) });
  if (!q.data) return null;
  const d = q.data;
  const toggle = async (allowed: boolean) => {
    try {
      qc.setQueryData(['daily-summary-admin'], await put<DailySummaryAdmin>('/settings/daily-summary', { allowed }));
      notifyOk(t('dailySummary.saved'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {t('dailySummary.title')}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('dailySummary.description')}
      </Text>
      <Switch label={t('dailySummary.allowed')} checked={d.allowed} onChange={(e) => toggle(e.currentTarget.checked)} mb="sm" />
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
