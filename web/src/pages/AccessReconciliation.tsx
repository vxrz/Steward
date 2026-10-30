import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  CloseButton,
  Code,
  Group,
  Modal,
  MultiSelect,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconArrowsDiff, IconEdit, IconFlask, IconPlayerPlay, IconPlus, IconShieldCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  GIT_PLATFORM_KINDS,
  type AccessCheck,
  type AccessFinding,
  type AccessReconciliationMeta,
  type AccessSnapshotSummary,
  type ImportedHistoryRef,
  type Platform,
  type Subject,
} from '@sm/shared';
import { get, getOptional, notifyError, notifyOk, post, put } from '../api';
import { EmptyState, PageHeader, QueryState, TONE, subjectLabel, useCreateParam } from '../components/common';
import { FindingStatusBadge, KindBadge, RightsDiff } from '../components/compliance/common';
import { fmtDate, fmtRelative } from '../format';
import { localNow } from './AccessChanges';
import { useMe } from '../auth';

/** Compliance → Access reconciliation: who has which access (snapshots) compared with the documented access changes. */
export function AccessReconciliationPage() {
  const { t } = useTranslation(['compliance', 'common']);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<AccessCheck | 'new' | null>(null);
  const meta = useQuery({ queryKey: ['reconciliation-meta'], queryFn: () => get<AccessReconciliationMeta>('/compliance/reconciliation/meta') });
  const checks = useQuery({ queryKey: ['access-checks'], queryFn: () => get<AccessCheck[]>('/compliance/access-checks') });
  useCreateParam(meta.data?.canCreate, () => setEditing('new'));
  const all = checks.data ?? [];
  // ?findings=open (the start page's "Undocumented access changes" tile): only checks with open findings
  const onlyOpen = params.get('findings') === 'open';
  const list = onlyOpen ? all.filter((c) => c.openFindings > 0) : all;
  const selectedId = params.get('check') ?? list[0]?.id ?? null;
  const selected = list.find((c) => c.id === selectedId) ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('check', id);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('reconciliation.title')}
        description={t('reconciliation.description')}
        actions={
          meta.data?.canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
              {t('reconciliation.new')}
            </Button>
          )
        }
      />
      <QueryState query={checks} />
      {onlyOpen && (
        <Group gap={6} mb="sm">
          <Badge
            variant="light"
            tt="none"
            data-testid="filter-open-findings"
            rightSection={
              <CloseButton
                size="xs"
                aria-label={t('reconciliation.showAllChecks')}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete('findings');
                  setParams(next, { replace: true });
                }}
              />
            }
          >
            {t('reconciliation.onlyOpen')}
          </Badge>
        </Group>
      )}
      {checks.isSuccess && onlyOpen && all.length > 0 && list.length === 0 && (
        <EmptyState compact icon={IconShieldCheck} title={t('reconciliation.noOpenTitle')}>
          {t('reconciliation.noOpenAnywhere')}
        </EmptyState>
      )}
      {checks.isSuccess && all.length === 0 && (
        <EmptyState
          icon={IconArrowsDiff}
          title={t('reconciliation.emptyTitle')}
          action={
            meta.data?.canCreate && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
                {t('reconciliation.new')}
              </Button>
            )
          }
        >
          {t('reconciliation.emptyText')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mb="md" role="list" aria-label={t('reconciliation.checks')}>
          {list.map((c) => (
            <Paper
              key={c.id}
              withBorder
              p="sm"
              role="listitem"
              style={c.id === selectedId ? { borderColor: 'var(--mantine-primary-color-filled)', borderWidth: 2 } : undefined}
            >
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Anchor
                  component={Link}
                  to={`/compliance/reconciliation?check=${encodeURIComponent(c.id)}`}
                  onClick={() => select(c.id)}
                  fw={600}
                  size="sm"
                  aria-current={c.id === selectedId ? 'true' : undefined}
                >
                  {c.name}
                </Anchor>
                <CheckStatusBadge c={c} />
              </Group>
              <Text size="xs" c="dimmed">
                {c.platformName ?? c.platformId} · {t(`sources.${c.source}`)}
                {c.datasetKey || c.scope ? ` (${c.datasetKey ?? c.scope})` : ''}
              </Text>
              <Text size="xs" c="dimmed">
                {c.lastRunAt ? t('reconciliation.lastRun', { when: fmtRelative(c.lastRunAt) }) : t('reconciliation.neverRun')}
                {!c.enabled && ` · ${t('reconciliation.disabled')}`}
              </Text>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {selected && <CheckDetail key={selected.id} check={selected} demo={!!meta.data?.demo} onEdit={() => setEditing(selected)} />}
      {editing && <CheckModal check={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(c) => select(c.id)} />}
    </>
  );
}

function CheckStatusBadge({ c }: { c: AccessCheck }) {
  const { t } = useTranslation('compliance');
  if (c.openFindings > 0)
    return (
      <Badge color={TONE.attention} variant="filled" size="sm">
        {t('reconciliation.openCount', { count: c.openFindings })}
      </Badge>
    );
  if (c.lastStatus === 'failed')
    return (
      <Badge color={TONE.bad} variant="light" size="sm">
        {t('reconciliation.failed')}
      </Badge>
    );
  if (!c.lastRunAt)
    return (
      <Badge color={TONE.neutral} variant="light" size="sm">
        {t('reconciliation.noSnapshot')}
      </Badge>
    );
  return (
    <Badge color={TONE.ok} variant="light" size="sm">
      {t('reconciliation.allDocumented')}
    </Badge>
  );
}

function CheckDetail({ check, demo, onEdit }: { check: AccessCheck; demo: boolean; onEdit: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const qc = useQueryClient();
  const [tab, setTab] = useState<string | null>('open');
  const [running, setRunning] = useState(false);
  const [documenting, setDocumenting] = useState<AccessFinding | null>(null);
  const [dismissing, setDismissing] = useState<AccessFinding | null>(null);
  const findings = useQuery({
    queryKey: ['access-findings', check.id],
    queryFn: () => get<AccessFinding[]>(`/compliance/findings?checkId=${encodeURIComponent(check.id)}`),
  });
  const snapshots = useQuery({
    queryKey: ['access-snapshots', check.id],
    queryFn: () => get<AccessSnapshotSummary[]>(`/compliance/access-checks/${check.id}/snapshots?limit=200`),
    enabled: tab === 'snapshots',
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['access-findings', check.id] });
    await qc.invalidateQueries({ queryKey: ['access-snapshots', check.id] });
    await qc.invalidateQueries({ queryKey: ['access-checks'] });
  };
  const run = async (simulate = false) => {
    setRunning(true);
    try {
      const r = simulate
        ? await post<{ granted: { userName: string; role: string }; result: { findings: AccessFinding[] } | null }>('/compliance/demo/simulate-change', {
            accessCheckId: check.id,
          })
        : { result: await post<{ findings: AccessFinding[]; baseline: boolean }>(`/compliance/access-checks/${check.id}/run`, {}) };
      const n = r.result?.findings.length ?? 0;
      notifyOk(n ? t('reconciliation.foundUndocumented', { count: n }) : t('reconciliation.nothingUndocumented'));
      setTab('open');
      await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setRunning(false);
    }
  };
  const all = findings.data ?? [];
  const open = all.filter((f) => f.status === 'open');
  return (
    <Paper withBorder p="md">
      <Group justify="space-between" align="flex-start" mb="sm" wrap="wrap">
        <Box style={{ minWidth: 0 }}>
          <Text fw={700}>{check.name}</Text>
          {check.description && (
            <Text size="sm" c="dimmed">
              {check.description}
            </Text>
          )}
          <Text size="xs" c="dimmed" mt={2}>
            {t('reconciliation.schedule')}: <Code>{check.cron}</Code> ({check.timezone}) · {t('reconciliation.owner')}: {check.owner}
          </Text>
          {check.lastError && (
            <Text size="xs" c="red" mt={2}>
              {check.lastError}
            </Text>
          )}
        </Box>
        <Group gap="xs">
          {check.canRun && (
            <Button size="xs" leftSection={<IconPlayerPlay size={14} />} loading={running} onClick={() => run(false)}>
              {t('reconciliation.runNow')}
            </Button>
          )}
          {demo && check.canRun && check.source === 'insights-hub' && (
            <Button size="xs" variant="light" color="orange" leftSection={<IconFlask size={14} />} loading={running} onClick={() => run(true)}>
              {t('reconciliation.simulate')}
            </Button>
          )}
          {check.canEdit && (
            <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={onEdit}>
              {t('common:edit')}
            </Button>
          )}
        </Group>
      </Group>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="open">{t('reconciliation.tabOpen', { count: open.length })}</Tabs.Tab>
          <Tabs.Tab value="all">{t('reconciliation.tabAll')}</Tabs.Tab>
          <Tabs.Tab value="snapshots">{t('reconciliation.tabSnapshots')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="open" pt="sm">
          <QueryState query={findings} />
          {findings.isSuccess && open.length === 0 && (
            <EmptyState compact icon={IconShieldCheck} title={t('reconciliation.noOpenTitle')}>
              {t('reconciliation.noOpenText')}
            </EmptyState>
          )}
          {open.length > 0 && <FindingsTable rows={open} onDocument={setDocumenting} onDismiss={setDismissing} />}
        </Tabs.Panel>
        <Tabs.Panel value="all" pt="sm">
          {all.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('reconciliation.noFindings')}
            </Text>
          ) : (
            <FindingsTable rows={all} onDocument={setDocumenting} onDismiss={setDismissing} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="snapshots" pt="sm">
          <SnapshotsPanel check={check} query={snapshots} />
        </Tabs.Panel>
      </Tabs>
      {documenting && <DocumentModal finding={documenting} onClose={() => setDocumenting(null)} onDone={refresh} />}
      {dismissing && <DismissModal finding={dismissing} onClose={() => setDismissing(null)} onDone={refresh} />}
    </Paper>
  );
}

function FindingsTable({
  rows,
  onDocument,
  onDismiss,
}: {
  rows: AccessFinding[];
  onDocument: (f: AccessFinding) => void;
  onDismiss: (f: AccessFinding) => void;
}) {
  const { t } = useTranslation('compliance');
  return (
    <div className="table-scroll">
      <Table fz="sm" aria-label={t('reconciliation.findings')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('reconciliation.subject')}</Table.Th>
            <Table.Th>{t('reconciliation.change')}</Table.Th>
            <Table.Th>{t('reconciliation.between')}</Table.Th>
            <Table.Th>{t('reconciliation.status')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td>
                <Text size="sm">{f.subjectName || f.subjectId}</Text>
                {f.subjectName && (
                  <Text size="xs" c="dimmed" className="mono">
                    {f.subjectId}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap={4} mb={2}>
                  <KindBadge kind={f.kind} />
                </Group>
                <RightsDiff granted={f.granted} revoked={f.revoked} />
              </Table.Td>
              <Table.Td>
                <Text size="xs">
                  {fmtDate(f.windowFrom)} – {fmtDate(f.windowTo)}
                </Text>
              </Table.Td>
              <Table.Td>
                <FindingStatusBadge status={f.status} />
                {f.recordId && (
                  <Anchor component={Link} to={`/records/${f.recordId}`} size="xs" ml={6} className="mono">
                    {f.recordNumber}
                  </Anchor>
                )}
                {f.status === 'dismissed' && f.comment && (
                  <Text size="xs" c="dimmed">
                    {f.comment}
                  </Text>
                )}
                {f.status === 'open' && f.dismissRequestedBy && (
                  <Text size="xs" c="dimmed">
                    {t('reconciliation.dismissRequested', { user: f.dismissRequestedBy, reason: f.comment })}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  {f.canDocument && (
                    <Button size="xs" onClick={() => onDocument(f)} aria-label={t('reconciliation.documentFor', { subject: f.subjectName || f.subjectId })}>
                      {t('reconciliation.document')}
                    </Button>
                  )}
                  {f.canDismiss && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => onDismiss(f)}
                      aria-label={t(f.dismissRequestedBy ? 'reconciliation.confirmDismissFor' : 'reconciliation.dismissFor', {
                        subject: f.subjectName || f.subjectId,
                      })}
                    >
                      {t(f.dismissRequestedBy ? 'reconciliation.confirmDismiss' : 'reconciliation.dismiss')}
                    </Button>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function SnapshotsPanel({
  check,
  query,
}: {
  check: AccessCheck;
  query: { data?: AccessSnapshotSummary[]; isLoading: boolean; error: unknown; refetch: () => unknown };
}) {
  const { t } = useTranslation('compliance');
  const [result, setResult] = useState<{ ok: boolean; checked: number; problems: string[]; importedHistory?: ImportedHistoryRef } | null>(null);
  const verify = async () => {
    try {
      setResult(await get(`/compliance/access-checks/${check.id}/verify`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          {t('reconciliation.snapshotsHelp')}
        </Text>
        <Button size="xs" variant="default" leftSection={<IconShieldCheck size={14} />} onClick={verify}>
          {t('reconciliation.verifyChain')}
        </Button>
      </Group>
      {result && (
        <Alert color={result.ok ? 'green' : 'red'} title={result.ok ? t('reconciliation.chainOk', { count: result.checked }) : t('reconciliation.chainBroken')}>
          {result.problems.map((p) => (
            <Text key={p} size="sm">
              {p}
            </Text>
          ))}
          {result.importedHistory && (
            <Text size="sm" data-testid="chain-imported-history">
              {t('reconciliation.importedHistory', { fingerprint: result.importedHistory.sourceFingerprint })}
            </Text>
          )}
        </Alert>
      )}
      <QueryState query={query} />
      {query.data && (
        <div className="table-scroll">
          <Table fz="xs" aria-label={t('reconciliation.tabSnapshots')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('reconciliation.takenAt')}</Table.Th>
                <Table.Th>{t('reconciliation.subjects')}</Table.Th>
                <Table.Th>{t('reconciliation.assignments')}</Table.Th>
                <Table.Th>{t('reconciliation.findings')}</Table.Th>
                <Table.Th>{t('reconciliation.chainHash')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {query.data.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    {fmtDate(s.takenAt)}
                    {s.sameAs && (
                      <Badge size="xs" variant="default" ml={4}>
                        {t('reconciliation.unchanged')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{s.subjects}</Table.Td>
                  <Table.Td>{s.assignments}</Table.Td>
                  <Table.Td>{s.findings}</Table.Td>
                  <Table.Td className="mono" title={s.chainHash}>
                    {s.chainHash.slice(0, 16)}…
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

function DocumentModal({ finding, onClose, onDone }: { finding: AccessFinding; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation(['compliance', 'common']);
  const [reason, setReason] = useState('');
  const [requestRef, setRequestRef] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [performedAt, setPerformedAt] = useState(localNow(new Date(finding.windowTo)));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<AccessFinding>(`/compliance/findings/${finding.id}/document`, {
        reason: reason.trim(),
        requestRef: requestRef.trim() || undefined,
        approvedBy: approvedBy.trim() || undefined,
        performedBy: performedBy.trim() || undefined,
        performedAt: performedAt ? new Date(performedAt).toISOString() : undefined,
      });
      notifyOk(t('reconciliation.documented', { number: r.recordNumber ?? '' }));
      await onDone();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('reconciliation.documentTitle', { subject: finding.subjectName || finding.subjectId })} size="lg">
      <Stack gap="sm">
        <Text size="sm">{t('reconciliation.documentHelp')}</Text>
        <Paper withBorder p="xs">
          <Group gap="xs">
            <KindBadge kind={finding.kind} />
            <RightsDiff granted={finding.granted} revoked={finding.revoked} />
          </Group>
        </Paper>
        <Textarea
          label={t('accessChanges.reason')}
          required
          autosize
          minRows={2}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          maxLength={4000}
          data-autofocus
        />
        <Group grow wrap="wrap">
          <TextInput label={t('accessChanges.requestRef')} value={requestRef} onChange={(e) => setRequestRef(e.currentTarget.value)} maxLength={500} />
          <TextInput label={t('accessChanges.approvedBy')} value={approvedBy} onChange={(e) => setApprovedBy(e.currentTarget.value)} maxLength={200} />
        </Group>
        <Group grow wrap="wrap">
          <TextInput
            label={t('accessChanges.performedBy')}
            placeholder={t('reconciliation.performedByUnknown')}
            value={performedBy}
            onChange={(e) => setPerformedBy(e.currentTarget.value)}
            maxLength={200}
          />
          <TextInput label={t('accessChanges.performedAt')} type="datetime-local" value={performedAt} onChange={(e) => setPerformedAt(e.currentTarget.value)} />
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!reason.trim()}>
            {t('reconciliation.documentAction')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function DismissModal({ finding, onClose, onDone }: { finding: AccessFinding; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation(['compliance', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  // four-eyes dismissals: a second person confirms the reason the first one gave
  const confirming = !!finding.dismissRequestedBy;
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/compliance/findings/${finding.id}/dismiss`, { comment: comment.trim() });
      await onDone();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={t(confirming ? 'reconciliation.confirmDismissTitle' : 'reconciliation.dismissTitle', { subject: finding.subjectName || finding.subjectId })}
    >
      <Stack gap="sm">
        <Text size="sm">{t('reconciliation.dismissHelp')}</Text>
        {confirming && <Text size="sm">{t('reconciliation.dismissRequested', { user: finding.dismissRequestedBy, reason: finding.comment })}</Text>}
        <Textarea
          label={t(confirming ? 'reconciliation.confirmDismissComment' : 'reconciliation.dismissReason')}
          required={!confirming}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          maxLength={2000}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button color="red" onClick={submit} loading={busy} disabled={!confirming && !comment.trim()}>
            {t(confirming ? 'reconciliation.confirmDismiss' : 'reconciliation.dismiss')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CheckModal({ check, onClose, onSaved }: { check: AccessCheck | null; onClose: () => void; onSaved: (c: AccessCheck) => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []) });
  const [f, setF] = useState({
    name: check?.name ?? '',
    description: check?.description ?? '',
    platformId: check?.platformId ?? '',
    source: check?.source ?? 'insights-hub',
    datasetKey: check?.datasetKey ?? 'ih.access-snapshot',
    scope: check?.scope ?? '',
    cron: check?.cron ?? '30 6 * * *',
    timezone: check?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    enabled: check?.enabled ?? true,
    notify: check?.notify ?? [],
    ignoreRights: check?.ignoreRights ?? [],
  });
  const [busy, setBusy] = useState(false);
  const up = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const usable = (platforms.data ?? []).filter((p) => p.permissions.includes('use'));
  const submit = async () => {
    setBusy(true);
    try {
      const body = {
        ...f,
        datasetKey: f.source === 'dataset' ? f.datasetKey : null,
        scope: f.source === 'git' || f.source === 'snowflake' ? f.scope.trim() : null,
      };
      const saved = check ? await put<AccessCheck>(`/compliance/access-checks/${check.id}`, body) : await post<AccessCheck>('/compliance/access-checks', body);
      await qc.invalidateQueries({ queryKey: ['access-checks'] });
      onSaved(saved);
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={check ? t('reconciliation.editTitle') : t('reconciliation.new')} size="lg">
      <Stack gap="sm">
        <TextInput label={t('reconciliation.name')} required value={f.name} onChange={(e) => up('name', e.currentTarget.value)} maxLength={120} />
        <Textarea
          label={t('reconciliation.descriptionLabel')}
          autosize
          minRows={2}
          value={f.description}
          onChange={(e) => up('description', e.currentTarget.value)}
          maxLength={2000}
        />
        <Select
          label={t('accessChanges.platform')}
          required
          disabled={!!check && check.snapshotCount > 0}
          data={usable.map((p) => ({ value: p.id, label: p.name }))}
          value={f.platformId || null}
          onChange={(v) => {
            const p = usable.find((x) => x.id === v);
            const git = !!p && (GIT_PLATFORM_KINDS as readonly string[]).includes(p.kind);
            const snowflake = p?.kind === 'snowflake';
            setF((x) => ({ ...x, platformId: v ?? '', source: git ? 'git' : snowflake ? 'snowflake' : p && p.kind !== 'insights-hub' ? 'dataset' : x.source }));
          }}
        />
        <Select
          label={t('reconciliation.source')}
          description={t('reconciliation.sourceHelp')}
          allowDeselect={false}
          disabled={!!check && check.snapshotCount > 0}
          data={[
            { value: 'insights-hub', label: t('sources.insights-hub') },
            { value: 'dataset', label: t('sources.dataset') },
            { value: 'git', label: t('sources.git') },
            { value: 'snowflake', label: t('sources.snowflake') },
          ]}
          value={f.source}
          onChange={(v) => up('source', (v as AccessCheck['source']) ?? 'insights-hub')}
        />
        {f.source === 'git' && (
          <TextInput
            label={t('reconciliation.scope')}
            description={t('reconciliation.scopeHelp')}
            required
            value={f.scope}
            onChange={(e) => up('scope', e.currentTarget.value)}
            maxLength={300}
            classNames={{ input: 'mono' }}
          />
        )}
        {f.source === 'snowflake' && (
          <TextInput
            label={t('reconciliation.snowflakeScope')}
            description={t('reconciliation.snowflakeScopeHelp')}
            value={f.scope}
            onChange={(e) => up('scope', e.currentTarget.value)}
            maxLength={800}
            classNames={{ input: 'mono' }}
          />
        )}
        {f.source === 'dataset' && (
          <TextInput
            label={t('reconciliation.datasetKey')}
            description={t('reconciliation.datasetKeyHelp')}
            required
            value={f.datasetKey}
            onChange={(e) => up('datasetKey', e.currentTarget.value)}
            maxLength={64}
          />
        )}
        <Group grow wrap="wrap">
          <TextInput
            label={t('reconciliation.cron')}
            description={t('reconciliation.cronHelp')}
            required
            value={f.cron}
            onChange={(e) => up('cron', e.currentTarget.value)}
            maxLength={100}
          />
          <TextInput label={t('reconciliation.timezone')} required value={f.timezone} onChange={(e) => up('timezone', e.currentTarget.value)} maxLength={64} />
        </Group>
        <MultiSelect
          label={t('reconciliation.notify')}
          description={t('reconciliation.notifyHelp')}
          searchable
          data={(subjects.data ?? []).filter((s) => s.kind !== 'role').map((s) => ({ value: s.value, label: subjectLabel(s.value) }))}
          value={f.notify}
          onChange={(v) => up('notify', v)}
          maxValues={20}
        />
        <TagsInput
          label={t('reconciliation.ignoreRights')}
          description={t(isAdmin ? 'reconciliation.ignoreRightsHelp' : 'reconciliation.ignoreRightsAdminOnly')}
          disabled={!isAdmin}
          value={f.ignoreRights}
          onChange={(v) => up('ignoreRights', v)}
          maxTags={100}
        />
        <Switch label={t('reconciliation.enabled')} checked={f.enabled} onChange={(e) => up('enabled', e.currentTarget.checked)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!f.name.trim() || !f.platformId}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
