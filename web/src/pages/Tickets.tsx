import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, CloseButton, Group, MultiSelect, NumberInput, Paper, Select, SimpleGrid, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconPlus, IconTicket } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ServiceSummary, TicketList, TicketReference } from '@sm/shared';
import { get } from '../api';
import { EmptyState, FilterPanel, PageHeader, QueryState, subjectLabel, useCreateParam } from '../components/common';
import { ExternalTicketLink, TICKET_STATUS_IDS, TicketStatusBadge, useSourceLabel, useTicketSettings } from '../components/tickets/common';
import { TicketForm } from '../components/tickets/TicketForm';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { fmtDate, fmtRelative } from '../format';

type State = 'open' | 'closed' | 'all';

function AffectedList({ x }: { x: TicketReference }) {
  const { t } = useTranslation(['tickets', 'records']);
  const visible = x.links.filter((l) => l.visible);
  const hidden = x.links.length - visible.length;
  if (!x.links.length) return <>–</>;
  return (
    <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
      {visible.map((l, i) => (
        <span key={l.id}>
          {i > 0 && ', '}
          {l.path ? (
            <Anchor component={Link} to={l.path} size="xs">
              {l.label}
            </Anchor>
          ) : (
            l.label
          )}
        </span>
      ))}
      {hidden > 0 && `${visible.length ? ', ' : ''}${t('detail.notVisible')}`}
    </Text>
  );
}

