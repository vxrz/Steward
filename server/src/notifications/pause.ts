import { DEFAULT_TRIGGER_NOTIFY, type NotifyPolicy } from '@sm/shared';
import { db } from '../db.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { nowIso, parseJson } from '../util.js';
import { failingChecks } from '../engine/check-alerts.js';
import { fullPolicy, pauseOf } from '../engine/notify-source.js';

/**
 * The end of a pause (#139). When a pause of a source's messages runs out while some of its checks still fail, each
 * of them sends one "still failing" message, so nothing is lost silently. Schedules and webhook triggers resume on
 * their own (the pause is removed and audited); a monitor output's pause is part of the monitor's definition and
 * simply stops counting. notify_pause_ends makes sure each pause end is reported once.
 */

/** Sends the "still failing" messages of a source whose pause ended at `until`, once. Returns how many were sent. */
function reportPauseEnd(source: string, until: string): number {
  const done = db().get('SELECT 1 FROM notify_pause_ends WHERE source = ? AND until = ?', source, until);
  if (done) return 0;
  db().run('INSERT INTO notify_pause_ends (source, until, notified_at) VALUES (?, ?, ?)', source, until, nowIso());
  let sent = 0;
  for (const f of failingChecks(source)) {
    const run = db().get<{ process_id: string; process_name: string }>('SELECT process_id, process_name FROM runs WHERE id = ?', f.runId);
    if (!run) continue;
    emit('check.failed', {
      runId: f.runId,
      processId: run.process_id,
      processName: run.process_name,
      check: f.check,
      severity: f.severity,
      message: f.message,
      dryRun: f.dryRun,
      phase: 'pauseEnded',
      source,
      ...(source.startsWith('schedule:') ? { scheduleId: source.slice('schedule:'.length) } : {}),
      since: f.since,
      ...(f.value !== null ? { value: f.value } : {}),
    });
    sent++;
  }
  return sent;
}

/** Finds the pauses that ended by `now`. Idempotent; runs with the other notification jobs. */
export function checkPauseEnds(now = Date.now()): number {
  let sent = 0;
  for (const table of ['schedules', 'webhook_triggers'] as const) {
    const kind = table === 'schedules' ? 'schedule' : 'trigger';
    for (const r of db().all<{ id: string; name: string; notify_pause: string }>(
      `SELECT id, name, notify_pause FROM ${table} WHERE notify_pause IS NOT NULL`,
    )) {
      const p = pauseOf(r.notify_pause);
      if (!p?.until || Date.parse(p.until) > now) continue;
      sent += reportPauseEnd(`${kind}:${r.id}`, p.until);
      db().run(`UPDATE ${table} SET notify_pause = NULL WHERE id = ?`, r.id);
      audit({
        actor: 'system',
        action: `${kind}.resumed`,
        entityType: kind,
        entityId: r.id,
        summary: `Messages of ${kind === 'schedule' ? 'schedule' : 'webhook trigger'} "${r.name}" resumed: the pause ended (${p.until})`,
        details: { reason: 'pause ended', until: p.until },
      });
    }
  }
  for (const m of db().all<{ id: string; definition: string }>('SELECT id, definition FROM monitors WHERE is_template = 0')) {
    const def = parseJson<{ outputs?: { id: string; type: string; notify?: NotifyPolicy }[] }>(m.definition, {});
    for (const o of def.outputs ?? []) {
      if (o.type !== 'process' || !o.notify?.pause?.until) continue;
      const p = fullPolicy(o.notify, DEFAULT_TRIGGER_NOTIFY).pause;
      if (!p?.until || Date.parse(p.until) > now) continue;
      sent += reportPauseEnd(`monitor:${m.id}:${o.id}`, p.until);
    }
  }
  return sent;
}
