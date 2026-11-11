import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  MultiSelect,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconCheck, IconEdit, IconListCheck, IconPlus, IconRotate, IconShieldCheck, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CA_SEVERITIES,
  CA_SOURCES,
  CA_SOURCE_SWITCHES,
  type CaAction,
  type CaFinding,
  type CaFindingList,
  type CaFindingSummary,
  type CaSettings,
  type CaSuggestion,
  type CaSuggestionList,
  type ServiceSummary,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { DetailState, QueryState, subjectLabel, useCreateParam } from '../components/common';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { ListPage } from '../components/page/ListPage';
import { DetailHeader } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { MaturityBadge } from '../components/modules/MaturityBadge';
import { Field } from '../components/records/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { confirmDanger } from '../components/confirm';
import {
  ActionForm,
  CaSeverityBadge,
  CaStatusBadge,
  EffectivenessModal,
  FindingForm,
  ReasonModal,
  calDay,
  useSuggestionTitle,
} from '../components/compliance/corrective';
import { fmtDate, fmtDay, fmtRelative } from '../format';
import { correctiveKeys } from '../queryKeys';

/**
 * Corrective actions (ISO/IEC 27001 clause 10.2, ADR 0029 part 3; Compliance module, preview): the register of findings,
 * the suggestions Steward makes from its own events and the switches of their sources – and one finding with its
 * actions and the effectiveness check by a second person.
 */

type Tab = 'findings' | 'suggestions' | 'settings';
const BASE = '/compliance/corrective-actions';

function Tabs({ active, pending }: { active: Tab; pending?: number }) {
  const { t } = useTranslation('corrective');
  return (
    <LinkTabs
      label={t('tabs.label')}
      active={active === 'findings' ? BASE : `${BASE}/${active}`}
      tabs={[
        { to: BASE, label: t('tabs.findings'), testId: 'ca-tab-findings' },
        { to: `${BASE}/suggestions`, label: t('tabs.suggestions'), count: pending, testId: 'ca-tab-suggestions' },
        { to: `${BASE}/settings`, label: t('tabs.settings'), testId: 'ca-tab-settings' },
      ]}
    />
  );
}

const Title = () => {
  const { t } = useTranslation('corrective');
  return (
    <Group gap="xs" component="span" wrap="nowrap">
      <span>{t('title')}</span>
      <MaturityBadge maturity="preview" />
    </Group>
  );
};

export function CorrectiveActionsPage({ tab }: { tab: Tab }) {
  if (tab === 'suggestions') return <SuggestionsTab />;
  if (tab === 'settings') return <SettingsTab />;
  return <FindingsTab />;
}

// ---------- findings ----------

