import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  List,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconArrowBackUp, IconCheck, IconFileUpload, IconShieldCheck, IconTrash, IconX } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  entryEvidence,
  type ManualCompletion,
  type ManualSubmission,
  type ManualTaskSpec,
  type ManualTaskState,
  type TaskEvidence,
  type TaskRecord,
} from '@sm/shared';
import { api, apiUrl, del, notifyError, notifyOk, post } from '../api';
import { fmtBytes, fmtDate } from '../format';
import { codeText } from '../i18n/errors';
import { subjectLabel } from './common';
import { confirmDanger } from './confirm';
import { MarkdownView } from './records/MarkdownView';
import { TaskHeader } from './TaskHeader';

type Field = ManualTaskSpec['fields'][number];

/** "2026-10-26T09:30" in the browser's time zone, for <input type="datetime-local"> */
const localInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string): string | undefined => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/**
 * A manual step (user task in mode "manual"): the person doing it ticks the checklist, fills in the fields, adds
 * evidence files and completes it; a second person verifies it when the step asks for that. Instructions are
 * Markdown, rendered without interpreting HTML.
 */
export function ManualTaskPanel({ task, showRunLink }: { task: TaskRecord; showRunLink: boolean }) {
  const { t } = useTranslation(['tasks', 'common']);
  const m = task.manual!;
  const open = task.status === 'open';
  const verifying = open && m.stage === 'verify';
  const badges = (
    <>
      {verifying && (
        <Badge color="orange" variant="light">
          {t('manual.waitingVerification')}
        </Badge>
      )}
      {m.spec.verification.required && (
        <Badge color="grape" variant="light" leftSection={<IconShieldCheck size={12} />}>
          {t('manual.secondPerson')}
        </Badge>
      )}
    </>
  );
  return (
    <Paper withBorder p="md" component="section" aria-label={t('panelLabel', { title: task.title })}>
      <Stack gap="sm">
        <TaskHeader task={task} showRunLink={showRunLink} badges={badges} />
        {task.instructions && <MarkdownView text={task.instructions} compact />}
        {m.returned.length > 0 && m.stage === 'work' && open && <Returned m={m} />}
        {open && m.stage === 'work' && task.canDecide !== false ? (
          <WorkForm task={task} />
        ) : (
          <>
            {m.submission && <SubmissionView task={task} sub={m.submission} />}
            {!m.submission && <EvidenceList task={task} canRemove={false} />}
            {open && m.stage === 'work' && <Waiting task={task} />}
            {verifying && (task.canDecide ? <VerifyForm task={task} /> : <Waiting task={task} />)}
            {!open && <Outcome task={task} />}
          </>
        )}
      </Stack>
    </Paper>
  );
}

function Waiting({ task }: { task: TaskRecord }) {
  const { t } = useTranslation('tasks');
  const reason = codeText(task.cannotDecideCode, task.cannotDecideParams, task.cannotDecideReason) ?? task.cannotDecideReason ?? '';
  return (
    <Alert color="gray" variant="light">
      {task.manual?.stage === 'verify' ? t('manual.waitingForVerifier', { reason }) : t('panel.waitingForOthers', { reason })}
    </Alert>
  );
}

function Returned({ m }: { m: ManualTaskState }) {
  const { t } = useTranslation('tasks');
  const last = m.returned[m.returned.length - 1]!;
  return (
    <Alert color="orange" variant="light" icon={<IconArrowBackUp size={18} />} title={t('manual.returnedTitle')}>
      {t('manual.returnedBody', { user: last.rejection.by, date: fmtDate(last.rejection.at), comment: last.rejection.comment ?? '' })}
    </Alert>
  );
}

