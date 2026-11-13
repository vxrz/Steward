import { useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlus, IconServer2 } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SubjectsInput, useSubjectLabel } from '../components/SubjectsInput';
import { SYSTEM_KINDS, SYSTEM_LIMITS, type Platform, type SystemDetail, type SystemKind, type SystemSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { EmptyState, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { EnvironmentBadge, useEnvironmentList } from '../components/catalogue/environments';
import { StackFields, stackBody, stackRowsOf, type StackRow } from '../components/catalogue/ComponentsPanel';
import { ListPage } from '../components/page/ListPage';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { platformKeys } from '../queryKeys';
import { NetworkFields, emptyNetwork, networkErrors } from '../components/catalogue/network';
import { RestrictedEmpty, useHiddenByPermissions } from '../components/modules/RestrictedEmpty';
import { SupplierPicker, useSupplierChoice } from '../components/suppliers/SupplierPicker';
import { EdgeSuggestionsSection } from '../components/catalogue/EdgeSuggestions';

/** Systems (#129): servers, VMs, clusters, appliances and cloud services that applications run on. */
export function SystemsPage() {
  const { t } = useTranslation(['applications', 'common']);
  const subjectName = useSubjectLabel();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  // the filters live in the address (?q=, ?kind=, ?env=, ?owner=), so a filtered list can be shared
  const { params, set } = useListParams();
  const q = params.get('q') ?? '';
  const kind = params.get('kind');
  const env = params.get('env');
  const owner = params.get('owner');
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems') });
  // entries the person may not see (U3): "nothing you may see" instead of "nothing yet"
  const hidden = useHiddenByPermissions('systems');
  const envList = useEnvironmentList();
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));
  const needle = q.trim().toLowerCase();
  const all = systems.data ?? [];
  const list = all.filter(
    (s) =>
      (!needle || [s.name, s.vendor, s.supplier?.name ?? '', s.note].some((x) => x.toLowerCase().includes(needle))) &&
      (!kind || s.kind === kind) &&
      (!env || s.environments.includes(env)) &&
      (!owner || s.owners.includes(owner)),
  );
  const kindLabel = (s: SystemSummary) => t(`systems.kinds.${s.kind}`);
  const eolBadges = (s: SystemSummary) => (
    <>
      {s.eol > 0 && (
        <Badge size="sm" color="red" variant="light">
          {t('systems.eolCount', { count: s.eol })}
        </Badge>
      )}
      {s.ending > 0 && (
        <Badge size="sm" color="orange" variant="light">
          {t('systems.endingCount', { count: s.ending })}
        </Badge>
      )}
    </>
  );
  const columns: DataColumn<SystemSummary>[] = [
    {
      key: 'name',
      header: t('name'),
      sortValue: (s) => s.name,
      cell: (s) => (
        <>
          <Anchor component={Link} to={`/systems/${s.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
            {s.name}
          </Anchor>
          {(s.supplier || s.vendor) && (
            <Text size="xs" c="dimmed">
              {s.supplier?.name ?? s.vendor}
            </Text>
          )}
        </>
      ),
    },
    {
      key: 'kind',
      header: t('systems.kind'),
      sortValue: kindLabel,
      cell: (s) => (
        <Badge size="sm" variant="default">
          {kindLabel(s)}
        </Badge>
      ),
    },
    {
      key: 'environments',
      header: t('environments.title'),
      sortValue: (s) => s.environments.join(', '),
      cell: (s) => (
        <Group gap={4}>
          {s.environments.map((e) => (
            <EnvironmentBadge key={e} value={e} />
          ))}
        </Group>
      ),
    },
    { key: 'applications', header: t('systems.applicationsColumn'), sortValue: (s) => s.applicationCount, cell: (s) => s.applicationCount },
    {
      key: 'eol',
      header: t('systems.eolColumn'),
      // past the end of life first, then ending soon
      sortValue: (s) => s.eol * 10000 + s.ending,
      cell: (s) => (
        <Group gap={4}>
          {eolBadges(s)}
          {!s.eol && !s.ending && '–'}
        </Group>
      ),
    },
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
      view="systems"
      search={{ value: q, onChange: (v) => set('q', v), placeholder: t('systems.searchPlaceholder') }}
      activeFilters={[kind, env, owner].filter(Boolean).length}
      title={t('systems.title')}
      description={t('systems.description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('systems.new')}
          </Button>
        )
      }
      filters={
        <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="system-filters">
          <Select
            size="xs"
            label={t('systems.kind')}
            data={SYSTEM_KINDS.map((k) => ({ value: k, label: t(`systems.kinds.${k}`) }))}
            value={kind}
            onChange={(v) => set('kind', v)}
            clearable
            w={{ base: '100%', xs: 180 }}
          />
          <Select
            size="xs"
            label={t('environments.label')}
            data={[...new Set([...envList.map((e) => e.name), ...all.flatMap((s) => s.environments).filter(Boolean)])]}
            value={env}
            onChange={(v) => set('env', v)}
            clearable
            w={{ base: '100%', xs: 180 }}
          />
          <Select
            size="xs"
            label={t('owners')}
            data={[...new Set([...all.flatMap((s) => s.owners), ...(owner ? [owner] : [])])]
              .sort((a, b) => subjectName(a).localeCompare(subjectName(b)))
              .map((o) => ({ value: o, label: subjectName(o) }))}
            value={owner}
            onChange={(v) => set('owner', v)}
            clearable
            searchable
            w={{ base: '100%', xs: 220 }}
          />
        </Group>
      }
    >
      <QueryState query={systems} />
      {/* 0.25.0 (ADR 0037): the suggestions of the Industrial Edge installations readout, confirmed by a person */}
      <EdgeSuggestionsSection canRestore={canCreate} />
      {systems.isSuccess && all.length === 0 && hidden && <RestrictedEmpty />}
      {systems.isSuccess && all.length === 0 && !hidden && (
        <EmptyState
          icon={IconServer2}
          title={t('systems.emptyTitle')}
          whoCanAct={t('common:whoCanAct.systems')}
          action={
            canCreate && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('systems.new')}
              </Button>
            )
          }
        >
          {t('systems.emptyText')}
        </EmptyState>
      )}
      {systems.isSuccess && all.length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('systems.noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(s) => s.id}
          ariaLabel={t('systems.title')}
          rowHref={(s) => `/systems/${s.id}`}
          testId="system-list"
          rememberSort="systems"
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={list.length} total={all.length} />}
          card={(s) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Anchor component={Link} to={`/systems/${s.id}`} fw={600} size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {s.name}
                </Anchor>
                <Badge size="sm" variant="default" style={{ flexShrink: 0 }}>
                  {kindLabel(s)}
                </Badge>
              </Group>
              {(s.supplier || s.vendor) && (
                <Text size="xs" c="dimmed">
                  {s.supplier?.name ?? s.vendor}
                </Text>
              )}
              <Group gap={4} mt={4}>
                {s.environments.map((e) => (
                  <EnvironmentBadge key={e} value={e} />
                ))}
                {eolBadges(s)}
              </Group>
              <Text size="xs" c="dimmed" mt={4}>
                {t('systems.cardLine', { apps: s.applicationCount, when: fmtRelative(s.updatedAt) })}
              </Text>
            </Paper>
          )}
        />
      )}
      {creating && (
        <SystemFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            void qc.invalidateQueries({ queryKey: ['systems'] });
            navigate(`/systems/${s.id}`);
          }}
        />
      )}
    </ListPage>
  );
}

/** Create or change a system: what it is, who owns it, the platform it is, its tech stack. */
export function SystemFormModal({ system, onClose, onSaved }: { system?: SystemDetail; onClose: () => void; onSaved: (s: SystemDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const [name, setName] = useState(system?.name ?? '');
  const [kind, setKind] = useState<SystemKind>(system?.kind ?? 'server');
  const [vendor, setVendor] = useState(system?.vendor ?? '');
  const supplier = useSupplierChoice(system?.supplier);
  const [cmdbUrl, setCmdbUrl] = useState(system?.cmdbUrl ?? '');
  const [owners, setOwners] = useState<string[]>(system?.owners ?? []);
  const [note, setNote] = useState(system?.note ?? '');
  // 0.25.0: its device id in Industrial Edge Management (an external reference)
  const [iemDeviceId, setIemDeviceId] = useState(system?.iemDeviceId ?? '');
  // a platform the reader may not see stays as it is (null here means "keep" only when hidden)
  const [platformId, setPlatformId] = useState<string | null>(system?.platform?.id ?? null);
  const [stack, setStack] = useState<StackRow[]>(stackRowsOf(system?.stack ?? []));
  // a network segment (#208): its attributes, all optional
  const [network, setNetwork] = useState(emptyNetwork(system?.kind === 'network' ? system.attributes : undefined));
  const [networkShown, setNetworkShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    cmdbUrl: !!cmdbUrl.trim() && !/^https?:\/\/\S+$/i.test(cmdbUrl.trim()) && t('common:validation.invalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    if (kind === 'network' && Object.keys(networkErrors(network)).length) {
      setNetworkShown(true);
      return;
    }
    setBusy(true);
    const body = {
      name: name.trim(),
      kind,
      vendor: vendor.trim(),
      supplierId: supplier.body,
      cmdbUrl: cmdbUrl.trim(),
      owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
      note,
      platformId: system?.platformHidden && platformId === null ? undefined : platformId,
      stack: stackBody(stack),
      attributes: kind === 'network' ? network : {},
      iemDeviceId: iemDeviceId.trim() || null,
    };
    try {
      onSaved(system ? await put<SystemDetail>(`/systems/${system.id}`, body) : await post<SystemDetail>('/systems', body));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="lg" title={system ? t('systems.editTitle', { name: system.name }) : t('systems.new')}>
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
              label={t('name')}
              required
              maxLength={SYSTEM_LIMITS.name}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
            />
            <Select
              label={t('systems.kind')}
              data={SYSTEM_KINDS.map((k) => ({ value: k, label: t(`systems.kinds.${k}`) }))}
              value={kind}
              allowDeselect={false}
              onChange={(k) => k && setKind(k as SystemKind)}
            />
          </Group>
          <Group grow align="flex-start">
            <SupplierPicker value={supplier.value} onChange={supplier.set} initial={system?.supplier} testId="system-supplier">
              <TextInput
                label={t('systems.vendor')}
                description={t('systems.vendorHint')}
                maxLength={SYSTEM_LIMITS.vendor}
                value={vendor}
                onChange={(e) => setVendor(e.currentTarget.value)}
              />
            </SupplierPicker>
            <TextInput
              label={t('systems.cmdbUrl')}
              placeholder="https://"
              value={cmdbUrl}
              onChange={(e) => setCmdbUrl(e.currentTarget.value)}
              error={v.error('cmdbUrl')}
            />
          </Group>
          {kind === 'network' && <NetworkFields value={network} onChange={setNetwork} showErrors={networkShown} />}
          <SubjectsInput
            label={t('owners')}
            description={t('systems.ownersHelp')}
            value={owners}
            onChange={setOwners}
            max={20}
            scope={{ kind: 'system', id: system?.id }}
            saved={system?.owners}
          />
          <Select
            label={t('systems.platform')}
            description={system?.platformHidden ? t('systems.platformHiddenHint') : t('systems.platformHint')}
            placeholder={system?.platformHidden ? t('systems.platformHidden') : t('systems.noPlatform')}
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.environment ? `${p.name} (${p.environment})` : p.name }))}
            value={platformId}
            onChange={setPlatformId}
            clearable
            searchable
          />
          <TextInput
            label={t('systems.iemDeviceId')}
            description={t('systems.iemDeviceIdHelp')}
            maxLength={SYSTEM_LIMITS.iemDeviceId}
            classNames={{ input: 'mono' }}
            value={iemDeviceId}
            onChange={(e) => setIemDeviceId(e.currentTarget.value)}
            data-testid="system-iem-device-id"
          />
          <Textarea
            label={t('systems.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SYSTEM_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <StackFields stack={stack} onChange={setStack} />
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
