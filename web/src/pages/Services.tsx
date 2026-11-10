import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Box, Button, Group, Modal, MultiSelect, Paper, Select, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconExternalLink, IconFileAlert, IconPlus, IconStack2, IconTicket, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SubjectsInput } from '../components/SubjectsInput';
import { SERVICE_CONTACT_ROLES, SERVICE_CRITICALITIES, tagsMatch, type ServiceContact, type ServiceDetail, type ServiceSummary } from '@sm/shared';
import { TagBadges, TagFilterChip, TagInput, useTagFilter } from '../components/tags';
import { get, notifyError, post, put } from '../api';
import { EmptyState, QueryState, subjectLabel, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { NeedBadges } from '../components/catalogue/cia';
import { ListPage } from '../components/page/ListPage';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { ServiceTabs } from '../components/page/LinkTabs';
import { RestrictedEmpty, useHiddenByPermissions } from '../components/modules/RestrictedEmpty';

export const CRITICALITY_COLORS: Record<string, string> = { low: 'gray', medium: 'blue', high: 'orange', critical: 'red' };

export function CriticalityBadge({ value }: { value: string | null }) {
  const { t } = useTranslation('services');
  if (!value) return null;
  return (
    <Badge color={CRITICALITY_COLORS[value] ?? 'gray'} variant="light">
      {t(`criticalities.${value as 'low'}`)}
    </Badge>
  );
}

/** "2 open vendor tickets" – links to the ticket list of the service. */
function VendorTicketsBadge({ count, serviceId, ml }: { count: number | undefined; serviceId: string; ml?: number }) {
  const { t } = useTranslation('tickets');
  if (!count) return null;
  return (
    <Badge
      component={Link}
      to={`/tickets?link=${encodeURIComponent(`service:${serviceId}`)}`}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      size="xs"
      color="yellow"
      variant="light"
      tt="none"
      ml={ml}
      leftSection={<IconTicket size={11} aria-hidden />}
      style={{ cursor: 'pointer' }}
    >
      {t('vendorBadge', { count })}
    </Badge>
  );
}

/** "1 review overdue": living documents of the service (only those the reader may read) whose periodic review is overdue. */
function OverdueReviewsBadge({ count, ml }: { count: number; ml?: number }) {
  const { t } = useTranslation('services');
  if (!count) return null;
  return (
    <Badge size="xs" color="red" variant="light" tt="none" ml={ml} leftSection={<IconFileAlert size={11} aria-hidden />} data-testid="overdue-reviews">
      {t('overdueBadge', { count })}
    </Badge>
  );
}

/** Sort order of the criticality column: the most critical first when descending. */
export const CRITICALITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function ServicesPage() {
  const { t } = useTranslation(['services', 'common', 'applications']);
  const navigate = useNavigate();
  // the filters live in the address (?q=, ?criticality=, ?owner=, ?archived=1, ?tag=), so a filtered list can be shared
  const { params, set } = useListParams();
  const q = params.get('q') ?? '';
  const criticality = params.getAll('criticality').filter((c) => (SERVICE_CRITICALITIES as readonly string[]).includes(c));
  const owner = params.get('owner');
  const archived = params.get('archived') === '1';
  const [creating, setCreating] = useState(false);
  const services = useQuery({ queryKey: ['services', archived], queryFn: () => get<ServiceSummary[]>(`/services${archived ? '?archived=1' : ''}`) });
  const vendorTickets = useQuery({
    queryKey: ['ticket-references', 'open-counts', 'service'],
    queryFn: () => get<Record<string, number>>('/ticket-references/open-counts?kind=service&vendorOnly=1'),
  });
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));
  const [tag, setTag] = useTagFilter();
  const all = services.data ?? [];
  const needle = q.trim().toLowerCase();
  const list = all.filter(
    (s) =>
      tagsMatch(s.tags, tag) &&
      (!needle || [s.name, s.cmdb?.id ?? '', ...s.contacts.map((c) => c.email), ...s.tags].some((x) => x.toLowerCase().includes(needle))) &&
      (!criticality.length || (s.criticality !== null && criticality.includes(s.criticality))) &&
      (!owner || s.owners.includes(owner)),
  );
  // services the person may not see (U3): "nothing you may see" instead of "no services yet"
  const hidden = useHiddenByPermissions('services');
  const cmdbText = (s: ServiceSummary) => (s.cmdb ? [s.cmdb.system, s.cmdb.id].filter(Boolean).join(' ') : '');
  const columns: DataColumn<ServiceSummary>[] = [
    {
      key: 'name',
      header: t('name'),
      sortValue: (s) => s.name,
      cell: (s) => (
        <>
          <Anchor component={Link} to={`/services/${s.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
            {s.name}
          </Anchor>
          {s.archived && (
            <Badge ml={6} size="xs" variant="outline" color="gray">
              {t('archived')}
            </Badge>
          )}
          <VendorTicketsBadge count={vendorTickets.data?.[s.id]} serviceId={s.id} ml={6} />
          <OverdueReviewsBadge count={s.overdueDocuments} ml={6} />
          {s.tags.length > 0 && (
            <Box mt={2}>
              <TagBadges tags={s.tags} onTag={setTag} />
            </Box>
          )}
        </>
      ),
    },
    {
      key: 'criticality',
      header: t('criticality'),
      sortValue: (s) => (s.criticality ? CRITICALITY_RANK[s.criticality] : null),
      cell: (s) => (s.criticality ? <CriticalityBadge value={s.criticality} /> : '–'),
    },
    { key: 'need', header: t('applications:need.title'), cell: (s) => <NeedBadges need={s.protectionNeed} /> },
    {
      key: 'contacts',
      header: t('contacts'),
      sortValue: (s) => s.contacts[0]?.email,
      cell: (s) =>
        s.contacts.map((c) => (
          <Text key={`${c.role}${c.email}`} size="xs">
            {t(`contactRoles.${c.role}`)}: {c.email}
          </Text>
        )),
    },
    {
      key: 'cmdb',
      header: t('cmdb'),
      sortValue: cmdbText,
      cell: (s) =>
        s.cmdb ? (
          s.cmdb.url ? (
            <Anchor href={s.cmdb.url} target="_blank" rel="noopener noreferrer nofollow" size="sm" onClick={(e) => e.stopPropagation()}>
              {cmdbText(s) || t('openCmdb')} <IconExternalLink size={12} aria-hidden />
            </Anchor>
          ) : (
            cmdbText(s)
          )
        ) : (
          '–'
        ),
    },
    { key: 'links', header: t('links'), sortValue: (s) => s.linkCount, cell: (s) => s.linkCount },
    {
      key: 'updated',
      header: t('updated'),
      sortValue: (s) => s.updatedAt,
      nowrap: true,
      tdProps: (s) => ({ title: fmtDate(s.updatedAt) }),
      cell: (s) => fmtRelative(s.updatedAt),
    },
  ];
  return (
    <ListPage
      tabs={<ServiceTabs active="/services" />}
      view="services"
      search={{ value: q, onChange: (v) => set('q', v), placeholder: t('searchPlaceholder') }}
      activeFilters={[archived, tag, criticality.length, owner].filter(Boolean).length}
      title={t('title')}
      description={t('description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('new')}
          </Button>
        )
      }
      filters={
        <Group gap="md" mb="md" align="flex-end" wrap="wrap" data-testid="service-filters">
          <MultiSelect
            size="xs"
            label={t('criticality')}
            data={SERVICE_CRITICALITIES.map((c) => ({ value: c, label: t(`criticalities.${c}`) }))}
            value={criticality}
            onChange={(v) => set('criticality', v)}
            clearable
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('owners')}
            data={[...new Set([...all.flatMap((s) => s.owners), ...(owner ? [owner] : [])])]
              .sort((a, b) => subjectLabel(a).localeCompare(subjectLabel(b)))
              .map((o) => ({ value: o, label: subjectLabel(o) }))}
            value={owner}
            onChange={(v) => set('owner', v)}
            clearable
            searchable
            w={{ base: '100%', xs: 220 }}
          />
          <Switch size="sm" mb={4} label={t('showArchived')} checked={archived} onChange={(e) => set('archived', e.currentTarget.checked ? '1' : null)} />
          <TagFilterChip tag={tag} onChange={setTag} />
        </Group>
      }
    >
      <QueryState query={services} />
      {services.isSuccess && all.length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('noMatch')}
        </Text>
      )}
      {services.isSuccess && all.length === 0 && !archived && hidden && <RestrictedEmpty />}
      {services.isSuccess && all.length === 0 && !(hidden && !archived) && (
        <EmptyState
          icon={IconStack2}
          title={archived ? t('emptyState.titleArchived') : t('emptyState.title')}
          whoCanAct={t('common:whoCanAct.services')}
          action={
            canCreate &&
            !archived && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('emptyState.action')}
              </Button>
            )
          }
        >
          {archived ? undefined : canCreate ? t('emptyState.textCreate') : t('emptyState.text')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(s) => s.id}
          ariaLabel={t('title')}
          rowHref={(s) => `/services/${s.id}`}
          rowProps={(s) => ({ 'data-inactive': s.archived || undefined })}
          testId="service-list"
          rememberSort="services"
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={list.length} total={all.length} />}
          card={(s) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap">
                <Group gap={6} wrap="wrap">
                  <Anchor component={Link} to={`/services/${s.id}`} fw={600} size="sm">
                    {s.name}
                  </Anchor>
                  <VendorTicketsBadge count={vendorTickets.data?.[s.id]} serviceId={s.id} />
                  <OverdueReviewsBadge count={s.overdueDocuments} />
                </Group>
                <CriticalityBadge value={s.criticality} />
              </Group>
              <NeedBadges need={s.protectionNeed} />
              <Text size="xs" c="dimmed">
                {s.contacts.map((c) => c.email).join(', ') || t('noContacts')}
              </Text>
            </Paper>
          )}
        />
      )}
      {creating && <ServiceFormModal onClose={() => setCreating(false)} onSaved={(s) => navigate(`/services/${s.id}`)} />}
    </ListPage>
  );
}

/** Create or edit a service. */
export function ServiceFormModal({ service, onClose, onSaved }: { service?: ServiceDetail; onClose: () => void; onSaved: (s: ServiceDetail) => void }) {
  const { t } = useTranslation(['services', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(service?.name ?? '');
  const [description, setDescription] = useState(service?.description ?? '');
  const [criticality, setCriticality] = useState<string | null>(service?.criticality ?? null);
  const [contacts, setContacts] = useState<ServiceContact[]>(
    service?.contacts ?? [
      { role: 'business', email: '' },
      { role: 'it', email: '' },
    ],
  );
  const [owners, setOwners] = useState<string[]>(service?.owners ?? []);
  const [cmdbSystem, setCmdbSystem] = useState(service?.cmdb?.system ?? '');
  const [cmdbId, setCmdbId] = useState(service?.cmdb?.id ?? '');
  const [cmdbUrl, setCmdbUrl] = useState(service?.cmdb?.url ?? '');
  const [tags, setTags] = useState<string[]>(service?.tags ?? []);
  const known = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const [busy, setBusy] = useState(false);
  const setContact = (i: number, patch: Partial<ServiceContact>) => setContacts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        criticality,
        contacts: contacts
          .filter((c) => c.email.trim())
          .map((c) => ({ role: c.role, email: c.email.trim(), ...(c.name?.trim() ? { name: c.name.trim() } : {}) })),
        owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
        cmdb: cmdbSystem.trim() || cmdbId.trim() || cmdbUrl.trim() ? { system: cmdbSystem.trim(), id: cmdbId.trim(), url: cmdbUrl.trim() } : null,
        tags,
      };
      const s = service ? await put<ServiceDetail>(`/services/${service.id}`, body) : await post<ServiceDetail>('/services', body);
      void qc.invalidateQueries({ queryKey: ['services'] });
      qc.setQueryData(['service', s.id], s);
      onSaved(s);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={service ? t('editTitle', { name: service.name }) : t('newTitle')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
            maxLength={160}
            data-autofocus
            error={v.error('name')}
          />
          <Textarea
            label={t('descriptionLabel')}
            description={t('descriptionHelp')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={12}
          />
          <Select
            label={t('criticality')}
            placeholder={t('criticalities.none')}
            data={SERVICE_CRITICALITIES.map((c) => ({ value: c, label: t(`criticalities.${c}`) }))}
            value={criticality}
            onChange={setCriticality}
            clearable
          />
          <Text fw={600} size="sm">
            {t('contacts')}
          </Text>
          {contacts.map((c, i) => (
            <Group key={i} align="flex-end" gap="xs" wrap="wrap">
              <Select
                size="xs"
                label={t('contactRole')}
                data={SERVICE_CONTACT_ROLES.map((r) => ({ value: r, label: t(`contactRoles.${r}`) }))}
                value={c.role}
                onChange={(v) => v && setContact(i, { role: v as ServiceContact['role'] })}
                allowDeselect={false}
                style={{ flex: '1 1 140px' }}
              />
              <TextInput
                size="xs"
                type="email"
                label={t('email')}
                value={c.email}
                onChange={(e) => setContact(i, { email: e.currentTarget.value })}
                style={{ flex: '2 1 200px' }}
              />
              <TextInput
                size="xs"
                label={t('contactName')}
                value={c.name ?? ''}
                onChange={(e) => setContact(i, { name: e.currentTarget.value })}
                style={{ flex: '1 1 140px' }}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t('removeContact', { n: i + 1 })}
                onClick={() => setContacts((cs) => cs.filter((_, j) => j !== i))}
                mb={2}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            onClick={() => setContacts((cs) => [...cs, { role: 'it', email: '' }])}
            w="fit-content"
          >
            {t('addContact')}
          </Button>
          <SubjectsInput label={t('owners')} description={t('ownersHelp')} value={owners} onChange={setOwners} max={20} />
          <Text fw={600} size="sm">
            {t('cmdb')}
          </Text>
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              size="xs"
              label={t('cmdbSystem')}
              placeholder="ServiceNow"
              value={cmdbSystem}
              onChange={(e) => setCmdbSystem(e.currentTarget.value)}
              maxLength={80}
              miw={140}
            />
            <TextInput size="xs" label={t('cmdbId')} value={cmdbId} onChange={(e) => setCmdbId(e.currentTarget.value)} maxLength={120} miw={140} />
          </Group>
          <TextInput
            size="xs"
            label={t('cmdbUrl')}
            placeholder="https://"
            value={cmdbUrl}
            onChange={(e) => setCmdbUrl(e.currentTarget.value)}
            maxLength={2000}
          />
          <TagInput label={t('tags')} value={tags} onChange={setTags} max={30} lower suggestions={(known.data ?? []).flatMap((s) => s.tags)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
