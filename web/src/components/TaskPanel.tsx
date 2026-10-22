import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Group, Paper, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { IconCheck, IconSearch, IconX } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { TaskRecord } from '@sm/shared';
import { notifyError, notifyOk, post } from '../api';
import { fmtDate } from '../format';
import { Markdown, StatusBadge, subjectLabel } from './common';
import { useMe } from '../auth';

const MAX_ROWS = 1000;

export function TaskPanel({ task, showRunLink = true }: { task: TaskRecord; showRunLink?: boolean }) {
  const { t } = useTranslation(['tasks', 'common']);
  const { username } = useMe();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(task.items.filter((i) => i.preselected).map((i) => i.key)));
  const [filter, setFilter] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const isOpen = task.status === 'open';
  /** open and this user may decide → interactive */
  const open = isOpen && task.canDecide !== false;
  const decided = new Set(task.decision?.selectedKeys ?? []);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? task.items.filter((i) => i.cells.some((c) => c.toLowerCase().includes(f))) : task.items;
  }, [filter, task.items]);

  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.key));
  const someVisibleSelected = visible.some((i) => selected.has(i.key));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allVisibleSelected) visible.forEach((i) => next.delete(i.key));
    else visible.forEach((i) => next.add(i.key));
    setSelected(next);
  };

  const submit = async (approved: boolean) => {
    setBusy(approved ? 'approve' : 'reject');
    try {
      await post(`/tasks/${task.id}/complete`, {
        approved,
        selectedKeys: task.mode === 'select' ? [...selected] : [],
        comment: comment || undefined,
      });
      notifyOk(task.mode === 'select' ? t('panel.submitted', { count: selected.size }) : approved ? t('panel.approved') : t('panel.rejected'));
      await qc.invalidateQueries();
    } catch (e) {
      notifyError(e, t('panel.submitFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Paper withBorder p="md" component="section" aria-label={`Task: ${task.title}`}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs">
              <Title order={4}>{task.title}</Title>
              <StatusBadge status={task.status} />
              {task.dryRun && (
                <Badge color="yellow" variant="light">
                  {t('common:status.dryrun')}
                </Badge>
              )}
              {task.fourEyes && (
                <Badge color="grape" variant="light" title={t('panel.fourEyesHint')}>
                  {t('panel.fourEyes')}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {task.processName}
              {showRunLink && (
                <>
                  {' · '}
                  <Anchor component={Link} to={`/runs/${task.runId}`} size="xs">
                    {t('panel.openRun')}
                  </Anchor>
                </>
              )}
              {' · '}
              {t('panel.created', { date: fmtDate(task.createdAt) })}
              {task.startedBy ? ` · ${t('panel.startedBy', { user: task.startedBy })}` : ''}
            </Text>
            {task.assignees?.length > 0 && (
              <Group gap={4} mt={4}>
                <Text size="xs" c="dimmed">
                  {t('panel.assignedTo')}
                </Text>
                {task.assignees.map((a) => (
                  <Badge key={a} size="xs" variant="outline" tt="none" color={a.startsWith('user:') ? 'blue' : a.startsWith('team:') ? 'grape' : 'gray'}>
                    {subjectLabel(a)}
                  </Badge>
                ))}
              </Group>
            )}
          </div>
        </Group>
        <Markdown text={task.instructions} />

        {task.mode === 'select' && (
          <>
            <Group justify="space-between" wrap="wrap" gap="xs">
              <TextInput
                size="xs"
                placeholder={t('panel.filter')}
                leftSection={<IconSearch size={14} />}
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                w={220}
              />
              <Text size="sm" c="dimmed">
                {open
                  ? t('panel.selectedOf', { count: selected.size, total: task.items.length })
                  : t('panel.wereSelectedOf', { count: decided.size, total: task.items.length })}
              </Text>
            </Group>
            <div className="table-scroll">
              <Table striped highlightOnHover withTableBorder verticalSpacing={4} fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={36}>
                      {open && (
                        <Checkbox
                          size="xs"
                          checked={allVisibleSelected}
                          indeterminate={!allVisibleSelected && someVisibleSelected}
                          onChange={toggleAll}
                          aria-label={t('panel.selectAll')}
                        />
                      )}
                    </Table.Th>
                    {task.columns.map((c) => (
                      <Table.Th key={c.label}>{c.label}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {visible.slice(0, MAX_ROWS).map((i) => (
                    <Table.Tr
                      key={i.key}
                      className={open ? 'clickable' : undefined}
                      onClick={() => {
                        if (!open) return;
                        const next = new Set(selected);
                        if (next.has(i.key)) next.delete(i.key);
                        else next.add(i.key);
                        setSelected(next);
                      }}
                    >
                      <Table.Td>
                        {open ? (
                          <Checkbox size="xs" checked={selected.has(i.key)} readOnly aria-label={t('panel.selectItem', { name: i.cells[0] ?? i.key })} />
                        ) : decided.has(i.key) ? (
                          <IconCheck size={14} color="var(--mantine-color-green-6)" />
                        ) : (
                          <IconX size={14} color="var(--mantine-color-gray-5)" />
                        )}
                      </Table.Td>
                      {i.cells.map((c, j) => (
                        <Table.Td key={j}>{c}</Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            {visible.length > MAX_ROWS && (
              <Text size="xs" c="dimmed">
                {t('panel.truncated', { max: MAX_ROWS, total: visible.length })}
              </Text>
            )}
          </>
        )}

        {isOpen && !open ? (
          <Alert color="gray" variant="light">
            {t('panel.waitingForOthers', {
              reason:
                task.fourEyes && task.startedBy && task.startedBy.toLowerCase() === username.toLowerCase()
                  ? t('panel.reasonFourEyes')
                  : task.assignees?.length
                    ? t('panel.reasonAssigned', { subjects: task.assignees.map(subjectLabel).join(', ') })
                    : t('panel.reasonRights'),
            })}
          </Alert>
        ) : open ? (
          <>
            <Textarea label={t('panel.comment')} autosize minRows={1} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
            <Group justify="flex-end">
              {task.mode === 'approve' ? (
                <>
                  <Button color="red" variant="light" leftSection={<IconX size={16} />} loading={busy === 'reject'} onClick={() => submit(false)}>
                    {t('panel.reject')}
                  </Button>
                  <Button color="green" leftSection={<IconCheck size={16} />} loading={busy === 'approve'} onClick={() => submit(true)}>
                    {t('panel.approve')}
                  </Button>
                </>
              ) : (
                <Button leftSection={<IconCheck size={16} />} loading={busy === 'approve'} onClick={() => submit(true)}>
                  {t('panel.submitSelection', { count: selected.size })}
                </Button>
              )}
            </Group>
          </>
        ) : task.status === 'completed' ? (
          <Alert color={task.mode === 'approve' && !task.decision?.approved ? 'red' : 'green'} variant="light">
            <Trans
              t={t}
              i18nKey={
                task.mode === 'approve' ? (task.decision?.approved ? 'panel.decidedApproved' : 'panel.decidedRejected') : 'panel.decidedSelected'
              }
              values={{ count: decided.size, user: task.decidedBy ?? '', date: fmtDate(task.decidedAt) }}
              components={{ b: <strong /> }}
            />
            {task.decision?.comment ? ` – ${t('panel.quoted', { text: task.decision.comment })}` : ''}
          </Alert>
        ) : (
          <Alert color="gray">{t('panel.cancelled')}</Alert>
        )}
      </Stack>
    </Paper>
  );
}
