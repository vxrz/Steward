import { useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconDownload, IconEdit, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { GatusMetricsSource, MonitorSummary, ProcessSummary, RecordType, ReportRecord, ReportSchedule, ReportSchedulePreset, Subject } from '@sm/shared';
import { apiUrl, del, get, getOptional, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { fmtBytes, fmtDate, fmtDay, fmtRelative } from '../format';

const PRESETS: ReportSchedulePreset[] = ['daily', 'weekly', 'monthly', 'custom'];
const BUILTIN = ['availability', 'gatus', 'credentials', 'runs', 'records'];

type Draft = Pick<
  ReportSchedule,
  'name' | 'enabled' | 'preset' | 'cron' | 'timezone' | 'periodDays' | 'lang' | 'classification' | 'title' | 'sections' | 'recipients' | 'attachPdf'
> & { id?: string };

const emptyDraft = (lang: 'en' | 'de'): Draft => ({
  name: '',
  enabled: true,
  preset: 'weekly',
  cron: '0 6 * * 1',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  periodDays: 7,
  lang,
  classification: '',
  title: '',
  sections: { availability: { monitorIds: null, slaTarget: 99.5 }, credentials: { dueWithinDays: 30 } },
  recipients: { users: [], teams: [], emails: [] },
  attachPdf: false,
});

export function ReportsPage() {
  const { t, i18n } = useTranslation(['reportSchedules', 'common']);
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const highlight = params.get('report');
  const schedules = useQuery({
    queryKey: ['report-schedules'],
    queryFn: () => get<{ items: ReportSchedule[]; canCreate: boolean; sections: string[] }>('/report-schedules'),
  });
  const generated = useQuery({ queryKey: ['report-schedules', 'reports'], queryFn: () => get<ReportRecord[]>('/report-schedules/reports') });
  const summaries = useQuery({ queryKey: ['reports', 'summary'], queryFn: () => getOptional<ReportRecord[]>('/reports?kind=summary', []) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['report-schedules'] });
  const reports = [...(generated.data ?? []), ...(summaries.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const runNow = async (s: ReportSchedule) => {
    setRunning(s.id);
    try {
      const r = await post<ReportRecord>(`/report-schedules/${s.id}/run`);
      notifyOk(t('ranOk', { name: s.name, file: r.filename }));
    } catch (e) {
      notifyError(e, t('runFailed'));
    } finally {
      setRunning(null);
      refresh();
    }
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          schedules.data?.canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft(i18n.language.startsWith('de') ? 'de' : 'en'))}>
              {t('new')}
            </Button>
          )
        }
      />
      <Stack>
        <Card withBorder>
          <Title order={5} mb="xs">
            {t('schedulesTitle')}
          </Title>
          {schedules.data?.items.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('empty')}
            </Text>
          )}
          {!!schedules.data?.items.length && (
            <div className="table-scroll">
              <Table fz="sm" highlightOnHover aria-label={t('schedulesTitle')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('table.name')}</Table.Th>
                    <Table.Th>{t('table.when')}</Table.Th>
                    <Table.Th>{t('table.sections')}</Table.Th>
                    <Table.Th>{t('table.last')}</Table.Th>
                    <Table.Th>{t('table.next')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {schedules.data.items.map((s) => (
                    <Table.Tr key={s.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {s.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t('table.owner', { owner: s.owner })}
                          {!s.enabled && (
                            <Badge ml={4} size="xs" color="gray" variant="light">
                              {t('disabled')}
                            </Badge>
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {t(`presets.${s.preset}`)}
                        <Text size="xs" c="dimmed">
                          <span className="mono">{s.cron}</span> {s.timezone}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {Object.keys(s.sections).map((id) => (
                            <Badge key={id} size="xs" variant="light">
                              {t(`sections.${id}.title`, { defaultValue: id })}
                            </Badge>
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {s.lastError ? (
                          <Text size="xs" c="red">
                            {s.lastError}
                          </Text>
                        ) : s.lastReportId ? (
                          <Anchor href={apiUrl(`/reports/${s.lastReportId}/download`)} size="xs">
                            {fmtRelative(s.lastRunAt)}
                          </Anchor>
                        ) : (
                          '–'
                        )}
                      </Table.Td>
                      <Table.Td className="nowrap">{s.enabled && s.nextRunAt ? fmtDate(s.nextRunAt) : '–'}</Table.Td>
                      <Table.Td>
                        {s.canEdit && (
                          <Group gap={2} wrap="nowrap" justify="flex-end">
                            <Tooltip label={t('runNow')}>
                              <ActionIcon variant="subtle" loading={running === s.id} onClick={() => runNow(s)} aria-label={t('runNowOf', { name: s.name })}>
                                <IconPlayerPlay size={16} />
                              </ActionIcon>
                            </Tooltip>
                            <ActionIcon variant="subtle" onClick={() => setDraft({ ...s })} aria-label={t('editOf', { name: s.name })}>
                              <IconEdit size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={t('deleteOf', { name: s.name })}
                              onClick={async () => {
                                if (!confirm(t('deleteConfirm', { name: s.name }))) return;
                                await del(`/report-schedules/${s.id}`).catch(notifyError);
                                refresh();
                              }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">
            {t('generatedTitle')}
          </Title>
          {reports.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('noReports')}
            </Text>
          )}
          {reports.length > 0 && (
            <div className="table-scroll">
              <Table fz="sm" highlightOnHover aria-label={t('generatedTitle')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('reports.title')}</Table.Th>
                    <Table.Th>{t('reports.period')}</Table.Th>
                    <Table.Th>{t('reports.created')}</Table.Th>
                    <Table.Th>{t('reports.file')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {reports.slice(0, 200).map((r) => (
                    <Table.Tr key={r.id} bg={r.id === highlight ? 'var(--mantine-primary-color-light)' : undefined}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {r.title}
                        </Text>
                        <Badge size="xs" variant="outline" color="gray">
                          {t(`reports.kind.${r.kind}`, { defaultValue: r.kind })}
                        </Badge>
                      </Table.Td>
                      <Table.Td className="nowrap">{r.from && r.to ? `${fmtDay(r.from)} – ${fmtDay(r.to)}` : '–'}</Table.Td>
                      <Table.Td>
                        {fmtDate(r.createdAt)}
                        <Text size="xs" c="dimmed">
                          {r.createdBy}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Anchor href={apiUrl(`/reports/${r.id}/download`)} size="sm">
                          <Group gap={4} wrap="nowrap">
                            <IconDownload size={14} />
                            {t('reports.download', { size: fmtBytes(r.size) })}
                          </Group>
                        </Anchor>
                        <Text size="xs" c="dimmed" className="mono">
                          sha256 {r.sha256.slice(0, 16)}…
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Card>
      </Stack>
      {draft && (
        <ScheduleModal
          draft={draft}
          sections={schedules.data?.sections ?? BUILTIN}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

type SectionConfig = Record<string, unknown> & {
  monitorIds?: string[] | null;
  processIds?: string[] | null;
  slaTarget?: number | null;
  dueWithinDays?: number;
  types?: string[] | null;
  windowDays?: number;
  sources?: { platformId: string; endpointKeys: string[] | null }[];
};

function ScheduleModal({ draft, sections, onClose, onSaved }: { draft: Draft; sections: string[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['reportSchedules', 'common']);
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const recordTypes = useQuery({ queryKey: ['record-types', false], queryFn: () => get<RecordType[]>('/record-types'), enabled: sections.includes('records') });
  const gatus = useQuery({ queryKey: ['gatus-sources'], queryFn: () => getOptional<GatusMetricsSource[]>('/gatus/sources', []) });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []), retry: false });
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const sec = (id: string) => d.sections[id] as SectionConfig | undefined;
  const setSec = (id: string, v: SectionConfig | undefined) => {
    const next = { ...d.sections };
    if (v) next[id] = v;
    else delete next[id];
    set({ sections: next });
  };
  const defaults: Record<string, SectionConfig> = {
    availability: { monitorIds: null, slaTarget: 99.5 },
    gatus: { sources: (gatus.data ?? []).map((g) => ({ platformId: g.platformId, endpointKeys: null })), slaTarget: 99.5 },
    credentials: { dueWithinDays: 30 },
    runs: { processIds: null },
    records: { types: null, windowDays: 30 },
  };
  const save = async () => {
    setBusy(true);
    try {
      const { id, ...body } = d;
      if (id) await put(`/report-schedules/${id}`, body);
      else await post('/report-schedules', body);
      notifyOk(t('saved'));
      onSaved();
    } catch (e) {
      notifyError(e, t('notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const users = (subjects.data ?? []).filter((s) => s.kind === 'user').map((s) => ({ value: s.value.slice(5), label: s.label }));
  const teams = (subjects.data ?? []).filter((s) => s.kind === 'team').map((s) => ({ value: s.name ?? s.value.slice(5), label: s.name ?? s.value.slice(5) }));

  return (
    <Modal opened onClose={onClose} title={d.id ? t('edit') : t('new')} size="xl">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('form.name')} required value={d.name} onChange={(e) => set({ name: e.currentTarget.value })} />
          <TextInput label={t('form.title')} description={t('form.titleHint')} value={d.title} onChange={(e) => set({ title: e.currentTarget.value })} />
        </SimpleGrid>
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('form.when')}
          </Text>
          <SegmentedControl
            fullWidth
            data={PRESETS.map((p) => ({ value: p, label: t(`presets.${p}`) }))}
            value={d.preset}
            onChange={(v) => set({ preset: v as ReportSchedulePreset })}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {t(`presetHints.${d.preset}`)}
          </Text>
        </div>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          {d.preset === 'custom' && (
            <TextInput label={t('form.cron')} classNames={{ input: 'mono' }} value={d.cron} onChange={(e) => set({ cron: e.currentTarget.value })} />
          )}
          {d.preset === 'custom' && (
            <NumberInput
              label={t('form.periodDays')}
              min={1}
              max={366}
              value={d.periodDays}
              onChange={(v) => set({ periodDays: typeof v === 'number' ? v : 7 })}
            />
          )}
          <TextInput label={t('form.timezone')} value={d.timezone} onChange={(e) => set({ timezone: e.currentTarget.value })} />
          <Select
            label={t('form.lang')}
            allowDeselect={false}
            data={[
              { value: 'en', label: 'English' },
              { value: 'de', label: 'Deutsch' },
            ]}
            value={d.lang}
            onChange={(v) => set({ lang: (v as 'en' | 'de') ?? 'en' })}
          />
          <TextInput label={t('form.classification')} value={d.classification} onChange={(e) => set({ classification: e.currentTarget.value })} />
        </SimpleGrid>

        <Divider label={t('form.sections')} labelPosition="left" />
        <Text size="xs" c="dimmed">
          {t('form.ownerRights')}
        </Text>
        {sections.map((id) => {
          const cfg = sec(id);
          return (
            <Stack key={id} gap={6}>
              <Checkbox
                label={t(`sections.${id}.title`, { defaultValue: id })}
                description={t(`sections.${id}.hint`, { defaultValue: '' }) || undefined}
                checked={!!cfg}
                onChange={(e) => setSec(id, e.currentTarget.checked ? (defaults[id] ?? {}) : undefined)}
              />
              {cfg && id === 'availability' && (
                <SimpleGrid cols={{ base: 1, sm: 2 }} ml="lg">
                  <MultiSelect
                    label={t('form.monitors')}
                    placeholder={t('form.allVisible')}
                    searchable
                    data={(monitors.data ?? []).filter((m) => !m.isTemplate).map((m) => ({ value: m.id, label: m.name }))}
                    value={cfg.monitorIds ?? []}
                    onChange={(v) => setSec(id, { ...cfg, monitorIds: v.length ? v : null })}
                  />
                  <NumberInput
                    label={t('form.slaTarget')}
                    min={0}
                    max={100}
                    decimalScale={3}
                    value={cfg.slaTarget ?? ''}
                    onChange={(v) => setSec(id, { ...cfg, slaTarget: typeof v === 'number' ? v : null })}
                  />
                </SimpleGrid>
              )}
              {cfg && id === 'gatus' && (
                <SimpleGrid cols={{ base: 1, sm: 2 }} ml="lg">
                  <MultiSelect
                    label={t('form.gatusPlatforms')}
                    description={(gatus.data ?? []).length ? undefined : t('form.noGatus')}
                    data={(gatus.data ?? []).map((g) => ({ value: g.platformId, label: g.platformName }))}
                    value={(cfg.sources ?? []).map((x) => x.platformId)}
                    onChange={(v) => setSec(id, { ...cfg, sources: v.map((platformId) => ({ platformId, endpointKeys: null })) })}
                  />
                  <NumberInput
                    label={t('form.slaTarget')}
                    min={0}
                    max={100}
                    decimalScale={3}
                    value={cfg.slaTarget ?? ''}
                    onChange={(v) => setSec(id, { ...cfg, slaTarget: typeof v === 'number' ? v : null })}
                  />
                </SimpleGrid>
              )}
              {cfg && id === 'credentials' && (
                <NumberInput
                  ml="lg"
                  maw={260}
                  label={t('form.dueWithinDays')}
                  min={0}
                  max={365}
                  value={cfg.dueWithinDays ?? 30}
                  onChange={(v) => setSec(id, { ...cfg, dueWithinDays: typeof v === 'number' ? v : 30 })}
                />
              )}
              {cfg && id === 'runs' && (
                <MultiSelect
                  ml="lg"
                  label={t('form.processes')}
                  placeholder={t('form.allVisible')}
                  searchable
                  data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  value={cfg.processIds ?? []}
                  onChange={(v) => setSec(id, { ...cfg, processIds: v.length ? v : null })}
                />
              )}
              {cfg && id === 'records' && (
                <SimpleGrid cols={{ base: 1, sm: 2 }} ml="lg">
                  <MultiSelect
                    label={t('form.recordTypes')}
                    placeholder={t('form.allTypes')}
                    searchable
                    data={(recordTypes.data ?? []).map((x) => ({ value: x.key, label: `${x.key} – ${x.name}` }))}
                    value={cfg.types ?? []}
                    onChange={(v) => setSec(id, { ...cfg, types: v.length ? v : null })}
                  />
                  <NumberInput
                    label={t('form.windowDays')}
                    description={t('form.windowDaysHint')}
                    min={0}
                    max={365}
                    value={cfg.windowDays ?? 30}
                    onChange={(v) => setSec(id, { ...cfg, windowDays: typeof v === 'number' ? v : 30 })}
                  />
                </SimpleGrid>
              )}
            </Stack>
          );
        })}

        <Divider label={t('form.recipients')} labelPosition="left" />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <MultiSelect
            label={t('form.users')}
            searchable
            data={users}
            value={d.recipients.users}
            onChange={(v) => set({ recipients: { ...d.recipients, users: v } })}
          />
          <MultiSelect
            label={t('form.teams')}
            searchable
            data={teams}
            value={d.recipients.teams}
            onChange={(v) => set({ recipients: { ...d.recipients, teams: v } })}
          />
        </SimpleGrid>
        <TagsInput
          label={t('form.emails')}
          description={t('form.emailsHint')}
          maxTags={20}
          value={d.recipients.emails}
          onChange={(v) => set({ recipients: { ...d.recipients, emails: v } })}
        />
        <Switch
          label={t('form.attachPdf')}
          description={t('form.attachPdfHint')}
          checked={d.attachPdf}
          onChange={(e) => set({ attachPdf: e.currentTarget.checked })}
        />
        <Switch label={t('form.enabled')} checked={d.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!d.name.trim() || !Object.keys(d.sections).length}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
