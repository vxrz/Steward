import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, Select, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconAddressBook, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ContactDetail, ContactDuplicateGroup, ContactInput, ContactList, ContactListItem } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { QueryState, useCreateParam } from '../components/common';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { ListPage } from '../components/page/ListPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { ContactForm } from '../components/contacts/ContactForm';

type Status = 'active' | 'left' | 'all';

function StatusBadge({ status }: { status: ContactListItem['status'] }) {
  const { t } = useTranslation('contacts');
  return (
    // never squeezed by a long name beside it on a phone's card
    <Badge size="sm" variant="light" color={status === 'left' ? 'gray' : 'teal'} style={{ flexShrink: 0 }}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Administrators: contacts that share an e-mail address (made apart because their authors could not see each other). */
function Duplicates() {
  const { t } = useTranslation('contacts');
  const dup = useQuery({ queryKey: ['contacts', 'duplicates'], queryFn: () => get<ContactDuplicateGroup[]>('/contacts/duplicates') });
  return (
    <Stack gap="sm" data-testid="contact-duplicates">
      <Text size="sm" c="dimmed">
        {t('duplicates.intro')}
      </Text>
      <QueryState query={dup} />
      {dup.isSuccess && dup.data.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('duplicates.empty')}
        </Text>
      )}
      {(dup.data ?? []).map((g) => (
        <Paper key={g.email} withBorder p="sm">
          <Text size="sm" fw={600} mb={4} style={{ overflowWrap: 'anywhere' }}>
            {g.email}
          </Text>
          <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {g.contacts.map((c) => (
              <Group key={c.id} gap="xs" wrap="wrap" component="li">
                <Anchor component={Link} to={`/contacts/${c.id}`} size="sm">
                  {c.name}
                </Anchor>
                <StatusBadge status={c.status} />
                <Text size="xs" c="dimmed">
                  {[c.orgUnit, t('duplicates.links', { count: c.links })].filter(Boolean).join(' · ')}
                </Text>
              </Group>
            ))}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

/** The contacts directory (ADR 0038): the contacts the person may see, by name; Possible duplicates for administrators. */
export function ContactsPage() {
  const { t } = useTranslation(['contacts', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'duplicates' && isAdmin ? 'duplicates' : 'all';
  const q = params.get('q') ?? '';
  const status = (['active', 'left', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'active') as Status;
  const [limit, setLimit] = useState(100);
  const [debounced] = useDebouncedValue(q.trim(), 250);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams({ q: debounced, status, limit: String(limit) }).toString();
  const list = useQuery({ queryKey: ['contacts', 'list', qs], queryFn: () => get<ContactList>(`/contacts?${qs}`), enabled: tab === 'all' });
  const [creating, setCreating] = useState(false);
  useCreateParam(list.data?.canCreate, () => setCreating(true));
  const create = useMutation({
    mutationFn: (c: ContactInput) => post<ContactDetail>('/contacts', c),
    onSuccess: (c) => {
      setCreating(false);
      notifyOk(t('edit.created'));
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      navigate(`/contacts/${c.id}`);
    },
    onError: (e) => notifyError(e),
  });
  const items = list.data?.items ?? [];
  const columns: DataColumn<ContactListItem>[] = [
    {
      key: 'name',
      header: t('table.name'),
      sortValue: (c) => c.name.toLowerCase(),
      cell: (c) => (
        <Anchor component={Link} to={`/contacts/${c.id}`} size="sm" fw={600} onClick={(e) => e.stopPropagation()}>
          {c.name}
        </Anchor>
      ),
    },
    {
      key: 'email',
      header: t('table.email'),
      sortValue: (c) => c.email,
      cell: (c) => (
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {c.email || '–'}
        </Text>
      ),
    },
    { key: 'orgUnit', header: t('table.orgUnit'), sortValue: (c) => c.orgUnit, cell: (c) => c.orgUnit || '–' },
    { key: 'usedBy', header: t('table.usedBy'), sortValue: (c) => c.usedBy, nowrap: true, cell: (c) => t('usedBy', { count: c.usedBy }) },
    { key: 'status', header: t('table.status'), sortValue: (c) => c.status, cell: (c) => <StatusBadge status={c.status} /> },
  ];
  return (
    <ListPage
      view="contacts"
      title={t('title')}
      description={t('description')}
      tabs={
        isAdmin ? (
          <LinkTabs
            label={t('tabs.label')}
            active={tab === 'all' ? '/contacts' : '/contacts?tab=duplicates'}
            tabs={[
              { to: '/contacts', label: t('tabs.all') },
              { to: '/contacts?tab=duplicates', label: t('tabs.duplicates'), testId: 'tab-duplicates' },
            ]}
          />
        ) : undefined
      }
      search={tab === 'all' ? { value: q, onChange: (v) => set('q', v), placeholder: t('searchPlaceholder'), label: t('searchLabel') } : undefined}
      activeFilters={status !== 'active' ? 1 : 0}
      filters={
        tab === 'all' ? (
          <Select
            size="xs"
            label={t('statusFilter.label')}
            data={(['active', 'left', 'all'] as const).map((s) => ({ value: s, label: t(`statusFilter.${s}`) }))}
            value={status}
            onChange={(v) => set('status', v && v !== 'active' ? v : '')}
            allowDeselect={false}
            w={180}
          />
        ) : undefined
      }
      primaryAction={
        list.data?.canCreate && tab === 'all' ? (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="contact-new">
            {t('new')}
          </Button>
        ) : undefined
      }
      empty={{
        show: tab === 'all' && list.isSuccess && items.length === 0 && !debounced && status === 'active',
        icon: IconAddressBook,
        title: t('empty.title'),
        text: t('empty.text'),
      }}
      testId="contacts-page"
    >
      <Alert variant="light" color="gray" mb="sm" p="xs">
        <Text size="xs">{t('noRight')}</Text>
      </Alert>
      {tab === 'duplicates' ? (
        <Duplicates />
      ) : (
        <>
          <QueryState query={list} />
          {list.isSuccess && items.length === 0 && (debounced || status !== 'active') && (
            <Text c="dimmed" size="sm">
              {t('empty.filtered')}
            </Text>
          )}
          {items.length > 0 && (
            <DataTable
              rows={items}
              columns={columns}
              rowKey={(c) => c.id}
              ariaLabel={t('title')}
              rowHref={(c) => `/contacts/${c.id}`}
              testId="contact-list"
              footer={
                <ListFooter
                  shown={items.length}
                  hasMore={list.data?.more}
                  onLoadMore={limit < 200 ? () => setLimit((l) => Math.min(200, l + 100)) : undefined}
                  loading={list.isFetching}
                />
              }
              card={(c) => (
                <Paper withBorder p="sm">
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                      <Anchor component={Link} to={`/contacts/${c.id}`} fw={600} size="sm">
                        {c.name}
                      </Anchor>
                      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                        {[c.email, c.orgUnit, t('usedBy', { count: c.usedBy })].filter(Boolean).join(' · ')}
                      </Text>
                    </div>
                    <StatusBadge status={c.status} />
                  </Group>
                </Paper>
              )}
            />
          )}
          {list.data?.more && limit >= 200 && (
            <Text size="xs" c="dimmed" mt="xs">
              {t('more')}
            </Text>
          )}
        </>
      )}
      {creating && (
        <ContactForm
          title={t('edit.createTitle')}
          submitLabel={t('edit.create')}
          offerMatches
          busy={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(c) => create.mutate(c)}
          onUseExisting={(c) => {
            setCreating(false);
            navigate(`/contacts/${c.id}`);
          }}
        />
      )}
    </ListPage>
  );
}
