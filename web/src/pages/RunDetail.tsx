import { useState } from 'react';
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
} from '@tabler/icons-react';
import type { AuditEntry, ProcessDetail, RunChild, RunDetail, RunStepRecord } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { fmtDate, fmtDuration, runDuration } from '../format';
import { JsonView, Markdown, PageHeader, StatusBadge } from '../components/common';
import { TaskPanel } from '../components/TaskPanel';
import { RunDialog } from '../components/RunDialog';

const ACTIVE = ['running', 'waiting', 'queued'];

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [rerun, setRerun] = useState(false);
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
  const openTasks = r.tasks.filter((t) => t.status === 'open');
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
                dry run
              </Badge>
            )}
          </Group>
        }
        description={
          <>
            Run <span className="mono">{r.id}</span> · <Anchor component={Link} to={`/processes/${r.processId}`} size="sm">version {r.processVersion}</Anchor> · started by {r.actor} ({r.trigger === 'subprocess' ? 'sub-process' : r.trigger}) {fmtDate(r.startedAt)} · {runDuration(r.startedAt, r.finishedAt)}
          </>
        }
        actions={
          <>
            {canRun && ['running', 'waiting', 'interrupted'].includes(r.status) && (
              <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={() => action('cancel')}>
                Cancel
              </Button>
            )}
            {canRun && r.status === 'interrupted' && (
              <Tooltip label="Replays completed steps from the journal and continues with the interrupted step (it may be executed again)." multiline w={260}>
                <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => action('resume')}>
                  Resume
                </Button>
              </Tooltip>
            )}
            {canRun && (
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={() => setRerun(true)}>
                Run again
              </Button>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" leftSection={<IconFileDownload size={14} />}>
                  Protocol
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.html`} target="_blank">
                  Open HTML protocol
                </Menu.Item>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.pdf`}>
                  Download PDF
                </Menu.Item>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.html?download=1`}>
                  Download HTML
                </Menu.Item>
                <Menu.Item component="a" href={`/api/runs/${r.id}/report.json`}>
                  Download JSON (full data)
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      <RunDialog processId={r.processId} opened={rerun} onClose={() => setRerun(false)} />

      <Stack>
        {r.parentRunId && (
          <Alert color="violet" variant="light" p="xs" icon={<IconBoxMultiple size={16} />}>
            <Text size="sm">
              Started by sub-process step{r.parentStepKey ? <> <span className="mono">{r.parentStepKey}</span></> : ''} of run{' '}
              <Anchor component={Link} to={`/runs/${r.parentRunId}`} className="mono" size="sm">
                {r.parentRunId}
              </Anchor>
            </Text>
          </Alert>
        )}
        {r.status === 'failed' && r.error && (
          <Alert color="red" title="Run failed">
            {r.error}
          </Alert>
        )}
        {r.status === 'interrupted' && (
          <Alert color="orange" title="Run interrupted">
            The application stopped while this run was active. Resume to continue from where it stopped, or cancel it.
          </Alert>
        )}
        {openTasks.map((t) => (
          <TaskPanel key={t.id} task={t} showRunLink={false} />
        ))}

        <SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }} spacing="xs">
          <Stat label="Steps" value={`${r.stats.steps}`} sub={r.stats.failedSteps ? `${r.stats.failedSteps} failed` : undefined} bad={r.stats.failedSteps > 0} />
          <Stat label="Changes made" value={`${r.stats.writes}`} />
          <Stat label="Simulated" value={`${r.stats.skippedWrites}`} />
          <Stat label="Checks passed" value={`${r.stats.checksPassed}`} />
          <Stat label="Checks failed" value={`${r.stats.checksFailed}`} bad={r.stats.checksFailed > 0} />
          <Stat label="Decisions" value={`${r.tasks.filter((t) => t.status === 'completed').length}/${r.tasks.length}`} />
        </SimpleGrid>

        {(r.children?.length ?? 0) > 0 && <ChildRuns runs={r.children!} />}

        <Tabs defaultValue={r.reports.length ? 'reports' : 'timeline'} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="timeline">Steps</Tabs.Tab>
            {r.reports.length > 0 && <Tabs.Tab value="reports">Reports ({r.reports.length})</Tabs.Tab>}
            {checks.length > 0 && <Tabs.Tab value="checks">Checks ({checks.length})</Tabs.Tab>}
            {r.tasks.length > 0 && <Tabs.Tab value="decisions">Decisions ({r.tasks.length})</Tabs.Tab>}
            {r.artifacts.length > 0 && <Tabs.Tab value="evidence">Evidence ({r.artifacts.length})</Tabs.Tab>}
            <Tabs.Tab value="log">Log ({r.logs.length})</Tabs.Tab>
            <Tabs.Tab value="inputs">Inputs</Tabs.Tab>
            <Tabs.Tab value="audit">Audit</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="timeline" pt="sm">
            <Stack gap={4}>
              {r.steps.length === 0 && <Text c="dimmed">No steps yet.</Text>}
              {r.steps.map((s) => (
                <StepRow key={s.id} runId={r.id} step={s} childRuns={r.children?.filter((c) => c.parentStepKey === s.key)} />
              ))}
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
                                  No rows
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
                    <Table.Th>Result</Table.Th>
                    <Table.Th>Check</Table.Th>
                    <Table.Th>Severity</Table.Th>
                    <Table.Th>Message</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {checks.map((c) => {
                    const o = (c.output ?? {}) as { passed?: boolean; severity?: string; message?: string };
                    return (
                      <Table.Tr key={c.id}>
                        <Table.Td>
                          {o.passed ? <IconCircleCheck color="var(--mantine-color-green-6)" size={18} /> : <IconCircleX color="var(--mantine-color-red-6)" size={18} />}
                        </Table.Td>
                        <Table.Td>{c.name}</Table.Td>
                        <Table.Td>{o.severity}</Table.Td>
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
              {r.tasks.map((t) => (
                <TaskPanel key={`${t.id}-${t.status}`} task={t} showRunLink={false} />
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
                    {a.stepKey} · sha256 {a.sha256.slice(0, 20)}… · {fmtDate(a.createdAt)}
                  </Text>
                </Card>
              ))}
            </SimpleGrid>
          </Tabs.Panel>

          <Tabs.Panel value="log" pt="sm">
            <div className="table-scroll">
              <Table fz="sm" verticalSpacing={2}>
                <Table.Tbody>
                  {r.logs.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td className="nowrap mono">{new Date(l.ts).toLocaleTimeString()}</Table.Td>
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
          </Tabs.Panel>

          <Tabs.Panel value="inputs" pt="sm">
            <Stack>
              <Text fw={600} size="sm">
                Connections
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
                Inputs
              </Text>
              <JsonView value={r.inputs} />
              {r.outputs && Object.keys(r.outputs).length > 0 && (
                <>
                  <Text fw={600} size="sm">
                    Outputs
                  </Text>
                  <JsonView value={r.outputs} />
                </>
              )}
              <Text size="xs" c="dimmed" className="mono">
                Definition hash {r.definitionHash}
              </Text>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="audit" pt="sm">
            <RunAudit runId={r.id} />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </>
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
  return (
    <Paper withBorder p="sm">
      <Group gap={6} mb={6}>
        <IconBoxMultiple size={16} />
        <Text fw={600} size="sm">
          Sub-process runs ({runs.length})
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

function StepRow({ runId, step, childRuns }: { runId: string; step: RunStepRecord; childRuns?: RunChild[] }) {
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
        <Stack gap="xs" mt="xs">
          <Text size="xs" c="dimmed" className="mono">
            {step.key} · started {fmtDate(step.startedAt)}
          </Text>
          {step.error && <Alert color="red" p="xs">{step.error}</Alert>}
          {childRuns && childRuns.length > 0 && (
            <Group gap={6}>
              <Text size="xs" fw={600}>
                Child run:
              </Text>
              {childRuns.map((c) => (
                <Anchor key={c.id} component={Link} to={`/runs/${c.id}`} size="xs" className="mono">
                  {c.id} ({c.status})
                </Anchor>
              ))}
            </Group>
          )}
          {s.input !== undefined && s.input !== null && (
            <>
              <Text size="xs" fw={600}>
                Request / configuration
              </Text>
              <JsonView value={s.input} maxHeight={260} />
            </>
          )}
          {s.output !== undefined && s.output !== null && (
            <>
              <Group gap="xs">
                <Text size="xs" fw={600}>
                  Result
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
                    Load full result
                  </Button>
                )}
              </Group>
              <JsonView value={s.output} maxHeight={400} />
            </>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}

function RunAudit({ runId }: { runId: string }) {
  const q = useQuery({ queryKey: ['audit', 'run', runId], queryFn: () => get<AuditEntry[]>(`/audit?runId=${runId}&limit=1000`) });
  return (
    <div className="table-scroll">
      <Table fz="sm" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Time</Table.Th>
            <Table.Th>Actor</Table.Th>
            <Table.Th>Action</Table.Th>
            <Table.Th>Summary</Table.Th>
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
