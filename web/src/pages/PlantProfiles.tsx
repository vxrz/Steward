import { useState } from 'react';
import { Anchor, Button, Group, Paper, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconCpu, IconDownload, IconFileImport, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_PROTOCOLS, type PlantProfileDetail, type PlantProfileSummary, type PlantProtocol } from '@sm/shared';
import { apiUrl, get, post } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge, usePlantConfig } from '../components/plant/common';
import { BulkBar, SelectAllBox, SelectBox, useSelection } from '../components/plant/bulk';
import { ProtocolBadge } from '../components/plant/data';
import { ProfileFormModal } from '../components/plant/dataForms';

/** The device profiles of the installation (#219): kinds of controllers and devices with their interfaces and data points. */
export function PlantProfilesPage() {
  const { t } = useTranslation(['plant', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles') });
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const protocol = params.get('protocol') as PlantProtocol | null;
  const category = params.get('category');
  const [creating, setCreating] = useState(false);
  const canManage = cfg.data?.canManageCatalogue;
  useCreateParam(canManage, () => setCreating(true));
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('plant-profiles', narrow);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const all = profiles.data ?? [];
  const categories = [...new Set(all.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const needle = q.trim().toLowerCase();
  const list = all.filter(
    (p) =>
      (!needle || [p.id, p.name, p.manufacturer, p.model, p.category].some((x) => x.toLowerCase().includes(needle))) &&
      (!protocol || p.protocols.includes(protocol)) &&
      (!category || p.category === category),
  );
  const none = profiles.isSuccess && all.length === 0;
  const active = (protocol ? 1 : 0) + (category ? 1 : 0) + (needle ? 1 : 0);
  const to = (p: PlantProfileSummary) => `/plant/profiles/${encodeURIComponent(p.id)}`;
  const protocols = (p: PlantProfileSummary) => (
    <Group gap={4}>
      {p.protocols.map((x) => (
        <ProtocolBadge key={x} protocol={x} size="xs" />
      ))}
    </Group>
  );
  const make = (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
      {t('profiles.new')}
    </Button>
  );
  // Edit selected / Remove selected (0.11.0)
  const canBulk = !!canManage;
  const shownIds = list.map((p) => p.id);
  const sel = useSelection(shownIds);
  return (
    <ListPage
      testId="plant-profiles"
      title={
        <Group gap="sm" component="span">
          <span>{t('profiles.title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('profiles.description')}
      primaryAction={canManage && make}
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
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('profiles.search') }}
      activeFilters={active}
      filters={
        none ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="profile-filters">
            <Select
              size="xs"
              label={t('data.protocol')}
              data={PLANT_PROTOCOLS.map((p) => ({ value: p, label: t(`data.protocols.${p}`) }))}
              value={protocol}
              onChange={(v) => set('protocol', v)}
              clearable
              w={{ base: '100%', xs: 180 }}
            />
            <Select
              size="xs"
              label={t('profile.category')}
              data={categories}
              value={category}
              onChange={(v) => set('category', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 200 }}
            />
          </Group>
        )
      }
      view={none ? undefined : 'plant-profiles'}
      viewState={view}
      empty={{
        show: none,
        icon: IconCpu,
        title: t('profiles.emptyTitle'),
        text: t('profiles.emptyText'),
        whoCanAct: canManage ? undefined : t('profiles.whoCanAct'),
        action: canManage && (
          <>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              {t('profiles.new')}
            </Button>
            <Button variant="default" component={Link} to="/plant/import" leftSection={<IconFileImport size={16} />}>
              {t('import.button')}
            </Button>
          </>
        ),
      }}
    >
      <QueryState query={profiles} />
      {!none && profiles.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('profiles.noMatch')}
        </Text>
      )}
      {canBulk && list.length > 0 && (
        <BulkBar kind="profile" sel={sel} visible={shownIds} selectAll={view.cards} entries={list.map((x) => ({ id: x.id, name: x.name }))} />
      )}
      {list.length > 0 && view.cards && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="plant-profile-cards">
          {list.map((p) => (
            <Paper key={p.id} withBorder p="md" component="article" aria-labelledby={`profile-${p.id}`}>
              <Stack gap={6}>
                {canBulk && <SelectBox sel={sel} id={p.id} name={p.name} />}
                <Anchor id={`profile-${p.id}`} component={Link} to={to(p)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                  {p.name}
                </Anchor>
                <Text size="sm" c="dimmed">
                  {[p.manufacturer, p.model, p.version].filter(Boolean).join(' · ') || '–'}
                </Text>
                {protocols(p)}
                <Text size="sm">{t('profiles.counts', { interfaces: p.interfaceCount, points: p.dataPointCount, assets: p.assetCount })}</Text>
                {p.notInSource && <NotInSourceBadge size="xs" />}
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {list.length > 0 && !view.cards && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm" aria-label={t('profiles.title')} data-testid="plant-profile-table">
            <Table.Thead>
              <Table.Tr>
                {canBulk && (
                  <Table.Th w={36}>
                    <SelectAllBox sel={sel} ids={shownIds} />
                  </Table.Th>
                )}
                <Table.Th>{t('form.name')}</Table.Th>
                <Table.Th>{t('asset.manufacturerModel')}</Table.Th>
                <Table.Th>{t('profile.category')}</Table.Th>
                <Table.Th>{t('profile.interfaces')}</Table.Th>
                <Table.Th>{t('profile.dataPoints')}</Table.Th>
                <Table.Th>{t('profile.assets')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((p) => (
                <Table.Tr key={p.id} className="clickable" onClick={() => navigate(to(p))}>
                  {canBulk && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <SelectBox sel={sel} id={p.id} name={p.name} />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Anchor component={Link} to={to(p)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Anchor>
                    <Group gap={4}>
                      <Text size="xs" c="dimmed" className="mono">
                        {p.id}
                      </Text>
                      {p.notInSource && <NotInSourceBadge size="xs" />}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {[p.manufacturer, p.model].filter(Boolean).join(' · ') || '–'}
                    {p.version && (
                      <Text size="xs" c="dimmed">
                        {t('profile.versionIs', { version: p.version })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{p.category || '–'}</Table.Td>
                  <Table.Td>{protocols(p)}</Table.Td>
                  <Table.Td>{p.dataPointCount}</Table.Td>
                  <Table.Td>{p.assetCount}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && (
        <ProfileFormModal
          onClose={() => setCreating(false)}
          onSave={async (v) => {
            const made = await post<PlantProfileDetail>('/plant/profiles', v);
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/profiles/${encodeURIComponent(made.id)}`);
          }}
        />
      )}
    </ListPage>
  );
}
