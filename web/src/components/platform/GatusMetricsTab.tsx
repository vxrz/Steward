import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, NumberInput, Paper, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconRefresh, IconShieldExclamation } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { GatusEndpointState, GatusMetricsSource, Platform } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { fmtDay, fmtNumber, fmtRelative } from '../../format';

interface Draft {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  rawRetentionDays: number;
  metricsPath: string;
  fetchUptimes: boolean;
}
const DEFAULTS: Draft = { enabled: true, intervalSeconds: 60, retentionDays: 90, rawRetentionDays: 14, metricsPath: '/metrics', fetchUptimes: false };

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${fmtNumber(v, { maximumFractionDigits: 2 })} %`);

/** Platform → Metrics (Gatus platforms): scrape Gatus' /metrics, see endpoint states and uptime. */
export function GatusMetricsTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation('gatus');
  const qc = useQueryClient();
  const canManage = platform.permissions.includes('manage');
  const canUse = platform.permissions.includes('use');
  const src = useQuery({ queryKey: ['gatus-source', platform.id], queryFn: () => get<{ source: GatusMetricsSource | null }>(`/gatus/sources/${platform.id}`) });
  const eps = useQuery({
    queryKey: ['gatus-endpoints', platform.id],
    queryFn: () => get<GatusEndpointState[]>(`/gatus/sources/${platform.id}/endpoints`),
    enabled: !!src.data?.source,
    refetchInterval: 30000,
  });
  const [d, setD] = useState<Draft>(DEFAULTS);
  const [busy, setBusy] = useState<string | null>(null);
  const source = src.data?.source ?? null;
  useEffect(() => {
    if (source)
      setD({
        enabled: source.enabled,
        intervalSeconds: source.intervalSeconds,
        retentionDays: source.retentionDays,
        rawRetentionDays: source.rawRetentionDays,
        metricsPath: source.metricsPath,
        fetchUptimes: source.fetchUptimes,
      });
  }, [source]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['gatus-source', platform.id] });
    qc.invalidateQueries({ queryKey: ['gatus-endpoints', platform.id] });
  };
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('intro')}
      </Text>
      <Alert color="orange" variant="light" icon={<IconShieldExclamation size={18} />} title={t('securityTitle')}>
        {t('securityText')}
      </Alert>
      {source?.lastError && (
        <Alert color="red" title={t('lastError')}>
          {source.lastError}
        </Alert>
      )}
      {source && (
        <Group gap="xs">
          <Badge color={source.enabled ? (source.lastError ? 'red' : 'green') : 'gray'} variant="light">
            {source.enabled ? (source.lastError ? t('state.failing') : t('state.active')) : t('state.disabled')}
          </Badge>
          <Text size="xs" c="dimmed">
            {source.lastSuccessAt ? t('lastScrape', { when: fmtRelative(source.lastSuccessAt), ms: source.lastDurationMs ?? 0 }) : t('neverScraped')} ·{' '}
            {t('endpointCount', { count: source.endpointCount })}
          </Text>
        </Group>
      )}
      <Paper withBorder p="sm">
        <Stack gap="xs">
          <Title order={6}>{t('config')}</Title>
          <Switch label={t('enabled')} disabled={!canManage} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
          <Group grow align="flex-start">
            <TextInput
              label={t('metricsPath')}
              description={t('metricsPathHint')}
              classNames={{ input: 'mono' }}
              disabled={!canManage}
              value={d.metricsPath}
              onChange={(e) => setD({ ...d, metricsPath: e.currentTarget.value })}
            />
            <NumberInput
              label={t('interval')}
              min={15}
              max={3600}
              disabled={!canManage}
              value={d.intervalSeconds}
              onChange={(v) => setD({ ...d, intervalSeconds: typeof v === 'number' ? v : 60 })}
            />
          </Group>
          <Group grow align="flex-start">
            <NumberInput
              label={t('retention')}
              description={t('retentionHint')}
              min={1}
              max={730}
              disabled={!canManage}
              value={d.retentionDays}
              onChange={(v) => setD({ ...d, retentionDays: typeof v === 'number' ? v : 90 })}
            />
            <NumberInput
              label={t('rawRetention')}
              description={t('rawRetentionHint')}
              min={1}
              max={90}
              disabled={!canManage}
              value={d.rawRetentionDays}
              onChange={(v) => setD({ ...d, rawRetentionDays: typeof v === 'number' ? v : 14 })}
            />
          </Group>
          <Switch
            label={t('fetchUptimes')}
            description={t('fetchUptimesHint')}
            disabled={!canManage}
            checked={d.fetchUptimes}
            onChange={(e) => setD({ ...d, fetchUptimes: e.currentTarget.checked })}
          />
          <Group justify="flex-end" gap="xs">
            {source && canManage && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                loading={busy === 'remove'}
                onClick={() => {
                  if (confirm(t('removeConfirm'))) void run('remove', () => del(`/gatus/sources/${platform.id}`).then(() => notifyOk(t('removed'))));
                }}
              >
                {t('remove')}
              </Button>
            )}
            {source && canUse && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                loading={busy === 'scrape'}
                onClick={() =>
                  run('scrape', async () => {
                    const r = await post<{ ok: boolean; endpoints: number; error?: string }>(`/gatus/sources/${platform.id}/scrape`);
                    if (r.ok) notifyOk(t('scraped', { count: r.endpoints }));
                    else notifyError(new Error(r.error ?? ''), t('scrapeFailed'));
                  })
                }
              >
                {t('scrapeNow')}
              </Button>
            )}
            {canManage && (
              <Button
                size="xs"
                loading={busy === 'save'}
                onClick={() => run('save', () => put(`/gatus/sources/${platform.id}`, d).then(() => notifyOk(t('saved'))))}
              >
                {source ? t('save') : t('enable')}
              </Button>
            )}
          </Group>
        </Stack>
      </Paper>
      {source && (
        <div className="table-scroll">
          <Table fz="sm" highlightOnHover aria-label={t('endpoints')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('table.endpoint')}</Table.Th>
                <Table.Th>{t('table.state')}</Table.Th>
                <Table.Th>{t('table.uptime24h')}</Table.Th>
                <Table.Th>{t('table.uptime7d')}</Table.Th>
                <Table.Th>{t('table.uptime30d')}</Table.Th>
                <Table.Th>{t('table.duration')}</Table.Th>
                <Table.Th>{t('table.certificate')}</Table.Th>
                <Table.Th>{t('table.lastResult')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(eps.data ?? []).map((e) => (
                <Table.Tr key={e.key}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {e.group ? `${e.group}/` : ''}
                      {e.name || e.key}
                    </Text>
                    <Text size="xs" c="dimmed" className="mono">
                      {e.key}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {e.success === null ? (
                      '–'
                    ) : (
                      <Badge color={e.success ? 'green' : 'red'} variant="light">
                        {e.success ? t('table.up') : t('table.down')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{pct(e.uptime.h24)}</Table.Td>
                  <Table.Td>{pct(e.uptime.d7)}</Table.Td>
                  <Table.Td>
                    {pct(e.uptime.d30)}
                    {e.gatusUptime?.d30 !== undefined && e.gatusUptime?.d30 !== null && (
                      <Text size="xs" c="dimmed">
                        {t('table.gatusSays', { value: pct(e.gatusUptime.d30) })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{e.durationMs === null ? '–' : `${fmtNumber(e.durationMs)} ms`}</Table.Td>
                  <Table.Td className="nowrap">{e.certificateExpiresAt ? fmtDay(e.certificateExpiresAt) : '–'}</Table.Td>
                  <Table.Td className="nowrap">{e.lastResultAt ? fmtRelative(e.lastResultAt) : '–'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}