function FindingsTab() {
  const { t } = useTranslation(['corrective', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 300);
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [severity, setSeverity] = useState<string[]>([]);
  const [source, setSource] = useState<string[]>([]);
  const [service, setService] = useState<string | null>(null);
  const [overdue, setOverdue] = useState(false);
  const [mine, setMine] = useState(false);
  // ?controlId=: the findings of one control (from a row of the statement of applicability)
  const [params, setParams] = useSearchParams();
  const controlId = params.get('controlId');
  // ?supplierId=: the findings about one supplier (from the supplier's page)
  const supplierId = params.get('supplierId');
  const [creating, setCreating] = useState(false);
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const qs = useMemo(() => {
    const u = new URLSearchParams({ state });
    if (debounced.trim()) u.set('q', debounced.trim());
    if (severity.length) u.set('severity', severity.join(','));
    if (source.length) u.set('source', source.join(','));
    if (service) u.set('serviceId', service);
    if (overdue) u.set('overdue', 'true');
    if (mine) u.set('owner', 'me');
    if (controlId) u.set('controlId', controlId);
    if (supplierId) u.set('supplierId', supplierId);
    return u.toString();
  }, [state, debounced, severity, source, service, overdue, mine, controlId, supplierId]);
  const list = useQuery({ queryKey: correctiveKeys.list(qs), queryFn: () => get<CaFindingList>(`/compliance/corrective-actions?${qs}`) });
  useCreateParam(list.data?.canCreate, () => setCreating(true));
  const items = list.data?.items ?? [];
  const active = [debounced.trim(), state !== 'open', severity.length, source.length, service, overdue, mine, controlId, supplierId].filter(Boolean).length;
  const columns: DataColumn<CaFindingSummary>[] = [
    {
      key: 'finding',
      header: t('table.finding'),
      sortValue: (x) => x.number,
      cell: (x) => (
        <>
          <Anchor component={Link} to={`${BASE}/${x.id}`} fw={600} size="sm" className="mono" onClick={(e) => e.stopPropagation()}>
            {x.number}
          </Anchor>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {x.title}
          </Text>
          <Text size="xs" c="dimmed">
            {[t(`sources.${x.source}`), x.controls.map((c) => `${c.catalogueKey} ${c.ref}`).join(', ')].filter(Boolean).join(' · ')}
          </Text>
        </>
      ),
    },
    {
      key: 'severity',
      header: t('table.severity'),
      sortValue: (x) => CA_SEVERITIES.indexOf(x.severity),
      cell: (x) => <CaSeverityBadge severity={x.severity} size="xs" />,
    },
    {
      key: 'status',
      header: t('table.status'),
      sortValue: (x) => x.status,
      cell: (x) => (
        <Group gap={4} wrap="nowrap">
          <CaStatusBadge status={x.status} size="xs" />
          {x.overdue && (
            <Badge color="orange" variant="light" size="xs">
              {t('overdue')}
            </Badge>
          )}
        </Group>
      ),
    },
    { key: 'service', header: t('table.service'), sortValue: (x) => x.serviceName ?? '', cell: (x) => x.serviceName ?? (x.serviceId ? t('notVisible') : '–') },
    { key: 'owner', header: t('table.owner'), sortValue: (x) => x.owner ?? '', cell: (x) => x.owner ?? '–' },
    { key: 'due', header: t('table.due'), sortValue: (x) => x.dueDate ?? '9999', nowrap: true, cell: (x) => calDay(x.dueDate) },
    {
      key: 'actions',
      header: t('table.actions'),
      sortValue: (x) => x.actionsOpen,
      nowrap: true,
      cell: (x) => (x.actionsTotal ? t('actionsCount', { open: x.actionsOpen, total: x.actionsTotal }) : t('noActions')),
    },
  ];
  return (
    <ListPage
      tabs={<Tabs active="findings" pending={list.data?.pendingSuggestions} />}
      title={<Title />}
      description={t('description')}
      view="corrective-actions"
      area="correctiveActions"
      primaryAction={
        list.data?.canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="ca-new">
            {t('new')}
          </Button>
        )
      }
      search={{ value: q, onChange: setQ, label: t('filters.search'), placeholder: t('filters.search') }}
      activeFilters={active}
      filters={
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="xs" mb="md">
          <Select
            size="xs"
            label={t('filters.state')}
            allowDeselect={false}
            data={(['open', 'closed', 'all'] as const).map((x) => ({ value: x, label: t(`filters.states.${x}`) }))}
            value={state}
            onChange={(v) => setState((v as typeof state) ?? 'open')}
          />
          <MultiSelect
            size="xs"
            label={t('filters.severity')}
            placeholder={severity.length ? undefined : t('filters.allSeverities')}
            data={CA_SEVERITIES.map((x) => ({ value: x, label: t(`severities.${x}`) }))}
            value={severity}
            onChange={setSeverity}
            clearable
          />
          <MultiSelect
            size="xs"
            label={t('filters.source')}
            placeholder={source.length ? undefined : t('filters.allSources')}
            data={CA_SOURCES.map((x) => ({ value: x, label: t(`sources.${x}`) }))}
            value={source}
            onChange={setSource}
            clearable
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
          <Checkbox size="xs" label={t('filters.overdueOnly')} checked={overdue} onChange={(e) => setOverdue(e.currentTarget.checked)} mt="xs" />
          <Checkbox size="xs" label={t('filters.mine')} checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} mt="xs" />
        </SimpleGrid>
      }
      empty={{
        show: list.isSuccess && items.length === 0 && active === 0,
        icon: IconListCheck,
        title: t('empty.title'),
        text: t('empty.text'),
        whoCanAct: t('whoCanAct'),
        action: list.data?.canCreate && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('new')}
          </Button>
        ),
      }}
    >
      {!!list.data?.pendingSuggestions && (
        <Alert color="violet" variant="light" mb="md" data-testid="ca-pending-alert">
          <Group justify="space-between" gap="xs">
            <Text size="sm">{t('suggestionsWaiting', { count: list.data.pendingSuggestions })}</Text>
            <Button size="compact-xs" variant="light" component={Link} to={`${BASE}/suggestions`}>
              {t('showSuggestions')}
            </Button>
          </Group>
        </Alert>
      )}
      {controlId && (
        <Alert color="gray" variant="light" mb="md" data-testid="ca-control-filter">
          <Group justify="space-between" gap="xs">
            <Text size="sm">{t('filters.oneControl')}</Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => {
                params.delete('controlId');
                setParams(params, { replace: true });
              }}
            >
              {t('filters.allControls')}
            </Button>
          </Group>
        </Alert>
      )}
      {supplierId && (
        <Alert color="gray" variant="light" mb="md" data-testid="ca-supplier-filter">
          <Group justify="space-between" gap="xs">
            <Text size="sm">{t('filters.oneSupplier')}</Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => {
                params.delete('supplierId');
                setParams(params, { replace: true });
              }}
            >
              {t('filters.allSuppliers')}
            </Button>
          </Group>
        </Alert>
      )}
      <QueryState query={list} />
      {list.isSuccess && items.length === 0 && active > 0 && (
        <Text c="dimmed" size="sm">
          {t('empty.filtered')}
        </Text>
      )}
      {items.length > 0 && (
        <DataTable
          rows={items}
          columns={columns}
          rowKey={(x) => x.id}
          ariaLabel={t('title')}
          rowHref={(x) => `${BASE}/${x.id}`}
          footer={<ListFooter shown={items.length} />}
          testId="ca-list"
          card={(x) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Anchor component={Link} to={`${BASE}/${x.id}`} fw={600} size="sm" className="mono">
                    {x.number}
                  </Anchor>
                  <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {x.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {[t(`sources.${x.source}`), x.serviceName, x.dueDate && calDay(x.dueDate)].filter(Boolean).join(' · ')}
                  </Text>
                </div>
                <Stack gap={4} align="flex-end">
                  <CaStatusBadge status={x.status} size="xs" />
                  <CaSeverityBadge severity={x.severity} size="xs" />
                </Stack>
              </Group>
            </Paper>
          )}
        />
      )}
      {creating && (
        <FindingForm
          onClose={() => setCreating(false)}
          onSaved={(f) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: correctiveKeys.all });
            navigate(`${BASE}/${f.id}`);
          }}
        />
      )}
    </ListPage>
  );
}

