import { memo, useMemo, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Image,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  IconChevronDown,
  IconChevronRight,
  IconFileDownload,
  IconPlayerStop,
  IconPlayerPlay,
  IconRefresh,
  IconCircleCheck,
  IconCircleX,
  IconBoxMultiple,
  IconFileCertificate,
  IconSparkles,
  IconBug,
  IconArrowsLeftRight,
} from '@tabler/icons-react';
import { outcomeOf, topSeverity, type AuditEntry, type ProcessDetail, type RunChild, type RunDetail, type RunStepRecord } from '@sm/shared';
import { get, notifyError, post, apiUrl } from '../api';
import { fmtDate, fmtDuration, fmtNumber, fmtTime, runDuration } from '../format';
import { DetailState, JsonView, Markdown, SEVERITY_COLORS, SeverityBadge, StatusBadge, TONE, severityLabel, statusLabel } from '../components/common';
import { errorSteps, findingsOf, findingsText } from '../components/RunTable';
import { DecideFromLinkNotice, TaskPanel } from '../components/TaskPanel';
import { PrivilegedBadge } from '../components/platform/PrivilegedBadge';
import { RunDialog } from '../components/RunDialog';
import { GenerateReportDialog, RunReportsPanel, canReport } from '../components/reports/RunReports';
import { DetailHeader } from '../components/page/DetailPage';
import { useCollapsible } from '../components/page/CollapsibleSection';
import { ShowAll, useShowMore } from '../components/page/ShowAll';
import { processKeys, runKeys } from '../queryKeys';
import { useMe } from '../auth';

const ACTIVE = ['running', 'waiting', 'queued'];
/** Long runs (for-each over thousands of items) render their steps and log lines in pages. */
const STEP_PAGE = 500;
const LOG_PAGE = 1000;
/** Findings listed at the top of a run that completed with findings (all of them: the Checks tab). */
const FINDINGS_SHOWN = 5;
/** Failed steps whose details are open when the run is opened (a for-each can fail thousands of times). */
const FAILED_OPEN = 20;

