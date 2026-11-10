import { useRef, useState } from 'react';
import { Anchor, Button, FileButton, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebouncedCallback } from '@mantine/hooks';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlugConnected, IconShieldExclamation, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ADVISORY_LIMITS,
  ADVISORY_SEVERITIES,
  ADVISORY_SORTS,
  ADVISORY_STATUSES,
  type AdvisoryList,
  type AdvisorySort,
  type AdvisorySeverity,
  type AdvisoryStatus,
  type AdvisorySummary,
  type AdvisoryUploadResult,
  type PlantSiteSummary,
} from '@sm/shared';
import { ApiError, get, notifyError, notifyOk, post } from '../api';
import { fmtDate, fmtDay } from '../format';
import { plantKeys } from '../queryKeys';
import { DataTable, ListFooter, type DataColumn, type SortState } from '../components/DataTable';
import { useListParams } from '../components/page/params';
import { QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { PreviewBadge } from '../components/plant/common';
import { AdvisoryStatusBadge, SeverityBadge, zoneText } from '../components/plant/advisories/common';
import { AdvisorySourcesModal } from '../components/plant/advisories/Sources';

/**
 * Plant → Advisories (0.14, docs/ADVISORIES.md): CSAF advisories with what they mean for the reader's sites – severity
 * and CVSS, affected assets (exact or confirmed matches only), possible matches apart, sites and zones, status. Designers
 * and administrators upload CSAF files (offline plants); administrators manage the sources.
 */
const PAGE = 50;
const DEFAULT_SORT: SortState = { key: 'severity', dir: 'desc' };
const isSortKey = (k: string | null): k is AdvisorySort => !!k && (ADVISORY_SORTS as readonly string[]).includes(k);

export function PlantAdvisoriesPage() {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  // the filters and the order live in the address and go to the server (?site=, ?status=, ?severity=, ?vendor=, ?q=, ?all=1, ?sort=, ?order=)
  const { params, set, setAll } = useListParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const site = params.get('site') ?? '';
  const status = (ADVISORY_STATUSES.find((x) => x === params.get('status')) ?? null) as AdvisoryStatus | null;
  const severity = (ADVISORY_SEVERITIES.find((x) => x === params.get('severity')) ?? null) as AdvisorySeverity | null;
  const affecting = params.get('all') !== '1';
  const qParam = params.get('q') ?? '';
  const vendorParam = params.get('vendor') ?? '';
  const [q, setQ] = useState(qParam);
  const [vendor, setVendor] = useState(vendorParam);
  // typed text goes into the address (and to the server) once typing pauses
  const setSearch = useDebouncedCallback((v: string) => set('q', v.trim()), 300);
  const setVendorParam = useDebouncedCallback((v: string) => set('vendor', v.trim()), 300);
  const sortParam = params.get('sort');
  const sort: SortState = isSortKey(sortParam) ? { key: sortParam, dir: params.get('order') === 'asc' ? 'asc' : 'desc' } : DEFAULT_SORT;
  const setSort = (next: SortState | null) => {
    const x = next ?? DEFAULT_SORT;
    const isDefault = x.key === DEFAULT_SORT.key && x.dir === DEFAULT_SORT.dir;
    setAll({ sort: isDefault ? null : x.key, order: isDefault ? null : x.dir });
  };
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const resetFile = useRef<() => void>(null);
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (site) query.set('site', site);
  if (status) query.set('status', status);
  if (severity) query.set('severity', severity);
  if (vendorParam) query.set('vendor', vendorParam);
  if (qParam) query.set('q', qParam);
  if (affecting) query.set('affecting', '1');
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) (query.set('sort', sort.key), query.set('order', sort.dir));
  const list = useInfiniteQuery({
    queryKey: plantKeys.advisories(query.toString()),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<AdvisoryList>(`/plant/advisories?${query.toString()}${pageParam ? `&offset=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const sites = useQuery({ queryKey: plantKeys.sites, queryFn: () => get<PlantSiteSummary[]>('/plant/sites') });
  const setParam = (k: string, v: string | null) => set(k, v);
  const upload = async (file: File | null) => {
    resetFile.current?.();
    if (!file) return;
    setUploading(true);
    try {
      if (file.size > ADVISORY_LIMITS.documentBytes)
        throw new ApiError(413, 'too large', undefined, 'PLANT_ADVISORY_TOO_LARGE', { mb: ADVISORY_LIMITS.documentBytes / 1024 / 1024 });
      const r = await post<AdvisoryUploadResult>('/plant/advisories/upload', { content: await file.text(), fileName: file.name });
      notifyOk(t('upload.done', { id: r.advisory.trackingId, result: t(`upload.result.${r.result}`), matches: r.matches, possible: r.possible }));
      void qc.invalidateQueries({ queryKey: ['plant', 'advisories'] });
      navigate(`/plant/advisories/${encodeURIComponent(r.advisory.id)}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setUploading(false);
    }
  };
  const first = list.data?.pages[0];
  const total = first?.total ?? 0;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!(site || status || severity || vendorParam || qParam);
  const href = (a: AdvisorySummary) => `/plant/advisories/${encodeURIComponent(a.id)}${site ? `?site=${encodeURIComponent(site)}` : ''}`;
  const affected = (a: AdvisorySummary) => (
    <Stack gap={0}>
      <Text size="sm">{t('list.affectedCount', { count: a.affectedAssets })}</Text>
      {a.openAssets > 0 && (
        <Text size="xs" c="red">
          {t('list.openCount', { count: a.openAssets })}
        </Text>
      )}
      {a.possibleMatches > 0 && (
        <Text size="xs" c="dimmed">
          {t('list.possibleCount', { count: a.possibleMatches })}
        </Text>
      )}
    </Stack>
  );
  const columns: DataColumn<AdvisorySummary>[] = [
    {
      key: 'title',
      header: t('list.advisory'),
      cell: (a) => (
        <Stack gap={0}>
          <Anchor component={Link} to={href(a)} fw={500} style={{ overflowWrap: 'anywhere' }}>
            {a.title}
          </Anchor>
          <Text size="xs" c="dimmed">
            {a.trackingId} · {a.publisher}
            {a.cves.length ? ` · ${a.cves.slice(0, 3).join(', ')}${a.cves.length > 3 ? ' …' : ''}` : ''}
          </Text>
        </Stack>
      ),
      serverSort: true,
    },
    {
      key: 'severity',
      header: t('list.severity'),
      cell: (a) => <SeverityBadge severity={a.severity} cvss={a.cvss} />,
      nowrap: true,
      serverSort: true,
    },
    { key: 'affected', header: t('list.affected'), cell: affected, serverSort: true },
    { key: 'sites', header: t('list.sites'), cell: (a) => a.sites.map((s) => s.name).join(', ') || '–' },
    { key: 'zones', header: t('list.zones'), cell: (a) => a.zones.map((z) => zoneText(t, z)).join(', ') || '–' },
    {
      key: 'updated',
      header: t('list.updated'),
      cell: (a) => <span title={fmtDate(a.updated)}>{fmtDay(a.updated)}</span>,
      nowrap: true,
      sortValue: (a) => a.updated,
    },
    { key: 'published', header: t('list.published'), cell: (a) => fmtDay(a.published), nowrap: true, serverSort: true },
    { key: 'status', header: t('list.status'), cell: (a) => <AdvisoryStatusBadge status={a.status} /> },
  ];
  const empty = list.isSuccess && total === 0 && !filtered && !affecting;
  return (
    <ListPage
      testId="plant-advisories"
      title={
        <Group gap="sm" component="span">
          <span>{t('title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('description')}
      primaryAction={
        first?.canUpload ? (
          <FileButton resetRef={resetFile} onChange={(f) => void upload(f)} accept="application/json,.json">
            {(props) => (
              <Button leftSection={<IconUpload size={16} aria-hidden />} loading={uploading} data-testid="advisory-upload" {...props}>
                {t('upload.button')}
              </Button>
            )}
          </FileButton>
        ) : undefined
      }
      actions={
        first?.canManageSources ? (
          <Button
            variant="default"
            leftSection={<IconPlugConnected size={16} aria-hidden />}
            onClick={() => setSourcesOpen(true)}
            data-testid="advisory-sources"
          >
            {t('sources.button')}
          </Button>
        ) : undefined
      }
      search={{
        value: q,
        onChange: (v) => {
          setQ(v);
          setSearch(v);
        },
        placeholder: t('list.search'),
      }}
      filters={
        <Group gap="sm" wrap="wrap" align="flex-end">
          <Select
            size="xs"
            label={t('list.site')}
            clearable
            placeholder={t('list.allSites')}
            value={site || null}
            onChange={(v) => setParam('site', v)}
            data={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            w={180}
          />
          <TextInput
            size="xs"
            label={t('list.vendor')}
            value={vendor}
            onChange={(e) => {
              setVendor(e.currentTarget.value);
              setVendorParam(e.currentTarget.value);
            }}
            w={180}
            data-testid="advisories-vendor"
          />
          <Select
            size="xs"
            label={t('list.severity')}
            clearable
            placeholder={t('list.anySeverity')}
            value={severity}
            onChange={(v) => setParam('severity', v)}
            data={ADVISORY_SEVERITIES.map((s) => ({ value: s, label: t(`severity.${s}`) }))}
            w={160}
          />
          <Select
            size="xs"
            label={t('list.status')}
            clearable
            placeholder={t('list.anyStatus')}
            value={status}
            onChange={(v) => setParam('status', v)}
            data={ADVISORY_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            w={180}
          />
          <Switch
            size="sm"
            checked={affecting}
            onChange={(e) => setParam('all', e.currentTarget.checked ? null : '1')}
            label={t('list.affecting')}
            data-testid="advisories-affecting"
          />
        </Group>
      }
      activeFilters={[site, status, severity, vendorParam].filter(Boolean).length + (affecting ? 0 : 1)}
      empty={{ show: empty, icon: IconShieldExclamation, title: t('list.emptyTitle'), text: t('list.emptyText') }}
    >
      <QueryState query={list} />
      {list.isSuccess && !empty && rows.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="advisories-empty">
          {affecting && !filtered ? t('list.noAffecting') : t('list.noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(a) => a.id}
          ariaLabel={t('list.label')}
          rowHref={href}
          testId="advisories-table"
          sort={sort}
          onSortChange={setSort}
          footer={
            <ListFooter
              shown={rows.length}
              total={total}
              hasMore={list.hasNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              loading={list.isFetchingNextPage}
            />
          }
          card={(a) => (
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <SeverityBadge severity={a.severity} cvss={a.cvss} />
                <AdvisoryStatusBadge status={a.status} />
              </Group>
              <Anchor component={Link} to={href(a)} fw={500} style={{ overflowWrap: 'anywhere' }}>
                {a.title}
              </Anchor>
              <Text size="xs" c="dimmed">
                {a.trackingId} · {t('list.card', { publisher: a.publisher, updated: fmtDay(a.updated) })}
              </Text>
              {affected(a)}
              {a.sites.length > 0 && <Text size="xs">{a.sites.map((s) => s.name).join(', ')}</Text>}
            </Stack>
          )}
        />
      )}
      {sourcesOpen && <AdvisorySourcesModal onClose={() => setSourcesOpen(false)} />}
    </ListPage>
  );
}
