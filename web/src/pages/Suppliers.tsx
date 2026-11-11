import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconCheck, IconGitMerge, IconPlus, IconTruckDelivery, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  SUPPLIER_DPA_STATUSES,
  SUPPLIER_LIMITS,
  SUPPLIER_TYPES,
  type SupplierDateState,
  type SupplierDetail,
  type SupplierDpaStatus,
  type SupplierStatus,
  type SupplierSummary,
  type SupplierType,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../api';
import { EmptyState, QueryState, subjectLabel, useCreateParam, useFieldErrors } from '../components/common';
import { SubjectsInput } from '../components/SubjectsInput';
import { useMe } from '../auth';
import { fmtDate, fmtDay, fmtRelative } from '../format';
import { ListPage } from '../components/page/ListPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { confirmDanger } from '../components/confirm';
import { supplierKeys } from '../queryKeys';
import { ContractScopeNotice, ProposedServices, SharedSuppliers } from '../components/suppliers/SharedSuppliers';

const usageTotal = (s: SupplierSummary) => Object.values(s.usage).reduce((a, b) => a + b, 0);
const DOC_LINK = /^(https?:\/\/\S+|rec_[A-Za-z0-9_-]{4,40}|[A-Z][A-Z0-9]{0,9}-\d{4}-\d{4,6})$/i;

/** A date with its state: due soon in orange, passed in red. */
export function DueDate({ date, state }: { date: string | null; state: SupplierDateState }) {
  const { t } = useTranslation('suppliers');
  if (!date) return <>–</>;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  const text = t(`dateState.${state}`, { date: fmtDay(date), days });
  return state === 'ok' || state === 'none' ? (
    <>{text}</>
  ) : (
    <Badge size="sm" variant="light" color={state === 'past' ? 'red' : 'orange'}>
      {text}
    </Badge>
  );
}

