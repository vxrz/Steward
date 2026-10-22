import { memo, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
} from '@tabler/icons-react';
import type { AuditEntry, ProcessDetail, RunChild, RunDetail, RunStepRecord } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { fmtDate, fmtDuration, fmtNumber, fmtTime, runDuration } from '../format';
import { JsonView, Markdown, PageHeader, StatusBadge, severityLabel, statusLabel } from '../components/common';
import { TaskPanel } from '../components/TaskPanel';
import { RunDialog } from '../components/RunDialog';
import { GenerateReportDialog, RunReportsPanel, canReport } from '../components/reports/RunReports';

const ACTIVE = ['running', 'waiting', 'queued'];
/** Long runs (for-each over thousands of items) render their steps and log lines in pages. */
const STEP_PAGE = 500;
const LOG_PAGE = 1000;

export function RunDetailPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [rerun, setRerun] = useState(false);
  const [stepLimit, setStepLimit] = useState(STEP_PAGE);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  const [pdfOpen, setPdfOpen] = useState(false);
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => get<RunDetail>(`/runs/${id}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1500 : false),
  });
  const proc = useQuery({
    queryKey: ['process', run.data?.processId],
    queryFn: () => get<ProcessDetail>(`/processes/${run.data!.processId}`),
    enabled: !!run.data?.processId,
    retry: false,
  });
  const canRun = !!proc.data?.permissions.includes('run');
  // Child runs per step key: stable arrays keep the memoized step rows from re-rendering on every poll.
  const childrenByStep = useMemo(() => {
    const m = new Map<string, RunChild[]>();
    for (const c of run.data?.children ?? []) if (c.parentStepKey) m.set(c.parentStepKey, [...(m.get(c.parentStepKey) ?? []), c]);
    return m;
  }, [run.data?.children]);
  const r = run.data;
  if (!r) return run.error ? <Alert color="red">{(run.error as Error).message}</Alert> : null;

  const action = async (what: 'cancel' | 'resume') => {
    try {
      await post(`/runs/${r.id}/${what}`);
      await qc.invalidateQueries({ queryKey: ['run', id] });
    } catch (e) {
      notifyError(e);
    }
  };
  const openTasks = r.tasks.filter((task) => task.status === 'open');
  const checks = r.steps.filter((s) => s.type === 'check');

  return (
    <>
      <PageHeader
        title={
          <Group gap="xs">
            <span>{r.processName}</span>
            <StatusBadge status={r.status} size="md" />
            {r.dryRun && (
              <Badge color="yellow" variant="light" size="md">
                {t('common:status.dryrun')}
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
            {canRun && ['running', 'waiting', 'interrupted'].includes(r.status) && (
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
            {canRun && (
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
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.html`} target="_blank">
                  {t('detail.openHtml')}
                </Menu.Item>
                <Menu.Item leftSection={<IconFileCertificate size={14} />} disabled={!canReport(r.status)} onClick={() => setPdfOpen(true)}>
                  {t('detail.generatePdf')}
                </Menu.Item>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.html?download=1`}>
                  {t('detail.downloadHtml')}
                </Menu.Item>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.json`}>
                  {t('detail.downloadJson')}
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
        {r.status === 'failed' && r.error && (
          <Alert color="red" title={t('detail.failed')}>
            {r.error}
          </Alert>
        )}
        {r.status === 'interrupted' && (
          <Alert color="orange" title={t('detail.interrupted')}>
            {t('detail.interruptedText')}
          </Alert>
        )}
        {openTasks.map((task) => (
          <TaskPanel key={task.id} task={task} showRunLink={false} />
        ))}

        <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="xs">
          <Stat
            label={t('detail.stats.steps')}
            value={fmtNumber(r.stats.steps)}
            sub={r.stats.failedSteps ? t('detail.stats.failed', { count: r.stats.failedSteps }) : undefined}
            bad={r.stats.failedSteps > 0}
          />
          <Stat label={t('detail.stats.changes')} value={fmtNumber(r.stats.writes)} />
          <Stat label={t('detail.stats.simulated')} value={fmtNumber(r.stats.skippedWrites)} />
          <Stat label={t('detail.stats.checksPassed')} value={fmtNumber(r.stats.checksPassed)} />
          <Stat label={t('detail.stats.checksFailed')} value={fmtNumber(r.stats.checksFailed)} bad={r.stats.checksFailed > 0} />
          <Stat label={t('detail.stats.decisions')} value={`${r.tasks.filter((task) => task.status === 'completed').length}/${r.tasks.length}`} />
        </SimpleGrid>

        {(r.children?.length ?? 0) > 0 && <ChildRuns runs={r.children!} />}

        <Tabs defaultValue={r.reports.length ? 'reports' : 'timeline'} keepMounted={false}>
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
              {r.steps.slice(0, stepLimit).map((s) => (
                <StepRow key={s.id} runId={r.id} step={s} childRuns={childrenByStep.get(s.key)} />
              ))}
              <ShowMore shown={Math.min(stepLimit, r.steps.length)} total={r.steps.length} page={STEP_PAGE} what="steps" onShow={setStepLimit} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="reports" pt="sm">
            <Stack>
              {r.reports.map((rep) => (
                <Paper withBorder p="md" key={rep.stepKey}>
                  <Text fw={600} mb="xs">
                    {rep.title}
                  </Text>
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
                            <IconCircleX color="var(--mantine-color-red-6)" size={18} aria-label={t('detail.checks.failedLabel')} />
                          )}
                        </Table.Td>
                        <Table.Td>{c.name}</Table.Td>
                        <Table.Td>{o.severity ? severityLabel(o.severity) : ''}</Table.Td>
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
                    <a href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                      <Image src={`/api/artifacts/${a.id}`} alt={a.name} />
                    </a>
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
                  {r.logs.slice(0, logLimit).map((l) => (
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
            <ShowMore shown={Math.min(logLimit, r.logs.length)} total={r.logs.length} page={LOG_PAGE} what="logLines" onShow={setLogLimit} />
          </Tabs.Panel>

          <Tabs.Panel value="inputs" pt="sm">
            <Stack>
              <Text fw={600} size="sm">
                {t('detail.connections')}
              </Text>
              {Object.entries(r.bindings).map(([slot, b]) => (
                <Text size="sm" key={slot}>
                  <b>{slot}</b> →{' '}
                  <Anchor component={Link} to={`/platforms/${b.platformId}`}>
                    {b.platformName}
                  </Anchor>{' '}
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

function ShowMore({ shown, total, page, what, onShow }: { shown: number; total: number; page: number; what: 'steps' | 'logLines'; onShow: (limit: number) => void }) {
  const { t } = useTranslation('runs');
  if (shown >= total) return null;
  return (
    <Group gap="xs" mt={4}>
      <Text size="xs" c="dimmed">
        {t(`detail.showMore.${what}`, { shown: fmtNumber(shown), count: total, total: fmtNumber(total) })}
      </Text>
      <Button size="compact-xs" variant="light" onClick={() => onShow(shown + page)}>
        {t('detail.showMore.more', { count: Math.min(page, total - shown) })}
      </Button>
      <Button size="compact-xs" variant="subtle" onClick={() => onShow(Infinity)}>
        {t('detail.showMore.all')}
      </Button>
    </Group>
  );
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <Paper withBorder p="xs">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={bad ? 'red' : undefined}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c={bad ? 'red' : 'dimmed'}>
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
const StepRow = memo(function StepRow({ runId, step, childRuns }: { runId: string; step: RunStepRecord; childRuns?: RunChild[] }) {
  const { t } = useTranslation('runs');
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<RunStepRecord | null>(null);
  const depth = step.key.split('/').length - 1;
  const s = full ?? step;
  return (
    <Paper withBorder p={6} ml={Math.min(depth, 6) * 16}>
      <Group gap="xs" wrap="nowrap" className="clickable" onClick={() => setOpen((o) => !o)}>
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <StatusBadge status={step.status} size="xs" />
        <Badge size="xs" variant="outline" color="gray">
          {step.type}
        </Badge>
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
      </Group>
      <Collapse in={open}>
        {open && (
          <Stack gap="xs" mt="xs">
            <Text size="xs" c="dimmed" className="mono">
              {t('detail.step.started', { key: step.key, date: fmtDate(step.startedAt) })}
            </Text>
            {step.error && <Alert color="red" p="xs">{step.error}</Alert>}
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