// ---------- suggestions ----------

function SuggestionsTab() {
  const { t } = useTranslation(['corrective', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const title = useSuggestionTitle();
  const [status, setStatus] = useState<'pending' | 'confirmed' | 'dismissed' | 'all'>('pending');
  const list = useQuery({
    queryKey: correctiveKeys.suggestions(status),
    queryFn: () => get<CaSuggestionList>(`/compliance/corrective-suggestions?status=${status}`),
  });
  const [confirming, setConfirming] = useState<CaSuggestion | null>(null);
  const [dismissing, setDismissing] = useState<CaSuggestion | null>(null);
  const items = list.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: correctiveKeys.all });
  return (
    <ListPage tabs={<Tabs active="suggestions" pending={list.data?.pending} />} title={<Title />} description={t('suggestions.intro')}>
      <Group mb="md" gap="xs" align="flex-end">
        <Select
          size="xs"
          label={t('suggestions.statusFilter')}
          allowDeselect={false}
          data={(['pending', 'confirmed', 'dismissed', 'all'] as const).map((x) => ({ value: x, label: t(`suggestions.statuses.${x}`) }))}
          value={status}
          onChange={(v) => setStatus((v as typeof status) ?? 'pending')}
          w={200}
        />
      </Group>
      {list.data?.atLimit && (
        <Alert color="orange" variant="light" mb="md">
          {t('suggestions.atLimit', { limit: list.data.limit })}
        </Alert>
      )}
      <QueryState query={list} />
      {list.isSuccess && items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('suggestions.empty')}
        </Text>
      )}
      <Stack gap="sm" data-testid="ca-suggestions">
        {items.map((s) => (
          <Paper key={s.id} withBorder p="sm" data-testid="ca-suggestion">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
              <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
                  {title(s)}
                </Text>
                <Group gap={6}>
                  <Badge size="xs" variant="default">
                    {t(`sources.${s.source}`)}
                  </Badge>
                  <CaSeverityBadge severity={s.severity} size="xs" />
                  {s.serviceName && (
                    <Text size="xs" c="dimmed">
                      {s.serviceName}
                    </Text>
                  )}
                  {s.supplierName && (
                    <Text size="xs" c="dimmed">
                      {s.supplierName}
                    </Text>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {t('suggestions.occurred', { date: fmtDay(s.occurredAt) })}
                  {s.controls.length > 0 && ` · ${s.controls.map((c) => `${c.catalogueKey} ${c.ref}`).join(', ')}`}
                </Text>
                {s.sourceRef?.path && (
                  <Anchor component={Link} to={s.sourceRef.path} size="xs">
                    {s.sourceRef.label}
                  </Anchor>
                )}
                {s.status !== 'pending' && s.decidedBy && (
                  <Text size="xs" c="dimmed">
                    {t('suggestions.decided', { status: t(`suggestions.statuses.${s.status}`), user: s.decidedBy, date: fmtDate(s.decidedAt) })}
                    {s.findingId && s.findingNumber && (
                      <>
                        {' · '}
                        <Anchor component={Link} to={`${BASE}/${s.findingId}`} size="xs">
                          {t('suggestions.finding', { number: s.findingNumber })}
                        </Anchor>
                      </>
                    )}
                    {s.reason && ` · ${t('suggestions.reason', { reason: s.reason })}`}
                  </Text>
                )}
              </Stack>
              {s.canDecide && (
                <Group gap="xs">
                  <Button size="xs" leftSection={<IconCheck size={14} />} onClick={() => setConfirming(s)} data-testid="ca-confirm">
                    {t('suggestions.confirm')}
                  </Button>
                  <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => setDismissing(s)} data-testid="ca-dismiss">
                    {t('suggestions.dismiss')}
                  </Button>
                </Group>
              )}
            </Group>
          </Paper>
        ))}
      </Stack>
      {confirming && (
        <FindingForm
          suggestion={confirming}
          onClose={() => setConfirming(null)}
          onSaved={(f) => {
            setConfirming(null);
            void refresh();
            navigate(`${BASE}/${f.id}`);
          }}
        />
      )}
      {dismissing && (
        <ReasonModal
          title={t('suggestions.dismissTitle')}
          label={t('suggestions.dismissReason')}
          submit={t('suggestions.dismiss')}
          onClose={() => setDismissing(null)}
          onSubmit={async (reason) => {
            await post(`/compliance/corrective-suggestions/${dismissing.id}/dismiss`, { reason });
            notifyOk(t('suggestions.dismissed'));
            setDismissing(null);
            await refresh();
          }}
        />
      )}
    </ListPage>
  );
}

