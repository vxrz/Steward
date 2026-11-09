import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  MultiSelect,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconDownload, IconPackageExport, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { EVIDENCE_PACK_STATUSES, type Control, type EvidencePack, type EvidencePacksMeta, type Platform, type ServiceSummary } from '@sm/shared';
import { apiUrl, confirmedDownload, del, get, getOptional, notifyError, post } from '../api';
import { useMe } from '../auth';
import { assuranceReportUrl } from '../components/assurance/AssurancePolicyPanel';
import { EmptyState, QueryState, TONE, useCreateParam, useFieldErrors } from '../components/common';
import { PeriodPicker, periodRange, presetPeriod, validPeriod, type Period } from '../components/compliance/common';
import { fmtBytes, fmtDate, fmtRelative } from '../format';
import { ListPage } from '../components/page/ListPage';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { platformKeys } from '../queryKeys';

/** Sort order of the status column: failed first. */
const PACK_STATUS_ORDER: EvidencePack['status'][] = ['failed', 'building', 'ready', 'expired'];

const STATUS_COLOR: Record<EvidencePack['status'], string> = { building: TONE.active, ready: TONE.ok, failed: TONE.bad, expired: TONE.neutral };

/** Compliance → Evidence packs: signed ZIP exports for auditors (controls, a platform or a service, and a period). */
export function EvidencePacksPage() {
  const { t } = useTranslation(['compliance', 'common']);
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const meta = useQuery({ queryKey: ['evidence-packs-meta'], queryFn: () => get<EvidencePacksMeta>('/compliance/evidence-packs/meta') });
  const packs = useQuery({
    queryKey: ['evidence-packs'],
    queryFn: () => get<EvidencePack[]>('/compliance/evidence-packs'),
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === 'building') ? 1500 : false),
  });
  useCreateParam(meta.data?.canCreate, () => setCreating(true));
  const list = packs.data ?? [];
  const { params, set } = useListParams();
  const remove = async (p: EvidencePack) => {
    try {
      await del(`/compliance/evidence-packs/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['evidence-packs'] });
    } catch (e) {
      notifyError(e);
    }
  };
  const actions = (p: EvidencePack) => (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      {p.canDownload && (
        <Button size="xs" variant="light" component="a" href={apiUrl(`/compliance/evidence-packs/${p.id}/download`)} leftSection={<IconDownload size={14} />}>
          {t('packs.download')}
        </Button>
      )}
      {p.canDelete && p.status !== 'building' && (
        <ActionIcon variant="subtle" color="red" aria-label={t('packs.delete', { title: p.title })} onClick={() => remove(p)}>
          <IconTrash size={16} />
        </ActionIcon>
      )}
    </Group>
  );
  const statusBadge = (p: EvidencePack) => (
    <Badge color={STATUS_COLOR[p.status]} variant="light" size="sm">
      {t(`packs.status.${p.status}`)}
    </Badge>
  );
  // ?status= (the filter lives in the address, so a filtered list can be shared)
  const statuses = params.getAll('status').filter((x): x is EvidencePack['status'] => (EVIDENCE_PACK_STATUSES as readonly string[]).includes(x));
  const shown = statuses.length ? list.filter((p) => statuses.includes(p.status)) : list;
  const columns: DataColumn<EvidencePack>[] = [
    {
      key: 'title',
      header: t('packs.packTitle'),
      sortValue: (p) => p.title,
      cell: (p) => (
        <>
          <Text size="sm" fw={500}>
            {p.title}
          </Text>
          {p.sha256 && (
            <Text size="xs" c="dimmed" className="mono" title={p.sha256}>
              {t('packs.sha', { hash: p.sha256.slice(0, 16) })}
            </Text>
          )}
        </>
      ),
    },
    { key: 'scope', header: t('packs.scope'), sortValue: (p) => p.scopeLabel, cell: (p) => p.scopeLabel },
    {
      key: 'period',
      header: t('packs.period'),
      sortValue: (p) => p.from,
      cell: (p) => (
        <>
          {fmtDate(p.from)} – {fmtDate(p.to)}
        </>
      ),
    },
    {
      key: 'status',
      header: t('packs.statusLabel'),
      // failed first, then those being built
      sortValue: (p) => PACK_STATUS_ORDER.indexOf(p.status),
      cell: (p) => (
        <>
          {statusBadge(p)}
          {p.error && (
            <Text size="xs" c="red" maw={320}>
              {p.error}
            </Text>
          )}
          {p.status === 'ready' && (
            <Text size="xs" c="dimmed">
              {t('packs.expires', { when: fmtRelative(p.expiresAt) })}
            </Text>
          )}
        </>
      ),
    },
    {
      key: 'size',
      header: t('packs.size'),
      sortValue: (p) => p.size,
      cell: (p) => (p.size !== null ? `${fmtBytes(p.size)} · ${t('packs.files', { count: p.fileCount ?? 0 })}` : '–'),
    },
    {
      key: 'createdBy',
      header: t('packs.createdBy'),
      // newest first by default
      sortValue: (p) => p.createdAt,
      tdProps: (p) => ({ title: fmtDate(p.createdAt) }),
      cell: (p) => (
        <>
          {p.createdBy}
          <Text size="xs" c="dimmed">
            {fmtRelative(p.createdAt)}
          </Text>
        </>
      ),
    },
    { key: 'actions', header: <VisuallyHidden>{t('packs.actions')}</VisuallyHidden>, label: t('packs.actions'), cell: actions },
  ];
  return (
    <ListPage
      title={t('packs.title')}
      description={t('packs.description')}
      activeFilters={statuses.length ? 1 : 0}
      filters={
        list.length ? (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="evidence-pack-filters">
            <MultiSelect
              size="xs"
              label={t('packs.statusLabel')}
              data={EVIDENCE_PACK_STATUSES.map((x) => ({ value: x, label: t(`packs.status.${x}`) }))}
              value={statuses}
              onChange={(v) => set('status', v)}
              clearable
              w={{ base: '100%', xs: 260 }}
            />
          </Group>
        ) : undefined
      }
      actions={
        meta.data?.canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('packs.new')}
          </Button>
        )
      }
    >
      {meta.data && (
        <Text size="xs" c="dimmed" mb="sm">
          {t('packs.limits', { size: fmtBytes(meta.data.maxBytes), days: meta.data.retentionDays })}
        </Text>
      )}
      <Paper withBorder p="sm" mb="md">
        <Text size="sm" fw={600}>
          {t('packs.verifyTitle')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('packs.verifyText')}
        </Text>
        <Code block mt={4}>
          {'npm run evidence:verify -- pack.zip\nsteward evidence verify pack.zip'}
        </Code>
      </Paper>
      <QueryState query={packs} />
      {packs.isSuccess && list.length === 0 && (
        <EmptyState
          icon={IconPackageExport}
          title={t('packs.emptyTitle')}
          whoCanAct={t('common:whoCanAct.evidencePacks')}
          action={
            meta.data?.canCreate && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('packs.new')}
              </Button>
            )
          }
        >
          {t('packs.emptyText')}
        </EmptyState>
      )}
      {list.length > 0 && shown.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('packs.noMatch')}
        </Text>
      )}
      {shown.length > 0 && (
        <DataTable
          rows={shown}
          columns={columns}
          rowKey={(p) => p.id}
          ariaLabel={t('packs.title')}
          testId="evidence-pack-list"
          rememberSort="evidence-packs"
          defaultSort={{ key: 'createdBy', dir: 'desc' }}
          footer={<ListFooter shown={shown.length} total={list.length} />}
          card={(p) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Text fw={600} size="sm">
                  {p.title}
                </Text>
                {statusBadge(p)}
              </Group>
              <Text size="xs" c="dimmed">
                {p.scopeLabel} · {fmtDate(p.from)} – {fmtDate(p.to)}
              </Text>
              {p.error && (
                <Text size="xs" c="red">
                  {p.error}
                </Text>
              )}
              <Group justify="flex-end" mt={4}>
                {actions(p)}
              </Group>
            </Paper>
          )}
        />
      )}
      {creating && <NewPackModal onClose={() => setCreating(false)} />}
    </ListPage>
  );
}

function NewPackModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const preset = params.get('controls')?.split(',').filter(Boolean) ?? [];
  const [kind, setKind] = useState<'controls' | 'platform' | 'service'>('controls');
  const [controlIds, setControlIds] = useState<string[]>(preset);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<'en' | 'de'>('en');
  const [period, setPeriod] = useState<Period>(
    params.get('from') && params.get('to') ? { preset: 'custom', from: params.get('from')!, to: params.get('to')! } : presetPeriod('90'),
  );
  const [busy, setBusy] = useState(false);
  // the assurance report of the period (#210): auditors and administrators
  const { caps } = useMe();
  const [assurance, setAssurance] = useState(false);
  const controls = useQuery({ queryKey: ['controls-all'], queryFn: () => get<Control[]>('/compliance/controls') });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => getOptional<Platform[]>('/platforms', []) });
  const services = useQuery({ queryKey: ['services'], queryFn: () => getOptional<ServiceSummary[]>('/services', []) });
  const scope =
    kind === 'controls'
      ? controlIds.length
        ? { controlIds }
        : null
      : kind === 'platform'
        ? platformId
          ? { platformId }
          : null
        : serviceId
          ? { serviceId }
          : null;
  const v = useFieldErrors({ scope: !scope && t('common:validation.required'), period: !validPeriod(period) && t('common:validation.invalid') });
  const submit = async () => {
    if (!v.validate()) return;
    if (!scope) return;
    setBusy(true);
    try {
      const r = periodRange(period);
      await post('/compliance/evidence-packs', {
        title: title.trim() || undefined,
        scope,
        from: r.from,
        to: r.to,
        lang,
        ...(assurance ? { assurance: true } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['evidence-packs'] });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('packs.new')} size="lg">
      <Stack gap="sm">
        <TextInput
          label={t('packs.packTitle')}
          placeholder={t('packs.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={200}
        />
        <SegmentedControl
          value={kind}
          onChange={(v) => setKind(v as 'controls')}
          aria-label={t('packs.scope')}
          data={[
            { value: 'controls', label: t('packs.scopeControls') },
            { value: 'platform', label: t('packs.scopePlatform') },
            { value: 'service', label: t('packs.scopeService') },
          ]}
        />
        {kind === 'controls' && (
          <MultiSelect
            label={t('packs.controls')}
            searchable
            required
            data={(controls.data ?? []).map((c) => ({ value: c.id, label: `${c.catalogueKey} ${c.ref} – ${c.title}` }))}
            value={controlIds}
            onChange={setControlIds}
            maxValues={200}
            error={v.error('scope')}
          />
        )}
        {kind === 'platform' && (
          <Select
            label={t('accessChanges.platform')}
            required
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={platformId}
            onChange={setPlatformId}
            error={v.error('scope')}
          />
        )}
        {kind === 'service' && (
          <Select
            label={t('packs.service')}
            required
            searchable
            data={(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={serviceId}
            onChange={setServiceId}
            error={v.error('scope')}
          />
        )}
        <PeriodPicker value={period} onChange={setPeriod} error={v.error('period')} />
        <Select
          label={t('packs.language')}
          allowDeselect={false}
          data={[
            { value: 'en', label: t('packs.langEn') },
            { value: 'de', label: t('packs.langDe') },
          ]}
          value={lang}
          onChange={(v) => setLang((v as 'en') ?? 'en')}
          w={{ base: '100%', xs: 200 }}
        />
        {caps.viewAudit && (
          <Group gap="xs" wrap="wrap" justify="space-between">
            <Checkbox
              label={t('packs.includeAssurance')}
              description={t('packs.includeAssuranceHint')}
              checked={assurance}
              onChange={(e) => setAssurance(e.currentTarget.checked)}
              data-testid="pack-include-assurance"
            />
            <Button
              component="a"
              size="xs"
              variant="default"
              href={validPeriod(period) ? assuranceReportUrl(periodRange(period), lang) : undefined}
              onClick={confirmedDownload('exportAuditLog')}
              disabled={!validPeriod(period)}
              leftSection={<IconDownload size={14} aria-hidden />}
            >
              {t('packs.assuranceReport')}
            </Button>
          </Group>
        )}
        <Alert color="gray" variant="light">
          <Text size="sm">{t('packs.contentsHelp')}</Text>
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t('packs.create')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('packs.permissionsNote')}
        </Text>
      </Stack>
    </Modal>
  );
}
