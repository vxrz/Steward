import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Radio,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconBellOff, IconBellRinging, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  NOTIFY_CHANGE_KINDS,
  NOTIFY_CHANNELS,
  SCHEDULE_NOTIFY_MODES,
  SCHEDULE_REMINDER_MAX_HOURS,
  pauseActive,
  type NotifyChange,
  type NotifyPause,
  type ScheduleNotify,
  type ScheduleNotifyMode,
} from '@sm/shared';
import { fmtDate, listFormat } from '../../format';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * The notification policy of a source that repeats runs (#139) – schedules, webhook triggers, monitor outputs: when
 * failed checks notify, what counts as a change, where the messages go. The pause has its own control (PauseControl);
 * monitor outputs keep it in the definition (`withPause`).
 */
export function NotifyPolicyFields({
  value,
  onChange,
  withPause,
  pauseControl,
}: {
  value: ScheduleNotify;
  onChange: (v: ScheduleNotify) => void;
  /** Edit the pause here (monitor outputs: it is part of the definition) */
  withPause?: boolean;
  /** Pause or resume next to the summary (a schedule or trigger that exists: its own actions, see PauseControl) */
  pauseControl?: ReactNode;
}) {
  const { t } = useTranslation('schedules');
  const channels = value.channels ?? null;
  return (
    <Stack gap="xs" data-testid="notify-policy">
      <NotifySummary value={value} />
      {pauseControl && <Group justify="flex-end">{pauseControl}</Group>}
      <Select
        label={t('form.notify.label')}
        description={t(`form.notify.hint.${value.mode}`)}
        data={SCHEDULE_NOTIFY_MODES.map((m) => ({ value: m, label: t(`form.notify.mode.${m}`) }))}
        value={value.mode}
        allowDeselect={false}
        onChange={(m) => m && onChange({ ...value, mode: m as ScheduleNotifyMode })}
      />
      {value.mode === 'change' && (
        <>
          <Select
            label={t('form.notify.change')}
            description={t(`form.notify.changeHint.${value.change ?? 'result'}`)}
            data={NOTIFY_CHANGE_KINDS.map((c) => ({ value: c, label: t(`form.notify.changeKind.${c}`) }))}
            value={value.change ?? 'result'}
            allowDeselect={false}
            onChange={(c) => c && onChange({ ...value, change: c as NotifyChange })}
          />
          <NumberInput
            label={t('form.notify.reminder')}
            description={t('form.notify.reminderHint')}
            min={0}
            max={SCHEDULE_REMINDER_MAX_HOURS}
            allowDecimal={false}
            suffix=" h"
            value={value.reminderHours}
            onChange={(h) => onChange({ ...value, reminderHours: typeof h === 'number' ? h : 0 })}
          />
        </>
      )}
      {value.mode !== 'off' && (
        <>
          <Switch label={t('form.notify.resolved')} checked={value.resolved} onChange={(e) => onChange({ ...value, resolved: e.currentTarget.checked })} />
          <Switch
            label={t('form.notify.urgent')}
            description={t('form.notify.urgentHint')}
            checked={!!value.urgent}
            onChange={(e) => onChange({ ...value, urgent: e.currentTarget.checked })}
            data-testid="notify-urgent"
          />
          <Radio.Group
            label={t('form.notify.where')}
            description={t('form.notify.whereHint')}
            value={channels ? 'chosen' : 'routes'}
            onChange={(v) => onChange({ ...value, channels: v === 'routes' ? null : (channels ?? ['inApp']) })}
          >
            <Stack gap={6} mt={6}>
              <Radio value="routes" label={t('form.notify.whereRoutes')} />
              <Radio value="chosen" label={t('form.notify.whereChosen')} />
            </Stack>
          </Radio.Group>
          {channels && (
            <Checkbox.Group
              aria-label={t('form.notify.channels')}
              value={channels}
              onChange={(v) => onChange({ ...value, channels: v as ScheduleNotify['channels'] })}
              error={channels.length ? undefined : t('form.notify.noChannel')}
            >
              <Group gap="md" ml="lg">
                {NOTIFY_CHANNELS.map((c) => (
                  <Checkbox key={c} value={c} label={t(`form.notify.channel.${c}`)} />
                ))}
              </Group>
            </Checkbox.Group>
          )}
        </>
      )}
      {withPause && <PauseFields value={value.pause ?? null} onChange={(pause) => onChange({ ...value, pause })} />}
    </Stack>
  );
}

/**
 * The policy in one or two plain sentences ("Messages are sent when a check starts failing, when what fails changes,
 * every 4 h while it keeps failing and when the check passes again."), so the choices below read as one decision.
 */
export function notifySummary(value: ScheduleNotify, t: TFunction<'schedules'>): string[] {
  if (value.mode === 'off') return [t('form.notify.summary.off')];
  const parts: string[] = [];
  if (value.mode === 'every') parts.push(t('form.notify.summary.part.every'));
  else {
    parts.push(t('form.notify.summary.part.starts'));
    if ((value.change ?? 'result') === 'result') parts.push(t('form.notify.summary.part.changes'));
    if (value.reminderHours > 0) parts.push(t('form.notify.summary.part.reminder', { count: value.reminderHours }));
  }
  if (value.resolved) parts.push(t('form.notify.summary.part.resolved'));
  const lines = [t('form.notify.summary.sent', { parts: listFormat().format(parts) })];
  const channels = value.channels ?? null;
  if (channels?.length) lines.push(t('form.notify.summary.channels', { channels: listFormat().format(channels.map((c) => t(`form.notify.channel.${c}`))) }));
  if (value.urgent) lines.push(t('form.notify.summary.urgent'));
  if (pauseActive(value.pause))
    lines.push(value.pause!.until ? t('form.notify.summary.paused', { until: fmtDate(value.pause!.until) }) : t('form.notify.summary.pausedOpen'));
  return lines;
}

/** The summary above the fields; read out again when a choice changes it (a polite live region). */
function NotifySummary({ value }: { value: ScheduleNotify }) {
  const { t } = useTranslation('schedules');
  return (
    <Paper withBorder p="xs" radius="sm" bg="var(--mantine-color-default-hover)">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <IconInfoCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
        <Text size="sm" aria-live="polite" aria-atomic data-testid="notify-summary">
          {notifySummary(value, t).join(' ')}
        </Text>
      </Group>
    </Paper>
  );
}

/** "2026-10-26T09:30" in the browser's time zone, for <input type="datetime-local"> */
const localInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): string | null => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Pause lengths offered as buttons, in hours */
const PAUSE_PRESETS = [1, 4, 8, 24, 168] as const;
/** A pause that would end before it starts */
const pauseEndError = (p: NotifyPause | null): boolean => !!p && p.until !== null && Date.parse(p.until) <= Date.now();