export function RunDetailPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { t: tDebug } = useTranslation('debug');
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [rerun, setRerun] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const run = useQuery({
    queryKey: runKeys.detail(id),
    queryFn: () => get<RunDetail>(`/runs/${id}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1500 : false),
  });
  const proc = useQuery({
    queryKey: processKeys.detail(run.data?.processId),
    queryFn: () => get<ProcessDetail>(`/processes/${run.data!.processId}`),
    enabled: !!run.data?.processId,
    retry: false,
  });
  const canRun = !!proc.data?.permissions.includes('run');
  const { username, isAdmin } = useMe();
  // the last good run before a failed one (or one with findings): "Compare with the last good run" (ADR 0010)
  const failedOrFindings = !!run.data && !run.data.debug && (run.data.status === 'failed' || outcomeOf(run.data) === 'findings');
  const lastGood = useQuery({
    queryKey: runKeys.lastGood(id),
    queryFn: () => get<{ run: { id: string } | null }>(`/runs/${id}/last-good`),
    enabled: failedOrFindings,
    retry: false,
  });
  // Child runs per step key: stable arrays keep the memoized step rows from re-rendering on every poll.
  const childrenByStep = useMemo(() => {
    const m = new Map<string, RunChild[]>();
    for (const c of run.data?.children ?? []) if (c.parentStepKey) m.set(c.parentStepKey, [...(m.get(c.parentStepKey) ?? []), c]);
    return m;
  }, [run.data?.children]);
  const steps = useShowMore(run.data?.steps ?? [], STEP_PAGE, { page: STEP_PAGE });
  const logs = useShowMore(run.data?.logs ?? [], LOG_PAGE, { page: LOG_PAGE });
  // the details of failed steps start open (the first few), a link to #step-<id> opens that step
  const openFailed = useMemo(
    () =>
      new Set(
        (run.data?.steps ?? [])
          .filter((s) => s.status === 'failed')
          .slice(0, FAILED_OPEN)
          .map((s) => s.id),
      ),
    [run.data?.steps],
  );
  const { hash } = useLocation();
  const r = run.data;
  if (!r) return <DetailState query={run} back="runs" />;

  const action = async (what: 'cancel' | 'resume') => {
    try {
      await post(`/runs/${r.id}/${what}`);
      await qc.invalidateQueries({ queryKey: runKeys.detail(id) });
    } catch (e) {
      notifyError(e);
    }
  };
  const openTasks = r.tasks.filter((task) => task.status === 'open');
  // a privileged run waits for a second person before its first step (0.14.0, ADR 0009 step 4)
  const startApproval = openTasks.find((task) => task.startApproval);
  // a card's Approve / Reject link (ADR 0013): ?task=<id>&decide=approve|reject opens that step's dialog
  const checks = r.steps.filter((s) => s.type === 'check');
  const findings = findingsOf(r);
  const failedChecks = checks.filter((s) => s.status === 'failed' && !s.error);
  const failedSteps = errorSteps(r);
  // a debug run is driven and stopped by its starter (or an administrator); it is never run again from here
  const debugRun = !!r.debug;
  const mayStop = canRun && (!debugRun || r.actor === username || isAdmin);

  return (
    <>
      <DetailHeader
        recent={{ label: r.processName, kind: 'run' }}
        back="runs"
        title={
          <Group gap="xs">
            <span>{r.processName}</span>
            <StatusBadge status={outcomeOf(r)} size="md" />
            {r.dryRun && (
              <Badge color="yellow" variant="light" size="md">
                {r.recorded ? t('detail.testRun') : t('common:status.dryrun')}
              </Badge>
            )}
            {debugRun && (
              <Badge color="grape" variant="light" size="md" leftSection={<IconBug size={12} />} data-testid="debug-badge">
                {tDebug(r.debug!.kind === 'node' ? 'run.badgeNode' : 'run.badgeStep')}
              </Badge>
            )}
          </Group>
        }
        description={
          <Trans
            t={t}
            i18nKey="detail.description"
            values={{
              id: r.id,
              version: r.processVersion,
              actor: r.actor,
              trigger:
                r.trigger === 'webhook'
                  ? t('trigger.webhookNamed', { name: r.triggerName ?? r.triggerId ?? '' })
                  : r.trigger === 'monitor'
                    ? t('trigger.monitorNamed', { name: r.triggerName ?? r.triggerId ?? '' })
                    : t(`trigger.${r.trigger}`, { defaultValue: r.trigger }),
              date: fmtDate(r.startedAt),
              duration: runDuration(r.startedAt, r.finishedAt),
            }}
            components={{ id: <span className="mono" />, version: <Anchor component={Link} to={`/processes/${r.processId}`} size="sm" /> }}
          />
        }
        actions={
          <>
            {lastGood.data?.run && (
              <Button
                size="xs"
                variant="light"
                component={Link}
                to={`/runs/compare?a=${lastGood.data.run.id}&b=${r.id}`}
                leftSection={<IconArrowsLeftRight size={14} />}
                data-testid="compare-last-good"
              >
                {tDebug('run.compareLastGood')}
              </Button>
            )}
            {mayStop && ['queued', 'running', 'waiting', 'interrupted'].includes(r.status) && (
              <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={() => action('cancel')}>
                {t('detail.cancel')}
              </Button>
            )}
            {canRun && r.status === 'interrupted' && (
              <Tooltip label={t('detail.resumeHint')} multiline w={260}>
                <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => action('resume')}>
                  {t('detail.resume')}
                </Button>
              </Tooltip>
            )}
            {canRun && !debugRun && (
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={() => setRerun(true)}>
                {t('detail.runAgain')}
              </Button>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" leftSection={<IconFileDownload size={14} />}>
                  {t('detail.protocol')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item component="a" href={apiUrl(`/runs/${r.id}/report.html`)} target="_blank">
                  {t('detail.openHtml')}
                </Menu.Item>
                <Menu.Item leftSection={<IconFileCertificate size={14} />} disabled={!canReport(r.status)} onClick={() => setPdfOpen(true)}>
                  {t('detail.generatePdf')}
                </Menu.Item>
                <Menu.Item component="a" href={apiUrl(`/runs/${r.id}/report.html?download=1`)}>
                  {t('detail.downloadHtml')}
                </Menu.Item>
                <Menu.Item component="a" href={apiUrl(`/runs/${r.id}/report.json`)}>
                  {t('detail.downloadJson')}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item component={Link} to={`/runs/compare?a=${r.id}`} leftSection={<IconArrowsLeftRight size={14} />} data-testid="compare-with">
                  {tDebug('run.compareWith')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      <RunDialog processId={r.processId} opened={rerun} onClose={() => setRerun(false)} />
      <GenerateReportDialog runId={r.id} status={r.status} opened={pdfOpen} onClose={() => setPdfOpen(false)} />

      <Stack>
        {r.parentRunId && (
          <Alert color="violet" variant="light" p="xs" icon={<IconBoxMultiple size={16} />}>
            <Text size="sm">
              <Trans
                t={t}
                i18nKey={r.parentStepKey ? 'detail.startedByStep' : 'detail.startedBySubprocess'}
                values={{ step: r.parentStepKey ?? '', run: r.parentRunId }}
                components={{ step: <span className="mono" />, run: <Anchor component={Link} to={`/runs/${r.parentRunId}`} className="mono" size="sm" /> }}
              />
            </Text>
          </Alert>
        )}
        {debugRun && (
          <Alert color="grape" variant="light" p="xs" icon={<IconBug size={16} />} data-testid="debug-run-note">
            <Text size="sm">
              {tDebug('run.note')}
              {r.debug!.recordedFrom ? ` ${tDebug('run.recordedFrom', { key: r.debug!.recordedFrom })}` : ''}
            </Text>
          </Alert>
        )}
        {r.status === 'failed' && r.error && (
          <Alert color="red" title={t('detail.failed')}>
            {r.error}
          </Alert>
        )}
        {outcomeOf(r) === 'findings' && (
          <Alert color={SEVERITY_COLORS[topSeverity(findings) ?? 'error']} title={t('detail.findingsTitle')} data-testid="run-findings" p="sm">
            <Text size="sm">{t('detail.findingsText', { findings: findingsText(t, findings) })}</Text>
            <Stack gap={2} mt={6}>
              {/* what was found first, the expectation (the check's name) after it */}
              {failedChecks.slice(0, FINDINGS_SHOWN).map((c) => {
                const o = (c.output ?? {}) as { severity?: string; message?: string };
                return (
                  <Group key={c.id} gap={6} wrap="nowrap" align="flex-start">
                    <SeverityBadge severity={o.severity ?? 'error'} />
                    <Text size="sm" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                      {o.message || t('detail.checkFailed', { name: c.name })}
                      <Text span size="xs" c="dimmed">
                        {' · '}
                        {t('detail.expected', { name: c.name })}
                      </Text>
                    </Text>
                  </Group>
                );
              })}
              {failedChecks.length > FINDINGS_SHOWN && (
                <Text size="xs" c="dimmed">
                  {t('detail.moreFindings', { count: failedChecks.length - FINDINGS_SHOWN })}
                </Text>
              )}
            </Stack>
          </Alert>
        )}
        {r.status === 'queued' && (
          <Alert color="gray" title={t('detail.queued')} data-testid="run-queued">
            {t('detail.queuedText')}
          </Alert>
        )}
        {r.status === 'interrupted' && (
          <Alert color="orange" title={t('detail.interrupted')}>
            {t('detail.interruptedText')}
          </Alert>
        )}
        {startApproval && (
          <Alert color="orange" title={t('detail.startApproval')} data-testid="run-start-approval">
            {t('detail.startApprovalText', { date: fmtDate(startApproval.startApproval!.expiresAt) })}
          </Alert>
        )}
        <DecideFromLinkNotice tasks={r.tasks} />
        {openTasks.map((task) => (
          <TaskPanel key={task.id} task={task} showRunLink={false} />
        ))}

        <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="xs">
          <Stat
            label={t('detail.stats.steps')}
            value={fmtNumber(r.stats.steps)}
            // check findings are no failed steps: only what failed while executing
            sub={failedSteps ? t('detail.stats.failed', { count: failedSteps }) : undefined}
            tone={failedSteps > 0 ? TONE.bad : undefined}
          />
          <Stat label={t('detail.stats.changes')} value={fmtNumber(r.stats.writes)} />
          <Stat label={t('detail.stats.simulated')} value={fmtNumber(r.stats.skippedWrites)} />
          <Stat label={t('detail.stats.checksPassed')} value={fmtNumber(r.stats.checksPassed)} />
          <Stat
            label={t('detail.stats.findings')}
            value={fmtNumber(findings.total)}
            sub={
              findings.total
                ? (['error', 'warning', 'info'] as const)
                    .filter((s) => findings[s])
                    .map((s) => t(`table.severity.${s}`, { count: findings[s] }))
                    .join(', ')
                : undefined
            }
            tone={findings.total ? SEVERITY_COLORS[topSeverity(findings) ?? 'error'] : undefined}
          />
          <Stat label={t('detail.stats.decisions')} value={`${r.tasks.filter((task) => task.status === 'completed').length}/${r.tasks.length}`} />
        </SimpleGrid>

        {(r.children?.length ?? 0) > 0 && <ChildRuns runs={r.children!} />}

        <Tabs defaultValue={r.reports.length && !hash.startsWith('#step-') ? 'reports' : 'timeline'} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="timeline">{t('detail.tabs.steps')}</Tabs.Tab>
            {r.reports.length > 0 && <Tabs.Tab value="reports">{t('detail.tabs.reports', { count: r.reports.length })}</Tabs.Tab>}
            {checks.length > 0 && <Tabs.Tab value="checks">{t('detail.tabs.checks', { count: checks.length })}</Tabs.Tab>}
            {r.tasks.length > 0 && <Tabs.Tab value="decisions">{t('detail.tabs.decisions', { count: r.tasks.length })}</Tabs.Tab>}
            {r.artifacts.length > 0 && <Tabs.Tab value="evidence">{t('detail.tabs.evidence', { count: r.artifacts.length })}</Tabs.Tab>}
            <Tabs.Tab value="log">{t('detail.tabs.log', { count: r.logs.length })}</Tabs.Tab>
            <Tabs.Tab value="inputs">{t('detail.tabs.inputs')}</Tabs.Tab>
            <Tabs.Tab value="pdf">{t('detail.tabs.pdf')}</Tabs.Tab>
            <Tabs.Tab value="audit">{t('detail.tabs.audit')}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="timeline" pt="sm">
            <Stack gap={4}>
              {r.steps.length === 0 && <Text c="dimmed">{t('detail.noSteps')}</Text>}
              {steps.items.map((s) => (
                <StepRow key={s.id} runId={r.id} step={s} childRuns={childrenByStep.get(s.key)} defaultOpen={openFailed.has(s.id)} />
              ))}
              <ShowAll
                state={steps}
                id="steps"
                label={(shown, total) => t('detail.showMore.steps', { shown: fmtNumber(shown), count: total, total: fmtNumber(total) })}
              />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="sm">
            <Stack>
              {r.reports.map((rep) => (
                <Paper withBorder p="md" key={rep.stepKey}>
                  <Text fw={600} mb="xs">
                    {rep.title}
                  </Text>
                  {rep.aiGenerated && (
                    <Badge
                      color="pink"
                      variant="light"
                      mb="xs"
                      leftSection={<IconSparkles size={12} />}
                      style={{ textTransform: 'none' }}
                      data-testid="report-ai-generated"
                    >
                      {t('detail.aiGenerated', { models: rep.aiGenerated.models.join(', ') })}
                    </Badge>
                  )}
                  <Markdown text={rep.text} />
                  {rep.rows && (
                    <div className="table-scroll">
                      <Table striped withTableBorder fz="sm" mt="xs">
                        <Table.Thead>
                          <Table.Tr>
                            {(rep.columns ?? []).map((c) => (
                              <Table.Th key={c}>{c}</Table.Th>
                            ))}
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {rep.rows.length === 0 && (
                            <Table.Tr>
                              <Table.Td colSpan={rep.columns?.length ?? 1}>
                                <Text c="dimmed" size="sm">
                                  {t('detail.noRows')}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          )}
                          {rep.rows.map((row, i) => (
                            <Table.Tr key={i}>
                              {row.map((c, j) => (
                                <Table.Td key={j}>{String(c)}</Table.Td>
                              ))}
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  )}
                </Paper>
              ))}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="checks" pt="sm">
            <div className="table-scroll">
              <Table withTableBorder fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('detail.checks.result')}</Table.Th>
                    <Table.Th>{t('detail.checks.check')}</Table.Th>
                    <Table.Th>{t('detail.checks.severity')}</Table.Th>
                    <Table.Th>{t('detail.checks.message')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {checks.map((c) => {
                    const o = (c.output ?? {}) as { passed?: boolean; severity?: string; message?: string };
                    return (
                      <Table.Tr key={c.id}>
                        <Table.Td>
                          {o.passed ? (
                            <IconCircleCheck color="var(--mantine-color-green-6)" size={18} aria-label={t('detail.checks.passed')} />
                          ) : (
                            <IconCircleX
                              color={`var(--mantine-color-${SEVERITY_COLORS[o.severity ?? 'error'] ?? 'red'}-6)`}
                              size={18}
                              aria-label={t('detail.checks.failedLabel')}
                            />
                          )}
                        </Table.Td>
                        <Table.Td>{c.name}</Table.Td>
                        <Table.Td>{o.severity ? <SeverityBadge severity={o.severity} /> : ''}</Table.Td>
                        <Table.Td>{o.message ?? c.error}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </div>
          </Tabs.Panel>

          <Tabs.Panel value="decisions" pt="sm">
            <Stack>
              {r.tasks.map((task) => (
                <TaskPanel key={`${task.id}-${task.status}`} task={task} showRunLink={false} />
              ))}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="evidence" pt="sm">
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {r.artifacts.map((a) => (
                <Card withBorder key={a.id} padding="xs">
                  <Card.Section>
                    <ArtifactImage id={a.id} name={a.name} />
                  </Card.Section>
                  <Text size="sm" fw={500} mt="xs">
                    {a.name}
                  </Text>
                  <Text size="xs" c="dimmed" className="mono">
                    {t('detail.artifactLine', { step: a.stepKey, hash: `${a.sha256.slice(0, 20)}…`, date: fmtDate(a.createdAt) })}
                  </Text>
                </Card>
              ))}
            </SimpleGrid>
          </Tabs.Panel>

          <Tabs.Panel value="log" pt="sm">
            <div className="table-scroll">
              <Table fz="sm" verticalSpacing={2}>
                <Table.Tbody>
                  {logs.items.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td className="nowrap mono">{fmtTime(l.ts)}</Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={l.level === 'error' ? 'red' : l.level === 'warn' ? 'orange' : 'gray'}>
                          {l.level}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ wordBreak: 'break-word' }}>
                        {l.message}
                        {l.stepKey && (
                          <Text span size="xs" c="dimmed" className="mono">
                            {' '}
                            · {l.stepKey}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <ShowAll
              state={logs}
              id="log"
              label={(shown, total) => t('detail.showMore.logLines', { shown: fmtNumber(shown), count: total, total: fmtNumber(total) })}
            />
          </Tabs.Panel>

          <Tabs.Panel value="inputs" pt="sm">
            <Stack>
              <Text fw={600} size="sm">
                {t('detail.connections')}
              </Text>
              {Object.entries(r.bindings).map(([slot, b]) => (
                <Text size="sm" key={slot}>
                  <b>{slot}</b> →{' '}
                  <Anchor inherit component={Link} to={`/platforms/${b.platformId}`}>
                    {b.platformName}
                  </Anchor>
                  {/* the identity the slot used (0.13.0, ADR 0009): "Snowflake · Read only" */}
                  {b.identityName && b.identityName !== 'Default' ? ` · ${b.identityName}` : ''} {b.privileged && <PrivilegedBadge size="xs" />}{' '}
                  <span className="mono">{b.baseUrl}</span>
                </Text>
              ))}
              <Text fw={600} size="sm">
                {t('detail.tabs.inputs')}
              </Text>
              <JsonView value={r.inputs} />
              {r.outputs && Object.keys(r.outputs).length > 0 && (
                <>
                  <Text fw={600} size="sm">
                    {t('detail.outputs')}
                  </Text>
                  <JsonView value={r.outputs} />
                </>
              )}
              <Text size="xs" c="dimmed" className="mono">
                {t('detail.definitionHash', { hash: r.definitionHash })}
              </Text>
              {r.libraryOrigin && (
                <Text size="xs" c={r.libraryOrigin.keyRevoked ? 'red' : 'dimmed'} style={{ overflowWrap: 'anywhere' }} data-testid="run-library-origin">
                  {t('detail.libraryOrigin', {
                    library: r.libraryOrigin.library,
                    release: r.libraryOrigin.release,
                    publisher: r.libraryOrigin.publisher,
                    key: r.libraryOrigin.keyFingerprint,
                  })}
                  {r.libraryOrigin.keyRevoked ? ` – ${t('detail.libraryRevoked')}` : ''}
                </Text>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="pdf" pt="sm">
            <RunReportsPanel runId={r.id} status={r.status} />
          </Tabs.Panel>

          <Tabs.Panel value="audit" pt="sm">
            <RunAudit runId={r.id} />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </>
  );
}

/** One number of the run; `tone` (TONE / severity colour) marks it as needing attention. */
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  const color = tone && tone !== TONE.neutral ? `var(--mantine-color-${tone}-text)` : undefined;
  return (
    <Paper withBorder p="xs">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={color}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c={color ?? 'dimmed'}>
          {sub}
        </Text>
      )}
    </Paper>
  );
}

function ChildRuns({ runs }: { runs: RunChild[] }) {
  const { t } = useTranslation('runs');
  return (
    <Paper withBorder p="sm">
      <Group gap={6} mb={6}>
        <IconBoxMultiple size={16} />
        <Text fw={600} size="sm">
          {t('detail.childRuns', { count: runs.length })}
        </Text>
      </Group>
      <Stack gap={4}>
        {runs.map((c) => (
          <Group key={c.id} gap="xs" wrap="nowrap">
            <StatusBadge status={c.status} size="xs" />
            <Anchor component={Link} to={`/runs/${c.id}`} size="sm" truncate style={{ minWidth: 0 }}>
              {c.processName}
            </Anchor>
            <Text size="xs" c="dimmed" className="mono" truncate style={{ flex: 1, minWidth: 0 }}>
              {c.parentStepKey ?? ''}
            </Text>
            <Text size="xs" c="dimmed" className="nowrap" visibleFrom="xs">
              {c.startedAt ? runDuration(c.startedAt, c.finishedAt) : ''}
            </Text>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

/**
 * One step of the timeline. Memoized (polling returns structurally shared step objects, so only
 * changed steps re-render), and the details are only mounted while open: Collapse keeps its
 * children mounted, which for thousands of steps meant thousands of hidden JSON views.
 */
const StepRow = memo(function StepRow({
  runId,
  step,
  childRuns,
  defaultOpen,
}: {
  runId: string;
  step: RunStepRecord;
  childRuns?: RunChild[];
  defaultOpen: boolean;
}) {
  const { t } = useTranslation('runs');
  const { t: tDebug } = useTranslation('debug');
  const rowId = `step-${step.id}`;
  // a step's own state for this page view; failed steps start open, a link to #step-<id> opens it
  const { open, toggle } = useCollapsible({ id: rowId, defaultOpen, inGroup: false });
  const [full, setFull] = useState<RunStepRecord | null>(null);
  const depth = step.key.split('/').length - 1;
  const s = full ?? step;
  // a failed check is a finding of the run (with the check's severity), not a step that failed to execute
  const findingSeverity =
    step.type === 'check' && step.status === 'failed' && !step.error ? ((step.output as { severity?: string } | null)?.severity ?? 'error') : null;
  return (
    <Paper withBorder p={6} ml={Math.min(depth, 6) * 16} id={rowId} className="sm-anchor" data-testid="run-step" data-open={open}>
      {/* the whole row is the toggle: a button, so the keyboard opens it too */}
      <UnstyledButton
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`${rowId}-details`}
        w="100%"
        mih={24}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--mantine-spacing-xs)', flexWrap: 'nowrap', borderRadius: 'var(--mantine-radius-sm)' }}
        data-testid="run-step-toggle"
      >
        {open ? <IconChevronDown size={14} aria-hidden style={{ flex: 'none' }} /> : <IconChevronRight size={14} aria-hidden style={{ flex: 'none' }} />}
        {findingSeverity ? (
          <Badge
            color={SEVERITY_COLORS[findingSeverity] ?? TONE.attention}
            variant="light"
            size="xs"
            style={{ minWidth: 'max-content' }}
            data-testid="step-finding"
          >
            {t('detail.findingBadge', { severity: severityLabel(findingSeverity) })}
          </Badge>
        ) : (
          <StatusBadge status={step.status} size="xs" />
        )}
        <Badge size="xs" variant="outline" color="gray">
          {step.type}
        </Badge>
        {!!(step.output as { simulated?: boolean } | null)?.simulated && (
          <Badge size="xs" variant="light" color="violet" data-testid="step-simulated">
            {tDebug('simulated')}
          </Badge>
        )}
        <Text size="sm" fw={500} style={{ minWidth: 0 }} truncate>
          {step.name}
          {/\[\d+\]/.test(step.key) && (
            <Text span size="xs" c="dimmed">
              {' '}
              #{Number(/\[(\d+)\][^[]*$/.exec(step.key)?.[1] ?? 0) + 1}
            </Text>
          )}
        </Text>
        <Text size="xs" c={step.error ? 'red' : 'dimmed'} truncate style={{ flex: 1, minWidth: 0 }}>
          {step.error ?? step.summary}
        </Text>
        <Text size="xs" c="dimmed" className="nowrap" visibleFrom="sm">
          {fmtDuration(step.durationMs)}
        </Text>
      </UnstyledButton>
      <Collapse expanded={open} id={`${rowId}-details`}>
        {open && (
          <Stack gap="xs" mt="xs">
            <Text size="xs" c="dimmed" className="mono">
              {t('detail.step.started', { key: step.key, date: fmtDate(step.startedAt) })}
            </Text>
            {step.error && (
              <Alert color="red" p="xs">
                {step.error}
              </Alert>
            )}
            {childRuns && childRuns.length > 0 && (
              <Group gap={6}>
                <Text size="xs" fw={600}>
                  {t('detail.step.childRun')}
                </Text>
                {childRuns.map((c) => (
                  <Anchor key={c.id} component={Link} to={`/runs/${c.id}`} size="xs" className="mono">
                    {c.id} ({statusLabel(c.status)})
                  </Anchor>
                ))}
              </Group>
            )}
            {s.input !== undefined && s.input !== null && (
              <>
                <Text size="xs" fw={600}>
                  {t('detail.step.request')}
                </Text>
                <JsonView value={s.input} maxHeight={260} />
              </>
            )}
            {s.output !== undefined && s.output !== null && (
              <>
                <Group gap="xs">
                  <Text size="xs" fw={600}>
                    {t('detail.step.result')}
                  </Text>
                  {step.outputTruncated && !full && (
                    <Button
                      size="compact-xs"
                      variant="light"
                      onClick={() =>
                        get<RunStepRecord>(`/runs/${runId}/steps/${step.id}`)
                          .then(setFull)
                          .catch((e) => notifyError(e))
                      }
                    >
                      {t('detail.step.loadFull')}
                    </Button>
                  )}
                </Group>
                <JsonView value={s.output} maxHeight={400} />
              </>
            )}
          </Stack>
        )}
      </Collapse>
    </Paper>
  );
});

function RunAudit({ runId }: { runId: string }) {
  const { t } = useTranslation('runs');
  const q = useQuery({ queryKey: ['audit', 'run', runId], queryFn: () => get<AuditEntry[]>(`/audit?runId=${runId}&limit=1000`) });
  return (
    <div className="table-scroll">
      <Table fz="sm" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>{t('detail.audit.time')}</Table.Th>
            <Table.Th>{t('detail.audit.actor')}</Table.Th>
            <Table.Th>{t('detail.audit.action')}</Table.Th>
            <Table.Th>{t('detail.audit.summary')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {[...(q.data ?? [])].reverse().map((a) => (
            <Table.Tr key={a.seq}>
              <Table.Td>{a.seq}</Table.Td>
              <Table.Td className="nowrap">{fmtDate(a.ts)}</Table.Td>
              <Table.Td>{a.actor}</Table.Td>
              <Table.Td className="mono">{a.action}</Table.Td>
              <Table.Td>{a.summary}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

/** A run artifact; its file may be missing (a backup restored without run artifacts): then a note instead of a broken image. */
function ArtifactImage({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation('runs');
  const [gone, setGone] = useState(false);
  if (gone)
    return (
      <Text size="sm" c="dimmed" p="md">
        {t('detail.artifactGone')}
      </Text>
    );
  return (
    <a href={apiUrl(`/artifacts/${id}`)} target="_blank" rel="noreferrer">
      <Image src={apiUrl(`/artifacts/${id}`)} alt={name} onError={() => setGone(true)} />
    </a>
  );
}
