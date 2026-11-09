import { useRef, useState } from 'react';
import { Anchor, Button, FileButton, Group, Select, Stack, Switch, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconPlugConnected, IconShieldExclamation, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ADVISORY_LIMITS,
  ADVISORY_SEVERITIES,
  ADVISORY_SEVERITY_RANK,
  ADVISORY_STATUSES,
  type AdvisoryList,
  type AdvisorySeverity,
  type AdvisoryStatus,
  type AdvisorySummary,
  type AdvisoryUploadResult,
  type PlantSiteSummary,
} from '@sm/shared';
import { ApiError, get, notifyError, notifyOk, post } from '../api';
import { fmtDate, fmtDay } from '../format';
import { plantKeys } from '../queryKeys';
import { DataTable, type DataColumn } from '../components/DataTable';
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
export function PlantAdvisoriesPage() {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const site = params.get('site') ?? '';
  const status = (ADVISORY_STATUSES.find((x) => x === params.get('status')) ?? null) as AdvisoryStatus | null;
  const severity = (ADVISORY_SEVERITIES.find((x) => x === params.get('severity')) ?? null) as AdvisorySeverity | null;
  const affecting = params.get('all') !== '1';
  const [q, setQ] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const resetFile = useRef<() => void>(null);
  const query = new URLSearchParams();
  if (site) query.set('site', site);
  if (status) query.set('status', status);
  if (severity) query.set('severity', severity);
  if (affecting) query.set('affecting', '1');
  const list = useQuery({ queryKey: plantKeys.advisories(query.toString()), queryFn: () => get<AdvisoryList>(`/plant/advisories?${query.toString()}`) });
  const sites = useQuery({ queryKey: plantKeys.sites, queryFn: () => get<PlantSiteSummary[]>('/plant/sites') });
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
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
  const needle = q.trim().toLowerCase();
  const all = list.data?.items ?? [];
  const rows = all
    .filter((a) => !needle || [a.title, a.trackingId, a.publisher, ...a.cves].some((x) => x.toLowerCase().includes(needle)))
    .sort(
      (a, b) => ADVISORY_SEVERITY_RANK[b.severity] - ADVISORY_SEVERITY_RANK[a.severity] || (b.cvss ?? 0) - (a.cvss ?? 0) || b.updated.localeCompare(a.updated),
    );
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
      sortValue: (a) => a.title,
    },
    {
      key: 'severity',
      header: t('list.severity'),
      cell: (a) => <SeverityBadge severity={a.severity} cvss={a.cvss} />,
      nowrap: true,
      sortValue: (a) => ADVISORY_SEVERITY_RANK[a.severity] * 100 + (a.cvss ?? 0),
    },
    { key: 'affected', header: t('list.affected'), cell: affected, sortValue: (a) => a.affectedAssets * 1000 + a.possibleMatches },
    { key: 'sites', header: t('list.sites'), cell: (a) => a.sites.map((s) => s.name).join(', ') || '–' },
    { key: 'zones', header: t('list.zones'), cell: (a) => a.zones.map((z) => zoneText(t, z)).join(', ') || '–' },
    {
      key: 'updated',
      header: t('list.updated'),
      cell: (a) => <span title={fmtDate(a.updated)}>{fmtDay(a.updated)}</span>,
      nowrap: true,
      sortValue: (a) => a.updated,
    },
    { key: 'published', header: t('list.published'), cell: (a) => fmtDay(a.published), nowrap: true, sortValue: (a) => a.published },
    { key: 'status', header: t('list.status'), cell: (a) => <AdvisoryStatusBadge status={a.status} />, nowrap: true, sortValue: (a) => a.status },
  ];
  const empty = list.isSuccess && all.length === 0 && !site && !status && !severity && !affecting;
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
        list.data?.canUpload ? (
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
        list.data?.canManageSources ? (
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
      search={{ value: q, onChange: setQ, placeholder: t('list.search') }}
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
      activeFilters={[site, status, severity].filter(Boolean).length + (affecting ? 0 : 1)}
      empty={{ show: empty, icon: IconShieldExclamation, title: t('list.emptyTitle'), text: t('list.emptyText') }}
    >
      <QueryState query={list} />
      {list.isSuccess && !empty && rows.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="advisories-empty">
          {affecting && !site && !status && !severity && !needle ? t('list.noAffecting') : t('list.noMatch')}
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
      {(list.data?.more ?? 0) > 0 && (
        <Text size="sm" c="dimmed" mt="sm">
          {t('list.more', { count: list.data!.more })}
        </Text>
      )}
      {sourcesOpen && <AdvisorySourcesModal onClose={() => setSourcesOpen(false)} />}
    </ListPage>
  );
}
