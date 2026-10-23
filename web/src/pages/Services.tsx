import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconExternalLink, IconPlus, IconStack2, IconTicket, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SERVICE_CONTACT_ROLES, SERVICE_CRITICALITIES, type ServiceContact, type ServiceDetail, type ServiceSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { EmptyState, PageHeader, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';

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

export function ServicesPage() {
  const { t } = useTranslation(['services', 'common']);
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const services = useQuery({ queryKey: ['services', archived], queryFn: () => get<ServiceSummary[]>(`/services${archived ? '?archived=1' : ''}`) });
  const vendorTickets = useQuery({
    queryKey: ['ticket-references', 'open-counts', 'service'],
    queryFn: () => get<Record<string, number>>('/ticket-references/open-counts?kind=service&vendorOnly=1'),
  });
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const list = services.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('new')}
            </Button>
          )
        }
      />
      <Switch size="sm" mb="md" label={t('showArchived')} checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} />
      <QueryState query={services} />
      {services.isSuccess && list.length === 0 && (
        <EmptyState
          icon={IconStack2}
          title={archived ? t('emptyState.titleArchived') : t('emptyState.title')}
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
      {list.length > 0 &&
        (narrow ? (
          <Stack gap="xs" role="list" aria-label={t('title')}>
            {list.map((s) => (
              <Paper key={s.id} withBorder p="sm" role="listitem">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="wrap">
                    <Anchor component={Link} to={`/services/${s.id}`} fw={600} size="sm">
                      {s.name}
                    </Anchor>
                    <VendorTicketsBadge count={vendorTickets.data?.[s.id]} serviceId={s.id} />
                  </Group>
                  <CriticalityBadge value={s.criticality} />
                </Group>
                <Text size="xs" c="dimmed">
                  {s.contacts.map((c) => c.email).join(', ') || t('noContacts')}
                </Text>
              </Paper>
            ))}
          </Stack>
        ) : (
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" aria-label={t('title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('name')}</Table.Th>
                  <Table.Th>{t('criticality')}</Table.Th>
                  <Table.Th>{t('contacts')}</Table.Th>
                  <Table.Th>{t('cmdb')}</Table.Th>
                  <Table.Th>{t('links')}</Table.Th>
                  <Table.Th>{t('updated')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((s) => (
                  <Table.Tr key={s.id} className="clickable" onClick={() => navigate(`/services/${s.id}`)} data-inactive={s.archived || undefined}>
                    <Table.Td>
                      <Anchor component={Link} to={`/services/${s.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                        {s.name}
                      </Anchor>
                      {s.archived && (
                        <Badge ml={6} size="xs" variant="outline" color="gray">
                          {t('archived')}
                        </Badge>
                      )}
                      <VendorTicketsBadge count={vendorTickets.data?.[s.id]} serviceId={s.id} ml={6} />
                      {s.tags.length > 0 && (
                        <Group gap={4} mt={2}>
                          {s.tags.map((tag) => (
                            <Badge key={tag} size="xs" variant="default">
                              {tag}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>{s.criticality ? <CriticalityBadge value={s.criticality} /> : '–'}</Table.Td>
                    <Table.Td>
                      {s.contacts.map((c) => (
                        <Text key={`${c.role}${c.email}`} size="xs">
                          {t(`contactRoles.${c.role}`)}: {c.email}
                        </Text>
                      ))}
                    </Table.Td>
                    <Table.Td>
                      {s.cmdb ? (
                        s.cmdb.url ? (
                          <Anchor href={s.cmdb.url} target="_blank" rel="noopener noreferrer nofollow" size="sm" onClick={(e) => e.stopPropagation()}>
                            {[s.cmdb.system, s.cmdb.id].filter(Boolean).join(' ') || t('openCmdb')} <IconExternalLink size={12} aria-hidden />
                          </Anchor>
                        ) : (
                          [s.cmdb.system, s.cmdb.id].filter(Boolean).join(' ')
                        )
                      ) : (
                        '–'
                      )}
                    </Table.Td>
                    <Table.Td>{s.linkCount}</Table.Td>
                    <Table.Td className="nowrap" title={fmtDate(s.updatedAt)}>
                      {fmtRelative(s.updatedAt)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
      {creating && <ServiceFormModal onClose={() => setCreating(false)} onSaved={(s) => navigate(`/services/${s.id}`)} />}
    </>
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
          <TagsInput label={t('owners')} description={t('ownersHelp')} value={owners} onChange={setOwners} maxTags={20} />
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
          <TagsInput label={t('tags')} value={tags} onChange={setTags} maxTags={30} />
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
