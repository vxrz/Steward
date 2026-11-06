import { Anchor, Group, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { coveragePct, type PlantSiteTile } from '@sm/shared';
import { get } from '../../../api';
import { plantKeys } from '../../../queryKeys';
import { LIVE_ICON, StatusBar, liveVar } from './common';
import { LIVE_REFRESH_MS } from './prefs';

/**
 * The overview of a site as a tile (#230, Plant → Sites): its assets by status as a small bar, the KPI coverage in per
 * cent, the open plant checks, the linked monitors' state where there are any – linking into the structure and the
 * coverage matrix. One request for all tiles (shared by the cards of the list).
 */
export function useSiteTiles() {
  return useQuery({ queryKey: plantKeys.overview, queryFn: () => get<PlantSiteTile[]>('/plant/views/overview'), refetchInterval: LIVE_REFRESH_MS });
}

export function SiteTileStats({ siteId, compact }: { siteId: string; compact?: boolean }) {
  const { t } = useTranslation('plantViews');
  const q = useSiteTiles();
  const tile = q.data?.find((x) => x.siteId === siteId);
  if (!tile) return null;
  const pct = coveragePct(tile.coverage);
  const base = `/plant/sites/${encodeURIComponent(siteId)}`;
  return (
    <Stack gap={6} data-testid={`site-tile-${siteId}`}>
      {!compact && <StatusBar counts={tile.counts} height={6} />}
      <Group gap="md" wrap="wrap">
        <Tooltip label={t('tiles.coverageHint')} withArrow multiline maw={260}>
          <Group gap={6} wrap="nowrap" tabIndex={0} data-testid="tile-coverage">
            <Text size="xs" c="dimmed">
              {t('tiles.coverage')}
            </Text>
            {pct === null ? (
              <Text size="xs">–</Text>
            ) : (
              <>
                <Progress value={pct} w={56} size="sm" color="green" aria-hidden />
                <Text size="xs" fw={600}>
                  {pct} %
                </Text>
              </>
            )}
          </Group>
        </Tooltip>
        <Group gap={4} wrap="nowrap" data-testid="tile-checks">
          {tile.checks > 0 ? (
            <IconAlertTriangle size={14} aria-hidden style={{ color: 'var(--pv-problem)' }} />
          ) : (
            <IconCircleCheck size={14} aria-hidden style={{ color: 'var(--mantine-color-dimmed)' }} />
          )}
          <Text size="xs">{t('tiles.checks', { count: tile.checks })}</Text>
        </Group>
        {(['fail', 'warn', 'unknown', 'ok'] as const)
          .filter((s) => tile.live[s])
          .map((s) => {
            const I = LIVE_ICON[s];
            return (
              <Group key={s} gap={3} wrap="nowrap">
                <I size={14} aria-hidden style={{ color: liveVar(s) }} />
                <Text size="xs">{t(`liveCount.${s}`, { count: tile.live[s] })}</Text>
              </Group>
            );
          })}
      </Group>
      <Group gap="sm">
        <Anchor component={Link} to={`${base}/structure`} size="xs">
          {t('tiles.structure')}
        </Anchor>
        <Anchor component={Link} to={`/plant/explore?view=coverage&site=${encodeURIComponent(siteId)}`} size="xs">
          {t('tiles.coverageLink')}
        </Anchor>
      </Group>
    </Stack>
  );
}
