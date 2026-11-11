import { db } from '../db.js';

/**
 * Clock skew (security review 0.19.0 L6; ISO/IEC 27001 A.8.17): audit entries, checkpoints and evidence carry the
 * server's time, so a clock that is off should be seen. Without asking anything new of the network, Steward compares its
 * clock with two references it has anyway:
 *
 * - the PostgreSQL server's clock (`now()`), when the database is PostgreSQL – one statement when the system status
 *   is shown;
 * - the `Date` header of the platforms' answers (HTTP, one-second resolution): the latest one is kept.
 *
 * The status names the larger difference; above CLOCK_SKEW_WARN_SECONDS it is a warning (the check of the readiness
 * report and the system status page). NTP on the host stays the fix.
 */
export const CLOCK_SKEW_WARN_SECONDS = 30;

export interface ClockSample {
  /** Steward's clock minus the reference, in seconds (positive: Steward is ahead) */
  skewSeconds: number;
  source: 'database' | 'http';
  checkedAt: string;
}

let lastHttp: ClockSample | null = null;

/**
 * An answer's `Date` header (a platform request: sent at `sentAt`, answered at `receivedAt`). Its time lies within the
 * request, so the difference to the middle of it, less the header's one second of resolution and half the round trip,
 * is what counts; anything within that uncertainty is 0.
 */
export function noteRemoteDate(date: string | null | undefined, sentAt: number, receivedAt: number): void {
  if (!date) return;
  const remote = Date.parse(date);
  if (!Number.isFinite(remote)) return;
  const middle = (sentAt + receivedAt) / 2;
  // the header is rounded down to the second: the remote time lies in [remote, remote + 1000)
  const diff = middle - (remote + 500);
  const slack = 500 + (receivedAt - sentAt) / 2;
  const skew = Math.abs(diff) <= slack ? 0 : diff - Math.sign(diff) * slack;
  lastHttp = { skewSeconds: Math.round(skew / 100) / 10, source: 'http', checkedAt: new Date(receivedAt).toISOString() };
}

/** The PostgreSQL server's clock against Steward's (null on SQLite – it has no clock of its own – or on an error). */
function databaseSample(): ClockSample | null {
  const d = db();
  if (d.dialect !== 'postgres') return null;
  try {
    const before = Date.now();
    const r = d.get<{ t: string | Date }>('SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS t');
    const after = Date.now();
    const remote = r ? Date.parse(String(r.t instanceof Date ? r.t.toISOString() : r.t)) : NaN;
    if (!Number.isFinite(remote)) return null;
    const diff = (before + after) / 2 - remote;
    const slack = (after - before) / 2;
    const skew = Math.abs(diff) <= slack ? 0 : diff - Math.sign(diff) * slack;
    return { skewSeconds: Math.round(skew / 100) / 10, source: 'database', checkedAt: new Date(after).toISOString() };
  } catch {
    return null; // the status shows the other reference, or none
  }
}

/** What the system status shows: the reference with the larger difference (the database first when equal). */
export function clockStatus(): { skewSeconds: number | null; source: 'database' | 'http' | null; checkedAt: string | null; warning: boolean } {
  const samples = [databaseSample(), lastHttp].filter((x): x is ClockSample => !!x);
  if (!samples.length) return { skewSeconds: null, source: null, checkedAt: null, warning: false };
  const worst = samples.reduce((a, b) => (Math.abs(b.skewSeconds) > Math.abs(a.skewSeconds) ? b : a));
  return { ...worst, warning: Math.abs(worst.skewSeconds) > CLOCK_SKEW_WARN_SECONDS };
}

/** Tests: forget the last HTTP sample. */
export function resetClockSamples(): void {
  lastHttp = null;
}