export function SupplierStatusBadge({ status }: { status: SupplierStatus }) {
  const { t } = useTranslation('suppliers');
  if (status === 'active') return null;
  return (
    <Badge size="sm" variant="light" color={status === 'unconfirmed' ? 'yellow' : 'gray'}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Suppliers (0.17.0, ADR 0029): the active ones, those to confirm after the update, and the archived ones. */
export function SuppliersPage() {
  const { t } = useTranslation(['suppliers', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState<SupplierSummary | null>(null);
  const { params, set } = useListParams();
  const q = params.get('q') ?? '';
  const type = params.get('type');
  const status = (params.get('status') as SupplierStatus | null) ?? 'active';
  const tab = status === 'unconfirmed' || status === 'archived' ? status : 'active';
  const list = useQuery({ queryKey: supplierKeys.list(tab), queryFn: () => get<SupplierSummary[]>(`/suppliers?status=${tab}`) });
  const toConfirm = useQuery({ queryKey: supplierKeys.list('unconfirmed'), queryFn: () => get<SupplierSummary[]>('/suppliers?status=unconfirmed') });
  const { hasRole } = useMe();
  const canManage = hasRole('admin') || hasRole('designer');
  useCreateParam(canManage, () => setCreating(true));
  const needle = q.trim().toLowerCase();
  const all = list.data ?? [];
  const rows = all.filter(
    (s) => (!needle || [s.name, s.description, ...s.aliases].some((x) => x.toLowerCase().includes(needle))) && (!type || s.type === type),
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: supplierKeys.all });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const confirmOne = (s: SupplierSummary) => act(() => post(`/suppliers/${s.id}/confirm`), t('actions.confirmed'));
  const dismissOne = async (s: SupplierSummary) => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('actions.notSupplier'),
        confirmLabel: t('actions.notSupplier'),
        message: t('confirmNotSupplier', { name: s.name }),
      }))
    )
      return;
    await act(() => post(`/suppliers/${s.id}/not-a-supplier`), t('actions.dismissed'));
  };
  const typeLabel = (s: SupplierSummary) => t(`types.${s.type}`);
  const name: DataColumn<SupplierSummary> = {
    key: 'name',
    header: t('columns.name'),
    sortValue: (s) => s.name,
    cell: (s) => (
      <>
        <Anchor component={Link} to={`/suppliers/${s.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
          {s.name}
        </Anchor>
        {s.website && (
          <Text size="xs" c="dimmed">
            {s.website.replace(/^https?:\/\//, '')}
          </Text>
        )}
      </>
    ),
  };
  const usage: DataColumn<SupplierSummary> = { key: 'usage', header: t('columns.usage'), sortValue: usageTotal, cell: (s) => usageTotal(s) };
  const columns: DataColumn<SupplierSummary>[] =
    tab === 'unconfirmed'
      ? [
          name,
          { key: 'spellings', header: t('columns.spellings'), sortValue: (s) => s.aliases.join(', '), cell: (s) => s.aliases.join(', ') || '–' },
          usage,
          ...(canManage
            ? [
                {
                  key: 'actions',
                  header: '',
                  cell: (s: SupplierSummary) => (
                    <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconCheck size={12} />}
                        onClick={() => void confirmOne(s)}
                        data-testid={`confirm-${s.id}`}
                      >
                        {t('actions.confirm')}
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="default"
                        leftSection={<IconGitMerge size={12} />}
                        onClick={() => setMerging(s)}
                        data-testid={`merge-${s.id}`}
                      >
                        {t('actions.merge')}
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconX size={12} />}
                        onClick={() => void dismissOne(s)}
                        data-testid={`dismiss-${s.id}`}
                      >
                        {t('actions.notSupplier')}
                      </Button>
                    </Group>
                  ),
                } satisfies DataColumn<SupplierSummary>,
              ]
            : []),
        ]
      : [
          name,
          {
            key: 'type',
            header: t('columns.type'),
            sortValue: typeLabel,
            cell: (s) => (
              <Badge size="sm" variant="default">
                {typeLabel(s)}
              </Badge>
            ),
          },
          {
            key: 'dpa',
            header: t('columns.dpa'),
            sortValue: (s) => s.dpaMissingContracts + (s.dpaMissing ? 1 : 0),
            cell: (s) =>
              s.dpaMissing ? (
                <Badge size="sm" color="red" variant="light">
                  {s.contractCount ? t('dpaMissingCount', { count: s.dpaMissingContracts }) : t('dpa.missing')}
                </Badge>
              ) : (
                '–'
              ),
          },
          {
            key: 'notice',
            header: t('columns.notice'),
            sortValue: (s) => s.nextNoticeBy ?? '9999',
            cell: (s) => <DueDate date={s.nextNoticeBy} state={s.noticeState} />,
          },
          {
            key: 'certificate',
            header: t('columns.certificate'),
            sortValue: (s) => s.nextCertificateExpiry ?? '9999',
            cell: (s) => <DueDate date={s.nextCertificateExpiry} state={s.certificateState} />,
          },
          usage,
          { key: 'owners', header: t('columns.owners'), sortValue: (s) => s.owners.join(', '), cell: (s) => s.owners.map(subjectLabel).join(', ') || '–' },
          {
            key: 'updated',
            header: t('columns.updated'),
            sortValue: (s) => s.updatedAt,
            nowrap: true,
            tdProps: (s) => ({ title: fmtDate(s.updatedAt) }),
            cell: (s) => fmtRelative(s.updatedAt),
          },
        ];
  const pending = toConfirm.data?.length ?? 0;
  return (
    <ListPage
      view="suppliers"
      tabs={
        <LinkTabs
          label={t('tabs.label')}
          active={tab === 'active' ? '/suppliers' : `/suppliers?status=${tab}`}
          tabs={[
            { to: '/suppliers', label: t('tabs.active') },
            { to: '/suppliers?status=unconfirmed', label: t('tabs.toConfirm'), count: pending || undefined, testId: 'tab-to-confirm' },
            { to: '/suppliers?status=archived', label: t('tabs.archived') },
          ]}
        />
      }
      search={{ value: q, onChange: (v) => set('q', v), placeholder: t('searchPlaceholder') }}
      activeFilters={type ? 1 : 0}
      title={t('title')}
      description={t('description')}
      primaryAction={
        canManage && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('new')}
          </Button>
        )
      }
      filters={
        tab !== 'unconfirmed' && (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              label={t('columns.type')}
              data={SUPPLIER_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) }))}
              value={type}
              onChange={(v) => set('type', v)}
              clearable
              w={{ base: '100%', xs: 220 }}
            />
          </Group>
        )
      }
    >
      {tab === 'active' && <ContractScopeNotice />}
      {tab === 'unconfirmed' && (
        <>
          <SharedSuppliers />
          <ProposedServices />
          <Text size="sm" c="dimmed" mb="md">
            {t('toConfirmIntro')}
          </Text>
        </>
      )}
      <QueryState query={list} />
      {list.isSuccess && all.length === 0 && tab === 'active' && (
        <EmptyState
          icon={IconTruckDelivery}
          title={t('emptyTitle')}
          whoCanAct={t('common:whoCanAct.suppliers')}
          action={
            canManage && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('new')}
              </Button>
            )
          }
        >
          {t('emptyText')}
        </EmptyState>
      )}
      {list.isSuccess && all.length === 0 && tab === 'unconfirmed' && (
        <Text size="sm" c="dimmed" data-testid="to-confirm-empty">
          {t('toConfirmEmpty')}
        </Text>
      )}
      {list.isSuccess && all.length > 0 && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(s) => s.id}
          ariaLabel={t('title')}
          rowHref={(s) => `/suppliers/${s.id}`}
          testId="supplier-list"
          rememberSort={`suppliers-${tab}`}
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={rows.length} total={all.length} />}
          card={(s) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Anchor component={Link} to={`/suppliers/${s.id}`} fw={600} size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {s.name}
                </Anchor>
                <Badge size="sm" variant="default" style={{ flexShrink: 0 }}>
                  {typeLabel(s)}
                </Badge>
              </Group>
              {tab === 'unconfirmed' && s.aliases.length > 0 && (
                <Text size="xs" c="dimmed">
                  {s.aliases.join(', ')}
                </Text>
              )}
              <Group gap={4} mt={4}>
                {s.nextNoticeBy && s.noticeState !== 'ok' && <DueDate date={s.nextNoticeBy} state={s.noticeState} />}
                {s.nextCertificateExpiry && s.certificateState !== 'ok' && <DueDate date={s.nextCertificateExpiry} state={s.certificateState} />}
              </Group>
              <Text size="xs" c="dimmed" mt={4}>
                {t('cardLine', { type: typeLabel(s), usage: t('usageCount', { count: usageTotal(s) }) })}
              </Text>
              {tab === 'unconfirmed' && canManage && (
                <Group gap={4} mt="xs">
                  <Button size="compact-xs" variant="light" onClick={() => void confirmOne(s)}>
                    {t('actions.confirm')}
                  </Button>
                  <Button size="compact-xs" variant="default" onClick={() => setMerging(s)}>
                    {t('actions.merge')}
                  </Button>
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => void dismissOne(s)}>
                    {t('actions.notSupplier')}
                  </Button>
                </Group>
              )}
            </Paper>
          )}
        />
      )}
      {creating && (
        <SupplierFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            refresh();
            navigate(`/suppliers/${s.id}`);
          }}
        />
      )}
      {merging && (
        <MergeModal
          supplier={merging}
          onClose={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            refresh();
          }}
        />
      )}
    </ListPage>
  );
}

/** Merge a supplier into another one (designers and administrators). */
export function MergeModal({
  supplier,
  onClose,
  onMerged,
}: {
  supplier: Pick<SupplierSummary, 'id' | 'name'>;
  onClose: () => void;
  onMerged: (into: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [into, setInto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = useQuery({ queryKey: supplierKeys.list('mergeTargets'), queryFn: () => get<SupplierSummary[]>('/suppliers') });
  const data = (targets.data ?? [])
    .filter((s) => s.id !== supplier.id && s.status !== 'archived')
    .map((s) => ({ value: s.id, label: s.status === 'unconfirmed' ? t('picker.unconfirmed', { name: s.name }) : s.name }));
  const save = async () => {
    if (!into) return;
    setBusy(true);
    try {
      const d = await post<SupplierDetail>(`/suppliers/${supplier.id}/merge`, { into });
      notifyOk(t('actions.merged'));
      onMerged(d);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('merge.title', { name: supplier.name })}>
      <Stack gap="sm">
        <Text size="sm">{t('merge.intro', { name: supplier.name })}</Text>
        <Select label={t('merge.into')} data={data} value={into} onChange={setInto} searchable data-autofocus data-testid="merge-into" />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!into}>
            {t('merge.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Create or change a supplier: what it is, who owns it, whether it processes personal data. */
export function SupplierFormModal({ supplier, onClose, onSaved }: { supplier?: SupplierDetail; onClose: () => void; onSaved: (s: SupplierDetail) => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [name, setName] = useState(supplier?.name ?? '');
  const [type, setType] = useState<SupplierType>(supplier?.type ?? 'saas');
  const [description, setDescription] = useState(supplier?.description ?? '');
  const [website, setWebsite] = useState(supplier?.website ?? '');
  const [owners, setOwners] = useState<string[]>(supplier?.owners ?? []);
  const [personalData, setPersonalData] = useState(supplier?.personalData ?? false);
  const [dpaStatus, setDpaStatus] = useState<SupplierDpaStatus>(supplier?.dpaStatus ?? 'missing');
  const [dpaSince, setDpaSince] = useState(supplier?.dpaSince ?? '');
  const [dpaLink, setDpaLink] = useState(supplier?.dpaLink ?? '');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    website: !!website.trim() && !/^https?:\/\/\S+$/i.test(website.trim()) && t('common:validation.invalid'),
    dpaLink: !!dpaLink.trim() && !DOC_LINK.test(dpaLink.trim()) && t('common:validation.invalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const inPlace = personalData && dpaStatus === 'inPlace';
    const body = {
      name: name.trim(),
      type,
      description,
      website: website.trim(),
      owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
      personalData,
      dpaStatus: personalData ? dpaStatus : null,
      dpaSince: inPlace && dpaSince ? dpaSince : null,
      dpaLink: inPlace ? dpaLink.trim() : '',
    };
    try {
      onSaved(supplier ? await put<SupplierDetail>(`/suppliers/${supplier.id}`, body) : await post<SupplierDetail>('/suppliers', body));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="lg" title={supplier ? supplier.name : t('new')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <TextInput
              label={t('fields.name')}
              required
              maxLength={SUPPLIER_LIMITS.name}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
            />
            <Select
              label={t('fields.type')}
              data={SUPPLIER_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) }))}
              value={type}
              allowDeselect={false}
              onChange={(k) => k && setType(k as SupplierType)}
            />
          </Group>
          <TextInput
            label={t('fields.website')}
            placeholder="https://"
            value={website}
            onChange={(e) => setWebsite(e.currentTarget.value)}
            error={v.error('website')}
          />
          <Textarea
            label={t('fields.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={SUPPLIER_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <SubjectsInput
            label={t('fields.owners')}
            description={t('fields.ownersHelp')}
            value={owners}
            onChange={setOwners}
            max={20}
            scope={{ kind: 'supplier', id: supplier?.id }}
            saved={supplier?.owners}
          />
          <Switch label={t('fields.personalData')} checked={personalData} onChange={(e) => setPersonalData(e.currentTarget.checked)} />
          {personalData && (
            <Group grow align="flex-start">
              <Select
                label={t('fields.dpaStatus')}
                data={SUPPLIER_DPA_STATUSES.map((k) => ({ value: k, label: t(`dpa.${k}`) }))}
                value={dpaStatus}
                allowDeselect={false}
                onChange={(k) => k && setDpaStatus(k as SupplierDpaStatus)}
              />
              {dpaStatus === 'inPlace' && (
                <TextInput type="date" label={t('fields.dpaSince')} value={dpaSince} onChange={(e) => setDpaSince(e.currentTarget.value)} />
              )}
            </Group>
          )}
          {personalData && dpaStatus === 'inPlace' && (
            <TextInput
              label={t('fields.dpaLink')}
              description={t('fields.docLinkHint')}
              value={dpaLink}
              onChange={(e) => setDpaLink(e.currentTarget.value)}
              error={v.error('dpaLink')}
            />
          )}
          {supplier?.status === 'unconfirmed' && (
            <Alert color="yellow" variant="light">
              {t('detail.unconfirmedNote')}
            </Alert>
          )}
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
