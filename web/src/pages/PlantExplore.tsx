import { useState } from 'react';
import { Anchor, Badge, Group, Paper, SegmentedControl, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PlantAssetSummary, PlantAssignmentView, PlantPointHit } from '@sm/shared';
import { get } from '../api';
import { QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { PreviewBadge, useNameOf, usePlantLabel } from '../components/plant/common';
import { Breakable, ChecksList, NoProblems, ProtocolBadge, UnitText } from '../components/plant/data';

const pointPath = (h: PlantPointHit) => `/plant/profiles/${encodeURIComponent(h.profile.id)}/points/${encodeURIComponent(h.point.id)}`;
const assetsPath = (h: PlantPointHit) => `/plant/assets?profile=${encodeURIComponent(h.profile.id)}&dataPoint=${encodeURIComponent(h.point.id)}`;

/**
 * Explore the data (#219): which assets deliver a data point (a text across every profile's data points: id, name,
 * address, description), and which KPIs an asset can have. Both are in the address, so a result can be shared.
 */
export function PlantExplorePage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const [params, setParams] = useSearchParams();
  const mode = params.get('view') === 'asset' ? 'asset' : 'points';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [needle] = useDebouncedValue(q.trim(), 250);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <ListPage
      testId="plant-explore"
      title={
        <Group gap="sm" component="span">
          <span>{t('explore.title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('explore.description', { type: label('asset', true, true) })}
      search={
        mode === 'points'
          ? {
              value: q,
              // the text is part of the address, so a result can be shared
              onChange: (v) => {
                setQ(v);
                set('q', v.trim() || null);
              },
              placeholder: t('explore.search'),
              label: t('explore.searchLabel'),
            }
          : undefined
      }
    >
      <SegmentedControl
        mb="md"
        value={mode}
        onChange={(v) => set('view', v === 'asset' ? 'asset' : null)}
        aria-label={t('explore.mode')}
        data={[
          { value: 'points', label: t('explore.points', { type: label('asset', true, true) }) },
          { value: 'asset', label: t('explore.asset', { type: label('asset', false, true) }) },
        ]}
        data-testid="explore-mode"
      />
      {mode === 'points' ? <PointSearch needle={needle} /> : <AssetKpis assetId={params.get('asset')} onAsset={(id) => set('asset', id)} />}
    </ListPage>
  );
}

function PointSearch({ needle }: { needle: string }) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const hits = useQuery({
    queryKey: plantKeys.explore(needle),
    queryFn: () => get<PlantPointHit[]>(`/plant/explore/points?q=${encodeURIComponent(needle)}`),
    enabled: !!needle,
  });
  if (!needle)
    return (
      <Text size="sm" c="dimmed">
        {t('explore.hint')}
      </Text>
    );
  const list = hits.data ?? [];
  const delivered = (h: PlantPointHit) =>
    h.deliveredBy > 0 ? (
      <Anchor component={Link} to={assetsPath(h)} size="sm">
        {t('explore.deliveredBy', { count: h.deliveredBy, type: label('asset', h.deliveredBy !== 1, true) })}
      </Anchor>
    ) : (
      <Text size="sm" c="dimmed">
        {t('explore.deliveredByNone')}
      </Text>
    );
  return (
    <Stack gap="xs">
      <QueryState query={hits} />
      {hits.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('explore.noHits')}
        </Text>
      )}
      {list.length > 0 && (
        <Text size="xs" c="dimmed" aria-live="polite">
          {t('explore.count', { count: list.length })}
        </Text>
      )}
      {list.length > 0 && narrow && (
        <Stack gap="xs" data-testid="explore-cards">
          {list.map((h) => (
            <Paper key={`${h.profile.id}:${h.point.id}`} withBorder p="sm">
              <Stack gap={4}>
                <Anchor component={Link} to={pointPath(h)} fw={500} size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {h.point.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono code-wrap">
                  <Breakable text={h.point.id} />
                </Text>
                <Group gap={6} wrap="wrap">
                  <ProtocolBadge protocol={h.interface.protocol} size="xs" />
                  <Text size="xs">{h.profile.name}</Text>
                </Group>
                {delivered(h)}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
      {list.length > 0 && !narrow && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('explore.results')}>
          <Table fz="sm" aria-label={t('explore.results')} data-testid="explore-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('data.point')}</Table.Th>
                <Table.Th>{t('point.profile')}</Table.Th>
                <Table.Th>{t('data.dataType')}</Table.Th>
                <Table.Th>{t('data.address')}</Table.Th>
                <Table.Th>{t('explore.delivery', { type: label('asset', true) })}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((h) => (
                <Table.Tr key={`${h.profile.id}:${h.point.id}`}>
                  <Table.Td>
                    <Anchor component={Link} to={pointPath(h)} fw={500} size="sm">
                      {h.point.name}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="mono">
                      {h.point.id}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(h.profile.id)}`} size="sm">
                      {h.profile.name}
                    </Anchor>
                    <Group gap={4} mt={2}>
                      <ProtocolBadge protocol={h.interface.protocol} size="xs" />
                      <Text size="xs" c="dimmed">
                        {[h.interface.name || h.interface.id, h.group].filter(Boolean).join(' › ')}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <span className="mono">{h.point.dataType || '–'}</span>
                    {h.point.unit && (
                      <Text size="xs" c="dimmed">
                        <UnitText unit={h.point.unit} />
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" className="mono code-wrap">
                      <Breakable text={h.point.address || '–'} />
                    </Text>
                  </Table.Td>
                  <Table.Td>{delivered(h)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

function AssetKpis({ assetId, onAsset }: { assetId: string | null; onAsset: (id: string | null) => void }) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const assets = useQuery({ queryKey: plantKeys.assets(''), queryFn: () => get<PlantAssetSummary[]>('/plant/assets') });
  const a = useQuery({
    queryKey: plantKeys.assignment(assetId),
    queryFn: () => get<PlantAssignmentView>(`/plant/assets/${encodeURIComponent(assetId!)}/assignment`),
    enabled: !!assetId,
  });
  const v = a.data;
  return (
    <Stack gap="md">
      <Select
        label={label('asset')}
        placeholder={t('explore.pickAsset', { type: label('asset', false, true) })}
        data={(assets.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.id})` }))}
        value={assetId}
        onChange={onAsset}
        searchable
        clearable
        maw={480}
        data-testid="explore-asset"
      />
      {assetId && <QueryState query={a} />}
      {v && (
        <Paper withBorder p="md" data-testid="explore-asset-result">
          <Stack gap="sm">
            <Group gap="xs" wrap="wrap">
              <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(v.asset.id)}`} fw={600}>
                {v.asset.name}
              </Anchor>
              <Text size="sm" c="dimmed">
                {v.profile ? t('explore.withProfile', { profile: v.profile.name }) : t('explore.noProfile')}
              </Text>
            </Group>
            <Title order={2} fz="h5">
              {t('explore.possible')}
            </Title>
            {v.possibleKpis.length === 0 ? (
              <Text size="sm" c="dimmed">
                {v.profile ? t('explore.nonePossible') : t('explore.nonePossibleNoProfile')}
              </Text>
            ) : (
              <Stack gap={4}>
                {v.possibleKpis.map((k) => (
                  <Group key={k.id} gap={6} wrap="wrap">
                    <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.id)}`} size="sm">
                      {nameOf(k)}
                    </Anchor>
                    {k.category && (
                      <Text size="xs" c="dimmed">
                        {k.category}
                      </Text>
                    )}
                    {k.instantiated && (
                      <Badge size="xs" variant="light" color="green">
                        {t('explore.instantiated')}
                      </Badge>
                    )}
                  </Group>
                ))}
              </Stack>
            )}
            <Title order={2} fz="h5">
              {t('checks.title')}
            </Title>
            {v.checks.length ? <ChecksList checks={v.checks} /> : <NoProblems text={t('checks.none')} />}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
