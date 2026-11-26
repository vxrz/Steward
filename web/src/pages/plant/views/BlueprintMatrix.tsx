import { useState } from 'react';
import { Anchor, Button, Group, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconGridDots } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { BLUEPRINT_IMPORTANCES, type BlueprintImportance, type PlantBlueprintMatrix, type PlantBlueprintTotals } from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, FilterPanel, QueryState } from '../../../components/common';
import { plantKeys } from '../../../queryKeys';
import { useNameOf, usePlantLabel } from '../../../components/plant/common';
import { STATE_COLOR } from '../../../components/plant/blueprints';
import { CountBar } from './common';

/**
 * The site-wide matrix of machine blueprints (0.30.0 step 2, ADR 0041; Plant → Explore the data): assets × the
 * blueprints they have, with the coverage of their signals per importance – in the style of the KPI coverage matrix. A
 * cell says how many of the applicable signals are covered; a total names what is covered, not collected and missing.
 * Filtered by site, area, device profile and blueprint; a row opens the asset.
 */

const PAGE = 100;
const color = (s: keyof typeof STATE_COLOR) => `var(--mantine-color-${STATE_COLOR[s]}-filled)`;

function TotalsBar({ totals, height = 8 }: { totals: PlantBlueprintTotals; height?: number }) {
  const { t } = useTranslation('plantBlueprints');
  const parts = (['covered', 'notCollected', 'missing'] as const).map((s) => ({
    key: s,
    value: totals[s],
    color: color(s),
    text: `${t(`coverage.states.${s}`)}: ${totals[s]}`,
  }));
  return <CountBar parts={parts} height={height} label={parts.map((p) => p.text).join(', ')} />;
}

/** "2 of 3" with the missing count, as one short text (colour is never the only signal). */
function useCellText() {
  const { t } = useTranslation('plantBlueprints');
  return (x: PlantBlueprintTotals) => (x.applicable ? t('matrix.cell', { covered: x.covered, applicable: x.applicable }) : t('matrix.cellNone'));
}