/** The pause as fields (in a dialog, or in a monitor output). */
function PauseFields({ value, onChange, inline = true }: { value: NotifyPause | null; onChange: (p: NotifyPause | null) => void; inline?: boolean }) {
  const { t } = useTranslation('schedules');
  const on = !!value;
  return (
    <Stack gap="xs">
      {inline && (
        <Switch
          label={t('pause.toggle')}
          checked={on}
          onChange={(e) => onChange(e.currentTarget.checked ? { until: new Date(Date.now() + 24 * 3_600_000).toISOString(), reason: '', inApp: true } : null)}
        />
      )}
      {value && (
        <>
          <Radio.Group
            label={t('pause.how')}
            value={value.until === null ? 'resume' : 'until'}
            onChange={(v) => onChange({ ...value, until: v === 'resume' ? null : new Date(Date.now() + 24 * 3_600_000).toISOString() })}
          >
            <Stack gap={6} mt={6}>
              <Radio value="until" label={t('pause.until')} />
              <Radio value="resume" label={t('pause.untilResumed')} />
            </Stack>
          </Radio.Group>
          {value.until !== null && (
            <>
              {/* the usual lengths in one click; the time below stays for anything else */}
              <Group gap={6} role="group" aria-label={t('pause.for')} data-testid="pause-presets">
                <Text size="sm" fw={500} component="span">
                  {t('pause.for')}
                </Text>
                {PAUSE_PRESETS.map((h) => (
                  <Button
                    key={h}
                    size="compact-sm"
                    variant="default"
                    onClick={() => onChange({ ...value, until: new Date(Date.now() + h * 3_600_000).toISOString() })}
                  >
                    {h < 24 ? t('pause.hours', { count: h }) : t('pause.days', { count: h / 24 })}
                  </Button>
                ))}
              </Group>
              <TextInput
                type="datetime-local"
                label={t('pause.end')}
                value={localInput(new Date(value.until))}
                min={localInput(new Date())}
                error={pauseEndError(value) ? t('pause.past') : undefined}
                onChange={(e) => {
                  const until = fromLocal(e.currentTarget.value);
                  if (until) onChange({ ...value, until });
                }}
              />
            </>
          )}
          <Textarea
            label={t('pause.reason')}
            autosize
            minRows={1}
            maxLength={500}
            value={value.reason}
            onChange={(e) => onChange({ ...value, reason: e.currentTarget.value })}
          />
          <Switch
            label={t('pause.inApp')}
            description={t('pause.inAppHint')}
            checked={value.inApp}
            onChange={(e) => onChange({ ...value, inApp: e.currentTarget.checked })}
          />
          <Text size="xs" c="dimmed">
            {t('pause.note')}
          </Text>
        </>
      )}
    </Stack>
  );
}

