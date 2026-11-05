import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconDownload, IconFileImport, IconGauge, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantKpiDetail, PlantKpiSummary } from '@sm/shared';
import { apiUrl, get, post } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge, useNameOf, usePlantConfig } from '../components/plant/common';
import { UnitText } from '../components/plant/data';
import { KpiFormModal } from '../components/plant/dataForms';

/** A KPI definition's own problems as a badge (a ratio without its denominator …). */
export function ProblemBadge({ count }: { count: number }) {
  const { t } = useTranslation('plant');
  if (!count) return null;
  return (
    <Badge color="orange" variant="light" size="sm" style={{ minWidth: 'max-content' }}>
      {t('checks.problems', { count })}
    </Badge>
  );
}

/** The KPI definitions of the installation (#219). */
export function PlantKpisPage() {
  const { t } = useTranslation(['plant', 'common']);
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const kpis = useQuery({ queryKey: plantKeys.kpis, queryFn: () => get<PlantKpiSummary[]>('/plant/kpis') });
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const category = params.get('category');
  const [creating, setCreating] = useState(false);
  const canManage = cfg.data?.canManageCatalogue;
  useCreateParam(canManage, () => setCreating(true));
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('plant-kpis', narrow);
  const all = kpis.data ?? [];
  const categories = [...new Set(all.map((k) => k.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const needle = q.trim().toLowerCase();
  const list = all.filter(
    (k) =>
      (!needle || [k.id, k.name, nameOf(k), k.category, ...k.profiles].some((x) => x.toLowerCase().includes(needle))) && (!category || k.category === category),
  );
  const none = kpis.isSuccess && all.length === 0;
  const to = (k: PlantKpiSummary) => `/plant/kpis/${encodeURIComponent(k.id)}`;
  return (
    <ListPage
      testId="plant-kpis"
      title={
        <Group gap="sm" component="span">
          <span>{t('kpis.title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('kpis.description')}
      primaryAction={
        canManage && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('kpis.new')}
          </Button>
        )
      }
      actions={
        <>
          {cfg.data?.canManageSome && (
            <Button size="xs" variant="default" component={Link} to="/plant/import" leftSection={<IconFileImport size={14} />}>
              {t('import.button')}
            </Button>
          )}
          {!none && (
            <Button size="xs" variant="default" component="a" href={apiUrl('/plant/export?part=catalogue')} download leftSection={<IconDownload size={14} />}>
              {t('export.catalogue')}
            </Button>
          )}
        </>
      }
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('kpis.search') }}
      activeFilters={(category ? 1 : 0) + (needle ? 1 : 0)}
      filters={
        none || !categories.length ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              label={t('kpi.category')}
              data={categories}
              value={category}
              onChange={(v) => {
                const next = new URLSearchParams(params);
                if (v) next.set('category', v);
                else next.delete('category');
                setParams(next, { replace: true });
              }}
              clearable
              w={{ base: '100%', xs: 200 }}
            />
          </Group>
        )
      }
      view={none ? undefined : 'plant-kpis'}
      viewState={view}
      empty={{
        show: none,
        icon: IconGauge,
        title: t('kpis.emptyTitle'),
        text: t('kpis.emptyText'),
        whoCanAct: canManage ? undefined : t('profiles.whoCanAct'),
        action: canManage && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('kpis.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={kpis} />
      {!none && kpis.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('kpis.noMatch')}
        </Text>
      )}
      {list.length > 0 && view.cards && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="plant-kpi-cards">
          {list.map((k) => (
            <Paper key={k.id} withBorder p="md" component="article" aria-labelledby={`kpi-${k.id}`}>
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                  <Anchor id={`kpi-${k.id}`} component={Link} to={to(k)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {nameOf(k)}
                  </Anchor>
                  <ProblemBadge count={k.problemCount} />
                </Group>
                <Text size="sm" c="dimmed">
                  {[k.category, k.trend && t(`kpi.trends.${k.trend}`)].filter(Boolean).join(' · ') || '–'}
                </Text>
                <Text size="sm">{t('kpis.counts', { params: k.parameterCount, columns: k.columnCount, instances: k.instanceCount })}</Text>
                {k.notInSource && <NotInSourceBadge size="xs" />}
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {list.length > 0 && !view.cards && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm" aria-label={t('kpis.title')} data-testid="plant-kpi-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('form.name')}</Table.Th>
                <Table.Th>{t('kpi.category')}</Table.Th>
                <Table.Th>{t('data.unit')}</Table.Th>
                <Table.Th>{t('kpi.trend')}</Table.Th>
                <Table.Th>{t('kpi.inputs')}</Table.Th>
                <Table.Th>{t('kpi.instances')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((k) => (
                <Table.Tr key={k.id} className="clickable" onClick={() => navigate(to(k))}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Anchor component={Link} to={to(k)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                        {nameOf(k)}
                      </Anchor>
                      <ProblemBadge count={k.problemCount} />
                    </Group>
                    <Group gap={4}>
                      <Text size="xs" c="dimmed" className="mono">
                        {k.id}
                      </Text>
                      {k.notInSource && <NotInSourceBadge size="xs" />}
                    </Group>
                  </Table.Td>
                  <Table.Td>{k.category || '–'}</Table.Td>
                  <Table.Td>
                    <UnitText unit={k.unit} />
                  </Table.Td>
                  <Table.Td>{k.trend ? t(`kpi.trends.${k.trend}`) : '–'}</Table.Td>
                  <Table.Td>
                    <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {k.profiles.join(', ') || '–'}
                    </Text>
                  </Table.Td>
                  <Table.Td>{k.instanceCount}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && (
        <KpiFormModal
          onClose={() => setCreating(false)}
          onSave={async (v) => {
            const made = await post<PlantKpiDetail>('/plant/kpis', v);
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/kpis/${encodeURIComponent(made.id)}`);
          }}
        />
      )}
    </ListPage>
  );
}