export function BlueprintMatrix() {
  const { t } = useTranslation(['plantBlueprints', 'plantViews', 'plant']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [params, setParams] = useSearchParams();
  const filter = {
    site: params.get('site') ?? '',
    area: params.get('area') ?? '',
    profile: params.get('profile') ?? '',
    blueprint: params.get('blueprint') ?? '',
  };
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const [limit, setLimit] = useState(PAGE);
  const q = useQuery({ queryKey: plantKeys.blueprintMatrix(qs), queryFn: () => get<PlantBlueprintMatrix>(`/plant/views/blueprints${qs ? `?${qs}` : ''}`) });
  const cellText = useCellText();
  const set = (k: keyof typeof filter, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'site') next.delete('area');
    setParams(next, { replace: true });
    setLimit(PAGE);
  };
  const m = q.data;
  const rows = m ? m.rows.slice(0, limit) : [];
  return (
    <Stack gap="sm" data-testid="blueprint-matrix">
      <div>
        <Title order={2} fz="h4">
          {t('matrix.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('matrix.help', { type: label('asset', true, true) })}
        </Text>
      </div>
      <QueryState query={q} />
      {m && (
        <FilterPanel active={Object.values(filter).filter(Boolean).length}>
          <Group gap="xs" wrap="wrap" data-testid="blueprint-matrix-filters">
            <Select
              size="xs"
              w={narrow ? '100%' : 190}
              label={label('site')}
              placeholder={t('plantViews:coverage.all')}
              data={m.options.sites.map((s) => ({ value: s.id, label: nameOf(s) }))}
              value={filter.site || null}
              onChange={(v) => set('site', v)}
              clearable
              searchable
              data-testid="matrix-site"
            />
            <Select
              size="xs"
              w={narrow ? '100%' : 190}
              label={label('area')}
              placeholder={t('plantViews:coverage.all')}
              data={m.options.areas.filter((a) => !filter.site || a.siteId === filter.site).map((a) => ({ value: a.id, label: nameOf(a) }))}
              value={filter.area || null}
              onChange={(v) => set('area', v)}
              clearable
              searchable
              data-testid="matrix-area"
            />
            <Select
              size="xs"
              w={narrow ? '100%' : 230}
              label={t('plantViews:coverage.profile')}
              placeholder={t('plantViews:coverage.all')}
              data={m.options.profiles.map((p) => ({ value: p.id, label: p.name }))}
              value={filter.profile || null}
              onChange={(v) => set('profile', v)}
              clearable
              searchable
              data-testid="matrix-profile"
            />
            {filter.blueprint && (
              <Button size="xs" variant="light" mt={narrow ? 0 : 22} onClick={() => set('blueprint', null)} data-testid="matrix-blueprint-clear">
                {t('matrix.allBlueprints')}
              </Button>
            )}
          </Group>
        </FilterPanel>
      )}
      {m && m.total === 0 ? (
        <EmptyState icon={IconGridDots} title={t('matrix.emptyTitle', { type: label('asset', true, true) })} testId="matrix-empty">
          {qs ? t('matrix.noMatch') : t('matrix.emptyText', { type: label('asset', true, true) })}
        </EmptyState>
      ) : (
        m && (
          <>
            <Paper withBorder p="sm" radius="md" data-testid="matrix-summary">
              <Stack gap="xs">
                {BLUEPRINT_IMPORTANCES.map((i: BlueprintImportance) => {
                  const x = m.totals[i];
                  return (
                    <Stack key={i} gap={2} data-testid={`matrix-total-${i}`}>
                      <Group justify="space-between" gap="xs" wrap="wrap">
                        <Text size="sm" fw={600}>
                          {t(`coverage.totals.${i}`)}
                        </Text>
                        <Text size="xs">
                          {t('matrix.total', { covered: x.covered, applicable: x.applicable, notCollected: x.notCollected, missing: x.missing })}
                        </Text>
                      </Group>
                      <TotalsBar totals={x} height={10} />
                    </Stack>
                  );
                })}
              </Stack>
            </Paper>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('matrix.title')}>
              <Table withTableBorder withColumnBorders data-testid="matrix-table" aria-label={t('matrix.title')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{label('asset')}</Table.Th>
                    {m.blueprints.map((b) => (
                      <Table.Th key={b.id} style={{ maxWidth: 160 }}>
                        <Anchor component={Link} to={`/plant/blueprints/${encodeURIComponent(b.id)}`} size="xs" fw={600} style={{ overflowWrap: 'anywhere' }}>
                          {b.name}
                        </Anchor>
                        <Text size="xs" c="dimmed" fw={400}>
                          {t('matrix.assetsOf', { count: b.assets })}
                        </Text>
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((r, i) => (
                    <Table.Tr key={r.asset.id} data-testid={`matrix-row-${r.asset.id}`}>
                      <Table.Td>
                        {(i === 0 || rows[i - 1]!.asset.siteId !== r.asset.siteId) && (
                          <Text size="xs" c="dimmed">
                            {nameOf(r.asset.site)}
                          </Text>
                        )}
                        <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(r.asset.id)}`} size="sm" fw={500}>
                          {r.asset.name}
                        </Anchor>
                        {r.profile && (
                          <Text size="xs" c="dimmed">
                            {r.profile.name}
                          </Text>
                        )}
                      </Table.Td>
                      {r.cells.map((c, j) => (
                        <Table.Td key={m.blueprints[j]!.id} data-testid={c ? `matrix-cell-${r.asset.id}-${m.blueprints[j]!.id}` : undefined}>
                          {c ? (
                            <Stack gap={2}>
                              {BLUEPRINT_IMPORTANCES.filter((imp) => c.byImportance[imp].total > 0).map((imp) => (
                                <Group key={imp} gap={6} wrap="nowrap" title={t(`coverage.totals.${imp}`)}>
                                  <Text size="xs" w={70} c="dimmed">
                                    {t(`coverage.totals.${imp}`)}
                                  </Text>
                                  <Text size="xs">{cellText(c.byImportance[imp])}</Text>
                                </Group>
                              ))}
                              <TotalsBar totals={c.totals} height={6} />
                            </Stack>
                          ) : (
                            <Text size="xs" c="dimmed" aria-label={t('matrix.hasNot')}>
                              –
                            </Text>
                          )}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            {(m.rows.length > limit || m.truncated) && (
              <Group gap="sm">
                {m.rows.length > limit && (
                  <Button size="xs" variant="default" onClick={() => setLimit((l) => l + PAGE)} data-testid="matrix-more">
                    {t('matrix.more', { count: Math.min(PAGE, m.rows.length - limit) })}
                  </Button>
                )}
                <Text size="xs" c="dimmed">
                  {m.truncated ? t('matrix.truncated', { shown: m.rows.length, total: m.total }) : t('matrix.shown', { shown: rows.length, total: m.total })}
                </Text>
              </Group>
            )}
          </>
        )
      )}
    </Stack>
  );
}
