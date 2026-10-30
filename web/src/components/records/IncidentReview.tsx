import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Checkbox, Group, Modal, Paper, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconCheck, IconEdit, IconListDetails, IconPlus, IconReportMedical, IconRotate, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  MEASURE_LIMITS,
  type OpenMeasure,
  type RecordDetail,
  type RecordMeasure,
  type RecordMeasures,
  type RecordsMeta,
  type TimelineCandidates,
} from '@sm/shared';
import { del, get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { confirmDanger } from '../confirm';
import { fmtDate, fmtDay } from '../../format';

/** Incident reviews (#109): measures with owners and due dates, the timeline from what Steward saw, starting a review. */

const ownerLabel = (s: string) => s.replace(/^(user|team):/, '');

/** "2026-10-26T09:30" in the browser's time zone, for <input type="datetime-local"> */
const localInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): string | null => {
  const ms = Date.parse(v);
  return v && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function MeasureModal({
  recordId,
  measure,
  onClose,
  onSaved,
}: {
  recordId: string;
  measure?: RecordMeasure;
  onClose: () => void;
  onSaved: (m: RecordMeasures) => void;
}) {
  const { t } = useTranslation(['records', 'common']);
  const [title, setTitle] = useState(measure?.title ?? '');
  const [owners, setOwners] = useState<string[]>(measure?.owners ?? []);
  const [dueDate, setDueDate] = useState(measure?.dueDate ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const [note, setNote] = useState(measure?.note ?? '');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    owners: !owners.length && t('common:validation.required'),
    dueDate: !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && t('common:validation.required'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = { title: title.trim(), owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)), dueDate, note };
    try {
      onSaved(
        measure
          ? await put<RecordMeasures>(`/records/${recordId}/measures/${measure.id}`, body)
          : await post<RecordMeasures>(`/records/${recordId}/measures`, body),
      );
      notifyOk(t('review.saved'));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={measure ? t('review.editMeasure') : t('review.addMeasure')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('review.measureTitle')}
            required
            maxLength={MEASURE_LIMITS.title}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={v.error('title')}
            data-autofocus
          />
          <SubjectsInput label={t('review.owners')} value={owners} onChange={setOwners} max={10} error={v.error('owners') || undefined} />
          <TextInput
            type="date"
            label={t('review.dueDate')}
            required
            value={dueDate}
            onChange={(e) => setDueDate(e.currentTarget.value)}
            error={v.error('dueDate')}
          />
          <Textarea
            label={t('review.note')}
            autosize
            minRows={2}
            maxRows={5}
            maxLength={MEASURE_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The measures of a review: add, change, mark done, remove. */
export function MeasuresPanel({ recordId }: { recordId: string }) {
  const { t } = useTranslation(['records', 'common']);
  const qc = useQueryClient();
  const key = ['record-measures', recordId];
  const q = useQuery({ queryKey: key, queryFn: () => get<RecordMeasures>(`/records/${recordId}/measures`) });
  const [editing, setEditing] = useState<RecordMeasure | 'new' | null>(null);
  const set = (m: RecordMeasures) => qc.setQueryData(key, m);
  const toggle = async (m: RecordMeasure) => {
    try {
      set(await put<RecordMeasures>(`/records/${recordId}/measures/${m.id}`, { done: !m.doneAt }));
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (m: RecordMeasure) => {
    if (!(await confirmDanger({ action: 'remove', message: t('review.removeQuestion', { title: m.title }) }))) return;
    try {
      set(await del<RecordMeasures>(`/records/${recordId}/measures/${m.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const items = q.data?.items ?? [];
  return (
    <Stack gap="xs" mt="lg" data-testid="review-measures">
      <Group justify="space-between">
        <Text fw={600} id="review-measures-title">
          {t('review.measures')}
        </Text>
        {q.data?.canEdit && (
          <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => setEditing('new')}>
            {t('review.addMeasure')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('review.measuresHelp')}
      </Text>
      {q.isSuccess && items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('review.noMeasures')}
        </Text>
      )}
      {items.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="review-measures-title">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('review.measureTitle')}</Table.Th>
                <Table.Th>{t('review.owners')}</Table.Th>
                <Table.Th>{t('review.dueDate')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>
                    <Text size="sm" td={m.doneAt ? 'line-through' : undefined}>
                      {m.title}
                    </Text>
                    {m.note && (
                      <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                        {m.note}
                      </Text>
                    )}
                    {m.doneAt && (
                      <Text size="xs" c="dimmed">
                        {t('review.doneBy', { date: fmtDate(m.doneAt), user: m.doneBy ?? '' })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{m.owners.map(ownerLabel).join(', ')}</Table.Td>
                  <Table.Td className="nowrap">
                    {fmtDay(m.dueDate)}{' '}
                    {m.overdue && (
                      <Badge size="xs" color="red" variant="light">
                        {t('review.overdue')}
                      </Badge>
                    )}
                    {m.doneAt && (
                      <Badge size="xs" color="green" variant="light">
                        {t('review.done')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap" justify="flex-end">
                      <Tooltip label={m.doneAt ? t('review.reopen') : t('review.markDone')}>
                        <ActionIcon
                          variant="subtle"
                          aria-label={`${m.doneAt ? t('review.reopen') : t('review.markDone')}: ${m.title}`}
                          onClick={() => void toggle(m)}
                        >
                          {m.doneAt ? <IconRotate size={16} /> : <IconCheck size={16} />}
                        </ActionIcon>
                      </Tooltip>
                      {q.data?.canEdit && (
                        <>
                          <Tooltip label={t('review.editMeasure')}>
                            <ActionIcon variant="subtle" aria-label={`${t('review.editMeasure')}: ${m.title}`} onClick={() => setEditing(m)}>
                              <IconEdit size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={t('review.removeMeasure')}>
                            <ActionIcon variant="subtle" color="red" aria-label={`${t('review.removeMeasure')}: ${m.title}`} onClick={() => void remove(m)}>
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {editing && <MeasureModal recordId={recordId} measure={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={set} />}
    </Stack>
  );
}

/** Pick entries from what Steward saw in the incident's time window and copy them into the timeline. */
export function TimelineModal({ rec, onClose, onSaved }: { rec: RecordDetail; onClose: () => void; onSaved: (r: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const start = rec.fields.incidentStart || new Date(Date.now() - 3_600_000).toISOString();
  const [from, setFrom] = useState(localInput(new Date(Date.parse(start) - 30 * 60_000).toISOString()));
  const [to, setTo] = useState(
    localInput(rec.fields.incidentEnd ? new Date(Date.parse(rec.fields.incidentEnd) + 30 * 60_000).toISOString() : new Date().toISOString()),
  );
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['record-timeline', rec.id, range?.from, range?.to],
    queryFn: () => get<TimelineCandidates>(`/records/${rec.id}/timeline?from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}`),
    enabled: !!range,
    retry: false,
  });
  const load = () => {
    const f = fromLocal(from);
    const tt = fromLocal(to);
    if (f && tt) {
      setChosen(new Set());
      setRange({ from: f, to: tt });
    }
  };
  const items = q.data?.items ?? [];
  const copy = async () => {
    if (!range || !chosen.size) return;
    setBusy(true);
    try {
      onSaved(await post<RecordDetail>(`/records/${rec.id}/timeline`, { ...range, keys: [...chosen] }));
      notifyOk(t('review.timelineAdded'));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="xl" title={t('review.timelineTitle')}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('review.timelineHelp')}
        </Text>
        <Group align="flex-end" wrap="wrap">
          <TextInput type="datetime-local" label={t('review.from')} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput type="datetime-local" label={t('review.to')} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
          <Button variant="default" onClick={load} loading={q.isFetching}>
            {t('review.load')}
          </Button>
        </Group>
        {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
        {q.isSuccess && items.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('review.none')}
          </Text>
        )}
        {q.data?.truncated && (
          <Text size="xs" c="orange.8">
            {t('review.truncated')}
          </Text>
        )}
        {items.length > 0 && (
          <>
            <Checkbox
              label={t('review.selectAll')}
              checked={chosen.size === items.length}
              indeterminate={chosen.size > 0 && chosen.size < items.length}
              onChange={(e) => setChosen(e.currentTarget.checked ? new Set(items.map((i) => i.key)) : new Set())}
            />
            <Paper withBorder p="xs" mah={360} style={{ overflowY: 'auto' }} data-testid="timeline-candidates">
              <Stack gap={6}>
                {items.map((i) => (
                  <Checkbox
                    key={i.key}
                    checked={chosen.has(i.key)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.currentTarget.checked) next.add(i.key);
                      else next.delete(i.key);
                      setChosen(next);
                    }}
                    label={
                      <Group gap={6} wrap="nowrap" align="flex-start">
                        <Badge size="xs" variant="light" tt="none" miw={56}>
                          {t(`review.sources.${i.source}`)}
                        </Badge>
                        <Text size="xs" className="nowrap" c="dimmed">
                          {fmtDate(i.at)}
                        </Text>
                        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                          {i.text}
                        </Text>
                      </Group>
                    }
                  />
                ))}
              </Stack>
            </Paper>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void copy()} disabled={!chosen.size} loading={busy}>
            {t('review.addSelected', { count: chosen.size })}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** "Fill in the timeline" for a review whose text can still change. */
export function TimelineButton({ rec, onSaved }: { rec: RecordDetail; onSaved: (r: RecordDetail) => void }) {
  const { t } = useTranslation('records');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="default" leftSection={<IconListDetails size={14} />} onClick={() => setOpen(true)}>
        {t('review.timeline')}
      </Button>
      {open && <TimelineModal rec={rec} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

/** May the user create records (and so start a review)? */
export function useCanStartReview(): boolean {
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => getOptional<RecordsMeta | null>('/records/meta', null) });
  return !!meta.data?.canCreate;
}

/** Starts a review and opens it. */
export function useStartReview() {
  const { t } = useTranslation('records');
  const navigate = useNavigate();
  return async (body: Record<string, unknown>) => {
    try {
      const r = await post<RecordDetail>('/incident-reviews', body);
      notifyOk(t('review.started'));
      navigate(`/records/${r.id}`);
    } catch (e) {
      notifyError(e);
    }
  };
}

/** From a monitor: the time window of the outage (the last change to down until now, editable). */
export function MonitorReviewModal({ monitorId, since, onClose }: { monitorId: string; since: string | null; onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const start = useStartReview();
  const [from, setFrom] = useState(localInput(since ?? new Date(Date.now() - 3_600_000).toISOString()));
  const [to, setTo] = useState(localInput(new Date().toISOString()));
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened onClose={onClose} title={t('review.startFromMonitor')}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('review.startHelp')}
        </Text>
        <TextInput type="datetime-local" label={t('review.from')} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        <TextInput type="datetime-local" label={t('review.to')} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={!fromLocal(from)}
            onClick={() => {
              setBusy(true);
              void start({ source: 'monitor', monitorId, from: fromLocal(from), to: fromLocal(to) }).finally(() => setBusy(false));
            }}
          >
            {t('review.start')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Open measures of the reviews linked to a service; overdue first in red. Hidden when there are none. */
export function OpenMeasuresPanel({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation('records');
  const q = useQuery({ queryKey: ['service-measures', serviceId], queryFn: () => get<OpenMeasure[]>(`/measures?serviceId=${encodeURIComponent(serviceId)}`) });
  const items = q.data ?? [];
  if (!items.length) return null;
  return (
    <Stack gap="xs" data-testid="service-measures">
      <Group gap={6}>
        <IconReportMedical size={16} />
        <Text fw={600}>{t('review.openMeasures')}</Text>
      </Group>
      <Text size="xs" c="dimmed">
        {t('review.openMeasuresHelp')}
      </Text>
      <Stack gap={4}>
        {items.map((m) => (
          <Group key={m.id} gap={6} wrap="nowrap" align="flex-start">
            {m.overdue ? (
              <Badge size="xs" color="red" variant="light" mt={3}>
                {t('review.overdue')}
              </Badge>
            ) : (
              <Badge size="xs" variant="default" mt={3}>
                {t('review.due', { date: fmtDay(m.dueDate) })}
              </Badge>
            )}
            <Text size="sm">
              {m.title} · {m.owners.map(ownerLabel).join(', ')} ·{' '}
              <Anchor component={Link} to={`/records/${m.recordId}`} size="sm">
                {m.recordNumber}
              </Anchor>
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}
