import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Drawer,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Timeline,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  IconArchive,
  IconCheck,
  IconCopy,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconKey,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Backlink, Credential, CredentialBelongsTo, CredentialEvent, CredentialList, CredentialStatus, CredentialType } from '@sm/shared';
import { api, apiUrl, confirmedDownload, del, get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { EmptyState, FilterPanel, PageHeader, QueryState, TONE, useCreateParam } from '../components/common';
import { CredentialEditor } from '../components/credentials/CredentialEditor';
import { TagBadges, TagFilterChip, useTagFilter } from '../components/tags';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { fmtDate, fmtDay, fmtRelative } from '../format';
import { confirmDanger } from '../components/confirm';
import { OwningTeams } from '../components/OwningTeams';

export const CREDENTIAL_TYPE_IDS: CredentialType[] = ['apiClient', 'technicalUser', 'password', 'token', 'certificate', 'agentCertificate', 'sshKey', 'other'];
export const CREDENTIAL_STATUS_IDS: CredentialStatus[] = ['ok', 'dueSoon', 'overdue', 'expired'];
export const STATUS_COLOR: Record<CredentialStatus, string> = { ok: TONE.ok, dueSoon: TONE.soon, overdue: TONE.attention, expired: TONE.bad };

export function CredentialStatusBadge({ status, size = 'sm' }: { status: CredentialStatus; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('credentials');
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size={size}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Where the secret is kept: http(s) links open in a new tab; KeePass/file paths are shown as copyable text, never as links. */
export function LocationView({ c }: { c: Credential }) {
  const { t } = useTranslation('credentials');
  const url = c.location.url;
  const clickable = !!url && /^https?:\/\//i.test(url);
  return (
    <Stack gap={4}>
      {c.location.text && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {c.location.text}
        </Text>
      )}
      {url &&
        (clickable ? (
          <Anchor href={url} target="_blank" rel="noopener noreferrer" size="sm" style={{ overflowWrap: 'anywhere' }}>
            {url} <IconExternalLink size={12} />
          </Anchor>
        ) : (
          <Group gap={4} wrap="nowrap">
            <Code style={{ overflowWrap: 'anywhere' }}>{url}</Code>
            <CopyButton value={url}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t('detail.copied') : t('detail.copy')}>
                  <ActionIcon variant="subtle" size="sm" onClick={copy} aria-label={t('detail.copyLocation')}>
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        ))}
      {!c.location.text && !url && (
        <Text size="sm" c="dimmed">
          –
        </Text>
      )}
    </Stack>
  );
}

/** The register: sortable table on wide screens, cards on phones; a row opens the entry's drawer. */
function CredentialTable({ items, onOpen, onTag }: { items: Credential[]; onOpen: (id: string) => void; onTag: (tag: string) => void }) {
  const { t } = useTranslation(['credentials', 'common']);
  const nameButton = (c: Credential, fw = 500) => (
    <Anchor
      component="button"
      type="button"
      size="sm"
      fw={fw}
      ta="left"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onOpen(c.id);
      }}
      style={{ overflowWrap: 'anywhere' }}
    >
      {c.name}
    </Anchor>
  );
  const archivedBadge = (c: Credential) =>
    c.archived && (
      <Badge ml={6} size="xs" color="gray" variant="outline">
        {t('archived')}
      </Badge>
    );
  const nextDueKind = (c: Credential) => t(`dueKinds.${[...c.dues].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0]!.kind}`);
  const owners = (c: Credential) => [...c.owners.map((o) => o.email), ...c.ownerSubjects].join(', ');
  const platformOf = (c: Credential) => c.platformName ?? c.platformText;
  const columns: DataColumn<Credential>[] = [
    {
      key: 'name',
      header: t('table.name'),
      sortValue: (c) => c.name,
      cell: (c) => (
        <>
          {nameButton(c)}
          {archivedBadge(c)}
          <TagBadges tags={c.tags} onTag={onTag} />
        </>
      ),
    },
    { key: 'type', header: t('table.type'), sortValue: (c) => t(`types.${c.type}`), cell: (c) => t(`types.${c.type}`) },
    {
      key: 'roles',
      header: t('table.roles'),
      sortValue: (c) => c.roles.map((r) => r.role).join(', '),
      cell: (c) =>
        c.roles.length ? (
          <Group gap={4}>
            {c.roles.slice(0, 2).map((r) => (
              <Tooltip key={`${r.role} ${r.scope}`} label={r.scope || r.role} disabled={!r.scope}>
                <Badge size="xs" variant="light" color="gray" tt="none" maw={180}>
                  {r.role}
                </Badge>
              </Tooltip>
            ))}
            {c.roles.length > 2 && (
              <Tooltip
                label={c.roles
                  .slice(2)
                  .map((r) => r.role)
                  .join(', ')}
              >
                <Badge size="xs" variant="outline" color="gray">
                  +{c.roles.length - 2}
                </Badge>
              </Tooltip>
            )}
          </Group>
        ) : (
          '–'
        ),
    },
    {
      key: 'platform',
      header: t('table.platform'),
      sortValue: platformOf,
      cell: (c) => (
        <>
          {platformOf(c) || '–'}
          {c.environment && (
            <Text size="xs" c="dimmed">
              {c.environment}
            </Text>
          )}
        </>
      ),
    },
    {
      key: 'status',
      header: t('table.status'),
      // by urgency, not alphabetically
      sortValue: (c) => CREDENTIAL_STATUS_IDS.indexOf(c.status),
      cell: (c) => <CredentialStatusBadge status={c.status} />,
    },
    {
      key: 'nextDue',
      header: t('table.nextDue'),
      sortValue: (c) => c.nextDueAt,
      nowrap: true,
      cell: (c) =>
        c.nextDueAt ? (
          <>
            {fmtDay(c.nextDueAt)}
            <Text size="xs" c="dimmed">
              {nextDueKind(c)} · {fmtRelative(c.nextDueAt)}
            </Text>
          </>
        ) : (
          '–'
        ),
    },
    {
      key: 'owners',
      header: t('table.owners'),
      sortValue: owners,
      cell: (c) => (
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
          {owners(c) || '–'}
        </Text>
      ),
    },
  ];
  return (
    <DataTable
      rows={items}
      columns={columns}
      rowKey={(c) => c.id}
      ariaLabel={t('title')}
      onRowClick={(c) => onOpen(c.id)}
      footer={<ListFooter shown={items.length} />}
      testId="credential-list"
      card={(c) => (
        <Paper withBorder p="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
            <div style={{ minWidth: 0 }}>
              {nameButton(c, 600)}
              {archivedBadge(c)}
            </div>
            <CredentialStatusBadge status={c.status} size="xs" />
          </Group>
          <Text size="xs" c="dimmed">
            {[t(`types.${c.type}`), platformOf(c), c.environment].filter(Boolean).join(' · ')}
          </Text>
          {c.nextDueAt && (
            <Text size="xs">
              {t('table.nextDue')}: {fmtDay(c.nextDueAt)} ({nextDueKind(c)} · {fmtRelative(c.nextDueAt)})
            </Text>
          )}
        </Paper>
      )}
    />
  );
}

