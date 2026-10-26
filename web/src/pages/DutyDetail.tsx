import { useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Modal, Paper, Stack, Table, Text, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IconArchive, IconArchiveOff, IconCalendarOff, IconEdit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DutyDetail, DutySkip, ServiceDetail } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { DetailState, PageHeader, subjectLabel } from '../components/common';
import { Field } from '../components/records/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { confirmDanger } from '../components/confirm';
import { DutyFormModal, DutyLevelBadge, DutyStatusBadge, lastDay, SkipModal } from '../components/duties/common';
import { fmtDate } from '../format';

export function DutyDetailPage() {
  const { t } = useTranslation(['duties', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['duty', id], queryFn: () => get<DutyDetail>(`/duties/${id}`) });
  const d = q.data;
  const service = useQuery({ queryKey: ['service', d?.serviceId], queryFn: () => get<ServiceDetail>(`/services/${d!.serviceId}`), enabled: !!d?.canEdit });
  const [editing, setEditing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [deciding, setDeciding] = useState<{ skip: DutySkip; decision: 'approve' | 'reject' } | null>(null);
  const refresh = (x?: DutyDetail) => {
    if (x) qc.setQueryData(['duty', id], x);
    else void qc.invalidateQueries({ queryKey: ['duty', id] });
    void qc.invalidateQueries({ queryKey: ['duties'] });
  };
  if (!d) return <DetailState query={q} back="duties" />;
  const archive = async () => {
    if (!d.archived && !(await confirmDanger({ action: 'archive', message: t('archiveConfirm', { name: d.name }) }))) return;
    try {
      refresh(await post<DutyDetail>(`/duties/${d.id}/archive`, { archived: !d.archived }));
    } catch (e) {
      notifyError(e);
    }
  };
  const withdraw = async (s: DutySkip) => {
    try {
      refresh(await post<DutyDetail>(`/duties/${d.id}/skips/${s.id}/withdraw`));
      notifyOk(t('skips.withdrawn'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <PageHeader
        back="duties"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{d.name}</span>
            <DutyLevelBadge level={d.level} />
            {d.archived && (
              <Badge variant="outline" color="gray">
                {t('archived')}
              </Badge>
            )}
          </Group>
        }
        description={
          <>
            {t('service')}:{' '}
            <Anchor component={Link} to={`/services/${d.serviceId}`} size="sm">
              {d.serviceName}
            </Anchor>
          </>
        }
        actions={
          <>
            {d.canRequestSkip && (
              <Button size="xs" variant="default" leftSection={<IconCalendarOff size={14} />} onClick={() => setSkipping(true)}>
                {t('askSkip')}
              </Button>
            )}
            {d.canEdit && (
              <>
                <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                  {t('common:edit')}
                </Button>
                <Button size="xs" variant="default" leftSection={d.archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />} onClick={archive}>
                  {d.archived ? t('restore') : t('archive')}
                </Button>
              </>
            )}
          </>
        }
      />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {d.description.trim() && <MarkdownView text={d.description} />}
            <Stack gap="xs" data-testid="duty-skips">
              <Text fw={600}>{t('skips.title')}</Text>
              {d.skips.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('skips.empty')}
                </Text>
              ) : (
                d.skips.map((s) => (
                  <Paper key={s.id} withBorder p="sm" data-testid={`skip-${s.periodKey}`}>
                    <Group justify="space-between" align="flex-start" wrap="wrap">
                      <Stack gap={2} style={{ minWidth: 0 }}>
                        <Group gap={6}>
                          <Text size="sm" fw={600}>
                            {s.periodKey}
                          </Text>
                          <Badge size="xs" variant="light" color={s.status === 'approved' ? 'green' : s.status === 'pending' ? 'violet' : 'gray'} tt="none">
                            {t(`skips.statuses.${s.status}`)}
                          </Badge>
                        </Group>
                        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                          {s.reason}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t('skips.requested', { user: s.requestedBy, date: fmtDate(s.requestedAt) })}
                          {s.decidedBy && s.decidedAt && s.status !== 'withdrawn'
                            ? ` · ${t('skips.decided', { status: t(`skips.statuses.${s.status}`), user: s.decidedBy, date: fmtDate(s.decidedAt) })}`
                            : ''}
                        </Text>
                        {s.comment && (
                          <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                            {s.comment}
                          </Text>
                        )}
                        {s.decideBlocked && (
                          <Text size="xs" c="orange">
                            {t('skips.fourEyes')}
                          </Text>
                        )}
                      </Stack>
                      <Group gap="xs">
                        {s.canDecide && (
                          <>
                            <Button size="xs" color="green" onClick={() => setDeciding({ skip: s, decision: 'approve' })}>
                              {t('skips.approve')}
                            </Button>
                            <Button size="xs" variant="default" onClick={() => setDeciding({ skip: s, decision: 'reject' })}>
                              {t('skips.reject')}
                            </Button>
                          </>
                        )}
                        {s.canWithdraw && (
                          <Button size="xs" variant="subtle" onClick={() => void withdraw(s)}>
                            {t('skips.withdraw')}
                          </Button>
                        )}
                      </Group>
                    </Group>
                  </Paper>
                ))
              )}
            </Stack>
            <Stack gap="xs" data-testid="duty-periods">
              <Text fw={600} id="duty-periods-title">
                {t('history')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('historyHint')}
              </Text>
              <div className="table-scroll">
                <Table fz="sm" aria-labelledby="duty-periods-title">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('period')}</Table.Th>
                      <Table.Th>{t('status')}</Table.Th>
                      <Table.Th>{t('evidence')}</Table.Th>
                      <Table.Th>{t('level')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.periods.slice(0, 60).map((p) => (
                      <Table.Tr key={p.key} data-testid={`period-${p.key}`}>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {p.key}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {t('dueBy', { date: lastDay(p.end, p.snapshot.timeZone) })} · {p.closed ? t('stateClosed') : t('stateOpen')}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <DutyStatusBadge period={p} size="xs" />
                          {p.failedRuns > 0 && (
                            <Text size="xs" c="dimmed">
                              {t('failedRuns', { count: p.failedRuns })}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {p.run ? (
                            <Anchor component={Link} to={`/runs/${p.run.id}`} size="sm">
                              {p.run.finishedAt ? fmtDate(p.run.finishedAt) : p.run.id}
                            </Anchor>
                          ) : p.skip?.status === 'approved' ? (
                            <Text size="xs">{p.skip.reason}</Text>
                          ) : (
                            t('noRun')
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">
                            {t(`levels.${p.snapshot.level}`)} · {t(`intervals.${p.snapshot.interval}`)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('current')}>
                <Group gap={6}>
                  <DutyStatusBadge period={d.current} />
                  {d.current && (
                    <Text size="xs" c="dimmed">
                      {d.current.key}
                    </Text>
                  )}
                </Group>
              </Field>
              <Field label={t('process')}>
                {d.processId ? (
                  <Anchor component={Link} to={`/processes/${d.processId}`} size="sm">
                    {d.processName}
                  </Anchor>
                ) : (
                  <Text size="sm" fs="italic">
                    {t('processHidden')}
                  </Text>
                )}
              </Field>
              <Field label={t('schedule')}>
                <Text size="sm">
                  {d.schedule
                    ? [
                        d.schedule.name,
                        !d.schedule.enabled && t('scheduleDisabled'),
                        d.schedule.dryRun && t('scheduleDryRun'),
                        d.schedule.nextRunAt && t('nextRun', { date: fmtDate(d.schedule.nextRunAt) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : t('noSchedule')}
                </Text>
              </Field>
              {d.applicationName && (
                <Field label={t('application')}>
                  <Anchor component={Link} to={`/applications/${d.applicationId}`} size="sm">
                    {d.applicationName}
                  </Anchor>
                </Field>
              )}
              <Field label={t('interval')}>
                <Text size="sm">
                  {t(`intervals.${d.interval}`)}
                  {d.graceDays ? ` ${t('graceShort', { count: d.graceDays })}` : ''}
                </Text>
              </Field>
              <Field label={t('remindDays')}>
                <Text size="sm">{d.remindDays || '–'}</Text>
              </Field>
              <Field label={t('owners')}>
                <Text size="sm">{d.owners.map(subjectLabel).join(', ') || '–'}</Text>
              </Field>
              <Text size="xs" c="dimmed">
                {t('createdBy', { user: d.createdBy, date: fmtDate(d.createdAt) })}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && (
        <DutyFormModal
          serviceId={d.serviceId}
          applications={(service.data?.applications ?? []).map((a) => ({ id: a.id, name: a.name }))}
          duty={d}
          onClose={() => setEditing(false)}
          onSaved={refresh}
        />
      )}
      {skipping && <SkipModal duty={d} onClose={() => setSkipping(false)} onSaved={refresh} />}
      {deciding && <DecisionModal duty={d} {...deciding} onClose={() => setDeciding(null)} onSaved={refresh} />}
    </>
  );
}

function DecisionModal({
  duty,
  skip,
  decision,
  onClose,
  onSaved,
}: {
  duty: DutyDetail;
  skip: DutySkip;
  decision: 'approve' | 'reject';
  onClose: () => void;
  onSaved: (d: DutyDetail) => void;
}) {
  const { t } = useTranslation(['duties', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<DutyDetail>(`/duties/${duty.id}/skips/${skip.id}/decision`, { decision, comment: comment.trim() }));
      notifyOk(decision === 'approve' ? t('skips.approved') : t('skips.rejected'));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t(decision === 'approve' ? 'skips.approveTitle' : 'skips.rejectTitle', { period: skip.periodKey })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {skip.reason}
          </Text>
          <Textarea
            label={t('skips.comment')}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={2000}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} color={decision === 'approve' ? 'green' : undefined}>
              {decision === 'approve' ? t('skips.approve') : t('skips.reject')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
