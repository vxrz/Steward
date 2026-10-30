import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, List, Modal, NumberInput, Select, Stack, Switch, Text, TextInput, Textarea, MultiSelect } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCalendarEvent, IconDownload, IconEdit, IconPlus, IconTool, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  MAINTENANCE_LIMITS,
  MAINTENANCE_TARGET_KINDS,
  type ApplicationSummary,
  type MaintenanceFreq,
  type MaintenanceList,
  type MaintenanceTarget,
  type MaintenanceTargetKind,
  type MaintenanceWindowDetail,
  type MaintenanceWindowSummary,
  type Platform,
  type RecordSummary,
  type ServiceSummary,
  type SystemSummary,
} from '@sm/shared';
import { apiUrl, get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { confirmDialog } from '../confirm';
import { fmtDate, fmtDay } from '../../format';

/** Maintenance windows (#108): forms, details and the panel on platform, system, application and service pages. */

const HOUR = 3_600_000;

/** "2026-10-26T09:30" in the browser's time zone, for <input type="datetime-local"> */
const localInput = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): string | null => {
  const ms = Date.parse(v);
  return v && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export const targetLink = (t: { kind: MaintenanceTargetKind; id: string }) =>
  t.kind === 'platform'
    ? `/platforms/${t.id}`
    : t.kind === 'system'
      ? `/systems/${t.id}`
      : t.kind === 'application'
        ? `/applications/${t.id}`
        : `/services/${t.id}`;

/** "Weekly", "Every 2 months until 1 Mar 2027", or "Once". */
export function useRepeatLabel() {
  const { t } = useTranslation('applications');
  return (w: Pick<MaintenanceWindowSummary, 'recurrence'>) =>
    w.recurrence
      ? `${t(`maintenance.every.${w.recurrence.freq}`, { count: w.recurrence.interval })}${w.recurrence.until ? ` ${t('maintenance.until_label', { date: fmtDay(w.recurrence.until) })}` : ''}`
      : t('maintenance.repeatNone');
}

export function TargetBadges({ targets }: { targets: MaintenanceTarget[] }) {
  const { t } = useTranslation('applications');
  return (
    <Group gap={4} wrap="wrap">
      {targets.map((x) =>
        x.name ? (
          <Badge key={`${x.kind}:${x.id}`} size="sm" variant="light" tt="none" component={Link} to={targetLink(x)} style={{ cursor: 'pointer' }}>
            {x.name}
          </Badge>
        ) : (
          <Badge key={`${x.kind}:${x.id}`} size="sm" variant="default" tt="none">
            {t('maintenance.hiddenTarget')}
          </Badge>
        ),
      )}
    </Group>
  );
}

/** The current or next occurrence: "Now until …" or the start. */
export function WhenLine({ w }: { w: Pick<MaintenanceWindowSummary, 'current' | 'cancelledAt'> }) {
  const { t } = useTranslation('applications');
  if (w.cancelledAt)
    return (
      <Badge size="sm" color="gray" variant="light">
        {t('maintenance.cancelledBadge')}
      </Badge>
    );
  if (!w.current) return <Text size="sm">–</Text>;
  return (
    <Group gap={6} wrap="nowrap">
      {w.current.active && (
        <Badge size="sm" color="orange" variant="filled">
          {t('maintenance.now')}
        </Badge>
      )}
      <Text size="sm" className="nowrap">
        {fmtDate(w.current.startsAt)} – {fmtDate(w.current.endsAt)}
      </Text>
    </Group>
  );
}

/** Create or change a window. `preset`: a target to start with (from a platform, system, application or service page). */
export function MaintenanceFormModal({
  window: w,
  preset,
  onClose,
  onSaved,
}: {
  window?: MaintenanceWindowDetail;
  preset?: { kind: MaintenanceTargetKind; id: string };
  onClose: () => void;
  onSaved: (w: MaintenanceWindowDetail) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const nextHour = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
  const [title, setTitle] = useState(w?.title ?? '');
  const [note, setNote] = useState(w?.note ?? '');
  const [start, setStart] = useState(localInput(w?.startsAt ?? new Date(nextHour).toISOString()));
  const [end, setEnd] = useState(localInput(w?.endsAt ?? new Date(nextHour + 2 * HOUR).toISOString()));
  const [freq, setFreq] = useState<'none' | MaintenanceFreq>(w?.recurrence?.freq ?? 'none');
  const [interval, setInterval] = useState<number>(w?.recurrence?.interval ?? 1);
  const [until, setUntil] = useState(w?.recurrence?.until ? localInput(w.recurrence.until).slice(0, 10) : '');
  const [targets, setTargets] = useState<string[]>(w ? w.targets.map((x) => `${x.kind}:${x.id}`) : preset ? [`${preset.kind}:${preset.id}`] : []);
  const [responsible, setResponsible] = useState<string[]>(w?.responsible ?? []);
  const [changeRecordId, setChangeRecordId] = useState<string | null>(w?.changeRecord?.id ?? null);
  const [quietMonitors, setQuiet] = useState(w?.quietMonitors ?? true);
  const [pauseMessages, setPause] = useState(w?.pauseMessages ?? false);
  const [reminderHours, setReminder] = useState<number>(w?.reminderHours ?? 24);
  const [busy, setBusy] = useState(false);

  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => getOptional<Platform[]>('/platforms', []) });
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => getOptional<SystemSummary[]>('/systems', []) });
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => getOptional<ApplicationSummary[]>('/applications', []) });
  const services = useQuery({ queryKey: ['services', false], queryFn: () => getOptional<ServiceSummary[]>('/services', []) });
  const records = useQuery({ queryKey: ['records', 'maintenance'], queryFn: () => getOptional<RecordSummary[]>('/records', []) });

  const options = useMemo(() => {
    const names: Record<MaintenanceTargetKind, { id: string; name: string }[]> = {
      platform: (platforms.data ?? []).map((p) => ({ id: p.id, name: p.environment ? `${p.name} (${p.environment})` : p.name })),
      system: (systems.data ?? []).map((s) => ({ id: s.id, name: s.name })),
      application: (apps.data ?? []).filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })),
      service: (services.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    };
    const known = new Set(MAINTENANCE_TARGET_KINDS.flatMap((k) => names[k].map((x) => `${k}:${x.id}`)));
    // targets of the window that are not in the lists (a platform the user may not see): kept with their name
    const extra = (w?.targets ?? []).filter((x) => !known.has(`${x.kind}:${x.id}`));
    return MAINTENANCE_TARGET_KINDS.map((k) => ({
      group: t(`maintenance.targetKinds.${k}`),
      items: [
        ...names[k].map((x) => ({ value: `${k}:${x.id}`, label: x.name })),
        ...extra.filter((x) => x.kind === k).map((x) => ({ value: `${k}:${x.id}`, label: x.name ?? t('maintenance.hiddenTarget') })),
      ],
    })).filter((g) => g.items.length);
  }, [platforms.data, systems.data, apps.data, services.data, w, t]);

  const startIso = fromLocal(start);
  const endIso = fromLocal(end);
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    start: !startIso && t('common:validation.required'),
    end:
      (!endIso && t('common:validation.required')) || (!!startIso && !!endIso && Date.parse(endIso) <= Date.parse(startIso) && t('maintenance.endBeforeStart')),
    targets: !targets.length && t('common:validation.required'),
  });
  const dayOfMonth = startIso ? new Date(startIso).getDate() : 1;

  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      title: title.trim(),
      note,
      startsAt: startIso,
      endsAt: endIso,
      recurrence: freq === 'none' ? null : { freq, interval, until: until ? new Date(`${until}T23:59:59`).toISOString() : null },
      targets: targets.map((x) => ({ kind: x.slice(0, x.indexOf(':')), id: x.slice(x.indexOf(':') + 1) })),
      responsible: responsible.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
      changeRecordId,
      quietMonitors,
      pauseMessages,
      reminderHours,
    };
    try {
      const saved = w
        ? await put<MaintenanceWindowDetail>(`/maintenance-windows/${w.id}`, body)
        : await post<MaintenanceWindowDetail>('/maintenance-windows', body);
      void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
      notifyOk(t('maintenance.saved'));
      onSaved(saved);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} size="lg" title={w ? t('maintenance.editTitle', { title: w.title }) : t('maintenance.new')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('maintenance.titleLabel')}
            required
            maxLength={MAINTENANCE_LIMITS.title}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={v.error('title')}
            data-autofocus
          />
          <Group grow align="flex-start">
            <TextInput
              type="datetime-local"
              label={t('maintenance.start')}
              required
              value={start}
              onChange={(e) => setStart(e.currentTarget.value)}
              error={v.error('start')}
            />
            <TextInput
              type="datetime-local"
              label={t('maintenance.end')}
              required
              value={end}
              onChange={(e) => setEnd(e.currentTarget.value)}
              error={v.error('end')}
            />
          </Group>
          <Group grow align="flex-start">
            <Select
              label={t('maintenance.repeat')}
              value={freq}
              allowDeselect={false}
              onChange={(x) => x && setFreq(x as typeof freq)}
              data={[
                { value: 'none', label: t('maintenance.repeatNone') },
                { value: 'weekly', label: t('maintenance.repeatWeekly') },
                { value: 'monthly', label: t('maintenance.repeatMonthly') },
              ]}
            />
            {freq !== 'none' && (
              <NumberInput
                label={t('maintenance.interval')}
                rightSection={<Text size="xs">{t(freq === 'weekly' ? 'maintenance.intervalWeeks' : 'maintenance.intervalMonths')}</Text>}
                rightSectionWidth={70}
                min={1}
                max={MAINTENANCE_LIMITS.interval}
                value={interval}
                onChange={(x) => setInterval(typeof x === 'number' ? x : 1)}
              />
            )}
            {freq !== 'none' && (
              <TextInput
                type="date"
                label={t('maintenance.until')}
                description={t('maintenance.untilHelp')}
                value={until}
                onChange={(e) => setUntil(e.currentTarget.value)}
              />
            )}
          </Group>
          {freq === 'monthly' && dayOfMonth >= 29 && (
            <Text size="xs" c="dimmed">
              {t('maintenance.monthEndHint')}
            </Text>
          )}
          <MultiSelect
            label={t('maintenance.targets')}
            description={t('maintenance.targetsHelp')}
            required
            searchable
            data={options}
            value={targets}
            onChange={setTargets}
            maxValues={MAINTENANCE_LIMITS.targets}
            error={v.error('targets')}
            data-testid="maintenance-targets"
          />
          <SubjectsInput
            label={t('maintenance.responsible')}
            description={t('maintenance.responsibleHelp')}
            value={responsible}
            onChange={setResponsible}
            max={20}
          />
          <Textarea
            label={t('maintenance.note')}
            description={t('maintenance.noteHelp')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={MAINTENANCE_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Select
            label={t('maintenance.changeRecord')}
            description={t('maintenance.changeRecordHelp')}
            searchable
            clearable
            clearButtonProps={{ 'aria-label': t('maintenance.clearChangeRecord') }}
            data={[
              ...(records.data ?? []).map((r) => ({ value: r.id, label: `${r.number} ${r.title}` })),
              ...(w?.changeRecord && !(records.data ?? []).some((r) => r.id === w.changeRecord!.id)
                ? [{ value: w.changeRecord.id, label: `${w.changeRecord.number} ${w.changeRecord.title}` }]
                : []),
            ]}
            value={changeRecordId}
            onChange={setChangeRecordId}
          />
          <Switch
            label={t('maintenance.quietMonitors')}
            description={t('maintenance.quietMonitorsHelp')}
            checked={quietMonitors}
            onChange={(e) => setQuiet(e.currentTarget.checked)}
          />
          <Switch
            label={t('maintenance.pauseMessages')}
            description={t('maintenance.pauseMessagesHelp')}
            checked={pauseMessages}
            onChange={(e) => setPause(e.currentTarget.checked)}
          />
          <NumberInput
            label={t('maintenance.reminderHours')}
            description={t('maintenance.reminderHoursHelp')}
            min={0}
            max={MAINTENANCE_LIMITS.reminderHoursMax}
            value={reminderHours}
            onChange={(x) => setReminder(typeof x === 'number' ? x : 0)}
            w={{ base: '100%', sm: 260 }}
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

/** One window: when, what it affects and reaches, the next occurrences, the calendar file; change or cancel it. */
export function MaintenanceDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const repeat = useRepeatLabel();
  const q = useQuery({ queryKey: ['maintenance-windows', id], queryFn: () => get<MaintenanceWindowDetail>(`/maintenance-windows/${id}`) });
  const [editing, setEditing] = useState(false);
  const w = q.data;
  const cancel = async () => {
    if (!w) return;
    const ok = await confirmDialog({
      action: 'confirm',
      title: t('maintenance.cancel'),
      confirmLabel: t('maintenance.cancel'),
      message: t('maintenance.cancelQuestion', { title: w.title }),
      danger: true,
    });
    if (!ok) return;
    try {
      await post(`/maintenance-windows/${w.id}/cancel`, {});
      notifyOk(t('maintenance.cancelledToast'));
      void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <Modal opened={!editing} onClose={onClose} size="lg" title={w?.title ?? t('maintenance.title')}>
        {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
        {w && (
          <Stack gap="sm" data-testid="maintenance-detail">
            <WhenLine w={w} />
            <Text size="sm">
              {repeat(w)} · {t('maintenance.timeZone', { tz: w.timeZone })}
            </Text>
            {w.cancelledAt && (
              <Text size="sm" c="dimmed">
                {t('maintenance.cancelled', { date: fmtDate(w.cancelledAt), user: w.cancelledBy ?? '' })}
              </Text>
            )}
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {t('maintenance.targets')}
              </Text>
              <TargetBadges targets={w.targets} />
              <Text size="xs" c="dimmed">
                {t('maintenance.affected', w.affected)}
              </Text>
            </Stack>
            {w.note && (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {w.note}
              </Text>
            )}
            {w.changeRecord && (
              <Text size="sm">
                {t('maintenance.changeRecord')}:{' '}
                <Anchor component={Link} to={`/records/${w.changeRecord.id}`}>
                  {w.changeRecord.number} {w.changeRecord.title}
                </Anchor>
              </Text>
            )}
            <Group gap="xs">
              {w.quietMonitors && (
                <Badge size="sm" variant="light" tt="none">
                  {t('maintenance.quietMonitors')}
                </Badge>
              )}
              {w.pauseMessages && (
                <Badge size="sm" variant="light" tt="none">
                  {t('maintenance.pauseMessages')}
                </Badge>
              )}
            </Group>
            {!w.cancelledAt && w.recurrence && w.upcoming.length > 0 && (
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  {t('maintenance.upcoming')}
                </Text>
                <List size="sm" spacing={2}>
                  {w.upcoming.slice(0, 6).map((o) => (
                    <List.Item key={o.startsAt}>
                      {fmtDate(o.startsAt)} – {fmtDate(o.endsAt)}
                    </List.Item>
                  ))}
                </List>
              </Stack>
            )}
            <Text size="xs" c="dimmed">
              {t('maintenance.createdBy', { user: w.createdBy, date: fmtDate(w.createdAt) })}
            </Text>
            <Group justify="space-between" mt="xs">
              <Button component="a" href={apiUrl(`/maintenance-windows/${w.id}/ics`)} variant="default" size="xs" leftSection={<IconDownload size={14} />}>
                {t('maintenance.ics')}
              </Button>
              {w.canEdit && !w.cancelledAt && (
                <Group gap="xs">
                  <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                    {t('common:edit')}
                  </Button>
                  <Button size="xs" variant="default" color="red" leftSection={<IconX size={14} />} onClick={() => void cancel()}>
                    {t('maintenance.cancel')}
                  </Button>
                </Group>
              )}
            </Group>
          </Stack>
        )}
      </Modal>
      {editing && w && <MaintenanceFormModal window={w} onClose={() => setEditing(false)} onSaved={() => void q.refetch()} />}
    </>
  );
}

/**
 * Maintenance of one item (platform, system, application, service page): the window going on now and the next ones
 * that list or reach it, with a button to plan one for it.
 */
export function MaintenancePanel({ kind, id, canPlan }: { kind: MaintenanceTargetKind; id: string; canPlan?: boolean }) {
  const { t } = useTranslation('applications');
  const q = useQuery({
    queryKey: ['maintenance-windows', 'target', kind, id],
    queryFn: () => get<MaintenanceList>(`/maintenance-windows?target=${kind}:${encodeURIComponent(id)}`),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const occ = q.data?.occurrences ?? [];
  const active = occ.filter((o) => o.active);
  // the next occurrence of each window (a weekly window shows once), at most three windows
  const next = occ
    .filter((o) => !o.active && Date.parse(o.startsAt) > Date.now() && !active.some((a) => a.windowId === o.windowId))
    .filter((o, i, all) => all.findIndex((x) => x.windowId === o.windowId) === i)
    .slice(0, 3);
  if (!q.data || (!occ.length && !canPlan)) return null;
  return (
    <Stack gap="xs" data-testid="maintenance-panel">
      <Group justify="space-between">
        <Text fw={600}>{t('maintenance.panelTitle')}</Text>
        {canPlan && (
          <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => setPlanning(true)}>
            {t('maintenance.new')}
          </Button>
        )}
      </Group>
      {active.map((o) => (
        <Alert key={`${o.windowId}${o.startsAt}`} color="orange" icon={<IconTool size={16} />} p="xs">
          <Anchor size="sm" onClick={() => setOpen(o.windowId)}>
            {t('maintenance.panelActive', { title: o.title, end: fmtDate(o.endsAt) })}
          </Anchor>
        </Alert>
      ))}
      {next.map((o) => (
        <Group key={`${o.windowId}${o.startsAt}`} gap={6} wrap="nowrap">
          <IconCalendarEvent size={14} />
          <Anchor size="sm" onClick={() => setOpen(o.windowId)}>
            {t('maintenance.panelNext', { title: o.title, start: fmtDate(o.startsAt) })}
          </Anchor>
        </Group>
      ))}
      {!active.length && !next.length && (
        <Text size="sm" c="dimmed">
          {t('maintenance.panelEmpty')}
        </Text>
      )}
      {open && <MaintenanceDetailModal id={open} onClose={() => setOpen(null)} />}
      {planning && <MaintenanceFormModal preset={{ kind, id }} onClose={() => setPlanning(false)} onSaved={() => void q.refetch()} />}
    </Stack>
  );
}
