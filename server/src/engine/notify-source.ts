import {
  DEFAULT_SCHEDULE_NOTIFY,
  DEFAULT_TRIGGER_NOTIFY,
  NOTIFY_CHANGE_KINDS,
  NOTIFY_CHANNELS,
  SCHEDULE_NOTIFY_MODES,
  notifyPauseSchema,
  notifyPolicySchema,
  type NotifyPause,
  type NotifyPolicy,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';

/**
 * The source of a run for its messages (#139): the schedule, webhook trigger or monitor output that repeats it. A
 * sub-process belongs to the source of its parent (up to the first run). Runs started by hand have none – they
 * notify on every failure through the routes, as before.
 */
export interface RunSource {
  /** Key of the alert state: schedule:<id>, trigger:<id>, monitor:<id>:<output> */
  key: string;
  kind: 'schedule' | 'trigger' | 'monitor';
  id: string;
  output?: string;
  name: string;
  owner: string | null;
  policy: Required<NotifyPolicy>;
  /** In-app path where the policy is set */
  settingsLink: string;
}

interface NotifyColumns {
  notify_mode?: string | null;
  notify_reminder_hours?: number | null;
  notify_resolved?: number | null;
  notify_change?: string | null;
  notify_channels?: string | null;
  notify_pause?: string | null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** The stored pause, or null when it is missing or unreadable. */
export function pauseOf(raw: string | null | undefined): NotifyPause | null {
  if (!raw) return null;
  const r = notifyPauseSchema.safeParse(parseJson(raw, null));
  return r.success ? r.data : null;
}

/** The policy from the notify_* columns of a schedule or webhook trigger. */
export function policyOfColumns(r: NotifyColumns, defaults: NotifyPolicy): Required<NotifyPolicy> {
  const channels = r.notify_channels ? parseJson<unknown>(r.notify_channels, null) : null;
  return {
    mode: oneOf(SCHEDULE_NOTIFY_MODES, r.notify_mode, defaults.mode),
    reminderHours: Number(r.notify_reminder_hours ?? defaults.reminderHours),
    resolved: r.notify_resolved === undefined || r.notify_resolved === null ? defaults.resolved : !!r.notify_resolved,
    change: oneOf(NOTIFY_CHANGE_KINDS, r.notify_change, defaults.change ?? 'result'),
    channels: Array.isArray(channels) ? channels.filter((c): c is (typeof NOTIFY_CHANNELS)[number] => NOTIFY_CHANNELS.includes(c)) : null,
    pause: pauseOf(r.notify_pause),
  };
}

/** A policy given in a definition (monitor output) or an API body, with the defaults filled in. */
export function fullPolicy(p: NotifyPolicy | undefined, defaults: NotifyPolicy): Required<NotifyPolicy> {
  const r = notifyPolicySchema.safeParse(p ?? defaults);
  const v = r.success ? r.data : defaults;
  return {
    mode: v.mode,
    reminderHours: v.reminderHours,
    resolved: v.resolved,
    change: v.change ?? defaults.change ?? 'result',
    channels: v.channels ?? null,
    pause: v.pause ?? null,
  };
}

interface RunLink {
  trigger: string;
  schedule_id: string | null;
  trigger_id: string | null;
  trigger_output: string | null;
  parent_run_id: string | null;
}

/** The source of a schedule, webhook trigger or monitor output by its key, or null when it no longer exists. */
export function sourceByKey(key: string): RunSource | null {
  const [kind, id, output] = key.split(':') as [string, string, string | undefined];
  if (kind === 'schedule') {
    const r = db().get<NotifyColumns & { name: string; owner: string | null }>('SELECT * FROM schedules WHERE id = ?', id);
    if (!r) return null;
    return { key, kind, id, name: r.name, owner: r.owner, policy: policyOfColumns(r, DEFAULT_SCHEDULE_NOTIFY), settingsLink: `/schedules?edit=${id}` };
  }
  if (kind === 'trigger') {
    const r = db().get<NotifyColumns & { name: string; owner: string | null }>('SELECT * FROM webhook_triggers WHERE id = ?', id);
    if (!r) return null;
    return { key, kind, id, name: r.name, owner: r.owner, policy: policyOfColumns(r, DEFAULT_TRIGGER_NOTIFY), settingsLink: `/triggers?edit=${id}` };
  }
  if (kind === 'monitor') {
    const m = db().get<{ name: string; owner: string; definition: string }>('SELECT name, owner, definition FROM monitors WHERE id = ?', id);
    if (!m) return null;
    const def = parseJson<{ outputs?: { id: string; type: string; notify?: NotifyPolicy }[] }>(m.definition, {});
    const o = output ? def.outputs?.find((x) => x.id === output && x.type === 'process') : undefined;
    return {
      key,
      kind,
      id,
      ...(output ? { output } : {}),
      name: output ? `${m.name} → ${output}` : m.name,
      owner: m.owner,
      policy: fullPolicy(o?.notify, DEFAULT_TRIGGER_NOTIFY),
      settingsLink: `/monitors/${id}/edit?tab=outputs`,
    };
  }
  return null;
}

/** The source that repeats this run (a sub-process: its first parent's), or null for runs started by hand. */
export function sourceOfRun(runId: string): RunSource | null {
  let id: string | null = runId;
  for (let depth = 0; id && depth < 20; depth++) {
    const r: RunLink | undefined = db().get<RunLink>('SELECT trigger, schedule_id, trigger_id, trigger_output, parent_run_id FROM runs WHERE id = ?', id);
    if (!r) return null;
    if (r.parent_run_id) {
      id = r.parent_run_id;
      continue;
    }
    if (r.trigger === 'schedule' && r.schedule_id) return sourceByKey(`schedule:${r.schedule_id}`);
    if (r.trigger === 'webhook' && r.trigger_id) return sourceByKey(`trigger:${r.trigger_id}`);
    if (r.trigger === 'monitor' && r.trigger_id) return sourceByKey(`monitor:${r.trigger_id}${r.trigger_output ? `:${r.trigger_output}` : ''}`);
    return null;
  }
  return null;
}
