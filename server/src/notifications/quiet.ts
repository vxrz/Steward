import {
  EVENT_DIGEST_GROUP,
  WEEKDAY_OF_JS,
  wallQuiet,
  type DigestChoice,
  type DigestPrefs,
  type DigestRhythm,
  type NotificationEvent,
  type QuietHours,
} from '@sm/shared';
import { localClock, minutesOf, type LocalClock } from './clock.js';

export { wallQuiet };

/**
 * Quiet hours and digests (ADR 0012): `deliveryPlan()` decides for one interrupting target (a person's e-mail, a Teams
 * channel) whether a message goes out now or is held in the outbox (outbox.ts). Suppression (pause, maintenance windows,
 * a monitor's quiet reasons, dry runs) has decided before that the message goes out at all; this only decides when.
 *
 * Everything is answered from the local wall clock of the target's time zone, at the moment a message arrives and at
 * every job tick – never from a stored instant. On the night the clocks go forward, quiet hours are shorter in real
 * time; an end that does not exist that day ends at the first minute after the gap. On the night they go back, they are
 * longer; an end time that occurs twice ends at its first occurrence (below).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const later = (a: LocalClock, b: LocalClock) => a.day > b.day || (a.day === b.day && a.minutes > b.minutes);

/** Whether the target is in its quiet hours at `now`. */
export function inQuietHours(qh: QuietHours | null | undefined, now = Date.now()): boolean {
  if (!qh?.enabled) return false;
  const c = localClock(now, qh.timeZone);
  if (!wallQuiet(qh, c)) return false;
  // the second pass of the hour the clocks go back: when the first pass already reached a wall time that is not quiet
  // after the current one, the quiet hours ended then (an end time that occurs twice ends at its first occurrence)
  for (const delta of [60, 30]) {
    const earlier = localClock(now - delta * MINUTE, qh.timeZone);
    if (earlier.day !== c.day || earlier.minutes !== c.minutes) continue;
    for (let k = 1; k < delta; k++) {
      const s = localClock(now - (delta - k) * MINUTE, qh.timeZone);
      if (later(s, c) && !wallQuiet(qh, s)) return false;
    }
    break;
  }
  return true;
}

/**
 * The first instant (a full minute) at or after `now` that is not quiet, looking at most `horizonMs` ahead (null:
 * still quiet then, or not quiet now). Used for the "until 07:30" line and for expiring decisions; never stored.
 */
export function quietUntil(qh: QuietHours | null | undefined, now = Date.now(), horizonMs = 8 * 24 * HOUR): number | null {
  if (!inQuietHours(qh, now)) return null;
  const start = Math.floor(now / MINUTE) * MINUTE;
  const STEP = 5 * MINUTE;
  for (let t = start + STEP; t <= start + horizonMs; t += STEP) {
    if (inQuietHours(qh, t)) continue;
    // the end lies in the last step: find its minute
    for (let m = t - STEP + MINUTE; m <= t; m += MINUTE) if (!inQuietHours(qh, m)) return m;
    return t;
  }
  return null;
}

// ---------- digests ----------

/** The rhythm of an event for a person (immediately when the group has none or the event is never digested). */
export function rhythmOf(digests: DigestPrefs | null | undefined, event: NotificationEvent): { rhythm: DigestRhythm; choice: DigestChoice | null } {
  const group = EVENT_DIGEST_GROUP[event];
  const choice = group ? (digests?.groups[group] ?? null) : null;
  return { rhythm: choice?.rhythm ?? 'immediately', choice };
}

const hourKey = (c: LocalClock) => `${c.day}T${String(Math.floor(c.minutes / 60)).padStart(2, '0')}`;

