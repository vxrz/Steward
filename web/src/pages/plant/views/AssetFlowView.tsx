import { Alert, Button, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconInfoCircle, IconRoute } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantFlowGraph } from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, QueryState } from '../../../components/common';
import { plantKeys } from '../../../queryKeys';
import { usePlantLabel } from '../../../components/plant/common';
import { FlowView } from './FlowView';
import { LIVE_REFRESH_MS } from './prefs';

/**
 * The data flow of an asset (#230, asset page → Data flow): interfaces → collector or gateway → publications (target
 * system, path) → KPI jobs → the datasets and dashboards that show the result.
 */
export function AssetFlowView({ assetId, assetName, canManage }: { assetId: string; assetName: string; canManage: boolean }) {
  const { t } = useTranslation('plantViews');
  const label = usePlantLabel();
  const q = useQuery({
    queryKey: plantKeys.flow(assetId),
    queryFn: () => get<PlantFlowGraph>(`/plant/assets/${encodeURIComponent(assetId)}/flow`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const g = q.data;
  return (
    <Stack gap="sm" data-testid="asset-flow">
      <div>
        <Title order={2} fz="h4">
          {t('flow.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('flow.help', { type: label('asset', false, true) })}
        </Text>
      </div>
      <QueryState query={q} />
      {g?.empty === 'no_assignment' ? (
        <EmptyState
          icon={IconRoute}
          title={t('flow.emptyTitle')}
          whoCanAct={canManage ? undefined : t('flow.whoCanAct')}
          action={
            canManage && (
              <Button component={Link} to={`/plant/assets/${encodeURIComponent(assetId)}`} variant="default">
                {t('flow.emptyAction')}
              </Button>
            )
          }
          testId="flow-empty"
        >
          {t('flow.emptyText')}
        </EmptyState>
      ) : (
        g && (
          <>
            {g.empty === 'no_profile' && (
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} data-testid="flow-no-profile">
                {t('flow.noProfile')}
              </Alert>
            )}
            <FlowView
              graph={g}
              viewId="asset-flow"
              title={t('flow.exportTitle', { name: assetName })}
              counts="points"
              pathsTitle={t('flow.points')}
              live={t('flow.live')}
              testId="asset-flow-view"
            />
          </>
        )
      )}
    </Stack>
  );
}

/**
 * The lineage of a data point (#230, data point page): every asset that delivers it, where each publishes it and which
 * KPIs read it – the same flow, fanned out from one point (one node per site when many assets have the profile).
 */
export function PointLineageView({ profileId, pointId, pointName }: { profileId: string; pointId: string; pointName: string }) {
  const { t } = useTranslation('plantViews');
  const label = usePlantLabel();
  const q = useQuery({
    queryKey: plantKeys.lineage(profileId, pointId),
    queryFn: () => get<PlantFlowGraph>(`/plant/profiles/${encodeURIComponent(profileId)}/points/${encodeURIComponent(pointId)}/lineage`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const g = q.data;
  return (
    <Stack gap="sm" data-testid="point-lineage">
      <div>
        <Title order={2} fz="h4">
          {t('lineage.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('lineage.help', { type: label('asset', true, true) })}
        </Text>
      </div>
      <QueryState query={q} />
      {g?.empty === 'no_assets' ? (
        <EmptyState compact icon={IconRoute} title={t('lineage.emptyTitle', { type: label('asset', true, true) })} testId="lineage-empty">
          {t('lineage.emptyText', { type: label('asset', false, true) })}
        </EmptyState>
      ) : (
        g && (
          <>
            {g.grouped && (
              <Text size="xs" c="dimmed" data-testid="lineage-grouped">
                {t('lineage.grouped', { type: label('asset', true, true), site: label('site', false, true) })}
              </Text>
            )}
            <FlowView
              graph={g}
              viewId="point-lineage"
              title={t('lineage.exportTitle', { name: pointName })}
              counts="assets"
              pathsTitle={label('asset', true)}
              live={t('lineage.live')}
              testId="point-lineage-view"
            />
          </>
        )
      )}
    </Stack>
  );
}
