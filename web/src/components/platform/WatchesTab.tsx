import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Autocomplete, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconExternalLink, IconFileDiff, IconLink, IconRefresh, IconSearch } from '@tabler/icons-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PAGE_WATCH_LIMITS,
  PAGE_WATCH_STATES,
  tagsMatch,
  type ApplicationSummary,
  type PageWatch,
  type PageWatchHistory,
  type PageWatchList,
  type PageWatchState,
  type Platform,
  type ServiceSummary,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { platformKeys } from '../../queryKeys';
import { fmtDate, fmtRelative } from '../../format';
import { DataTable, type DataColumn } from '../DataTable';
import { EmptyState, FilterPanel, TONE } from '../common';
import { SupplierPicker, useSupplierChoice } from '../suppliers/SupplierPicker';

const STATE_COLORS: Record<PageWatchState, string> = {
  ok: TONE.ok,
  failing: TONE.bad,
  paused: TONE.neutral,
  unchecked: TONE.soon,
  removed: TONE.neutral,
};

function StateBadge({ state }: { state: PageWatchState }) {
  const { t } = useTranslation('platforms');
  return (
    <Badge
      color={STATE_COLORS[state]}
      variant="light"
      size="sm"
      styles={{ root: { flexShrink: 0, maxWidth: 'none', overflow: 'visible' }, label: { overflow: 'visible' } }}
    >
      {t(`watches.state.${state}`)}
    </Badge>
  );
}

/** Application, service and vendor of a watch, as links where the reader may open them. */
function Links({ w }: { w: PageWatch }) {
  const { t } = useTranslation('platforms');
  const parts = [
    w.application &&
      (w.application.visible && w.application.path ? (
        <Anchor key="a" component={Link} to={w.application.path} size="sm">
          {w.application.label}
        </Anchor>
      ) : (
        <Text key="a" span size="sm" c="dimmed">
          {t('watches.hidden')}
        </Text>
      )),
    w.service &&
      (w.service.visible && w.service.path ? (
        <Anchor key="s" component={Link} to={w.service.path} size="sm">
          {w.service.label}
        </Anchor>
      ) : (
        <Text key="s" span size="sm" c="dimmed">
          {t('watches.hidden')}
        </Text>
      )),
    w.supplier ? (
      <Anchor key="v" component={Link} to={`/suppliers/${w.supplier.id}`} size="sm">
        {t('watches.vendorIs', { vendor: w.supplier.name })}
      </Anchor>
    ) : (
      w.vendor && (
        <Text key="v" span size="sm">
          {t('watches.vendorIs', { vendor: w.vendor })}
        </Text>
      )
    ),
  ].filter(Boolean);
  if (!parts.length)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  return <Stack gap={0}>{parts}</Stack>;
}

