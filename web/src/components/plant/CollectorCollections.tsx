import { Anchor, Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PlantCollectionBrief, PlantSinkTarget } from '@sm/shared';
import { get } from '../../api';
import { useModuleOn } from '../../modules';

/**
 * The data collections a collector runs (0.11.0, ADR 0019), on the page of the application, platform or process that
 * is the collector – only while the plant registry is on, and only those of assets the reader may see.
 */
export function CollectorCollections({ kind, id }: { kind: 'application' | 'platform' | 'process'; id: string }) {
  const on = useModuleOn('plant');
  const q = useQuery({
    queryKey: ['plant', 'collections', 'collector', kind, id],
    queryFn: () => get<PlantCollectionBrief[]>(`/plant/collections?collectorKind=${kind}&collectorRef=${encodeURIComponent(id)}`),
    enabled: on,
  });
  if (!on || !q.data?.length) return null;
  return <CollectionBriefs title="collectorTitle" list={q.data} testId="collector-collections" />;
}

/** The data collections that read a data point (its page). */
export function PointCollections({ profileId, pointId }: { profileId: string; pointId: string }) {
  const q = useQuery({
    queryKey: ['plant', 'collections', 'point', profileId, pointId],
    queryFn: () => get<PlantCollectionBrief[]>(`/plant/profiles/${encodeURIComponent(profileId)}/points/${encodeURIComponent(pointId)}/collections`),
  });
  return <CollectionBriefs title="pointTitle" list={q.data ?? []} testId="point-collections" empty />;
}

function CollectionBriefs({
  title,
  list,
  testId,
  empty,
}: {
  title: 'collectorTitle' | 'pointTitle';
  list: PlantCollectionBrief[];
  testId: string;
  empty?: boolean;
}) {
  const { t } = useTranslation('plantModel');
  return (
    <Paper withBorder p="md" data-testid={testId}>
      <Stack gap="xs">
        <Title order={2} fz="h5">
          {t(`collections.${title}`)}
        </Title>
        {!list.length && empty && (
          <Text size="sm" c="dimmed">
            {t('collections.noneRead')}
          </Text>
        )}
        {list.map((c) => (
          <Stack key={`${c.assetId}/${c.id}`} gap={2}>
            <Group gap={6} wrap="wrap">
              <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(c.assetId)}/collections?collection=${encodeURIComponent(c.id)}`} size="sm">
                {c.assetName} · {c.name}
              </Anchor>
              {c.writes && (
                <Badge size="xs" color="red" variant="light" tt="none">
                  {t('collections.writes')}
                </Badge>
              )}
              <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                {c.outputNames?.length ? t('collections.asNames', { names: c.outputNames.join(', ') }) : t('collections.itemsCount', { count: c.items })}
                {title === 'pointTitle' ? ` · ${c.collectorLabel}` : ''}
              </Text>
            </Group>
            {c.goesTo && c.goesTo.length > 0 && <GoesTo list={c.goesTo} />}
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}

/** Where the data point goes through a collection (0.12): its sinks, a target the reader may not see unnamed. */
function GoesTo({ list }: { list: PlantSinkTarget[] }) {
  const { t } = useTranslation('plantDocs');
  return (
    <Text size="xs" style={{ overflowWrap: 'anywhere' }} data-testid="point-goes-to">
      {t('flow.goesTo')}{' '}
      {list.map((x, i) => (
        <span key={x.sink}>
          {i > 0 && '; '}
          {x.path ? (
            <Anchor component={Link} to={x.path} size="xs">
              {x.label || x.name}
            </Anchor>
          ) : (
            x.label || (x.kind === 'system' || x.kind === 'platform' || x.kind === 'application' ? t('flow.hiddenTarget') : x.name)
          )}
          {x.object && <span className="mono"> {x.object}</span>}
          {x.target && <> {t('flow.asTarget', { target: x.target })}</>}
        </span>
      ))}
    </Text>
  );
}
