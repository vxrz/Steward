import { useEffect, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Modal, Paper, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconCode, IconDownload, IconFlask, IconHistory, IconInfoCircle, IconLink, IconListCheck, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_CONTRACT_SERVICE_KIND,
  type DataContractDetail,
  type DataContractDiff,
  type DataContractLintFinding,
  type DataContractPreview,
  type DataContractRun,
  type DataContractRunSummary,
  type DataContractVersion,
  type DataContractVersionSummary,
  type Platform,
} from '@sm/shared';
import { apiUrl, del, get, notifyError, notifyOk, post, put } from '../api';
import { DetailState, Hint, JsonView, QueryState } from '../components/common';
import { DetailPage } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { OwningTeams } from '../components/OwningTeams';
import { DataTable } from '../components/DataTable';
import { confirmDanger } from '../components/confirm';
import { UnifiedDiff } from '../components/editor/VersionDiff';
import { dataContractKeys, platformKeys } from '../queryKeys';
import { fmtDate, fmtDuration, fmtRelative } from '../format';
import { ChangeList, ContractYamlEditor, FindingsList, LintList, OdcsStatusBadge, ResultBadge } from '../components/contracts/parts';
import { LinksPanel } from '../components/contracts/links';

const TABS = ['', 'contract', 'versions', 'tests', 'links'] as const;
const TAB_ICONS = { '': IconInfoCircle, contract: IconCode, versions: IconHistory, tests: IconFlask, links: IconLink } as const;

export function DataContractDetailPage() {
  const { t } = useTranslation(['contracts', 'common']);
  const { id, tab: tabParam = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: dataContractKeys.detail(id), queryFn: () => get<DataContractDetail>(`/data-contracts/${id}`) });
  const [testing, setTesting] = useState(false);
  const [serviceLint, setServiceLint] = useState<DataContractLintFinding[] | null>(null);
  const tab = TABS.find((x) => x === tabParam);
  if (tab === undefined) return <Navigate to={`/data-contracts/${id}`} replace />;
  const c = q.data;
  if (!c) return <DetailState query={q} back="dataContracts" />;
  const base = `/data-contracts/${encodeURIComponent(c.id)}`;
  const canEdit = c.permissions.includes('edit');
  const canTest = c.permissions.includes('test');
  const refresh = () => void qc.invalidateQueries({ queryKey: dataContractKeys.all });
  const test = async () => {
    setTesting(true);
    try {
      const run = await post<DataContractRun>(`${base}/test`, {});
      refresh();
      navigate(`${base}/tests?run=${encodeURIComponent(run.id)}`);
    } catch (e) {
      notifyError(e, t('tests.notRun'));
    } finally {
      setTesting(false);
    }
  };
  const lintService = async () => {
    try {
      setServiceLint((await post<{ findings: DataContractLintFinding[] }>(`${base}/service-lint`, {})).findings);
    } catch (e) {
      notifyError(e, t('lint.serviceFailed'));
    }
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('detail.deleteConfirm', { name: c.name }) }))) return;
    try {
      await del(base);
      refresh();
      navigate('/data-contracts');
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <DetailPage
      back="dataContracts"
      title={c.name}
      status={
        <>
          <OdcsStatusBadge status={c.status} />
          <ResultBadge result={c.lastRun?.result} />
        </>
      }
      description={t('detail.line', { key: c.key, version: c.version || '–', n: c.currentVersion, user: c.updatedBy, date: fmtDate(c.updatedAt) })}
      recent={{ label: c.name, kind: 'contract', to: base }}
      actions={
        canTest && (
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={14} />}
            onClick={() => void test()}
            loading={testing}
            disabled={!c.servicePlatformId}
            data-testid="contract-test"
          >
            {t('detail.testNow')}
          </Button>
        )
      }
      menu={{
        items: [
          { label: t('detail.export'), icon: IconDownload, onClick: () => window.open(apiUrl(`${base}/export`), '_blank', 'noopener') },
          ...(c.servicePlatformId
            ? [{ label: t('detail.serviceLint'), icon: IconListCheck, onClick: () => void lintService(), testId: 'contract-service-lint' }]
            : []),
          ...(canEdit ? [{ label: t('common:delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'contract-delete' }] : []),
        ],
      }}
      tabs={
        <LinkTabs
          label={t('detail.tabs.label')}
          active={tab ? `${base}/${tab}` : base}
          tabs={TABS.map((x) => ({
            to: x ? `${base}/${x}` : base,
            label: t(`detail.tabs.${x || 'overview'}`),
            icon: TAB_ICONS[x],
            count: x === 'links' ? c.linkCount : undefined,
            testId: `contract-tab-${x || 'overview'}`,
          }))}
        />
      }
    >
      {serviceLint && (
        <Modal opened onClose={() => setServiceLint(null)} title={t('lint.serviceTitle')} size="lg">
          <LintList findings={serviceLint} />
        </Modal>
      )}
      {tab === '' && <Overview c={c} canEdit={canEdit} />}
      {tab === 'contract' && <ContractTab c={c} canEdit={canEdit} />}
      {tab === 'versions' && <VersionsTab c={c} />}
      {tab === 'tests' && <TestsTab c={c} />}
      {tab === 'links' && <LinksPanel c={c} canEdit={canEdit} />}
    </DetailPage>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ overflowWrap: 'anywhere' }} component="div">
        {children}
      </Text>
    </div>
  );
}