function Title({ w }: { w: PageWatch }) {
  return (
    <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
      <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
        {w.title}
      </Text>
      <Anchor href={w.url} target="_blank" rel="noreferrer noopener" size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {w.url}
      </Anchor>
      {w.tags.length > 0 && (
        <Group gap={4}>
          {w.tags.map((tag) => (
            <Badge key={tag} size="xs" variant="outline" color="gray" tt="none">
              {tag}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  );
}

/**
 * Platform → Watches (changedetection.io platforms, #242): the watches as components of the platform – metadata only,
 * never page contents –, read now or every hour in the background, filtered by text, tag and state, each with its
 * diff in changedetection.io, its snapshot times and its links to an application, a service or a vendor.
 */
export function WatchesTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const list = useQuery({ queryKey: platformKeys.watches(platform.id), queryFn: () => get<PageWatchList>(`/changedetection/${platform.id}/watches`) });
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PageWatch | null>(null);
  const [history, setHistory] = useState<PageWatch | null>(null);
  const focus = params.get('watch');
  const data = list.data;

  useEffect(() => {
    // ?watch=<uuid> (a backlink of an application or service) shows that watch
    if (focus && data?.watches.some((w) => w.uuid === focus)) setQ(data.watches.find((w) => w.uuid === focus)!.title);
  }, [focus, data]);

  const rows = useMemo(() => {
    const text = q.trim().toLowerCase();
    return (data?.watches ?? []).filter(
      (w) =>
        (!text || [w.title, w.url, w.vendor, w.application?.label ?? '', w.service?.label ?? ''].some((x) => x.toLowerCase().includes(text))) &&
        (!tag || tagsMatch(w.tags, tag)) &&
        (!state || w.state === state),
    );
  }, [data, q, tag, state]);

  const readNow = async () => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; total?: number; error?: string }>(`/changedetection/${platform.id}/watches/read`);
      if (r.ok) notifyOk(t('watches.read', { count: r.total ?? 0 }));
      else notifyError(new Error(r.error ?? ''), t('watches.readFailed'));
    } catch (e) {
      notifyError(e, t('watches.readFailed'));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: platformKeys.watches(platform.id) });
    }
  };

  if (!data) return null;
  const failing = data.watches.filter((w) => w.state === 'failing').length;
  const columns: DataColumn<PageWatch>[] = [
    { key: 'title', header: t('watches.col.watch'), cell: (w) => <Title w={w} />, sortValue: (w) => w.title },
    { key: 'state', header: t('watches.col.state'), cell: (w) => <StateBadge state={w.state} />, sortValue: (w) => w.state, nowrap: true },
    {
      key: 'changed',
      header: t('watches.col.changed'),
      cell: (w) => (w.lastChangedAt ? fmtRelative(w.lastChangedAt) : t('watches.noChange')),
      sortValue: (w) => w.lastChangedAt ?? '',
      nowrap: true,
      tdProps: (w) => ({ title: w.lastChangedAt ? fmtDate(w.lastChangedAt) : undefined }),
    },
    {
      key: 'checked',
      header: t('watches.col.checked'),
      cell: (w) => (
        <Stack gap={0}>
          <Text size="sm">{w.lastCheckedAt ? fmtRelative(w.lastCheckedAt) : t('watches.never')}</Text>
          {w.lastError && (
            <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>
              {w.lastError}
            </Text>
          )}
        </Stack>
      ),
      sortValue: (w) => w.lastCheckedAt ?? '',
    },
    { key: 'links', header: t('watches.col.links'), cell: (w) => <Links w={w} /> },
    {
      key: 'actions',
      header: <span className="visually-hidden">{t('watches.col.actions')}</span>,
      label: t('watches.col.actions'),
      cell: (w) => <Actions w={w} />,
    },
  ];

  function Actions({ w }: { w: PageWatch }) {
    return (
      <Group gap={4} wrap="nowrap">
        <Button
          component="a"
          href={w.diffUrl}
          target="_blank"
          rel="noreferrer noopener"
          size="compact-xs"
          variant="subtle"
          leftSection={<IconFileDiff size={14} />}
          aria-label={t('watches.diffOf', { title: w.title })}
        >
          {t('watches.diff')}
        </Button>
        {data!.canRead && w.state !== 'removed' && (
          <Button size="compact-xs" variant="subtle" onClick={() => setHistory(w)} aria-label={t('watches.historyOf', { title: w.title })}>
            {t('watches.history')}
          </Button>
        )}
        {data!.canLink && (
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconLink size={14} />}
            onClick={() => setEditing(w)}
            aria-label={t('watches.linkOf', { title: w.title })}
          >
            {t('watches.link')}
          </Button>
        )}
      </Group>
    );
  }

  const card = (w: PageWatch) => (
    <Paper withBorder p="sm" data-testid="watch-card">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Title w={w} />
          <StateBadge state={w.state} />
        </Group>
        <Text size="xs" c="dimmed">
          {t('watches.changedChecked', {
            changed: w.lastChangedAt ? fmtRelative(w.lastChangedAt) : t('watches.noChange'),
            checked: w.lastCheckedAt ? fmtRelative(w.lastCheckedAt) : t('watches.never'),
          })}
        </Text>
        {w.lastError && (
          <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>
            {w.lastError}
          </Text>
        )}
        {(w.application || w.service || w.vendor || w.supplier) && <Links w={w} />}
        <Actions w={w} />
      </Stack>
    </Paper>
  );

  const activeFilters = (tag ? 1 : 0) + (state ? 1 : 0);
  return (
    <Stack data-testid="watches-tab">
      <Text size="sm" c="dimmed">
        {t('watches.intro')}
      </Text>
      {data.error && (
        <Alert color="red" title={t('watches.lastReadFailed')}>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {data.error}
          </Text>
        </Alert>
      )}
      <Group justify="space-between" gap="xs">
        <Group gap="xs">
          {failing > 0 && (
            <Badge color={TONE.bad} variant="light">
              {t('watches.failingCount', { count: failing })}
            </Badge>
          )}
          <Text size="xs" c="dimmed">
            {data.readAt ? t('watches.lastRead', { when: fmtRelative(data.readAt), who: data.readBy ?? '', count: data.total }) : t('watches.neverRead')}
          </Text>
        </Group>
        <Group gap="xs">
          <Button
            component="a"
            href={data.uiUrl}
            target="_blank"
            rel="noreferrer noopener"
            size="xs"
            variant="default"
            leftSection={<IconExternalLink size={14} />}
          >
            {t('watches.open')}
          </Button>
          {data.canRead && (
            <Button size="xs" leftSection={<IconRefresh size={14} />} loading={busy} onClick={readNow}>
              {t('watches.readNow')}
            </Button>
          )}
        </Group>
      </Group>
      {data.watches.length === 0 ? (
        <EmptyState
          icon={IconFileDiff}
          title={data.readAt ? t('watches.emptyTitle') : t('watches.notReadTitle')}
          whoCanAct={data.canRead ? undefined : t('watches.whoCanRead')}
          action={
            data.canRead && !data.readAt ? (
              <Button size="xs" leftSection={<IconRefresh size={14} />} loading={busy} onClick={readNow}>
                {t('watches.readNow')}
              </Button>
            ) : undefined
          }
        >
          {data.readAt ? t('watches.emptyText') : t('watches.notReadText')}
        </EmptyState>
      ) : (
        <>
          <div>
            <TextInput
              size="xs"
              mb="xs"
              maw={360}
              type="search"
              leftSection={<IconSearch size={14} aria-hidden />}
              aria-label={t('watches.search')}
              placeholder={t('watches.search')}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
            />
            <FilterPanel active={activeFilters}>
              <Group gap="xs" mb="md" align="flex-end">
                <Select
                  size="xs"
                  label={t('watches.filterTag')}
                  placeholder={t('watches.allTags')}
                  clearable
                  searchable
                  data={data.tags}
                  value={tag}
                  onChange={setTag}
                />
                <Select
                  size="xs"
                  label={t('watches.filterState')}
                  placeholder={t('watches.allStates')}
                  clearable
                  data={PAGE_WATCH_STATES.map((s) => ({ value: s, label: t(`watches.state.${s}`) }))}
                  value={state}
                  onChange={setState}
                />
              </Group>
            </FilterPanel>
          </div>
          {rows.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('watches.noMatch')}
            </Text>
          ) : (
            <DataTable rows={rows} columns={columns} rowKey={(w) => w.uuid} ariaLabel={t('watches.tableLabel')} card={card} testId="watches-table" />
          )}
          {data.total > data.watches.length && (
            <Text size="xs" c="dimmed">
              {t('watches.limited', { shown: data.watches.length, total: data.total, max: PAGE_WATCH_LIMITS.watches })}
            </Text>
          )}
        </>
      )}
      {editing && (
        <LinkModal
          platformId={platform.id}
          watch={editing}
          vendors={[...new Set(data.watches.map((w) => w.vendor).filter(Boolean))].sort()}
          onClose={() => setEditing(null)}
        />
      )}
      {history && <HistoryModal platformId={platform.id} watch={history} onClose={() => setHistory(null)} />}
    </Stack>
  );
}

