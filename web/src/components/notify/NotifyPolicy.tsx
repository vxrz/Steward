import { useState } from 'react';
import { Badge, Button, Checkbox, Group, Modal, NumberInput, Radio, Select, Stack, Switch, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { IconBellOff, IconBellRinging } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
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
import { fmtDate } from '../../format';

/**
 * The notification policy of a source that repeats runs (#139) – schedules, webhook triggers, monitor outputs: when
 * failed checks notify, what counts as a change, where the messages go. The pause has its own control (PauseControl);
 * monitor outputs keep it in the definition (`withPause`).
 */
export function NotifyPolicyFields({
  value,
  onChange,
  withPause,
}: {
  value: ScheduleNotify;
  onChange: (v: ScheduleNotify) => void;
  /** Edit the pause here (monitor outputs: it is part of the definition) */
  withPause?: boolean;
}) {
  const { t } = useTranslation('schedules');
  const channels = value.channels ?? null;
  return (
    <Stack gap="xs" data-testid="notify-policy">
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

/** "2026-10-26T09:30" in the browser's time zone, for <input type="datetime-local"> */
const localInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): string | null => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

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
            <TextInput
              type="datetime-local"
              label={t('pause.end')}
              value={localInput(new Date(value.until))}
              onChange={(e) => {
                const until = fromLocal(e.currentTarget.value);
                if (until) onChange({ ...value, until });
              }}
            />
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
}: {
  pause: NotifyPause | null | undefined;
  onPause: (p: NotifyPause) => Promise<void>;
  onResume: () => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useTranslation(['schedules', 'common']);
  const [draft, setDraft] = useState<NotifyPause | null>(null);
  const [busy, setBusy] = useState(false);
  const active = pauseActive(pause);
  if (active)
    return (
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconBellRinging size={14} />}
        disabled={disabled}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onResume();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('pause.resume')}
      </Button>
    );
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconBellOff size={14} />}
        disabled={disabled}
        onClick={() => setDraft({ until: new Date(Date.now() + 24 * 3_600_000).toISOString(), reason: '', inApp: true })}
      >
        {t('pause.button')}
      </Button>
      {draft && (
        <Modal opened onClose={() => setDraft(null)} title={t('pause.title')}>
          <Stack gap="sm">
            <PauseFields value={draft} onChange={(p) => p && setDraft(p)} inline={false} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDraft(null)}>
                {t('common:cancel')}
              </Button>
              <Button
                loading={busy}
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
        </Modal>
      )}
    </>
  );
}
