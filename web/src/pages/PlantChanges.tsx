import { Anchor, Button, Group, Paper, Select, Stack, Switch, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconGitPullRequest, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_CHANGESET_SOURCES, type PlantChangeSetDetail, type PlantChangeSetList, type PlantChangeSetSource, type PlantChangeSetSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { fmtDate, fmtRelative } from '../format';
import { plantKeys } from '../queryKeys';
import { DataTable, type DataColumn } from '../components/DataTable';
import { QueryState } from '../components/common';
import { LinkTabs } from '../components/page/LinkTabs';
import { ListPage } from '../components/page/ListPage';
import { PreviewBadge } from '../components/plant/common';
import { usePlantConfig } from '../components/plant/labels';
import { SourceBadge, StateBadge, useChangeSetConfig, useDraftRefresh } from '../components/plant/changes/common';

const BOXES = ['drafts', 'review', 'applied', 'closed'] as const;
type Box = (typeof BOXES)[number];

/**
 * Plant → Changes (0.13.0, ADR 0020 §5): the change sets of the plant registry – the person's drafts, those to review
 * (with a count), applied and closed ones. Assistants' proposals are here and under AI requests; both open the same
 * review page.
 */
export function PlantChangesPage() {
  const { t } = useTranslation(['plantChanges', 'common']);
  const [params, setParams] = useSearchParams();
  const box = (BOXES.find((b) => b === params.get('box')) ?? 'review') as Box;
  const site = params.get('site') ?? '';
  const source = (PLANT_CHANGESET_SOURCES.find((x) => x === params.get('source')) ?? null) as PlantChangeSetSource | null;
  const cfg = useChangeSetConfig();
  const config = usePlantConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  useDraftRefresh();
  const list = useQuery({
    queryKey: plantKeys.changeSets(`${box}:${site}:${source ?? ''}`),
    queryFn: () =>
      get<PlantChangeSetList>(`/plant/change-sets?box=${box}${site ? `&site=${encodeURIComponent(site)}` : ''}${source ? `&source=${source}` : ''}`),
  });
  const start = useMutation({
    mutationFn: () => post<PlantChangeSetDetail>('/plant/change-sets', { title: t('bar.newTitle'), current: true }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      navigate(`/plant/changes/${encodeURIComponent(d.id)}`);
    },
    onError: (e) => notifyError(e),
  });
  const catalogue = useMutation({
    mutationFn: (on: boolean) => put('/plant/change-sets/settings', { catalogueReview: on }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: plantKeys.config }),
    onError: (e) => notifyError(e),
  });
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const rows = list.data?.items ?? [];
  const columns: DataColumn<PlantChangeSetSummary>[] = [
    {
      key: 'title',
      header: t('list.title'),
      cell: (r) => (
        <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(r.id)}`} fw={500} style={{ overflowWrap: 'anywhere' }}>
          {r.title}
        </Anchor>
      ),
      sortValue: (r) => r.title,
    },
    { key: 'state', header: t('list.state'), cell: (r) => <StateBadge state={r.state} />, nowrap: true, sortValue: (r) => r.state },
    { key: 'source', header: t('list.source'), cell: (r) => <SourceBadge source={r.source} />, nowrap: true, sortValue: (r) => r.source },
    { key: 'sites', header: t('list.sites'), cell: (r) => [...r.sites, ...(r.catalogue ? [t('list.catalogue')] : [])].join(', ') || '–' },
    { key: 'ops', header: t('list.changes'), cell: (r) => r.operationCount, nowrap: true, sortValue: (r) => r.operationCount },
    { key: 'by', header: t('list.by'), cell: (r) => r.createdBy, sortValue: (r) => r.createdBy },
    {
      key: 'updated',
      header: t('list.updated'),
      cell: (r) => <span title={fmtDate(r.updatedAt)}>{fmtRelative(r.updatedAt)}</span>,
      nowrap: true,
      sortValue: (r) => r.updatedAt,
    },
  ];
  const tabTo = (b: Box) => `/plant/changes?box=${b}${site ? `&site=${encodeURIComponent(site)}` : ''}`;
  return (
    <ListPage
      testId="plant-changes"
      title={
        <Group gap="sm" component="span">
          <span>{t('title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('description')}
      primaryAction={
        cfg?.canPropose ? (
          <Button leftSection={<IconPlus size={16} aria-hidden />} onClick={() => start.mutate()} loading={start.isPending} data-testid="new-draft">
            {t('list.newDraft')}
          </Button>
        ) : undefined
      }
      empty={{ show: false, icon: IconGitPullRequest, title: '', text: '' }}
    >
      <LinkTabs
        label={t('list.boxes')}
        active={tabTo(box)}
        tabs={BOXES.map((b) => ({
          to: tabTo(b),
          label: t(`boxes.${b}`),
          testId: `changes-box-${b}`,
          ...(b === 'review' ? { count: list.data?.toReview ?? 0 } : {}),
        }))}
      />
      <Group gap="sm" mb="sm" wrap="wrap" align="flex-end">
        <Select
          size="xs"
          label={t('list.source')}
          clearable
          value={source}
          onChange={(v) => setParam('source', v)}
          data={PLANT_CHANGESET_SOURCES.map((x) => ({ value: x, label: t(`sources.${x}`) }))}
          w={180}
        />
        {site && (
          <Button size="xs" variant="default" onClick={() => setParam('site', null)}>
            {t('list.allSites', { site })}
          </Button>
        )}
      </Group>
      {cfg?.level === 'optional' && config.data?.canManageCatalogue && (
        <Paper withBorder p="sm" mb="sm">
          <Switch
            checked={cfg.catalogueReview}
            onChange={(e) => catalogue.mutate(e.currentTarget.checked)}
            label={t('settings.catalogue')}
            description={t('settings.catalogueHint')}
            data-testid="catalogue-review"
          />
        </Paper>
      )}
      <QueryState query={list} />
      {list.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed" data-testid="changes-empty">
          {t(`empty.${box}`)}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          ariaLabel={t(`boxes.${box}`)}
          rowHref={(r) => `/plant/changes/${encodeURIComponent(r.id)}`}
          testId="changes-table"
          card={(r) => (
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <StateBadge state={r.state} />
                <SourceBadge source={r.source} />
              </Group>
              <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(r.id)}`} fw={500} style={{ overflowWrap: 'anywhere' }}>
                {r.title}
              </Anchor>
              <Text size="xs" c="dimmed">
                {t('list.card', { count: r.operationCount, by: r.createdBy, when: fmtRelative(r.updatedAt) })}
              </Text>
            </Stack>
          )}
        />
      )}
    </ListPage>
  );
}