export function CredentialsPage() {
  const { t } = useTranslation(['credentials', 'common']);
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  // ?status=overdue,expired (the start page's "Credentials due" tile) presets the status filter
  const [statuses, setStatuses] = useState<string[]>(() =>
    (params.get('status') ?? '').split(',').filter((x): x is CredentialStatus => (CREDENTIAL_STATUS_IDS as string[]).includes(x)),
  );
  const [platform, setPlatform] = useState('');
  const [owner, setOwner] = useState('');
  const [role, setRole] = useState('');
  const [dueWithin, setDueWithin] = useState<number | ''>('');
  const [archived, setArchived] = useState<'exclude' | 'include' | 'only'>('exclude');
  const [tag, setTag] = useTagFilter();
  const [debounced] = useDebouncedValue({ q, platform, owner }, 300);
  const qs = useMemo(() => {
    const u = new URLSearchParams();
    if (debounced.q) u.set('q', debounced.q);
    if (types.length) u.set('type', types.join(','));
    if (statuses.length) u.set('status', statuses.join(','));
    if (debounced.platform) u.set('platform', debounced.platform);
    if (debounced.owner) u.set('owner', debounced.owner);
    if (role) u.set('role', role);
    if (dueWithin !== '') u.set('dueWithinDays', String(dueWithin));
    if (archived !== 'exclude') u.set('archived', archived);
    if (tag) u.set('tag', tag);
    return u.toString();
  }, [debounced, types, statuses, role, dueWithin, archived, tag]);
  const list = useQuery({ queryKey: ['credentials', qs], queryFn: () => get<CredentialList>(`/credentials${qs ? `?${qs}` : ''}`) });
  const openId = params.get('open');
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);
  useCreateParam(list.data?.canCreate, () => setEditing('new'));
  const refresh = () => qc.invalidateQueries({ queryKey: ['credentials'] });
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('open', id);
    else next.delete('open');
    setParams(next, { replace: true });
  };
  const platforms = useMemo(() => [...new Set((list.data?.items ?? []).map((c) => c.platformName ?? c.platformText).filter(Boolean))].sort(), [list.data]);
  const roles = useMemo(
    () => [...new Set([...(list.data?.items ?? []).flatMap((c) => c.roles.map((r) => r.role)), ...(role ? [role] : [])])].sort(),
    [list.data, role],
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/credentials/export.csv${qs ? `?${qs}` : ''}`)}
              onClick={confirmedDownload('exportCredentials')}
              leftSection={<IconDownload size={14} />}
            >
              {t('exportCsv')}
            </Button>
            {list.data?.canCreate && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
                {t('new')}
              </Button>
            )}
          </Group>
        }
      />
      <Alert icon={<IconShieldLock size={18} />} color="blue" variant="light" mb="md">
        {t('noSecretsHint')}
      </Alert>
      <FilterPanel active={[q, types.length, statuses.length, platform, owner, role, dueWithin !== '', archived !== 'exclude'].filter(Boolean).length}>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs" mb="md">
          <TextInput size="xs" label={t('filters.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <MultiSelect
            size="xs"
            label={t('filters.type')}
            data={CREDENTIAL_TYPE_IDS.map((x) => ({ value: x, label: t(`types.${x}`) }))}
            value={types}
            onChange={setTypes}
            placeholder={types.length ? undefined : t('filters.allTypes')}
            clearable
          />
          <MultiSelect
            size="xs"
            label={t('filters.status')}
            data={CREDENTIAL_STATUS_IDS.map((x) => ({ value: x, label: t(`status.${x}`) }))}
            value={statuses}
            onChange={setStatuses}
            placeholder={statuses.length ? undefined : t('filters.allStatuses')}
            clearable
          />
          <Select
            size="xs"
            label={t('filters.platform')}
            placeholder={t('filters.allPlatforms')}
            data={platforms}
            value={platform || null}
            onChange={(v) => setPlatform(v ?? '')}
            clearable
            searchable
          />
          <TextInput
            size="xs"
            label={t('filters.owner')}
            placeholder={t('filters.ownerPlaceholder')}
            value={owner}
            onChange={(e) => setOwner(e.currentTarget.value)}
          />
          <Select
            size="xs"
            label={t('filters.role')}
            placeholder={t('filters.allRoles')}
            data={roles}
            value={role || null}
            onChange={(v) => setRole(v ?? '')}
            clearable
            searchable
          />
          <NumberInput
            size="xs"
            label={t('filters.dueWithin')}
            min={0}
            max={3650}
            value={dueWithin}
            onChange={(v) => setDueWithin(typeof v === 'number' ? v : '')}
          />
          <Select
            size="xs"
            label={t('filters.archived')}
            data={(['exclude', 'include', 'only'] as const).map((x) => ({ value: x, label: t(`filters.archivedOptions.${x}`) }))}
            value={archived}
            onChange={(v) => setArchived((v as typeof archived) ?? 'exclude')}
            allowDeselect={false}
          />
        </SimpleGrid>
      </FilterPanel>
      <QueryState query={list} />
      {list.data &&
        list.data.items.length === 0 &&
        (qs ? (
          <Text c="dimmed" size="sm">
            {t('emptyFiltered')}
          </Text>
        ) : (
          <EmptyState
            icon={IconKey}
            title={t('emptyState.title')}
            action={
              list.data.canCreate && (
                <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
                  {t('emptyState.action')}
                </Button>
              )
            }
          >
            {t('emptyState.text')}
          </EmptyState>
        ))}
      <TagFilterChip tag={tag} onChange={setTag} />
      {!!list.data?.items.length && <CredentialTable items={list.data.items} onOpen={open} onTag={setTag} />}
      {openId && <CredentialDrawer id={openId} onClose={() => open(null)} onEdit={(c) => setEditing(c)} isAdmin={isAdmin} onChanged={refresh} />}
      {editing && (
        <CredentialEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            refresh();
            qc.setQueryData(['credential', c.id], c);
            open(c.id);
          }}
        />
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <div>{children}</div>
    </div>
  );
}

function CredentialDrawer({
  id,
  onClose,
  onEdit,
  onChanged,
  isAdmin,
}: {
  id: string;
  onClose: () => void;
  onEdit: (c: Credential) => void;
  onChanged: () => void;
  isAdmin: boolean;
}) {
  const { t } = useTranslation(['credentials', 'common']);
  const qc = useQueryClient();
  const entry = useQuery({ queryKey: ['credential', id], queryFn: () => get<Credential>(`/credentials/${id}`), retry: false });
  const history = useQuery({
    queryKey: ['credential', id, 'history'],
    queryFn: () => get<CredentialEvent[]>(`/credentials/${id}/history`),
    enabled: !!entry.data,
  });
  const backlinks = useQuery({
    queryKey: ['credential', id, 'backlinks'],
    queryFn: () => get<Backlink[]>(`/backlinks?kind=credential&id=${encodeURIComponent(id)}`),
    enabled: !!entry.data,
  });
  const [action, setAction] = useState<'rotated' | 'reviewed' | null>(null);
  const c = entry.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ['credential', id] });
    onChanged();
  };
  const simple = async (path: string, ok: string) => {
    try {
      await post(`/credentials/${id}/${path}`);
      notifyOk(ok);
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={c?.name ?? t('detail.title')}>
      {entry.isLoading && <Loader size="sm" />}
      {entry.error && <Alert color="red">{t('detail.notFound')}</Alert>}
      {c && (
        <Stack>
          <Group gap="xs">
            <CredentialStatusBadge status={c.status} />
            <Badge variant="outline" color="gray">
              {t(`types.${c.type}`)}
            </Badge>
            {c.archived && <Badge color="gray">{t('archived')}</Badge>}
          </Group>
          {c.permissions.includes('edit') && (
            <Group gap="xs">
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => onEdit(c)}>
                {t('common:edit')}
              </Button>
              <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => setAction('rotated')}>
                {t('detail.markRotated')}
              </Button>
              <Button size="xs" variant="light" leftSection={<IconCheck size={14} />} onClick={() => setAction('reviewed')}>
                {t('detail.markReviewed')}
              </Button>
            </Group>
          )}
          {isAdmin && (
            <Group gap="xs">
              {c.archived ? (
                <Button size="xs" variant="default" leftSection={<IconRestore size={14} />} onClick={() => simple('restore', t('detail.restored'))}>
                  {t('detail.restore')}
                </Button>
              ) : (
                <Button size="xs" variant="default" leftSection={<IconArchive size={14} />} onClick={() => simple('archive', t('detail.archivedOk'))}>
                  {t('detail.archive')}
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={async () => {
                  if (!(await confirmDanger({ action: 'delete', message: t('detail.deleteConfirm', { name: c.name }) }))) return;
                  try {
                    await del(`/credentials/${id}`);
                    notifyOk(t('detail.deleted'));
                    onChanged();
                    onClose();
                  } catch (e) {
                    notifyError(e);
                  }
                }}
              >
                {t('common:delete')}
              </Button>
            </Group>
          )}
          {action && (
            <ActionForm
              id={id}
              kind={action}
              cert={c.type === 'certificate' || c.type === 'agentCertificate'}
              onDone={async () => (setAction(null), await reload())}
              onCancel={() => setAction(null)}
            />
          )}

          <Paper withBorder p="sm">
            <Title order={6} mb="xs">
              {t('detail.dates')}
            </Title>
            <Stack gap={6}>
              {c.dues.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('detail.noDates')}
                </Text>
              )}
              {c.dues.map((d) => (
                <Group key={d.kind} justify="space-between" wrap="nowrap">
                  <Text size="sm">{t(`dueKinds.${d.kind}`)}</Text>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm">{fmtDay(d.dueAt)}</Text>
                    <Text size="xs" c="dimmed">
                      {d.daysLeft >= 0 ? t('detail.inDays', { count: d.daysLeft }) : t('detail.daysAgo', { count: -d.daysLeft })}
                    </Text>
                    <CredentialStatusBadge status={d.status} size="xs" />
                  </Group>
                </Group>
              ))}
            </Stack>
            <SimpleGrid cols={{ base: 1, xs: 2 }} mt="sm" spacing="xs">
              <Field label={t('fields.rotationInterval')}>{c.rotationIntervalDays ? t('detail.everyDays', { count: c.rotationIntervalDays }) : '–'}</Field>
              <Field label={t('fields.lastRotated')}>{c.lastRotatedAt ? fmtDay(c.lastRotatedAt) : '–'}</Field>
              <Field label={t('fields.reviewInterval')}>{c.reviewIntervalDays ? t('detail.everyDays', { count: c.reviewIntervalDays }) : '–'}</Field>
              <Field label={t('fields.lastReviewed')}>{c.lastReviewedAt ? fmtDay(c.lastReviewedAt) : '–'}</Field>
              <Field label={t('fields.issuedAt')}>{c.issuedAt ? fmtDay(c.issuedAt) : '–'}</Field>
              {c.gatus && <Field label={t('fields.gatusSync')}>{c.gatus.endpointKey}</Field>}
            </SimpleGrid>
          </Paper>

          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            {c.belongsTo && (
              <Field label={t('fields.belongsTo')}>
                <BelongsToLink b={c.belongsTo} />
              </Field>
            )}
            <Field label={t('fields.platform')}>{c.platformName ?? (c.platformText || '–')}</Field>
            <Field label={t('fields.environment')}>{c.environment || '–'}</Field>
          </SimpleGrid>
          {c.description && (
            <Field label={t('fields.description')}>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {c.description}
              </Text>
            </Field>
          )}
          <Field label={t('fields.location')}>
            <LocationView c={c} />
          </Field>
          <Field label={t('fields.owners')}>
            <Stack gap={2}>
              {c.owners.map((o) => (
                <Text size="sm" key={o.email}>
                  <Anchor href={`mailto:${o.email}`} size="sm">
                    {o.email}
                  </Anchor>
                  {o.role && ` – ${o.role}`}
                </Text>
              ))}
              {c.ownerSubjects.map((s) => (
                <Text size="sm" key={s}>
                  {s}
                </Text>
              ))}
              {!c.owners.length && !c.ownerSubjects.length && (
                <Text size="sm" c="dimmed">
                  –
                </Text>
              )}
            </Stack>
          </Field>
          <Field label={t('fields.usedBy')}>
            <Stack gap={2}>
              {c.usedBy.text && <Text size="sm">{c.usedBy.text}</Text>}
              {c.usedBy.links.map((l) => (
                <Text size="sm" key={`${l.kind}:${l.id}`}>
                  {t(`linkKinds.${l.kind}`, { defaultValue: l.kind })}:{' '}
                  {l.label ? (
                    <LinkTo kind={l.kind} id={l.id} label={l.label} />
                  ) : (
                    <Text span c="dimmed">
                      {t('detail.notVisible')}
                    </Text>
                  )}
                </Text>
              ))}
              {c.usedBy.urls.map((x) => (
                <Text size="sm" key={x.url}>
                  <Anchor href={x.url} target="_blank" rel="noopener noreferrer nofollow" size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {x.label || x.url}
                  </Anchor>
                </Text>
              ))}
              {!c.usedBy.text && !c.usedBy.links.length && !c.usedBy.urls.length && (
                <Text size="sm" c="dimmed">
                  –
                </Text>
              )}
            </Stack>
          </Field>
          <Field label={t('fields.roles')}>
            {c.roles.length ? (
              <div className="table-scroll">
                <Table fz="sm" data-testid="credential-roles">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('roles.role')}</Table.Th>
                      <Table.Th>{t('roles.scope')}</Table.Th>
                      <Table.Th>{t('roles.grantedAt')}</Table.Th>
                      <Table.Th>{t('roles.note')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {c.roles.map((r) => (
                      <Table.Tr key={`${r.role} ${r.scope}`}>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>
                          <Code>{r.role}</Code>
                        </Table.Td>
                        <Table.Td>{r.scope || '–'}</Table.Td>
                        <Table.Td className="nowrap">{r.grantedAt ? fmtDay(r.grantedAt) : '–'}</Table.Td>
                        <Table.Td>{r.note || '–'}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            ) : (
              <Text size="sm" c="dimmed">
                {t('roles.none')}
              </Text>
            )}
          </Field>
          <Field label={t('detail.linkedFrom')}>
            <Stack gap={2}>
              {(backlinks.data ?? []).map((b) => (
                <Text size="sm" key={b.linkId}>
                  {t(`linkKinds.${b.kind}`, { defaultValue: b.kind })}:{' '}
                  <Anchor component={Link} to={b.path} size="sm">
                    {b.label}
                  </Anchor>
                  {b.note && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      · {b.note}
                    </Text>
                  )}
                </Text>
              ))}
              {backlinks.data && !backlinks.data.length && (
                <Text size="sm" c="dimmed">
                  {t('detail.noLinkedFrom')}
                </Text>
              )}
            </Stack>
          </Field>
          {c.certificate && (
            <Paper withBorder p="sm">
              <Title order={6} mb="xs">
                {t('detail.certificate')}
              </Title>
              <Stack gap={4}>
                <Field label={t('cert.subject')}>{c.certificate.subject}</Field>
                <Field label={t('cert.issuer')}>{c.certificate.issuer}</Field>
                <Field label={t('cert.validity')}>
                  {fmtDay(c.certificate.notBefore)} – {fmtDay(c.certificate.notAfter)}
                </Field>
                {c.certificate.subjectAltNames.length > 0 && <Field label={t('cert.sans')}>{c.certificate.subjectAltNames.join(', ')}</Field>}
                <Field label={t('cert.fingerprint')}>
                  <Code style={{ overflowWrap: 'anywhere' }}>{c.certificate.fingerprint256}</Code>
                </Field>
                {c.certificate.chain.length > 0 && (
                  <Field label={t('cert.chain')}>{c.certificate.chain.map((x) => `${x.subject} (${fmtDay(x.notAfter)})`).join('; ')}</Field>
                )}
              </Stack>
            </Paper>
          )}
          {c.notes && (
            <Field label={t('fields.notes')}>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {c.notes}
              </Text>
            </Field>
          )}
          <Title order={6}>{t('detail.history')}</Title>
          <Timeline bulletSize={14} lineWidth={2}>
            {(history.data ?? []).map((e) => (
              <Timeline.Item key={e.id} title={t(`events.${e.kind}`, { defaultValue: e.kind })}>
                <Text size="xs" c="dimmed">
                  {fmtDate(e.ts)} · {e.actor}
                </Text>
                {e.kind === 'rolesChanged' && <RolesChange details={e.details} />}
                {e.comment && <Text size="sm">{e.comment}</Text>}
              </Timeline.Item>
            ))}
          </Timeline>
          <OwningTeams kind="credential" id={c.id} />
          <Text size="xs" c="dimmed">
            {t('detail.updated', { user: c.updatedBy, date: fmtDate(c.updatedAt) })}
          </Text>
        </Stack>
      )}
    </Drawer>
  );
}

function LinkTo({ kind, id, label }: { kind: string; id: string; label: string }) {
  const href =
    kind === 'process'
      ? `/processes/${id}`
      : kind === 'monitor'
        ? `/monitors/${id}`
        : kind === 'platform'
          ? `/platforms/${id}`
          : kind === 'service'
            ? `/services/${id}`
            : kind === 'application'
              ? `/applications/${id}`
              : null;
  return href ? (
    <Anchor component={Link} to={href} size="sm">
      {label}
    </Anchor>
  ) : (
    <>{label}</>
  );
}

function ActionForm({
  id,
  kind,
  cert,
  onDone,
  onCancel,
}: {
  id: string;
  kind: 'rotated' | 'reviewed';
  cert: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['credentials', 'common']);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [comment, setComment] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setComment(''), [kind]);
  const submit = async () => {
    setBusy(true);
    try {
      const body = kind === 'rotated' ? { rotatedAt: date, comment, ...(expires ? { expiresAt: expires } : {}) } : { reviewedAt: date, comment };
      await api('POST', `/credentials/${id}/${kind}`, body);
      notifyOk(kind === 'rotated' ? t('detail.rotatedOk') : t('detail.reviewedOk'));
      onDone();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Title order={6}>{kind === 'rotated' ? t('detail.markRotated') : t('detail.markReviewed')}</Title>
        <TextInput
          type="date"
          label={kind === 'rotated' ? t('detail.rotatedOn') : t('detail.reviewedOn')}
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          max={new Date().toISOString().slice(0, 10)}
        />
        {kind === 'rotated' && (
          <TextInput
            type="date"
            label={t('detail.newExpiry')}
            description={cert ? t('detail.newExpiryCertHint') : undefined}
            value={expires}
            onChange={(e) => setExpires(e.currentTarget.value)}
          />
        )}
        <Textarea
          label={t('detail.comment')}
          description={t('noSecretsShort')}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" size="xs" onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button size="xs" loading={busy} onClick={submit} disabled={!date}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/** What a "roles changed" history event added, removed and changed. */
function RolesChange({ details }: { details: Record<string, unknown> }) {
  const { t } = useTranslation('credentials');
  type R = { role: string; scope: string };
  const label = (r: R) => (r.scope ? `${r.role} (${r.scope})` : r.role);
  const list = (k: string) => (Array.isArray(details[k]) ? (details[k] as R[]) : []);
  const changed = (Array.isArray(details.changed) ? details.changed : []) as { to: R }[];
  return (
    <Stack gap={0}>
      {list('added').map((r) => (
        <Text size="xs" key={`+${label(r)}`}>
          {t('roles.added', { role: label(r) })}
        </Text>
      ))}
      {list('removed').map((r) => (
        <Text size="xs" key={`-${label(r)}`}>
          {t('roles.removed', { role: label(r) })}
        </Text>
      ))}
      {changed.map((c) => (
        <Text size="xs" key={`~${label(c.to)}`}>
          {t('roles.changed', { role: label(c.to) })}
        </Text>
      ))}
    </Stack>
  );
}

/** What an entry belongs to (#143), linked: the application (also for a component) or the system. */
function BelongsToLink({ b }: { b: CredentialBelongsTo }) {
  const { t } = useTranslation('credentials');
  if (!b.name) return <Text size="sm">{t('belongsGone')}</Text>;
  const to = b.kind === 'system' ? `/systems/${b.id}` : `/applications/${b.kind === 'component' ? b.applicationId : b.id}`;
  return (
    <Text size="sm">
      {t(`belongsKinds.${b.kind}`)}:{' '}
      <Anchor component={Link} to={to} size="sm">
        {b.kind === 'component' ? `${b.applicationName} / ${b.name}` : b.name}
      </Anchor>
    </Text>
  );
}