// ---------- settings ----------

function SettingsTab() {
  const { t } = useTranslation(['corrective', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: correctiveKeys.settings, queryFn: () => get<CaSettings>('/compliance/corrective-settings') });
  const pending = useQuery({ queryKey: correctiveKeys.suggestions('pending'), queryFn: () => get<CaSuggestionList>('/compliance/corrective-suggestions') });
  const toggle = async (key: (typeof CA_SOURCE_SWITCHES)[number], on: boolean) => {
    try {
      qc.setQueryData(correctiveKeys.settings, await put<CaSettings>('/compliance/corrective-settings', { sources: { [key]: on } }));
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e);
    }
  };
  const s = q.data;
  return (
    <ListPage tabs={<Tabs active="settings" pending={pending.data?.pending} />} title={<Title />} description={t('settings.intro')}>
      <QueryState query={q} />
      {s && (
        <Paper withBorder p="md" maw={760}>
          <Stack gap="md" data-testid="ca-settings">
            {!s.canEdit && (
              <Text size="sm" c="dimmed">
                {t('settings.readOnly')}
              </Text>
            )}
            {CA_SOURCE_SWITCHES.map((k) => (
              <Switch
                key={k}
                label={t(`settings.sources.${k}.label`)}
                description={t(`settings.sources.${k}.description`)}
                checked={s.sources[k]}
                disabled={!s.canEdit}
                onChange={(e) => void toggle(k, e.currentTarget.checked)}
                data-testid={`ca-source-${k}`}
              />
            ))}
            {s.updatedBy && s.updatedAt && (
              <Text size="xs" c="dimmed">
                {t('settings.updated', { user: s.updatedBy, when: fmtRelative(s.updatedAt) })}
              </Text>
            )}
          </Stack>
        </Paper>
      )}
    </ListPage>
  );
}