function Overview({ c, canEdit }: { c: DataContractDetail; canEdit: boolean }) {
  const { t } = useTranslation('contracts');
  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          <Paper withBorder p="md">
            <Text fw={600} size="sm" mb="sm">
              {t('findings.title')}
            </Text>
            <FindingsList findings={c.findingList} />
          </Paper>
          <Paper withBorder p="md">
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
              <Fact label={t('facts.key')}>
                <span className="mono">{c.facts.key}</span>
              </Fact>
              <Fact label={t('facts.version')}>
                {c.facts.version || '–'} · {t('facts.saved', { n: c.currentVersion })}
              </Fact>
              <Fact label={t('facts.apiVersion')}>{c.facts.apiVersion}</Fact>
              <Fact label={t('facts.domain')}>{c.facts.domain ?? '–'}</Fact>
              <Fact label={t('facts.team')}>{c.facts.team.join(', ') || '–'}</Fact>
              <Fact label={t('facts.lint')}>{c.lintErrors ? t('facts.lintErrors', { count: c.lintErrors }) : t('lint.ok')}</Fact>
            </SimpleGrid>
            <Text fw={600} size="sm" mt="md" mb={4}>
              {t('facts.schemas')}
            </Text>
            {c.facts.schemas.length ? (
              <Stack gap={4}>
                {c.facts.schemas.map((s) => (
                  <Text key={s.name} size="sm" style={{ overflowWrap: 'anywhere' }}>
                    <Text span fw={500} className="mono">
                      {s.name}
                    </Text>
                    {s.physicalName && s.physicalName !== s.name ? ` (${s.physicalName})` : ''} – {t('facts.fields', { count: s.properties.length })}
                  </Text>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                –
              </Text>
            )}
            <Text fw={600} size="sm" mt="md" mb={4}>
              {t('facts.servers')}
            </Text>
            <Group gap={6}>
              {c.facts.servers.length
                ? c.facts.servers.map((s) => (
                    <Badge key={s.server} variant="light" style={{ textTransform: 'none' }}>
                      {s.server} · {s.type}
                    </Badge>
                  ))
                : '–'}
            </Group>
          </Paper>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap="md">
          <SettingsCard c={c} canEdit={canEdit} />
          <OwningTeams kind="contract" id={c.id} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/** Where the tests run: the service, the server, and whether breaking changes need a change record. */
function SettingsCard({ c, canEdit }: { c: DataContractDetail; canEdit: boolean }) {
  const { t } = useTranslation(['contracts', 'common']);
  const qc = useQueryClient();
  const platforms = useQuery({
    queryKey: platformKeys.ofKind(DATA_CONTRACT_SERVICE_KIND),
    queryFn: async () => (await get<Platform[]>('/platforms')).filter((p) => p.kind === DATA_CONTRACT_SERVICE_KIND),
  });
  const [service, setService] = useState<string | null>(c.servicePlatformId);
  const [server, setServer] = useState<string | null>(c.testServer);
  const [needsRecord, setNeedsRecord] = useState(c.requireChangeRecord);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setService(c.servicePlatformId);
    setServer(c.testServer);
    setNeedsRecord(c.requireChangeRecord);
  }, [c.servicePlatformId, c.testServer, c.requireChangeRecord]);
  const dirty = service !== c.servicePlatformId || server !== c.testServer || needsRecord !== c.requireChangeRecord;
  const save = async () => {
    setBusy(true);
    try {
      await put(`/data-contracts/${c.id}/settings`, { servicePlatformId: service, testServer: server, requireChangeRecord: needsRecord });
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e, t('settings.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const usable = (platforms.data ?? []).filter((p) => p.permissions.includes('use') || p.id === c.servicePlatformId);
  // switching the rule off is for who approves changes (the "manage" right): others can only switch it on – and who
  // has only that right (an approver) can only switch it off
  const canManage = c.permissions.includes('manage');
  const locked = c.requireChangeRecord && !canManage;
  const canSwitch = canEdit ? !locked : canManage && c.requireChangeRecord;
  return (
    <Paper withBorder p="md" data-testid="contract-settings">
      <Text fw={600} size="sm" mb="sm">
        {t('settings.title')}
      </Text>
      <Stack gap="sm">
        <Select
          label={t('settings.service')}
          description={t('settings.serviceHint')}
          data={usable.map((p) => ({ value: p.id, label: p.name }))}
          value={service}
          onChange={setService}
          clearable
          disabled={!canEdit}
          placeholder={c.servicePlatformId === null && c.serviceName === null ? t('settings.noService') : undefined}
          nothingFoundMessage={t('settings.noServicePlatform')}
          data-testid="contract-service"
        />
        <Select
          label={t('settings.server')}
          description={t('settings.serverHint')}
          data={c.facts.servers.map((s) => ({ value: s.server, label: `${s.server} (${s.type})` }))}
          value={server}
          onChange={setServer}
          clearable
          disabled={!canEdit}
          placeholder={c.facts.servers.length === 1 ? t('settings.onlyServer', { server: c.facts.servers[0]!.server }) : undefined}
        />
        <Switch
          label={t('settings.requireChangeRecord')}
          description={locked ? t('settings.requireChangeRecordLocked') : t('settings.requireChangeRecordHint')}
          checked={needsRecord}
          onChange={(e) => setNeedsRecord(e.currentTarget.checked)}
          disabled={!canSwitch}
          data-testid="contract-require-change-record"
        />
        {(canEdit || canSwitch) && (
          <Group>
            <Button size="xs" onClick={() => void save()} loading={busy} disabled={!dirty}>
              {t('common:save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function ContractTab({ c, canEdit }: { c: DataContractDetail; canEdit: boolean }) {
  const { t } = useTranslation(['contracts', 'common']);
  const qc = useQueryClient();
  const [yaml, setYaml] = useState(c.yaml);
  const [note, setNote] = useState('');
  const [record, setRecord] = useState('');
  const [preview, setPreview] = useState<DataContractPreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setYaml(c.yaml), [c.yaml]);
  const changed = yaml !== c.yaml;
  const save = async () => {
    setBusy(true);
    try {
      const r = await post<{ created: boolean; diff: DataContractDiff | null }>(`/data-contracts/${c.id}/versions`, {
        yaml,
        note,
        ...(record.trim() ? { changeRecordId: record.trim() } : {}),
      });
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
      setNote('');
      setRecord('');
      notifyOk(r.created ? t('editor.saved', { n: c.currentVersion + 1 }) : t('editor.unchanged'));
    } catch (e) {
      notifyError(e, t('editor.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit)
    return (
      <Stack gap="sm">
        <Hint>{t('editor.readOnly')}</Hint>
        <ContractYamlEditor value={c.yaml} onChange={() => undefined} readOnly contractId={c.id} name={c.name} currentVersion={c.currentVersion} />
      </Stack>
    );
  return (
    <Stack gap="md" maw={1100}>
      <ContractYamlEditor value={yaml} onChange={setYaml} contractId={c.id} name={c.name} currentVersion={c.currentVersion} onPreview={setPreview} />
      {changed && (
        <Paper withBorder p="md">
          <Stack gap="sm">
            <TextInput label={t('editor.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
            {(preview?.needsChangeRecord || c.requireChangeRecord) && (
              <TextInput
                label={t('editor.changeRecord')}
                description={preview?.needsChangeRecord ? t('editor.changeRecordNeeded') : t('editor.changeRecordHint')}
                placeholder="CR-12"
                value={record}
                onChange={(e) => setRecord(e.currentTarget.value)}
                required={!!preview?.needsChangeRecord}
                data-testid="contract-change-record"
              />
            )}
            <Group>
              <Button
                onClick={() => void save()}
                loading={busy}
                disabled={!preview?.facts || (preview.needsChangeRecord && !record.trim())}
                data-testid="contract-save"
              >
                {t('editor.save', { n: c.currentVersion + 1 })}
              </Button>
              <Button variant="default" onClick={() => setYaml(c.yaml)}>
                {t('editor.discard')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

function VersionsTab({ c }: { c: DataContractDetail }) {
  const { t } = useTranslation(['contracts', 'common']);
  const versions = useQuery({
    queryKey: dataContractKeys.versions(c.id),
    queryFn: () => get<DataContractVersionSummary[]>(`/data-contracts/${c.id}/versions`),
  });
  const list = versions.data ?? [];
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const a = Number(from ?? Math.max(1, c.currentVersion - 1));
  const b = Number(to ?? c.currentVersion);
  const cmp = useQuery({
    queryKey: dataContractKeys.compare(c.id, a, b),
    queryFn: () => get<DataContractDiff>(`/data-contracts/${c.id}/compare?from=${a}&to=${b}`),
    enabled: list.length > 1 && a !== b,
  });
  const va = useQuery({
    queryKey: dataContractKeys.version(c.id, a),
    queryFn: () => get<DataContractVersion>(`/data-contracts/${c.id}/versions/${a}`),
    enabled: list.length > 1,
  });
  const vb = useQuery({
    queryKey: dataContractKeys.version(c.id, b),
    queryFn: () => get<DataContractVersion>(`/data-contracts/${c.id}/versions/${b}`),
    enabled: list.length > 1,
  });
  const options = list.map((v) => ({ value: String(v.version), label: `v${v.version} · ${v.odcsVersion || '–'} · ${fmtDate(v.createdAt)}` }));
  return (
    <Stack gap="md">
      <QueryState query={versions} />
      {list.length > 0 && (
        <DataTable
          testId="contract-versions"
          ariaLabel={t('versions.title')}
          rows={list}
          rowKey={(v) => String(v.version)}
          columns={[
            {
              key: 'version',
              header: t('versions.version'),
              nowrap: true,
              sortValue: (v) => v.version,
              cell: (v) => (
                <Text size="sm" fw={500}>
                  v{v.version}
                </Text>
              ),
            },
            { key: 'odcs', header: t('versions.odcsVersion'), nowrap: true, cell: (v) => v.odcsVersion || '–' },
            { key: 'status', header: t('versions.status'), nowrap: true, cell: (v) => <OdcsStatusBadge status={v.status} /> },
            {
              key: 'changes',
              header: t('versions.changes'),
              nowrap: true,
              cell: (v) =>
                v.version === 1 ? (
                  t('versions.first')
                ) : (
                  <Group gap={4} wrap="nowrap">
                    <Text size="sm">{v.changes}</Text>
                    {v.breaking > 0 && (
                      <Badge color="red" variant="light" size="xs">
                        {t('versions.breaking', { count: v.breaking })}
                      </Badge>
                    )}
                  </Group>
                ),
            },
            {
              key: 'record',
              header: t('versions.changeRecord'),
              cell: (v) =>
                v.changeRecord ? (
                  <Anchor component={Link} to={`/records/${v.changeRecord.id}`} size="sm">
                    {v.changeRecord.number}
                  </Anchor>
                ) : (
                  '–'
                ),
            },
            { key: 'saved', header: t('versions.saved'), nowrap: true, sortValue: (v) => v.createdAt, cell: (v) => `${fmtDate(v.createdAt)} · ${v.createdBy}` },
            { key: 'note', header: t('versions.note'), cell: (v) => v.note || '–' },
            {
              key: 'export',
              header: <span className="visually-hidden">{t('detail.export')}</span>,
              label: t('detail.export'),
              cell: (v) => (
                <Anchor href={apiUrl(`/data-contracts/${c.id}/export?version=${v.version}`)} size="sm" aria-label={t('versions.exportOne', { n: v.version })}>
                  <IconDownload size={16} aria-hidden />
                </Anchor>
              ),
            },
          ]}
          card={(v) => (
            <Stack gap={4}>
              <Group gap={6}>
                <Text fw={600}>v{v.version}</Text>
                <OdcsStatusBadge status={v.status} />
                {v.breaking > 0 && (
                  <Badge color="red" variant="light" size="xs">
                    {t('versions.breaking', { count: v.breaking })}
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed">
                {v.odcsVersion || '–'} · {fmtDate(v.createdAt)} · {v.createdBy}
              </Text>
              {v.note && <Text size="sm">{v.note}</Text>}
            </Stack>
          )}
        />
      )}
      {list.length > 1 && (
        <Paper withBorder p="md" data-testid="contract-compare">
          <Text fw={600} size="sm" mb="sm">
            {t('versions.compare')}
          </Text>
          <Group gap="sm" mb="md" wrap="wrap">
            <Select label={t('versions.from')} data={options} value={String(a)} onChange={setFrom} allowDeselect={false} w={{ base: '100%', xs: 260 }} />
            <Select label={t('versions.to')} data={options} value={String(b)} onChange={setTo} allowDeselect={false} w={{ base: '100%', xs: 260 }} />
          </Group>
          {a === b ? (
            <Text size="sm" c="dimmed">
              {t('versions.same')}
            </Text>
          ) : (
            cmp.data && (
              <Stack gap="md">
                <ChangeList diff={cmp.data} name={c.name} from={a} to={b} />
                {va.data && vb.data && <UnifiedDiff oldText={va.data.yaml} newText={vb.data.yaml} oldName={`v${a}`} newName={`v${b}`} context={3} />}
              </Stack>
            )
          )}
        </Paper>
      )}
    </Stack>
  );
}

const VIA_KEYS = { ui: 'ui', monitor: 'monitor', process: 'process' } as const;

function TestsTab({ c }: { c: DataContractDetail }) {
  const { t } = useTranslation(['contracts', 'common']);
  const runs = useQuery({ queryKey: dataContractKeys.runs(c.id), queryFn: () => get<DataContractRunSummary[]>(`/data-contracts/${c.id}/runs`) });
  const [params, setParams] = useSearchParams();
  const open = params.get('run');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('run', id);
    else next.delete('run');
    setParams(next, { replace: true });
  };
  const list = runs.data ?? [];
  return (
    <Stack gap="md">
      {!c.servicePlatformId && <Hint>{t('tests.noService')}</Hint>}
      <QueryState query={runs} />
      {runs.isSuccess && !list.length && (
        <Text size="sm" c="dimmed">
          {t('tests.none')}
        </Text>
      )}
      {list.length > 0 && (
        <DataTable
          testId="contract-runs"
          ariaLabel={t('tests.title')}
          rows={list}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpen(r.id)}
          columns={[
            {
              key: 'result',
              header: t('tests.result'),
              nowrap: true,
              cell: (r) => (
                <Group gap={4} wrap="nowrap">
                  <ResultBadge result={r.result} size="xs" />
                  {r.dryRun && (
                    <Badge size="xs" color="yellow" variant="light">
                      {t('tests.dryRun')}
                    </Badge>
                  )}
                </Group>
              ),
            },
            {
              key: 'when',
              header: t('tests.when'),
              nowrap: true,
              sortValue: (r) => r.startedAt,
              cell: (r) => (
                <Anchor
                  component="button"
                  size="sm"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    setOpen(r.id);
                  }}
                  title={fmtDate(r.startedAt)}
                >
                  {fmtRelative(r.startedAt)}
                </Anchor>
              ),
            },
            { key: 'via', header: t('tests.via'), nowrap: true, cell: (r) => t(`tests.vias.${VIA_KEYS[r.via]}`) },
            { key: 'server', header: t('tests.server'), nowrap: true, cell: (r) => `${r.server ?? '–'} · v${r.version}` },
            { key: 'checks', header: t('tests.checks'), nowrap: true, cell: (r) => t('tests.checkCounts', { passed: r.checks.passed, total: r.checks.total }) },
            {
              key: 'headline',
              header: t('tests.headline'),
              cell: (r) => (
                <Text size="sm" lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
                  {r.headline}
                </Text>
              ),
            },
            { key: 'actor', header: t('tests.actor'), nowrap: true, cell: (r) => r.actor },
          ]}
          card={(r) => (
            <Stack gap={4}>
              <Group gap={6}>
                <ResultBadge result={r.result} size="xs" />
                <Text size="sm">{fmtRelative(r.startedAt)}</Text>
              </Group>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {r.headline}
              </Text>
              <Text size="xs" c="dimmed">
                {t(`tests.vias.${VIA_KEYS[r.via]}`)} · {r.actor}
              </Text>
            </Stack>
          )}
        />
      )}
      {open && <RunModal contractId={c.id} runId={open} onClose={() => setOpen(null)} />}
    </Stack>
  );
}

interface ReportCheck {
  name?: string;
  type?: string;
  model?: string;
  field?: string;
  result?: string;
  reason?: string;
}

function RunModal({ contractId, runId, onClose }: { contractId: string; runId: string; onClose: () => void }) {
  const { t } = useTranslation(['contracts', 'common']);
  const q = useQuery({ queryKey: dataContractKeys.run(contractId, runId), queryFn: () => get<DataContractRun>(`/data-contracts/${contractId}/runs/${runId}`) });
  const r = q.data;
  // the checks that did not pass first
  const checks = ((r?.report as { checks?: ReportCheck[] } | null)?.checks ?? [])
    .filter((x) => x && typeof x === 'object')
    .sort((a, b) => Number(a.result === 'passed') - Number(b.result === 'passed'));
  return (
    <Modal opened onClose={onClose} title={t('tests.runTitle')} size="xl" data-testid="contract-run">
      <QueryState query={q} />
      {r && (
        <Stack gap="md">
          <Group gap="sm" wrap="wrap">
            <ResultBadge result={r.result} />
            <Text size="sm">
              {fmtDate(r.startedAt)} · {fmtDuration(r.durationMs)} · {r.server ?? '–'} · v{r.version}
            </Text>
          </Group>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {r.headline}
          </Text>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {t('tests.evidence', { sha: r.reportSha256, service: r.service?.name ?? '–', actor: r.actor })}
            {r.truncated ? ` ${t('tests.truncated')}` : ''}
          </Text>
          {checks.length > 0 && (
            <div className="table-scroll">
              <Table fz="sm" aria-label={t('tests.checksTitle')} data-testid="contract-run-checks">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('tests.result')}</Table.Th>
                    <Table.Th>{t('tests.check')}</Table.Th>
                    <Table.Th>{t('tests.reason')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {checks.map((x, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        <ResultBadge result={(['passed', 'warning', 'failed', 'error'] as const).find((k) => k === x.result) ?? 'warning'} size="xs" />
                      </Table.Td>
                      <Table.Td style={{ overflowWrap: 'anywhere' }}>
                        {x.name ?? x.type}
                        {(x.model || x.field) && (
                          <Text size="xs" c="dimmed" className="mono">
                            {[x.model, x.field].filter(Boolean).join('.')}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td style={{ overflowWrap: 'anywhere' }}>{x.reason ?? '–'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
          <details>
            <summary>
              <Text span size="sm">
                {t('tests.fullReport')}
              </Text>
            </summary>
            <JsonView value={r.report} maxHeight={420} />
          </details>
        </Stack>
      )}
    </Modal>
  );
}
