import { useEffect, useState } from 'react';
import { Button, Card, Group, NumberInput, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconHistory } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_HISTORY_RETENTION, type PlantHistorySettingsInput, type PlantHistorySettingsView, type PlantSettings } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { fmtBytes, fmtNumber } from '../../format';
import { plantKeys } from '../../queryKeys';
import { useSaveSection } from '../settings/SaveBar';

const FIELDS = ['removedHistoryDays', 'closedDays', 'baselinesPerEntry'] as const;
const valid = (d: PlantHistorySettingsInput) =>
  FIELDS.every((k) => Number.isInteger(d[k]) && d[k] >= PLANT_HISTORY_RETENTION[k].min && d[k] <= PLANT_HISTORY_RETENTION[k].max);
const inputOf = (v: PlantHistorySettingsView): PlantHistorySettingsInput => ({
  removedHistoryDays: v.settings.removedHistoryDays,
  closedDays: v.settings.closedDays,
  baselinesPerEntry: v.settings.baselinesPerEntry,
});

/**
 * Settings → Data → Plant registry history (0.15.0, ADR 0020): how long the history of removed entries and closed
 * change sets are kept and how many of the import's baselines per entry, with what they take in the database now.
 * Administrators; saved with the area's save bar, audited.
 */
export function PlantHistorySettingsCard() {
  const { t } = useTranslation('plantChanges');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: plantKeys.historySettings, queryFn: () => get<PlantHistorySettingsView>('/settings/plant/history') });
  const [d, setD] = useState<PlantHistorySettingsInput | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setD(inputOf(q.data));
  }, [q.data]);
  const dirty = !!d && !!q.data && FIELDS.some((k) => d[k] !== q.data.settings[k]);
  const save = async () => {
    if (!d) return;
    setBusy(true);
    try {
      qc.setQueryData(plantKeys.historySettings, await put<PlantHistorySettingsView>('/settings/plant/history', d));
      notifyOk(t('retention.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('plantHistory', { dirty, valid: !!d && valid(d), save, reset: () => q.data && setD(inputOf(q.data)) });
  if (!q.data || !d) return null;
  const u = q.data.usage;
  const size = (n: number) => (n < 0 ? t('retention.sizeUnknown') : fmtBytes(n));
  const field = (k: (typeof FIELDS)[number]) => (
    <NumberInput
      key={k}
      label={t(`retention.${k}`)}
      description={t(`retention.${k}Hint`, { min: fmtNumber(PLANT_HISTORY_RETENTION[k].min), max: fmtNumber(PLANT_HISTORY_RETENTION[k].max) })}
      min={PLANT_HISTORY_RETENTION[k].min}
      max={PLANT_HISTORY_RETENTION[k].max}
      allowDecimal={false}
      clampBehavior="none"
      value={d[k]}
      onChange={(v) => setD({ ...d, [k]: typeof v === 'number' ? v : NaN })}
      error={!Number.isInteger(d[k]) || d[k] < PLANT_HISTORY_RETENTION[k].min || d[k] > PLANT_HISTORY_RETENTION[k].max ? true : undefined}
      data-testid={`plant-history-${k}`}
    />
  );
  return (
    <Card withBorder data-testid="plant-history-settings">
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconHistory size={18} aria-hidden />
        <Title order={5}>{t('retention.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('retention.description')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="md">
        {FIELDS.map(field)}
      </SimpleGrid>
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('retention.usage')} data-testid="plant-history-usage">
          <Table.Caption>{t('retention.usageHint', { size: size(u.databaseBytes) })}</Table.Caption>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('retention.what')}</Table.Th>
              <Table.Th ta="right">{t('retention.rows')}</Table.Th>
              <Table.Th ta="right">{t('retention.size')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>
                {t('retention.history')}
                <Text size="xs" c="dimmed">
                  {t('retention.historyRemoved', { count: u.history.removedRows, n: fmtNumber(u.history.removedRows) })}
                </Text>
              </Table.Td>
              <Table.Td ta="right">{fmtNumber(u.history.rows)}</Table.Td>
              <Table.Td ta="right">{size(u.history.bytes)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>{t('retention.baselines')}</Table.Td>
              <Table.Td ta="right">{fmtNumber(u.baselines.rows)}</Table.Td>
              <Table.Td ta="right">{size(u.baselines.bytes)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>
                {t('retention.changeSets')}
                <Text size="xs" c="dimmed">
                  {t('retention.changeSetsClosed', { count: u.changeSets.closedRows, n: fmtNumber(u.changeSets.closedRows) })}
                </Text>
              </Table.Td>
              <Table.Td ta="right">{fmtNumber(u.changeSets.rows)}</Table.Td>
              <Table.Td ta="right">{size(u.changeSets.bytes)}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </div>
      {!inBar && (
        <Group justify="flex-end" mt="sm">
          <Button size="xs" onClick={() => void save()} loading={busy} disabled={!valid(d) || !dirty}>
            {t('retention.save')}
          </Button>
        </Group>
      )}
    </Card>
  );
}

/** Only while the plant registry is on. */
export function PlantHistorySettingsGate() {
  const plant = useQuery({ queryKey: plantKeys.settings, queryFn: () => get<PlantSettings>('/settings/plant') });
  return plant.data?.enabled ? <PlantHistorySettingsCard /> : null;
}
