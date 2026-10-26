import { useState } from 'react';
import { Badge, Button, Group, Modal, NumberInput, Select, Stack, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DUTY_INTERVALS,
  DUTY_LEVELS,
  DUTY_LIMITS,
  type DutyDetail,
  type DutyInterval,
  type DutyLevel,
  type DutyPeriod,
  type DutyPeriodStatus,
  type DutySummary,
  type ProcessSummary,
  type Schedule,
} from '@sm/shared';
import { get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { TONE, useFieldErrors } from '../common';
import { dateTimeFormat } from '../../format';

/** Colours of period statuses (the label always says the status, too). */
export const DUTY_STATUS_COLORS: Record<DutyPeriodStatus, string> = {
  due: TONE.active,
  done: TONE.ok,
  late: TONE.soon,
  skipped: TONE.neutral,
  failed: TONE.bad,
  missed: TONE.bad,
  inactive: TONE.neutral,
};
const LEVEL_COLORS: Record<DutyLevel, string> = { mandatory: 'red', recommended: 'blue', optional: 'gray' };

export function DutyStatusBadge({ period, size = 'sm' }: { period: DutyPeriod | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('duties');
  if (!period) return <Text size="sm">–</Text>;
  return (
    <Badge size={size} color={DUTY_STATUS_COLORS[period.status]} variant="light" data-testid="duty-status" data-status={period.status}>
      {t(`statuses.${period.status}`)}
    </Badge>
  );
}

export function DutyLevelBadge({ level }: { level: DutyLevel }) {
  const { t } = useTranslation('duties');
  return (
    <Badge size="xs" variant="outline" color={LEVEL_COLORS[level]} tt="none">
      {t(`levels.${level}`)}
    </Badge>
  );
}

/** The last day of a period (its end is the midnight after it), in the instance time zone. */
export function lastDay(endIso: string, tz: string): string {
  return dateTimeFormat({ day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(Date.parse(endIso) - 1));
}

/** What a period needs or what made it done: "Due by 31 Oct 2026 · 1 failed run". */
export function PeriodLine({ period, tz }: { period: DutyPeriod; tz: string }) {
  const { t } = useTranslation('duties');
  const parts: string[] = [];
  if (period.status === 'due')
    parts.push(period.inGrace ? t('graceUntil', { date: lastDay(period.graceEndsAt, tz) }) : t('dueBy', { date: lastDay(period.end, tz) }));
  if ((period.status === 'done' || period.status === 'late') && period.run?.finishedAt)
    parts.push(t('doneBy', { date: dateTimeFormat({ day: 'numeric', month: 'short', timeZone: tz }).format(new Date(period.run.finishedAt)) }));
  if (period.failedRuns) parts.push(t('failedRuns', { count: period.failedRuns }));
  if (period.runsInProgress) parts.push(t('inProgress', { count: period.runsInProgress }));
  if (period.skip?.status === 'pending') parts.push(t('skips.statuses.pending'));
  return (
    <Text size="xs" c="dimmed">
      {period.key}
      {parts.length ? ` · ${parts.join(' · ')}` : ''}
    </Text>
  );
}

/** ISO week key (2026-W44) of the week that contains the UTC date of `t`. */
function isoWeekKey(t: number): string {
  const d = new Date(t);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The keys of the `n` periods after `p` (for planned exceptions). */
export function nextKeys(interval: DutyInterval, p: DutyPeriod, n: number): string[] {
  const out: string[] = [];
  const y = Number(p.key.slice(0, 4));
  const pad = (x: number) => String(x).padStart(2, '0');
  const per: Record<Exclude<DutyInterval, 'weekly'>, number> = { monthly: 12, quarterly: 4, halfYearly: 2, yearly: 1 };
  const prefix: Record<Exclude<DutyInterval, 'weekly'>, string> = { monthly: '', quarterly: 'Q', halfYearly: 'H', yearly: '' };
  for (let k = 1; k <= n; k++) {
    // the middle of the week k weeks later: never near a day boundary of any time zone
    if (interval === 'weekly') out.push(isoWeekKey(Date.parse(p.start) + (k * 7 + 3.5) * 86400000));
    else if (interval === 'yearly') out.push(String(y + k));
    else {
      const i = Number(p.key.slice(-2).replace(/\D/g, '')) - 1 + k;
      const yy = y + Math.floor(i / per[interval]);
      const x = (i % per[interval]) + 1;
      out.push(`${yy}-${prefix[interval]}${interval === 'monthly' ? pad(x) : x}`);
    }
  }
  return out;
}

// ---------- forms ----------

/** Create or edit a duty of a service. */
export function DutyFormModal({
  serviceId,
  applications,
  duty,
  onClose,
  onSaved,
}: {
  serviceId: string;
  applications: { id: string; name: string }[];
  duty?: DutySummary;
  onClose: () => void;
  onSaved: (d: DutyDetail) => void;
}) {
  const { t } = useTranslation(['duties', 'common']);
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => getOptional<Schedule[]>('/schedules', []) });
  const [name, setName] = useState(duty?.name ?? '');
  const [description, setDescription] = useState(duty?.description ?? '');
  const [processId, setProcessId] = useState<string | null>(duty?.processId ?? null);
  const [scheduleId, setScheduleId] = useState<string | null>(duty?.schedule?.id ?? null);
  const [applicationId, setApplicationId] = useState<string | null>(duty?.applicationId ?? null);
  const [interval, setInterval] = useState<DutyInterval>(duty?.interval ?? 'monthly');
  const [level, setLevel] = useState<DutyLevel>(duty?.level ?? 'mandatory');
  const [graceDays, setGraceDays] = useState<number>(duty?.graceDays ?? 0);
  const [remindDays, setRemindDays] = useState<number>(duty?.remindDays ?? 5);
  const [owners, setOwners] = useState<string[]>(duty?.owners ?? []);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    process: !processId && t('common:validation.required'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      description,
      processId,
      scheduleId,
      applicationId,
      interval,
      level,
      graceDays,
      remindDays,
      owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
    };
    try {
      const saved = duty ? await put<DutyDetail>(`/duties/${duty.id}`, body) : await post<DutyDetail>('/duties', { serviceId, ...body });
      notifyOk(t('saved'));
      onSaved(saved);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const procOptions = (processes.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  if (duty && duty.processId === null) procOptions.push({ value: '', label: t('processHidden') });
  return (
    <Modal opened onClose={onClose} title={duty ? t('editOf', { name: duty.name }) : t('add')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('name')}
            placeholder={t('namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={DUTY_LIMITS.name}
            required
            error={v.error('name')}
            data-autofocus
          />
          <Select
            label={t('process')}
            data={procOptions}
            value={processId}
            onChange={(x) => {
              setProcessId(x);
              setScheduleId(null);
            }}
            searchable
            required
            error={v.error('process')}
          />
          <Select
            label={t('schedule')}
            placeholder={t('noSchedule')}
            data={(schedules.data ?? []).filter((s) => s.processId === processId).map((s) => ({ value: s.id, label: s.name }))}
            value={scheduleId}
            onChange={setScheduleId}
            clearable
            disabled={!processId}
          />
          <Group grow align="flex-start">
            <Select
              label={t('interval')}
              data={DUTY_INTERVALS.map((x) => ({ value: x, label: t(`intervals.${x}`) }))}
              value={interval}
              onChange={(x) => x && setInterval(x as DutyInterval)}
              allowDeselect={false}
            />
            <Select
              label={t('level')}
              data={DUTY_LEVELS.map((x) => ({ value: x, label: t(`levels.${x}`) }))}
              value={level}
              onChange={(x) => x && setLevel(x as DutyLevel)}
              allowDeselect={false}
            />
          </Group>
          <Group grow align="flex-start">
            <NumberInput
              label={t('graceDays')}
              description={t('graceDaysHint')}
              min={0}
              max={DUTY_LIMITS.graceDays}
              value={graceDays}
              onChange={(x) => setGraceDays(typeof x === 'number' ? x : 0)}
            />
            <NumberInput
              label={t('remindDays')}
              description={t('remindDaysHint')}
              min={0}
              max={DUTY_LIMITS.remindDays}
              value={remindDays}
              onChange={(x) => setRemindDays(typeof x === 'number' ? x : 0)}
            />
          </Group>
          {applications.length > 0 && (
            <Select
              label={t('application')}
              placeholder={t('noApplication')}
              data={applications.map((a) => ({ value: a.id, label: a.name }))}
              value={applicationId}
              onChange={setApplicationId}
              clearable
            />
          )}
          <TagsInput label={t('owners')} description={t('ownersHint')} value={owners} onChange={setOwners} maxTags={DUTY_LIMITS.owners} />
          <Textarea
            label={t('descriptionLabel')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={DUTY_LIMITS.description}
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

/** Ask for an exception: the current period (or the one in its grace period) or one of the next ones. */
export function SkipModal({ duty, onClose, onSaved }: { duty: DutySummary; onClose: () => void; onSaved: (d: DutyDetail) => void }) {
  const { t } = useTranslation(['duties', 'common']);
  const open = [duty.previous, duty.current].filter((p): p is DutyPeriod => !!p && !p.closed && p.status === 'due' && Date.parse(p.graceEndsAt) > Date.now());
  const keys = [...new Set([...open.map((p) => p.key), ...(duty.current ? nextKeys(duty.interval, duty.current, 6) : [])])];
  const [periodKey, setPeriodKey] = useState<string | null>(keys[0] ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ reason: !reason.trim() && t('common:validation.required'), period: !periodKey && t('common:validation.required') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      onSaved(await post<DutyDetail>(`/duties/${duty.id}/skips`, { periodKey, reason: reason.trim() }));
      notifyOk(t('skips.asked'));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('askSkipOf', { name: duty.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Select label={t('skips.period')} data={keys} value={periodKey} onChange={setPeriodKey} allowDeselect={false} required error={v.error('period')} />
          <Textarea
            label={t('skips.reason')}
            description={t('skips.reasonHint')}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={DUTY_LIMITS.reason}
            required
            error={v.error('reason')}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('skips.ask')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