export function TicketsPage() {
  const { t } = useTranslation(['tickets', 'records', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [state, setState] = useState<State>('open');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [vendor, setVendor] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null);
  const [responsible, setResponsible] = useState<string | null>(null);
  const [minAge, setMinAge] = useState<number | ''>('');
  const [debounced] = useDebouncedValue(q, 300);
  const link = params.get('link');
  const settings = useTicketSettings();
  const sourceLabel = useSourceLabel();
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const vendors = useQuery({ queryKey: ['ticket-vendors'], queryFn: () => get<string[]>('/ticket-references/vendors') });
  const qs = useMemo(() => {
    const u = new URLSearchParams();
    if (debounced.trim()) u.set('q', debounced.trim());
    if (statuses.length) u.set('status', statuses.join(','));
    else u.set('state', state);
    if (sources.length) u.set('source', sources.join(','));
    if (vendor) u.set('vendor', vendor);
    const item = service ? `service:${service}` : link;
    if (item) u.set('link', item);
    if (responsible) u.set('responsible', responsible);
    if (minAge !== '') u.set('minAgeDays', String(minAge));
    return u.toString();
  }, [debounced, statuses, state, sources, vendor, service, link, responsible, minAge]);
  const list = useQuery({ queryKey: ['ticket-references', qs], queryFn: () => get<TicketList>(`/ticket-references?${qs}`) });
  const [creating, setCreating] = useState(false);
  useCreateParam(list.data?.canCreate, () => setCreating(true));
  const items = list.data?.items ?? [];
  const filtered = !!(debounced.trim() || statuses.length || state !== 'open' || sources.length || vendor || service || link || responsible || minAge !== '');
  const linkLabel = link ? (items.flatMap((x) => x.links).find((l) => l.visible && `${l.kind}:${l.targetId}` === link)?.label ?? link) : null;
  const clearLink = () => {
    const next = new URLSearchParams(params);
    next.delete('link');
    setParams(next, { replace: true });
  };

  const columns: DataColumn<TicketReference>[] = [
    {
      key: 'ticket',
      header: t('table.ticket'),
      sortValue: (x) => x.externalNumber,
      cell: (x) => (
        <>
          <Group gap={6} wrap="nowrap">
            <Anchor component={Link} to={`/tickets/${x.id}`} fw={600} size="sm" className="mono" onClick={(e) => e.stopPropagation()}>
              {x.externalNumber}
            </Anchor>
            <span onClick={(e) => e.stopPropagation()}>
              <ExternalTicketLink ticket={x} size="xs" />
            </span>
          </Group>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {x.title}
          </Text>
          <Text size="xs" c="dimmed">
            {sourceLabel(x.source)}
          </Text>
        </>
      ),
    },
    { key: 'status', header: t('table.status'), sortValue: (x) => TICKET_STATUS_IDS.indexOf(x.status), cell: (x) => <TicketStatusBadge status={x.status} /> },
    { key: 'vendor', header: t('table.vendor'), sortValue: (x) => x.vendor, cell: (x) => x.vendor || '–' },
    {
      key: 'affected',
      header: t('table.affected'),
      tdProps: () => ({ onClick: (e: React.MouseEvent) => e.stopPropagation() }),
      cell: (x) => <AffectedList x={x} />,
    },
    {
      key: 'responsible',
      header: t('table.responsible'),
      sortValue: (x) => x.responsible.map(subjectLabel).join(', '),
      cell: (x) => <Text size="xs">{x.responsible.map(subjectLabel).join(', ') || '–'}</Text>,
    },
    {
      key: 'age',
      header: t('table.age'),
      sortValue: (x) => x.ageDays,
      nowrap: true,
      tdProps: (x) => ({ title: fmtDate(x.openedAt) }),
      cell: (x) => t('ageDays', { count: x.ageDays }),
    },
    {
      key: 'lastChecked',
      header: t('table.lastChecked'),
      sortValue: (x) => x.lastCheckedAt,
      nowrap: true,
      tdProps: (x) => ({ title: x.lastCheckedAt ? fmtDate(x.lastCheckedAt) : undefined }),
      cell: (x) => (x.lastCheckedAt ? fmtRelative(x.lastCheckedAt) : t('neverChecked')),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          list.data?.canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('new')}
            </Button>
          )
        }
      />
      {link && (
        <Group gap={6} mb="sm">
          <Badge variant="light" tt="none" rightSection={<CloseButton size="xs" aria-label={t('common:remove')} onClick={clearLink} />}>
            {t('fields.affected')}: {linkLabel}
          </Badge>
        </Group>
      )}
      <FilterPanel active={[q, state !== 'open', statuses.length, sources.length, vendor, service, responsible, minAge !== ''].filter(Boolean).length}>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs" mb="md">
          <TextInput size="xs" label={t('filters.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Select
            size="xs"
            label={t('filters.state')}
            data={(['open', 'closed', 'all'] as const).map((x) => ({ value: x, label: t(`filters.states.${x}`) }))}
            value={state}
            onChange={(v) => setState((v as State) ?? 'open')}
            allowDeselect={false}
            disabled={statuses.length > 0}
          />
          <MultiSelect
            size="xs"
            label={t('filters.status')}
            placeholder={statuses.length ? undefined : t('filters.allStatuses')}
            data={TICKET_STATUS_IDS.map((x) => ({ value: x, label: t(`status.${x}`) }))}
            value={statuses}
            onChange={setStatuses}
            clearable
          />
          <MultiSelect
            size="xs"
            label={t('filters.source')}
            placeholder={sources.length ? undefined : t('filters.allSources')}
            data={(settings.data?.sources ?? []).map((s) => ({ value: s.key, label: sourceLabel(s.key) }))}
            value={sources}
            onChange={setSources}
            clearable
          />
          <Select
            size="xs"
            label={t('filters.vendor')}
            placeholder={t('filters.allVendors')}
            data={vendors.data ?? []}
            value={vendor}
            onChange={setVendor}
            clearable
            searchable
          />
          <Select
            size="xs"
            label={t('filters.service')}
            placeholder={t('filters.allServices')}
            data={(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={service}
            onChange={setService}
            clearable
            searchable
          />
          <Select
            size="xs"
            label={t('filters.responsible')}
            placeholder={t('filters.anyone')}
            data={[{ value: 'me', label: t('filters.me') }]}
            value={responsible}
            onChange={setResponsible}
            clearable
          />
          <NumberInput size="xs" label={t('filters.minAge')} min={0} max={3650} value={minAge} onChange={(v) => setMinAge(typeof v === 'number' ? v : '')} />
        </SimpleGrid>
      </FilterPanel>
      <QueryState query={list} />
      {list.isSuccess &&
        items.length === 0 &&
        (filtered ? (
          <Text c="dimmed" size="sm">
            {t('emptyFiltered')}
          </Text>
        ) : (
          <EmptyState
            icon={IconTicket}
            title={t('emptyState.title')}
            action={
              list.data.canCreate && (
                <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                  {t('emptyState.action')}
                </Button>
              )
            }
          >
            {t('emptyState.text')}
          </EmptyState>
        ))}
      {items.length > 0 && (
        <DataTable
          rows={items}
          columns={columns}
          rowKey={(x) => x.id}
          ariaLabel={t('title')}
          rowHref={(x) => `/tickets/${x.id}`}
          footer={<ListFooter shown={items.length} />}
          testId="ticket-list"
          card={(x) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6}>
                    <Anchor component={Link} to={`/tickets/${x.id}`} fw={600} size="sm" className="mono">
                      {x.externalNumber}
                    </Anchor>
                    <ExternalTicketLink ticket={x} size="xs" />
                  </Group>
                  <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {x.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {[sourceLabel(x.source), x.vendor, t('ageDays', { count: x.ageDays })].filter(Boolean).join(' · ')}
                  </Text>
                </div>
                <TicketStatusBadge status={x.status} size="xs" />
              </Group>
            </Paper>
          )}
        />
      )}
      {creating && (
        <TicketForm
          ticket={null}
          onClose={() => setCreating(false)}
          onSaved={(x) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['ticket-references'] });
            void qc.invalidateQueries({ queryKey: ['ticket-vendors'] });
            navigate(`/tickets/${x.id}`);
          }}
        />
      )}
    </>
  );
}