/** "Messages paused until …" – shown next to a source while a pause is in effect. */
export function PauseBadge({ pause }: { pause: NotifyPause | null | undefined }) {
  const { t } = useTranslation('schedules');
  if (!pauseActive(pause)) return null;
  const label = pause!.until ? t('pause.badgeUntil', { until: fmtDate(pause!.until) }) : t('pause.badgeOpen');
  return (
    <Tooltip label={pause!.reason || t('pause.noReason')} multiline maw={320}>
      <Badge size="sm" variant="light" color="orange" leftSection={<IconBellOff size={12} aria-hidden />} data-testid="pause-badge">
        {label}
      </Badge>
    </Tooltip>
  );
}

/** Pause or resume the messages of a schedule or trigger; the server stores and audits it. */
export function PauseControl({
  pause,
  onPause,
  onResume,
  disabled,
  name,
  withLabel,
}: {
  pause: NotifyPause | null | undefined;
  onPause: (p: NotifyPause) => Promise<void>;
  onResume: () => Promise<void>;
  disabled?: boolean;
  /** The schedule's or trigger's name, for the buttons' accessible names */
  name?: string;
  /** A button with its label (in a dialog) instead of an icon (in a row) */
  withLabel?: boolean;
}) {
  const { t } = useTranslation(['schedules', 'common']);
  const [draft, setDraft] = useState<NotifyPause | null>(null);
  const [busy, setBusy] = useState(false);
  const active = pauseActive(pause);
  const label = active ? t('pause.resume') : t('pause.button');
  const toggle = async () => {
    if (!active) return setDraft({ until: new Date(Date.now() + 24 * 3_600_000).toISOString(), reason: '', inApp: true });
    setBusy(true);
    try {
      await onResume();
    } finally {
      setBusy(false);
    }
  };
  // an icon button like the other actions of a row (Run now, Edit, Delete), named after the item for screen readers;
  // one element for both states, so the focus stays on it when pausing or resuming swaps the icon
  return (
    <>
      {withLabel ? (
        <Button
          size="xs"
          variant="default"
          color={active ? 'orange' : undefined}
          leftSection={active ? <IconBellRinging size={14} /> : <IconBellOff size={14} />}
          disabled={disabled}
          loading={busy && !draft}
          onClick={toggle}
          data-testid="pause-control"
        >
          {label}
        </Button>
      ) : (
        <Tooltip label={label}>
          <ActionIcon
            variant="subtle"
            color={active ? 'orange' : undefined}
            aria-label={name ? t(active ? 'pause.resumeFor' : 'pause.buttonFor', { name }) : label}
            disabled={disabled}
            loading={busy && !draft}
            onClick={toggle}
          >
            {active ? <IconBellRinging size={16} /> : <IconBellOff size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
      {draft && (
        // a FormModal: the focus goes back to the button when it closes (WCAG 2.4.3)
        <FormModal dirty={false} onClose={() => setDraft(null)} title={t('pause.title')}>
          <Stack gap="sm">
            <PauseFields value={draft} onChange={(p) => p && setDraft(p)} inline={false} />
            <Group justify="flex-end">
              <FormModalCancel />
              <Button
                loading={busy}
                disabled={pauseEndError(draft)}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onPause(draft);
                    setDraft(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('pause.confirm')}
              </Button>
            </Group>
          </Stack>
        </FormModal>
      )}
    </>
  );
}