/** Links a watch to an application, a service and a vendor (platform managers). A hidden application or service stays linked unless replaced. */
function LinkModal({ platformId, watch: w, vendors, onClose }: { platformId: string; watch: PageWatch; vendors: string[]; onClose: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const [application, setApplication] = useState<string | null | undefined>(undefined);
  const [service, setService] = useState<string | null | undefined>(undefined);
  const [vendor, setVendor] = useState(w.vendor);
  const supplier = useSupplierChoice(w.supplier);
  const [saving, setSaving] = useState(false);
  const appValue = application === undefined ? (w.application?.id ?? null) : application;
  const serviceValue = service === undefined ? (w.service?.id ?? null) : service;
  const save = async () => {
    setSaving(true);
    try {
      await put(`/changedetection/${platformId}/watches/${w.uuid}/link`, {
        ...(application !== undefined ? { applicationId: application } : {}),
        ...(service !== undefined ? { serviceId: service } : {}),
        vendor: vendor.trim(),
        ...(supplier.body !== undefined ? { supplierId: supplier.body } : {}),
      });
      notifyOk(t('watches.linked'));
      void qc.invalidateQueries({ queryKey: platformKeys.watches(platformId) });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('watches.linkTitle', { title: w.title })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('watches.linkIntro')}
        </Text>
        <Select
          label={t('watches.application')}
          searchable
          clearable
          data={(apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          value={appValue}
          placeholder={w.application && !w.application.visible && application === undefined ? t('watches.hidden') : undefined}
          onChange={setApplication}
        />
        <Select
          label={t('watches.service')}
          searchable
          clearable
          data={(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          value={serviceValue}
          placeholder={w.service && !w.service.visible && service === undefined ? t('watches.hidden') : undefined}
          onChange={setService}
        />
        <SupplierPicker value={supplier.value} onChange={supplier.set} initial={w.supplier} testId="watch-supplier">
          <Autocomplete
            label={t('watches.vendor')}
            description={t('watches.vendorHint')}
            maxLength={PAGE_WATCH_LIMITS.vendor}
            data={vendors}
            value={vendor}
            onChange={setVendor}
          />
        </SupplierPicker>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button loading={saving} onClick={save}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The snapshot times of a watch, read now – never the snapshots. */
function HistoryModal({ platformId, watch: w, onClose }: { platformId: string; watch: PageWatch; onClose: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const h = useQuery({
    queryKey: platformKeys.watchHistory(platformId, w.uuid),
    queryFn: () => get<PageWatchHistory>(`/changedetection/${platformId}/watches/${w.uuid}/history`),
    retry: false,
  });
  return (
    <Modal opened onClose={onClose} title={t('watches.historyTitle', { title: w.title })}>
      <Stack gap="xs">
        {h.error && <Alert color="red">{(h.error as Error).message}</Alert>}
        {h.data && (
          <>
            <Text size="sm">{t('watches.snapshots', { count: h.data.count, changes: Math.max(0, h.data.count - 1) })}</Text>
            <Stack gap={2} component="ul" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
              {h.data.snapshots.map((s, i) => (
                <Text key={s} size="sm" component="li">
                  {fmtDate(s)}
                  {i === h.data.snapshots.length - 1 && h.data.count === h.data.snapshots.length ? ` · ${t('watches.firstSnapshot')}` : ''}
                </Text>
              ))}
            </Stack>
            <Text size="xs" c="dimmed">
              {t('watches.historyNote')}
            </Text>
            <Group justify="flex-end">
              <Button component="a" href={h.data.diffUrl} target="_blank" rel="noreferrer noopener" leftSection={<IconFileDiff size={14} />} variant="light">
                {t('watches.diff')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