// ---------- one finding ----------

export function CorrectiveActionDetailPage() {
  const { t } = useTranslation(['corrective', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: correctiveKeys.detail(id), queryFn: () => get<CaFinding>(`/compliance/corrective-actions/${id}`), retry: false });
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<CaAction | 'new' | null>(null);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const f = q.data;
  if (!f) return <DetailState query={q} back="correctiveActions" />;
  const set = (n: CaFinding) => {
    qc.setQueryData(correctiveKeys.detail(id), n);
    void qc.invalidateQueries({ queryKey: ['corrective', 'list'] });
  };
  const status = async (to: 'inProgress' | 'implemented') => {
    try {
      set(await put<CaFinding>(`/compliance/corrective-actions/${f.id}`, { status: to }));
      notifyOk(t('detail.statusChanged'));
    } catch (e) {
      notifyError(e);
    }
  };
  const toggle = async (a: CaAction) => {
    try {
      set(await put<CaFinding>(`/compliance/corrective-actions/${f.id}/actions/${a.id}`, { done: !a.doneAt }));
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (a: CaAction) => {
    if (!(await confirmDanger({ action: 'remove', message: t('actions.removeConfirm', { title: a.title }) }))) return;
    try {
      set(await del<CaFinding>(`/compliance/corrective-actions/${f.id}/actions/${a.id}`));
      notifyOk(t('actions.removed'));
    } catch (e) {
      notifyError(e);
    }
  };
  const allDone = f.actions.length > 0 && f.actions.every((a) => a.doneAt);
  return (
    <>
      <DetailHeader
        recent={{ label: `${f.number} ${f.title}`, kind: 'record' }}
        back="correctiveActions"
        title={
          <Group gap="sm" wrap="wrap">
            <span className="mono">{f.number}</span>
            <span>{f.title}</span>
          </Group>
        }
        status={
          <Group gap={6}>
            <CaStatusBadge status={f.status} size="md" />
            <CaSeverityBadge severity={f.severity} size="md" />
            {f.overdue && (
              <Badge color="orange" variant="light" size="md">
                {t('overdue')}
              </Badge>
            )}
          </Group>
        }
        description={t(`sources.${f.source}`)}
        actions={
          <>
            {f.permissions.verify && (
              <Button size="xs" leftSection={<IconShieldCheck size={14} />} onClick={() => setChecking(true)} data-testid="ca-check">
                {t('detail.checkEffectiveness')}
              </Button>
            )}
            {f.permissions.edit && f.status === 'open' && (
              <Button size="xs" variant="light" onClick={() => void status('inProgress')}>
                {t('detail.markInProgress')}
              </Button>
            )}
            {f.permissions.edit && f.status === 'inProgress' && allDone && (
              <Button size="xs" variant="light" leftSection={<IconCheck size={14} />} onClick={() => void status('implemented')} data-testid="ca-implemented">
                {t('detail.markImplemented')}
              </Button>
            )}
            {f.permissions.edit && f.status === 'implemented' && (
              <Button size="xs" variant="default" leftSection={<IconRotate size={14} />} onClick={() => void status('inProgress')}>
                {t('detail.reopen')}
              </Button>
            )}
            {f.permissions.edit && (
              <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('detail.edit')}
              </Button>
            )}
          </>
        }
        menu={{
          items: f.permissions.cancel
            ? [{ label: t('detail.cancel'), icon: IconX, color: 'red', onClick: () => setCancelling(true), testId: 'ca-cancel' }]
            : [],
        }}
      />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {f.description.trim() ? (
              <MarkdownView text={f.description} />
            ) : (
              <Text c="dimmed" size="sm">
                {t('detail.noDescription')}
              </Text>
            )}
            {f.cause.trim() && (
              <Field label={t('fields.cause')}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {f.cause}
                </Text>
              </Field>
            )}
            <div data-testid="ca-actions">
              <Group justify="space-between" mb={4}>
                <Text fw={600} id="ca-actions-title">
                  {t('actions.title')}
                </Text>
                {f.permissions.addActions && (
                  <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => setAction('new')} data-testid="ca-add-action">
                    {t('actions.add')}
                  </Button>
                )}
              </Group>
              {f.record &&
                (f.record.visible ? (
                  <Text size="xs" c="dimmed" mb="xs">
                    {t('detail.measuresNote', { record: f.record.number })}{' '}
                    <Anchor component={Link} to={`/records/${f.record.id}`} size="xs">
                      {f.record.number} {f.record.title}
                    </Anchor>
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed" mb="xs">
                    {t('detail.recordHidden')}
                  </Text>
                ))}
              {f.actions.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('noActions')}
                </Text>
              ) : (
                <div className="table-scroll">
                  <Table fz="sm" aria-labelledby="ca-actions-title">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('actions.done')}</Table.Th>
                        <Table.Th>{t('actions.fieldTitle')}</Table.Th>
                        <Table.Th>{t('actions.owners')}</Table.Th>
                        <Table.Th>{t('actions.dueDate')}</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {f.actions.map((a) => (
                        <Table.Tr key={a.id}>
                          <Table.Td>
                            <Checkbox
                              checked={!!a.doneAt}
                              disabled={!a.canMarkDone}
                              onChange={() => void toggle(a)}
                              aria-label={a.doneAt ? t('actions.markOpen', { title: a.title }) : t('actions.markDone', { title: a.title })}
                            />
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" style={{ overflowWrap: 'anywhere' }} td={a.doneAt ? 'line-through' : undefined}>
                              {a.title}
                            </Text>
                            {a.measure && (
                              <Badge size="xs" variant="default">
                                {t('actions.measure')}
                              </Badge>
                            )}
                            {a.note && (
                              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                                {a.note}
                              </Text>
                            )}
                            {a.doneAt && a.doneBy && (
                              <Text size="xs" c="dimmed">
                                {t('actions.doneBy', { user: a.doneBy, date: fmtDay(a.doneAt) })}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs">{a.owners.map(subjectLabel).join(', ')}</Text>
                          </Table.Td>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>
                            <Text size="sm" c={a.overdue ? 'orange' : undefined}>
                              {calDay(a.dueDate)}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {a.canEdit && (
                              <Group gap={2} wrap="nowrap">
                                <Tooltip label={t('actions.editAction', { title: a.title })}>
                                  <ActionIcon variant="subtle" aria-label={t('actions.editAction', { title: a.title })} onClick={() => setAction(a)}>
                                    <IconEdit size={16} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={t('actions.remove', { title: a.title })}>
                                  <ActionIcon variant="subtle" color="red" aria-label={t('actions.remove', { title: a.title })} onClick={() => void remove(a)}>
                                    <IconTrash size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </div>
            <Paper withBorder p="sm" data-testid="ca-effectiveness">
              <Text fw={600} mb={4}>
                {t('detail.effectiveness')}
              </Text>
              {f.effectiveness ? (
                <Stack gap={2}>
                  <Text size="sm">
                    {t('detail.checkedBy', {
                      result: t(`effectiveness.${f.effectiveness.result}`),
                      user: f.effectiveness.checkedBy,
                      date: fmtDate(f.effectiveness.checkedAt),
                    })}
                  </Text>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                    {t('detail.method', { method: f.effectiveness.method })}
                  </Text>
                  {f.effectiveness.note && (
                    <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                      {f.effectiveness.note}
                    </Text>
                  )}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  {t('detail.notChecked')}
                </Text>
              )}
              {f.permissions.verifyBlocked === 'ownPart' && (
                <Text size="xs" c="orange" mt={4}>
                  {t('detail.ownPart')}
                </Text>
              )}
              {!f.permissions.fourEyes && (
                <Text size="xs" c="dimmed" mt={4}>
                  {t('detail.fourEyesOff')}
                </Text>
              )}
            </Paper>
            {f.status === 'cancelled' && f.cancelReason && (
              <Alert color="gray" variant="light">
                {t('detail.cancelled', { reason: f.cancelReason })}
              </Alert>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('fields.status')}>
                <CaStatusBadge status={f.status} />
              </Field>
              <Field label={t('fields.service')}>
                {f.serviceId && f.serviceName ? (
                  <Anchor component={Link} to={`/services/${f.serviceId}`} size="sm">
                    {f.serviceName}
                  </Anchor>
                ) : (
                  <Text size="sm">{f.serviceId ? t('notVisible') : '–'}</Text>
                )}
              </Field>
              <Field label={t('fields.supplier')}>
                {f.supplierId && f.supplierName ? (
                  <Anchor component={Link} to={`/suppliers/${f.supplierId}`} size="sm" data-testid="ca-detail-supplier">
                    {f.supplierName}
                  </Anchor>
                ) : (
                  <Text size="sm">{f.supplierId ? t('notVisible') : '–'}</Text>
                )}
              </Field>
              <Field label={t('fields.owner')}>
                <Text size="sm">{f.owner ?? '–'}</Text>
              </Field>
              <Field label={t('fields.dueDate')}>
                <Text size="sm" c={f.overdue ? 'orange' : undefined}>
                  {calDay(f.dueDate)}
                </Text>
              </Field>
              <Field label={t('fields.controls')}>
                {f.controls.length ? (
                  <Stack gap={0}>
                    {f.controls.map((c) => (
                      <Text key={c.id} size="sm">
                        {c.catalogueKey} {c.ref} – {c.title}
                      </Text>
                    ))}
                  </Stack>
                ) : (
                  <Text size="sm">–</Text>
                )}
              </Field>
              {f.sourceRef && (
                <Field label={t('detail.sourceLink')}>
                  {f.sourceRef.path && /^https?:\/\//i.test(f.sourceRef.path) ? (
                    <Anchor href={f.sourceRef.path} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                      {f.sourceRef.label || f.sourceRef.path}
                    </Anchor>
                  ) : f.sourceRef.path ? (
                    <Anchor component={Link} to={f.sourceRef.path} size="sm">
                      {f.sourceRef.label}
                    </Anchor>
                  ) : (
                    <Text size="sm">{f.sourceRef.visible ? f.sourceRef.label : t('notVisible')}</Text>
                  )}
                </Field>
              )}
              {(f.grcRef || f.grcUrl) && (
                <Field label={t('detail.grc')}>
                  {f.grcUrl && /^https?:\/\//i.test(f.grcUrl) ? (
                    <Anchor href={f.grcUrl} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                      {f.grcRef || f.grcUrl}
                    </Anchor>
                  ) : (
                    <Text size="sm">{f.grcRef}</Text>
                  )}
                </Field>
              )}
              {f.suggestionId && (
                <Text size="xs" c="dimmed">
                  {t('detail.fromSuggestion')}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {t('fields.created', { user: f.createdBy, date: fmtDate(f.createdAt) })}
                <br />
                {t('fields.updated', { user: f.updatedBy, when: fmtRelative(f.updatedAt) })}
                {f.closedAt && f.closedBy && (
                  <>
                    <br />
                    {t('fields.closed', { user: f.closedBy, date: fmtDate(f.closedAt) })}
                  </>
                )}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && (
        <FindingForm
          finding={f}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            setEditing(false);
            set(n);
          }}
        />
      )}
      {action && (
        <ActionForm
          finding={f}
          action={action === 'new' ? undefined : action}
          onClose={() => setAction(null)}
          onSaved={(n) => {
            setAction(null);
            set(n);
          }}
        />
      )}
      {checking && (
        <EffectivenessModal
          finding={f}
          onClose={() => setChecking(false)}
          onSaved={(n) => {
            setChecking(false);
            set(n);
          }}
        />
      )}
      {cancelling && (
        <ReasonModal
          title={t('cancel.title', { number: f.number })}
          label={t('cancel.reason')}
          hint={t('cancel.reasonHint')}
          submit={t('cancel.submit')}
          onClose={() => setCancelling(false)}
          onSubmit={async (reason) => {
            set(await post<CaFinding>(`/compliance/corrective-actions/${f.id}/cancel`, { reason }));
            notifyOk(t('cancel.done'));
            setCancelling(false);
          }}
        />
      )}
    </>
  );
}