/** Whether a digest's due time lies in (since, now]: an hour began, or the daily / weekly time passed. */
export function digestDue(choice: DigestChoice | null, timeZone: string, since: number, now = Date.now()): boolean {
  if (!choice || choice.rhythm === 'immediately') return true;
  if (now <= since) return false;
  if (choice.rhythm === 'hourly') return hourKey(localClock(since, timeZone)) !== hourKey(localClock(now, timeZone));
  const at = minutesOf(choice.time ?? '08:00');
  const onDay = (c: LocalClock) => choice.rhythm === 'daily' || WEEKDAY_OF_JS[c.weekday] === (choice.weekday ?? 'mon');
  // walk the local clock in steps of 15 minutes (at most 8 days): did it pass the time on a day it is sent?
  let prev = localClock(since, timeZone);
  const end = Math.min(now, since + 8 * 24 * HOUR);
  for (let t = since + 15 * MINUTE; ; t += 15 * MINUTE) {
    const x = Math.min(t, end);
    const c = localClock(x, timeZone);
    const crossed = c.day !== prev.day ? (onDay(prev) && prev.minutes < at) || (onDay(c) && c.minutes >= at) : onDay(c) && prev.minutes < at && c.minutes >= at;
    if (crossed) return true;
    prev = c;
    if (x >= end) return now - since > 8 * 24 * HOUR;
  }
}

/** The start of the next hour in the zone (for hourly digests and expiring decisions). */
function nextHour(now: number, timeZone: string): number {
  const c = localClock(now, timeZone);
  return now + (60 - (c.minutes % 60)) * MINUTE - (now % MINUTE);
}

// ---------- the plan ----------

export type HoldReason = 'quiet' | 'hourly' | 'daily' | 'weekly';
/** Why a message broke through (its footer says so) */
export type BreakReason = 'emergency' | 'expires' | 'urgent';

export type DeliveryPlan = { send: true; broke?: BreakReason } | { send: false; hold: HoldReason };

export interface PlanTarget {
  /** A person's e-mail or chat (digests apply), or a channel (quiet hours only) */
  personal: boolean;
  quietHours: QuietHours | null;
  digests?: DigestPrefs | null;
}

export interface PlanNotice {
  event: NotificationEvent;
  /** The source is marked urgent and this is a failed run or a check failing with severity error */
  urgent?: boolean;
  /** A decision that expires then (ISO) */
  expiresAt?: string;
  /** Decisions for several people: another eligible decider is outside their quiet hours now */
  otherDeciderReachable?: boolean;
}

/**
 * When a message reaches one target: now (today's path) or held, with the reason. Break-throughs: emergency access
 * always; a decision that expires inside the quiet hours or within an hour after them, unless another decider can be
 * reached; messages of urgent sources unless the target turned that off.
 */
export function deliveryPlan(target: PlanTarget, n: PlanNotice, now = Date.now(), opts: { allowed?: boolean } = {}): DeliveryPlan {
  if (opts.allowed === false) return { send: true };
  if (n.event === 'security.emergency') return inQuietHours(target.quietHours, now) ? { send: true, broke: 'emergency' } : { send: true };
  const qh = target.quietHours;
  const quiet = inQuietHours(qh, now);
  const expires = n.expiresAt ? Date.parse(n.expiresAt) : NaN;
  const { rhythm } = target.personal && !n.urgent ? rhythmOf(target.digests, n.event) : { rhythm: 'immediately' as DigestRhythm };
  if (quiet) {
    if (Number.isFinite(expires)) {
      const until = quietUntil(qh, now, Math.max(0, expires - now) + HOUR);
      const expiresInside = until === null || expires <= until + HOUR;
      if (expiresInside && !n.otherDeciderReachable) return { send: true, broke: 'expires' };
    }
    if (n.urgent && qh!.urgentBreaksThrough) return { send: true, broke: 'urgent' };
    return { send: false, hold: rhythm === 'immediately' ? 'quiet' : rhythm };
  }
  if (rhythm === 'immediately') return { send: true };
  // an expiring decision breaks through a digest like it breaks through quiet hours
  if (Number.isFinite(expires) && expires <= nextHour(now, target.digests?.timeZone ?? 'UTC') + HOUR) return { send: true };
  return { send: false, hold: rhythm };
}
