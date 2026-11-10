import { Anchor, Badge, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PlantIhSiteCoverage } from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, QueryState } from '../../../components/common';
import { CollapsibleSection, SectionGroup } from '../../../components/page/CollapsibleSection';
import { GapList } from '../../../components/plant/InsightsHubMapping';
import { fmtDate } from '../../../format';

/**
 * A site's Insights Hub sinks (0.14, docs/PLANT.md "Insights Hub mapping"): per sink of its collections how many items
 * are mapped, verified against the tenant and watched by a monitor, and the gaps with a way to the collection.
 */
export function SiteIhCoverageView({ siteId }: { siteId: string }) {
  const { t } = useTranslation('plantDocs');
  const q = useQuery({
    queryKey: ['plant', 'sites', siteId, 'insights-hub'],
    queryFn: () => get<PlantIhSiteCoverage>(`/plant/sites/${encodeURIComponent(siteId)}/insights-hub`),
  });
  const c = q.data;
  if (!c) return <QueryState query={q} rows={3} />;
  if (!c.entries.length)
    return (
      <EmptyState compact title={t('ih.siteEmptyTitle')}>
        {t('ih.siteEmpty')}
      </EmptyState>
    );
  const tot = c.totals;
  return (
    <Stack gap="md" data-testid="site-ih-coverage">
      <Text size="sm" c="dimmed">
        {t('ih.siteHelp')}
      </Text>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
        {(
          [
            ['items', tot.items],
            ['mappedTotal', tot.mapped],
            ['verifiedTotal', tot.verified],
            ['watchedTotal', tot.watched],
          ] as const
        ).map(([k, n]) => (
          <Paper key={k} withBorder p="xs">
            <Text size="xs" c="dimmed">
              {t(`ih.tile.${k}`)}
            </Text>
            <Text fw={600} size="lg">
              {n}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={t('ih.siteTable')}>
        <Table fz="sm" aria-label={t('ih.siteTable')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('ih.collection')}</Table.Th>
              <Table.Th>{t('ih.tile.mappedTotal')}</Table.Th>
              <Table.Th>{t('ih.tile.verifiedTotal')}</Table.Th>
              <Table.Th>{t('ih.tile.watchedTotal')}</Table.Th>
              <Table.Th>{t('ih.checkedCol')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {c.entries.map((e) => (
              <Table.Tr key={`${e.assetId}/${e.collectionId}/${e.sinkId}`}>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>
                  <Anchor
                    component={Link}
                    to={`/plant/assets/${encodeURIComponent(e.assetId)}/collections?collection=${encodeURIComponent(e.collectionId)}`}
                    size="sm"
                  >
                    {e.assetName} · {e.collectionName}
                  </Anchor>{' '}
                  <Text span size="xs" c="dimmed">
                    {e.sinkName}
                  </Text>
                </Table.Td>
                <Table.Td>{t('ih.ofItems', { count: e.counts.mapped, of: e.counts.items })}</Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={e.counts.verified === e.counts.mapped && e.counts.mapped ? 'green' : 'gray'} tt="none">
                    {e.counts.verified}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={e.counts.watched === e.counts.mapped && e.counts.mapped ? 'green' : 'orange'} tt="none">
                    {e.counts.watched}
                  </Badge>
                </Table.Td>
                <Table.Td>{e.checkedAt ? fmtDate(e.checkedAt) : t('ih.status.none')}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <SectionGroup controls="none">
        {c.entries
          .filter((e) => e.counts.gaps.unmapped.length + e.counts.gaps.unverified.length + e.counts.gaps.unwatched.length > 0)
          .map((e) => {
            const g = e.counts.gaps;
            return (
              <CollapsibleSection
                key={`${e.assetId}/${e.collectionId}/${e.sinkId}`}
                id={`site-ih-gaps-${e.assetId}-${e.collectionId}-${e.sinkId}`}
                order={3}
                title={t('ih.gapsOf', { name: `${e.assetName} · ${e.collectionName}` })}
                count={g.unmapped.length + g.unverified.length + g.unwatched.length}
                collapseOnPhone
                tone="warning"
                actions={
                  <Anchor
                    component={Link}
                    to={`/plant/assets/${encodeURIComponent(e.assetId)}/collections?collection=${encodeURIComponent(e.collectionId)}`}
                    size="xs"
                  >
                    {t('ih.openCollection')}
                  </Anchor>
                }
              >
                <Group>
                  <GapList gaps={g} label={(i) => t('ih.itemNo', { n: i + 1 })} />
                </Group>
              </CollapsibleSection>
            );
          })}
      </SectionGroup>
    </Stack>
  );
}
