import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, CloseButton, Group, MultiSelect, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconPlus, IconTicket } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ServiceSummary, TicketList, TicketReference } from '@sm/shared';
import { get } from '../api';
import { EmptyState, FilterPanel, PageHeader, QueryState, subjectLabel, useCreateParam } from '../components/common';
import { ExternalTicketLink, TICKET_STATUS_IDS, TicketStatusBadge, useSourceLabel, useTicketSettings } from '../components/tickets/common';
import { TicketForm } from '../components/tickets/TicketForm';
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
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
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
      {items.length > 0 &&
        (narrow ? (
          <Stack gap="xs" role="list" aria-label={t('title')}>
            {items.map((x) => (
              <Paper key={x.id} withBorder p="sm" role="listitem">
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
            ))}
          </Stack>
        ) : (
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" aria-label={t('title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('table.ticket')}</Table.Th>
                  <Table.Th>{t('table.status')}</Table.Th>
                  <Table.Th>{t('table.vendor')}</Table.Th>
                  <Table.Th>{t('table.affected')}</Table.Th>
                  <Table.Th>{t('table.responsible')}</Table.Th>
                  <Table.Th>{t('table.age')}</Table.Th>
                  <Table.Th>{t('table.lastChecked')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((x) => (
                  <Table.Tr key={x.id} className="clickable" onClick={() => navigate(`/tickets/${x.id}`)}>
                    <Table.Td>
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
                    </Table.Td>
                    <Table.Td>
                      <TicketStatusBadge status={x.status} />
                    </Table.Td>
                    <Table.Td>{x.vendor || '–'}</Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <AffectedList x={x} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{x.responsible.map(subjectLabel).join(', ') || '–'}</Text>
                    </Table.Td>
                    <Table.Td className="nowrap" title={fmtDate(x.openedAt)}>
                      {t('ageDays', { count: x.ageDays })}
                    </Table.Td>
                    <Table.Td className="nowrap" title={x.lastCheckedAt ? fmtDate(x.lastCheckedAt) : undefined}>
                      {x.lastCheckedAt ? fmtRelative(x.lastCheckedAt) : t('neverChecked')}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
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