function Outcome({ task }: { task: TaskRecord }) {
  const { t } = useTranslation('tasks');
  const m = task.manual!;
  if (task.status === 'cancelled') return <Alert color="gray">{t('panel.cancelled')}</Alert>;
  const v = m.verification;
  if (v && !v.approved)
    return (
      <Alert color="red" variant="light">
        {t('manual.rejectedFailed', { user: v.by, date: fmtDate(v.at), comment: v.comment ?? '' })}
      </Alert>
    );
  return (
    <Alert color="green" variant="light">
      {v
        ? t('manual.doneVerified', { user: m.submission?.completedBy ?? '', verifier: v.by, date: fmtDate(v.at) })
        : t('manual.done', { user: m.submission?.completedBy ?? '', date: fmtDate(m.submission?.completedAt) })}
      {v?.comment ? ` – ${t('panel.quoted', { text: v.comment })}` : ''}
    </Alert>
  );
}

// ---------- person A: complete the step ----------

function WorkForm({ task }: { task: TaskRecord }) {
  const { t } = useTranslation(['tasks', 'common']);
  const qc = useQueryClient();
  const m = task.manual!;
  const spec = m.spec;
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [na, setNa] = useState<Record<string, string | undefined>>({});
  const [late, setLate] = useState(false);
  const [doneAt, setDoneAt] = useState(() => localInput(new Date()));
  const [doneAtReason, setDoneAtReason] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const needsEvidence = spec.evidence === 'required' && !m.evidence.some((e) => e.round === m.round);
  const verification = spec.verification.required || m.returned.length > 0 || late || Object.values(na).some((v) => v !== undefined);
  const setValue = (id: string, v: string) => setValues((x) => ({ ...x, [id]: v }));
  const toggleNa = (target: string, on: boolean) => setNa((x) => ({ ...x, [target]: on ? '' : undefined }));

  const submit = async () => {
    const body: ManualCompletion = {
      checked: [...checked],
      fields: spec.fields.map((f) => ({ id: f.id, value: f.type === 'datetime' ? (fromLocalInput(values[f.id] ?? '') ?? '') : (values[f.id] ?? '') })),
      notAvailable: Object.entries(na)
        .filter((e): e is [string, string] => e[1] !== undefined && (e[0] !== 'evidence' || needsEvidence))
        .map(([target, reason]) => ({ target, reason })),
      comment: comment || undefined,
      ...(late ? { doneAt: fromLocalInput(doneAt) ?? doneAt, doneAtReason } : {}),
    };
    setBusy(true);
    try {
      const r = await post<{ verificationNeeded: boolean }>(`/tasks/${task.id}/complete`, body);
      notifyOk(r.verificationNeeded ? t('manual.completedVerify') : t('manual.completed'));
      await qc.invalidateQueries();
    } catch (e) {
      notifyError(e, t('manual.completeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      {spec.checklist.length > 0 && (
        <Stack gap={6} role="group" aria-label={t('manual.checklist')}>
          <Text size="sm" fw={600}>
            {t('manual.checklist')}
            {spec.checklistAllRequired && (
              <Text span size="xs" c="dimmed" fw={400}>
                {' '}
                · {t('manual.allRequired')}
              </Text>
            )}
          </Text>
          {spec.checklist.map((item, i) => (
            <Checkbox
              key={i}
              label={item}
              checked={checked.has(i)}
              onChange={(e) => {
                const next = new Set(checked);
                if (e.currentTarget.checked) next.add(i);
                else next.delete(i);
                setChecked(next);
              }}
            />
          ))}
        </Stack>
      )}

      {spec.fields.map((f) => (
        <FieldInput
          key={f.id}
          field={f}
          value={values[f.id] ?? ''}
          onChange={(v) => setValue(f.id, v)}
          na={na[f.id]}
          onNa={toggleNa}
          onNaReason={(r) => setNa((x) => ({ ...x, [f.id]: r }))}
        />
      ))}

      {spec.evidence !== 'off' && (
        <Stack gap={6}>
          <Group justify="space-between" wrap="wrap">
            <Text size="sm" fw={600}>
              {t('manual.evidence')}
              <Text span size="xs" c="dimmed" fw={400}>
                {' '}
                · {spec.evidence === 'required' ? t('manual.required') : t('manual.optional')}
              </Text>
            </Text>
            <EvidenceUpload task={task} />
          </Group>
          <EvidenceList task={task} canRemove />
          {needsEvidence && (
            <NotAvailable
              label={t('manual.evidenceNotAvailable')}
              value={na.evidence}
              onToggle={(on) => toggleNa('evidence', on)}
              onReason={(r) => setNa((x) => ({ ...x, evidence: r }))}
            />
          )}
        </Stack>
      )}

      <Switch label={t('manual.late')} description={t('manual.lateHint')} checked={late} onChange={(e) => setLate(e.currentTarget.checked)} />
      {late && (
        <Group grow align="flex-start" wrap="wrap">
          <TextInput
            type="datetime-local"
            label={t('manual.doneAt')}
            required
            value={doneAt}
            max={localInput(new Date())}
            onChange={(e) => setDoneAt(e.currentTarget.value)}
            miw={200}
          />
          <Textarea
            label={t('manual.doneAtReason')}
            required
            autosize
            minRows={1}
            value={doneAtReason}
            onChange={(e) => setDoneAtReason(e.currentTarget.value)}
            miw={200}
          />
        </Group>
      )}

      <Textarea label={t('panel.comment')} autosize minRows={1} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
      {verification && (
        <Alert color="grape" variant="light" icon={<IconShieldCheck size={18} />}>
          {t('manual.verificationNotice')}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button leftSection={<IconCheck size={16} />} loading={busy} onClick={submit}>
          {t('manual.complete')}
        </Button>
      </Group>
    </Stack>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  na,
  onNa,
  onNaReason,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
  na: string | undefined;
  onNa: (target: string, on: boolean) => void;
  onNaReason: (r: string) => void;
}) {
  const { t } = useTranslation('tasks');
  const required = field.use === 'required';
  const unavailable = na !== undefined;
  const type = field.type === 'datetime' ? 'datetime-local' : field.type === 'link' ? 'url' : 'text';
  return (
    <Stack gap={4}>
      <TextInput
        type={type}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        label={field.label}
        description={field.hint || (field.type === 'ticket' ? t('manual.ticketHint') : undefined)}
        placeholder={field.type === 'link' ? 'https://…' : undefined}
        withAsterisk={required && !unavailable}
        disabled={unavailable}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {required && !value.trim() && (
        <NotAvailable label={t('manual.fieldNotAvailable', { field: field.label })} value={na} onToggle={(on) => onNa(field.id, on)} onReason={onNaReason} />
      )}
    </Stack>
  );
}

function NotAvailable({
  label,
  value,
  onToggle,
  onReason,
}: {
  label: string;
  value: string | undefined;
  onToggle: (on: boolean) => void;
  onReason: (r: string) => void;
}) {
  const { t } = useTranslation('tasks');
  return (
    <Stack gap={4} pl="md">
      <Checkbox size="xs" label={label} checked={value !== undefined} onChange={(e) => onToggle(e.currentTarget.checked)} />
      {value !== undefined && (
        <Textarea size="xs" label={t('manual.because')} required autosize minRows={1} value={value} onChange={(e) => onReason(e.currentTarget.value)} />
      )}
    </Stack>
  );
}

function EvidenceUpload({ task }: { task: TaskRecord }) {
  const { t } = useTranslation('tasks');
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const upload = async (files: File[]) => {
    setBusy(true);
    try {
      for (const f of files) {
        const form = new FormData();
        form.append('file', f, f.name);
        await api('POST', `/tasks/${task.id}/evidence`, form);
      }
    } catch (e) {
      notifyError(e, t('manual.uploadFailed'));
    } finally {
      setBusy(false);
      await qc.invalidateQueries();
    }
  };
  return (
    <FileButton onChange={(f) => void upload(f)} multiple>
      {(props) => (
        <Button size="xs" variant="default" leftSection={<IconFileUpload size={14} />} loading={busy} {...props}>
          {t('manual.addEvidence')}
        </Button>
      )}
    </FileButton>
  );
}

function EvidenceList({ task, canRemove }: { task: TaskRecord; canRemove: boolean }) {
  const { t } = useTranslation('tasks');
  const qc = useQueryClient();
  const m = task.manual!;
  // the entry's files: fixed when it was completed, else this round's
  const files = entryEvidence(m);
  if (!files.length)
    return m.spec.evidence === 'off' ? null : (
      <Text size="xs" c="dimmed">
        {t('manual.noEvidence')}
      </Text>
    );
  const remove = async (e: TaskEvidence) => {
    if (!(await confirmDanger({ action: 'remove', message: t('manual.removeConfirm', { name: e.filename }) }))) return;
    try {
      await del(`/tasks/${task.id}/evidence/${e.id}`);
    } catch (err) {
      notifyError(err);
    } finally {
      await qc.invalidateQueries();
    }
  };
  return (
    <div className="table-scroll">
      <Table fz="sm" aria-label={t('manual.evidence')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('manual.file')}</Table.Th>
            <Table.Th>{t('manual.size')}</Table.Th>
            <Table.Th>SHA-256</Table.Th>
            <Table.Th>{t('manual.added')}</Table.Th>
            {canRemove && <Table.Th aria-label={t('manual.actions')} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td style={{ overflowWrap: 'anywhere', minWidth: 140 }}>
                <Anchor href={apiUrl(`/tasks/${task.id}/evidence/${e.id}/download`)} size="sm">
                  {e.filename}
                </Anchor>
              </Table.Td>
              <Table.Td className="nowrap">{fmtBytes(e.size)}</Table.Td>
              <Table.Td className="mono" title={e.sha256}>
                {e.sha256.slice(0, 16)}…
              </Table.Td>
              <Table.Td className="nowrap">
                {fmtDate(e.uploadedAt)} · {e.uploadedBy}
              </Table.Td>
              {canRemove && (
                <Table.Td>
                  {e.round === m.round && (
                    <ActionIcon variant="subtle" color="red" aria-label={t('manual.removeNamed', { name: e.filename })} onClick={() => void remove(e)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

// ---------- what was entered ----------

function FieldValue({ field, v }: { field: Field; v: ManualSubmission['fields'][number] | undefined }) {
  if (!v || v.value === null || v.value === '') return <>–</>;
  if (field.type === 'link' && typeof v.value === 'string' && /^https?:\/\//i.test(v.value))
    return (
      <Anchor href={v.value} target="_blank" rel="noopener noreferrer nofollow" size="sm" style={{ overflowWrap: 'anywhere' }}>
        {v.value}
      </Anchor>
    );
  if (field.type === 'ticket' && v.ticketId)
    return (
      <Anchor component={Link} to={`/tickets/${v.ticketId}`} size="sm">
        {String(v.value)}
      </Anchor>
    );
  if (field.type === 'datetime') return <>{fmtDate(String(v.value))}</>;
  return <>{String(v.value)}</>;
}

function SubmissionView({ task, sub }: { task: TaskRecord; sub: ManualSubmission }) {
  const { t } = useTranslation('tasks');
  const spec = task.manual!.spec;
  const na = new Map(sub.notAvailable.map((n) => [n.target, n.reason]));
  return (
    <Stack gap="xs">
      <Text size="sm">
        {t('manual.completedBy', { user: sub.completedBy, date: fmtDate(sub.completedAt) })}
        {sub.doneAt ? ` · ${t('manual.doneAtStated', { date: fmtDate(sub.doneAt) })}` : ''}
      </Text>
      {sub.doneAt && (
        <Alert color="yellow" variant="light" p="xs">
          {t('manual.lateReason', { reason: sub.doneAtReason ?? '' })}
        </Alert>
      )}
      {spec.checklist.length > 0 && (
        <List spacing={2} size="sm" aria-label={t('manual.checklist')} listStyleType="none">
          {spec.checklist.map((item, i) => {
            const ok = sub.checked.includes(i);
            return (
              <List.Item
                key={i}
                icon={
                  ok ? (
                    <IconCheck size={14} color="var(--mantine-color-green-6)" aria-label={t('manual.ticked')} />
                  ) : (
                    <IconX size={14} color="var(--mantine-color-red-6)" aria-label={t('manual.notTicked')} />
                  )
                }
              >
                {item}
              </List.Item>
            );
          })}
        </List>
      )}
      {spec.fields.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" withTableBorder aria-label={t('manual.fields')}>
            <Table.Tbody>
              {spec.fields.map((f) => (
                <Table.Tr key={f.id}>
                  <Table.Th w="35%">{f.label}</Table.Th>
                  <Table.Td>
                    {na.has(f.id) ? (
                      <Text size="sm" c="orange">
                        {t('manual.notAvailableValue', { reason: na.get(f.id) })}
                      </Text>
                    ) : (
                      <FieldValue field={f} v={sub.fields.find((x) => x.id === f.id)} />
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {spec.evidence !== 'off' && (
        <>
          <Text size="sm" fw={600}>
            {t('manual.evidence')}
          </Text>
          {na.has('evidence') ? (
            <Text size="sm" c="orange">
              {t('manual.notAvailableValue', { reason: na.get('evidence') })}
            </Text>
          ) : null}
          <EvidenceList task={task} canRemove={false} />
        </>
      )}
      {sub.comment && (
        <Text size="sm">
          {t('panel.comment')}: {t('panel.quoted', { text: sub.comment })}
        </Text>
      )}
    </Stack>
  );
}

// ---------- person B: verify ----------

function VerifyForm({ task }: { task: TaskRecord }) {
  const { t } = useTranslation('tasks');
  const qc = useQueryClient();
  const m = task.manual!;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const reasons = m.submission?.verificationReasons ?? [];
  const send = async (approved: boolean) => {
    setBusy(approved ? 'verify' : 'reject');
    try {
      await post(`/tasks/${task.id}/verify`, { approved, comment: comment || undefined });
      notifyOk(approved ? t('manual.verified') : m.spec.verification.onReject === 'fail' ? t('manual.rejectedRunFails') : t('manual.sentBack'));
      await qc.invalidateQueries();
    } catch (e) {
      notifyError(e, t('manual.verifyFailed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Stack gap="sm">
      <Alert color="grape" variant="light" icon={<IconShieldCheck size={18} />} title={t('manual.verifyTitle')}>
        <Stack gap={4}>
          <Text size="sm">{t('manual.verifyBody', { user: m.submission?.completedBy ?? '' })}</Text>
          {reasons.length > 0 && <Text size="xs">{t('manual.verifyBecause', { reasons: reasons.map((r) => t(`manual.reason.${r}`)).join(', ') })}</Text>}
          {m.spec.verification.verifiers.length > 0 && (
            <Text size="xs">{t('manual.verifiers', { subjects: m.spec.verification.verifiers.map(subjectLabel).join(', ') })}</Text>
          )}
        </Stack>
      </Alert>
      <Textarea
        label={t('manual.verifyComment')}
        description={t('manual.verifyCommentHint')}
        autosize
        minRows={1}
        value={comment}
        onChange={(e) => setComment(e.currentTarget.value)}
      />
      <Group justify="flex-end">
        <Button
          color="red"
          variant="light"
          leftSection={<IconX size={16} />}
          loading={busy === 'reject'}
          disabled={!comment.trim()}
          onClick={() => send(false)}
        >
          {m.spec.verification.onReject === 'fail' ? t('manual.rejectFail') : t('manual.sendBack')}
        </Button>
        <Button color="green" leftSection={<IconShieldCheck size={16} />} loading={busy === 'verify'} onClick={() => send(true)}>
          {t('manual.verify')}
        </Button>
      </Group>
    </Stack>
  );
}
