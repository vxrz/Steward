import { useState } from 'react';
import { Alert, Anchor, Button, Group, List, Menu, Modal, Paper, Select, Stack, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAnchor, IconChevronDown, IconChevronRight, IconDownload, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { AUDIT_SORT_KEYS, type AuditEntry, type AuditFacets, type AuditSortKey, type AuditVerifyResult } from '@sm/shared';
import { apiUrl, confirmedDownload, get, notifyError, post } from '../api';
import { FilterPanel, JsonView, PageHeader, QueryState } from '../components/common';
import { DataTable, ListFooter, type DataColumn, type SortState } from '../components/DataTable';
import { useListParams } from '../components/page/params';
import { fmtDate } from '../format';
import { VerifyReportButton } from '../components/reports/VerifyReportButton';
import { AuditAnchoringPanel } from '../components/security/AuditAnchoringPanel';
import { AuditArchivePanel } from '../components/security/AuditArchivePanel';
import { useMe } from '../auth';

const CATEGORIES = ['run', 'api', 'task', 'check', 'platform', 'process', 'schedule', 'vault', 'report'] as const;

/** Entries per request; "Load more" continues after the last entry shown, in the chosen order. */
export const AUDIT_PAGE = 100;

const DEFAULT_SORT: SortState = { key: 'time', dir: 'desc' };
const isSortKey = (v: string | null): v is AuditSortKey => AUDIT_SORT_KEYS.some((k) => k === v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day of the date filter (YYYY-MM-DD, local time) as the instant it starts; `next`: the instant the day ends. */
function dayStart(day: string | null, next = false): string | undefined {
  if (!day || !DAY.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (next) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** The audit log itself stays English: entries are evidence and must read the same for every auditor (see docs/I18N.md). */
export function AuditPage() {
  const { t } = useTranslation('audit');
  // the filters and the order live in the address (?q=, ?actor=, ?action=, ?type=, ?from=, ?to=, ?sort=, ?order=)
  const { params, set, setAll } = useListParams();
  const qParam = params.get('q') ?? '';
  const [q, setQ] = useState(qParam);
  // the search text goes into the address (and to the server) once typing pauses
  const setSearch = useDebouncedCallback((v: string) => set('q', v.trim()), 300);
  const actor = params.get('actor');
  const action = params.get('action');
  const entityType = params.get('type');
  const from = params.get('from');
  const to = params.get('to');
  const sortParam = params.get('sort');
  const sort: SortState = isSortKey(sortParam) ? { key: sortParam, dir: params.get('order') === 'asc' ? 'asc' : 'desc' } : DEFAULT_SORT;
  const setSort = (next: SortState | null) => {
    const s = next ?? DEFAULT_SORT;
    const isDefault = s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir;
    setAll({ sort: isDefault ? null : s.key, order: isDefault ? null : s.dir });
  };
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  // entries whose details are open (several at a time, this page view)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (seq: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  const [anchorOpen, setAnchorOpen] = useState(false);
  const [anchorText, setAnchorText] = useState('');
  const { caps } = useMe();
  const verifyAgainst = () =>
    post<AuditVerifyResult>('/audit/verify', { anchor: anchorText })
      .then((r) => {
        setVerify(r);
        setAnchorOpen(false);
      })
      .catch((e) => notifyError(e));

  const facets = useQuery({ queryKey: ['audit', 'facets'], queryFn: () => get<AuditFacets>('/audit/facets'), staleTime: 60_000 });
  const filter = {
    q: qParam,
    actor: actor ?? '',
    action: action ?? '',
    entityType: entityType ?? '',
    from: dayStart(from) ?? '',
    to: dayStart(to, true) ?? '',
  };
  const entries = useInfiniteQuery({
    queryKey: ['audit', 'list', filter, sort.key, sort.dir],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(AUDIT_PAGE) });
      for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
      if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) (p.set('sort', sort.key), p.set('order', sort.dir));
      // keyset: the next page continues after the last entry shown, in the same order
      if (pageParam) p.set('afterSeq', String(pageParam));
      return get<AuditEntry[]>(`/audit?${p}`);
    },
    getNextPageParam: (last) => (last.length === AUDIT_PAGE ? last[last.length - 1]!.seq : undefined),
  });
  const rows = entries.data?.pages.flat() ?? [];
  const activeFilters = [actor, action, entityType, from, to].filter(Boolean).length;
  const withCurrent = (values: string[], current: string | null) => (current && !values.includes(current) ? [current, ...values] : values);

  // the number is the toggle (a button: keyboard and screen readers); a click on the row works too
  const toggleButton = (a: AuditEntry) => (
    <UnstyledButton
      onClick={(e) => {
        e.stopPropagation();
        toggle(a.seq);
      }}
      aria-expanded={open.has(a.seq)}
      aria-controls={open.has(a.seq) ? `audit-entry-${a.seq}` : undefined}
      aria-label={t('table.details', { seq: a.seq })}
      mih={24}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
      data-testid="audit-row-toggle"
    >
      {open.has(a.seq) ? <IconChevronDown size={14} aria-hidden /> : <IconChevronRight size={14} aria-hidden />}
      {a.seq}
    </UnstyledButton>
  );
  const details = (a: AuditEntry) => (
    <div id={`audit-entry-${a.seq}`} data-testid="audit-row-details">
      <Text size="xs" c="dimmed" className="mono" mb={4}>
        {t('table.hash', { hash: a.hash })}
      </Text>
      {a.details != null && <JsonView value={a.details} maxHeight={240} />}
    </div>
  );
  const summary = (a: AuditEntry) => (
    <>
      {a.summary}
      {a.runId && (
        <>
          {' '}
          <Anchor component={Link} to={`/runs/${a.runId}`} size="xs" onClick={(e) => e.stopPropagation()}>
            {t('table.run')}
          </Anchor>
        </>
      )}
    </>
  );
  const target = (a: AuditEntry) => (
    <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
      {a.entityType}
      {a.entityId ? ` ${a.entityId}` : ''}
    </Text>
  );
  const columns: DataColumn<AuditEntry>[] = [
    { key: 'seq', header: '#', cell: toggleButton },
    { key: 'time', header: t('table.time'), serverSort: true, nowrap: true, cell: (a) => fmtDate(a.ts) },
    { key: 'actor', header: t('table.actor'), serverSort: true, cell: (a) => a.actor },
    { key: 'action', header: t('table.action'), serverSort: true, nowrap: true, tdProps: () => ({ className: 'mono nowrap' }), cell: (a) => a.action },
    { key: 'target', header: t('table.target'), serverSort: true, cell: target },
    { key: 'summary', header: t('table.summary'), cell: summary },
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <VerifyReportButton />
            <Button
              size="xs"
              variant="light"
              leftSection={<IconShieldCheck size={14} />}
              onClick={() =>
                get<AuditVerifyResult>('/audit/verify')
                  .then(setVerify)
                  .catch((e) => notifyError(e))
              }
            >
              {t('verify')}
            </Button>
            <Button size="xs" variant="light" leftSection={<IconAnchor size={14} />} onClick={() => setAnchorOpen(true)}>
              {t('verifyAnchor')}
            </Button>
            <Menu>
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                  {t('export')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item component="a" href={apiUrl('/audit/export?format=csv')} onClick={confirmedDownload('exportAuditLog')}>
                  CSV
                </Menu.Item>
                <Menu.Item component="a" href={apiUrl('/audit/export?format=jsonl')} onClick={confirmedDownload('exportAuditLog')}>
                  {t('jsonl')}
                </Menu.Item>
                <Menu.Item component="a" href={apiUrl('/audit/export?format=json')} onClick={confirmedDownload('exportAuditLog')}>
                  {t('jsonSigned')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      {verify && (
        <Alert color={verify.ok ? 'green' : 'red'} mb="md" withCloseButton onClose={() => setVerify(null)} title={verify.ok ? t('intact') : t('broken')}>
          {verify.ok
            ? verify.mode === 'incremental' && verify.fromSeq !== undefined
              ? verify.checked
                ? t('intactIncremental', { from: verify.fromSeq + 1, to: verify.fromSeq + verify.checked })
                : t('intactNothingNew', { from: verify.fromSeq })
              : verify.deletedThroughSeq
                ? t('intactDeleted', { count: verify.checked, seq: verify.deletedThroughSeq })
                : t('intactText', { count: verify.checked })
            : verify.firstBadSeq
              ? t('brokenText', { seq: verify.firstBadSeq, message: verify.message })
              : verify.message}
          {!!verify.anchors?.length && (
            <List size="sm" mt={4}>
              {verify.anchors.map((a, i) => (
                <List.Item key={i}>{a.message}</List.Item>
              ))}
            </List>
          )}
          {verify.checkpoint && (
            <Text size="xs" mt={4}>
              {t('checkpointWritten', { seq: verify.checkpoint.seq })}
            </Text>
          )}
        </Alert>
      )}
      <Modal opened={anchorOpen} onClose={() => setAnchorOpen(false)} title={t('verifyAnchor')} size="lg">
        <Stack gap="sm">
          <Text size="sm">{t('anchorHint')}</Text>
          <Textarea
            label={t('anchorLabel')}
            autosize
            minRows={4}
            maxRows={12}
            classNames={{ input: 'mono' }}
            value={anchorText}
            onChange={(e) => setAnchorText(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button onClick={verifyAgainst} disabled={!anchorText.trim()}>
              {t('verify')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <AuditAnchoringPanel canManage={caps.manageSettings} />
      <AuditArchivePanel canManage={caps.manageSettings} />
      <TextInput
        size="xs"
        type="search"
        mb="xs"
        placeholder={t('search')}
        aria-label={t('search')}
        leftSection={<IconSearch size={14} aria-hidden />}
        value={q}
        onChange={(e) => {
          setQ(e.currentTarget.value);
          setSearch(e.currentTarget.value);
        }}
        maw={360}
      />
      <FilterPanel active={activeFilters}>
        <Group mb="md" gap="xs" align="flex-end" wrap="wrap" data-testid="audit-filters">
          <Select
            size="xs"
            label={t('category')}
            placeholder={t('allCategories')}
            clearable
            data={withCurrent(
              CATEGORIES.map((c) => `${c}.`),
              action,
            ).map((v) => {
              const c = CATEGORIES.find((x) => `${x}.` === v);
              return { value: v, label: c ? t(`categories.${c}`) : v };
            })}
            value={action}
            onChange={(v) => set('action', v)}
            w={{ base: '100%', xs: 190 }}
          />
          <Select
            size="xs"
            label={t('table.actor')}
            placeholder={t('allActors')}
            clearable
            searchable
            data={withCurrent(facets.data?.actors ?? [], actor)}
            value={actor}
            onChange={(v) => set('actor', v)}
            w={{ base: '100%', xs: 200 }}
          />
          <Select
            size="xs"
            label={t('targetType')}
            placeholder={t('allTargetTypes')}
            clearable
            searchable
            data={withCurrent(facets.data?.entityTypes ?? [], entityType)}
            value={entityType}
            onChange={(v) => set('type', v)}
            w={{ base: '100%', xs: 200 }}
          />
          <TextInput
            size="xs"
            type="date"
            label={t('from')}
            value={from ?? ''}
            onChange={(e) => set('from', e.currentTarget.value)}
            w={{ base: '100%', xs: 160 }}
          />
          <TextInput size="xs" type="date" label={t('to')} value={to ?? ''} onChange={(e) => set('to', e.currentTarget.value)} w={{ base: '100%', xs: 160 }} />
        </Group>
      </FilterPanel>
      <QueryState query={entries} />
      {entries.isSuccess && rows.length === 0 && (
        <Text c="dimmed" size="sm">
          {t('noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(a) => String(a.seq)}
          ariaLabel={t('title')}
          testId="audit-list"
          sort={sort}
          onSortChange={setSort}
          onRowClick={(a) => toggle(a.seq)}
          rowProps={() => ({ 'data-testid': 'audit-row' })}
          rowDetail={(a) => (open.has(a.seq) ? details(a) : null)}
          footer={
            <ListFooter
              shown={rows.length}
              hasMore={entries.hasNextPage}
              onLoadMore={() => void entries.fetchNextPage()}
              loading={entries.isFetchingNextPage}
            />
          }
          card={(a) => (
            <Paper withBorder p="sm" data-testid="audit-row">
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                {toggleButton(a)}
                <Text size="xs" c="dimmed" ta="right">
                  {fmtDate(a.ts)}
                </Text>
              </Group>
              <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {a.action}
              </Text>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {summary(a)}
              </Text>
              <Group gap={6} mt={4} wrap="wrap">
                <Text size="xs" c="dimmed">
                  {a.actor}
                </Text>
                {target(a)}
              </Group>
              {open.has(a.seq) && <div style={{ marginTop: 8 }}>{details(a)}</div>}
            </Paper>
          )}
        />
      )}
    </>
  );
}
