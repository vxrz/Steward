import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  MultiSelect,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconDownload, IconPackageExport, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Control, EvidencePack, EvidencePacksMeta, Platform, ServiceSummary } from '@sm/shared';
import { apiUrl, del, get, getOptional, notifyError, post } from '../api';
import { EmptyState, PageHeader, QueryState, TONE, useCreateParam } from '../components/common';
import { PeriodPicker, periodRange, presetPeriod, validPeriod, type Period } from '../components/compliance/common';
import { fmtBytes, fmtDate, fmtRelative } from '../format';

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
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
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
  return (
    <>
      <PageHeader
        title={t('packs.title')}
        description={t('packs.description')}
        actions={
          meta.data?.canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('packs.new')}
            </Button>
          )
        }
      />
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
      {list.length > 0 &&
        (narrow ? (
          <Stack gap="xs" role="list" aria-label={t('packs.title')}>
            {list.map((p) => (
              <Paper key={p.id} withBorder p="sm" role="listitem">
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
            ))}
          </Stack>
        ) : (
          <div className="table-scroll">
            <Table fz="sm" aria-label={t('packs.title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('packs.packTitle')}</Table.Th>
                  <Table.Th>{t('packs.scope')}</Table.Th>
                  <Table.Th>{t('packs.period')}</Table.Th>
                  <Table.Th>{t('packs.statusLabel')}</Table.Th>
                  <Table.Th>{t('packs.size')}</Table.Th>
                  <Table.Th>{t('packs.createdBy')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {p.title}
                      </Text>
                      {p.sha256 && (
                        <Text size="xs" c="dimmed" className="mono" title={p.sha256}>
                          {t('packs.sha', { hash: p.sha256.slice(0, 16) })}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{p.scopeLabel}</Table.Td>
                    <Table.Td>
                      {fmtDate(p.from)} – {fmtDate(p.to)}
                    </Table.Td>
                    <Table.Td>
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
                    </Table.Td>
                    <Table.Td>{p.size !== null ? `${fmtBytes(p.size)} · ${t('packs.files', { count: p.fileCount ?? 0 })}` : '–'}</Table.Td>
                    <Table.Td>{p.createdBy}</Table.Td>
                    <Table.Td>{actions(p)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
      {creating && <NewPackModal onClose={() => setCreating(false)} />}
    </>
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
  const controls = useQuery({ queryKey: ['controls-all'], queryFn: () => get<Control[]>('/compliance/controls') });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => getOptional<Platform[]>('/platforms', []) });
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
  const submit = async () => {
    if (!scope || !validPeriod(period)) return;
    setBusy(true);
    try {
      const r = periodRange(period);
      await post('/compliance/evidence-packs', { title: title.trim() || undefined, scope, from: r.from, to: r.to, lang });
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
          />
        )}
        {kind === 'platform' && (
          <Select
            label={t('accessChanges.platform')}
            required
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={platformId}
            onChange={setPlatformId}
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
          />
        )}
        <PeriodPicker value={period} onChange={setPeriod} />
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
        <Alert color="gray" variant="light">
          <Text size="sm">{t('packs.contentsHelp')}</Text>
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!scope || !validPeriod(period)}>
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
