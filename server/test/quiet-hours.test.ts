import { describe, expect, it } from 'vitest';
import { DEFAULT_QUIET_HOURS, type QuietHours } from '@sm/shared';
import { deliveryPlan, digestDue, inQuietHours, quietUntil } from '../src/notifications/quiet.js';
import { localClock, utcOffsetMinutes } from '../src/notifications/clock.js';

/** Quiet hours (ADR 0012): wall-clock evaluation and the daylight-saving matrix. */

const at = (iso: string) => Date.parse(iso);
const qh = (timeZone: string, windows: QuietHours['windows'], allDay: QuietHours['allDay'] = []): QuietHours => ({
  ...DEFAULT_QUIET_HOURS,
  enabled: true,
  timeZone,
  windows,
  allDay,
});
const EVERY: QuietHours['windows'][number]['days'] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS: QuietHours['windows'][number]['days'] = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('quiet hours: windows', () => {
  const berlin = qh('Europe/Berlin', [{ days: WEEKDAYS, from: '18:00', to: '07:30' }], ['sat', 'sun']);

  it('is off when not enabled', () => {
    expect(inQuietHours({ ...berlin, enabled: false }, at('2026-11-09T22:00:00Z'))).toBe(false);
    expect(inQuietHours(null, at('2026-11-09T22:00:00Z'))).toBe(false);
  });

  it('crosses midnight and belongs to its start day', () => {
    // Monday 9 November 2026, CET (UTC+1)
    expect(inQuietHours(berlin, at('2026-11-09T16:59:00Z'))).toBe(false); // 17:59
    expect(inQuietHours(berlin, at('2026-11-09T17:00:00Z'))).toBe(true); // 18:00
    expect(inQuietHours(berlin, at('2026-11-10T06:29:00Z'))).toBe(true); // Tue 07:29
    expect(inQuietHours(berlin, at('2026-11-10T06:30:00Z'))).toBe(false); // Tue 07:30
    expect(quietUntil(berlin, at('2026-11-09T21:13:00Z'))).toBe(at('2026-11-10T06:30:00Z'));
  });

  it('joins the weekend up to Monday morning', () => {
    expect(inQuietHours(berlin, at('2026-11-13T17:00:00Z'))).toBe(true); // Fri 18:00
    expect(inQuietHours(berlin, at('2026-11-14T12:00:00Z'))).toBe(true); // Sat noon
    expect(inQuietHours(berlin, at('2026-11-16T06:00:00Z'))).toBe(true); // Mon 07:00
    expect(inQuietHours(berlin, at('2026-11-16T06:30:00Z'))).toBe(false); // Mon 07:30
    expect(quietUntil(berlin, at('2026-11-13T19:00:00Z'))).toBe(at('2026-11-16T06:30:00Z'));
  });

  it('takes windows within a day and whole-day windows', () => {
    const lunch = qh('UTC', [{ days: ['wed'], from: '12:00', to: '13:00' }]);
    expect(inQuietHours(lunch, at('2026-11-11T12:30:00Z'))).toBe(true);
    expect(inQuietHours(lunch, at('2026-11-11T13:00:00Z'))).toBe(false);
    expect(inQuietHours(lunch, at('2026-11-12T12:30:00Z'))).toBe(false);
    // from = to: 24 hours from that time
    const day = qh('UTC', [{ days: ['wed'], from: '09:00', to: '09:00' }]);
    expect(inQuietHours(day, at('2026-11-12T08:59:00Z'))).toBe(true);
    expect(inQuietHours(day, at('2026-11-12T09:00:00Z'))).toBe(false);
  });
});

describe('quiet hours: daylight saving', () => {
  it('Europe/Berlin, clocks forward: an end in the gap ends at the first minute after it', () => {
    // 29 March 2026: 02:00 CET → 03:00 CEST at 01:00 UTC; 02:30 does not exist
    const q = qh('Europe/Berlin', [{ days: EVERY, from: '22:00', to: '02:30' }]);
    expect(inQuietHours(q, at('2026-03-29T00:59:00Z'))).toBe(true); // 01:59 CET
    expect(inQuietHours(q, at('2026-03-29T01:00:00Z'))).toBe(false); // 03:00 CEST
    expect(quietUntil(q, at('2026-03-28T21:00:00Z'))).toBe(at('2026-03-29T01:00:00Z'));
    // an ordinary end on that night: 07:30 CEST, one hour shorter in real time
    const morning = qh('Europe/Berlin', [{ days: EVERY, from: '22:00', to: '07:30' }]);
    expect(quietUntil(morning, at('2026-03-28T21:00:00Z'))).toBe(at('2026-03-29T05:30:00Z'));
  });

  it('Europe/Berlin, clocks back: an end time that occurs twice ends at its first occurrence', () => {
    // 25 October 2026: 03:00 CEST → 02:00 CET at 01:00 UTC; 02:00–02:59 happen twice
    const q = qh('Europe/Berlin', [{ days: EVERY, from: '22:00', to: '02:30' }]);
    expect(inQuietHours(q, at('2026-10-25T00:00:00Z'))).toBe(true); // 02:00 CEST
    expect(inQuietHours(q, at('2026-10-25T00:30:00Z'))).toBe(false); // 02:30 CEST – the first 02:30
    expect(inQuietHours(q, at('2026-10-25T01:00:00Z'))).toBe(false); // 02:00 CET (again)
    expect(inQuietHours(q, at('2026-10-25T01:20:00Z'))).toBe(false); // 02:20 CET
    expect(quietUntil(q, at('2026-10-24T20:00:00Z'))).toBe(at('2026-10-25T00:30:00Z'));
    // an end at 03:00 comes only after the repeated hour: one hour longer in real time
    const three = qh('Europe/Berlin', [{ days: EVERY, from: '22:00', to: '03:00' }]);
    expect(inQuietHours(three, at('2026-10-25T01:30:00Z'))).toBe(true); // 02:30 CET
    expect(quietUntil(three, at('2026-10-24T20:00:00Z'))).toBe(at('2026-10-25T02:00:00Z'));
  });

  it('America/New_York, both switch nights', () => {
    const q = qh('America/New_York', [{ days: EVERY, from: '23:00', to: '02:30' }]);
    // 8 March 2026: 02:00 EST → 03:00 EDT at 07:00 UTC
    expect(inQuietHours(q, at('2026-03-08T06:59:00Z'))).toBe(true);
    expect(inQuietHours(q, at('2026-03-08T07:00:00Z'))).toBe(false);
    // 1 November 2026: 02:00 EDT → 01:00 EST at 06:00 UTC; 01:30 occurs twice
    const back = qh('America/New_York', [{ days: EVERY, from: '23:00', to: '01:30' }]);
    expect(inQuietHours(back, at('2026-11-01T05:29:00Z'))).toBe(true); // 01:29 EDT
    expect(inQuietHours(back, at('2026-11-01T05:30:00Z'))).toBe(false); // 01:30 EDT
    expect(inQuietHours(back, at('2026-11-01T06:10:00Z'))).toBe(false); // 01:10 EST
    expect(inQuietHours(back, at('2026-11-02T04:00:00Z'))).toBe(true); // 23:00 EST next evening
  });

  it('Australia/Lord_Howe: a shift of 30 minutes', () => {
    // 5 April 2026: 02:00 (+11) → 01:30 (+10:30) at 15:00 UTC the day before
    const back = qh('Australia/Lord_Howe', [{ days: EVERY, from: '22:00', to: '01:45' }]);
    expect(utcOffsetMinutes(at('2026-04-04T14:00:00Z'), 'Australia/Lord_Howe')).toBe(660);
    expect(utcOffsetMinutes(at('2026-04-04T16:00:00Z'), 'Australia/Lord_Howe')).toBe(630);
    expect(inQuietHours(back, at('2026-04-04T14:44:00Z'))).toBe(true); // 01:44 (+11)
    expect(inQuietHours(back, at('2026-04-04T14:45:00Z'))).toBe(false); // 01:45 (+11)
    expect(inQuietHours(back, at('2026-04-04T15:05:00Z'))).toBe(false); // 01:35 (+10:30), again
    // 4 October 2026: 02:00 (+10:30) → 02:30 (+11) at 15:30 UTC the day before; 02:15 does not exist
    const fwd = qh('Australia/Lord_Howe', [{ days: EVERY, from: '22:00', to: '02:15' }]);
    expect(inQuietHours(fwd, at('2026-10-03T15:29:00Z'))).toBe(true); // 01:59
    expect(inQuietHours(fwd, at('2026-10-03T15:30:00Z'))).toBe(false); // 02:30
  });

  it('weekend windows across a switch night', () => {
    // Saturday and Sunday all day in Berlin; the clocks go back on Sunday 25 October 2026
    const q = qh('Europe/Berlin', [{ days: WEEKDAYS, from: '18:00', to: '07:30' }], ['sat', 'sun']);
    expect(inQuietHours(q, at('2026-10-25T01:30:00Z'))).toBe(true);
    expect(quietUntil(q, at('2026-10-23T17:00:00Z'))).toBe(at('2026-10-26T06:30:00Z')); // Mon 07:30 CET
    expect(localClock(at('2026-10-26T06:30:00Z'), 'Europe/Berlin')).toMatchObject({ weekday: 1, minutes: 7 * 60 + 30 });
  });
});

describe('digests', () => {
  it('hourly: due once an hour began', () => {
    const c = { rhythm: 'hourly' as const };
    expect(digestDue(c, 'UTC', at('2026-11-09T10:02:00Z'), at('2026-11-09T10:55:00Z'))).toBe(false);
    expect(digestDue(c, 'UTC', at('2026-11-09T10:02:00Z'), at('2026-11-09T11:00:00Z'))).toBe(true);
  });

  it('daily and weekly: due once the local time passed on a day it is sent', () => {
    const daily = { rhythm: 'daily' as const, time: '17:00' };
    expect(digestDue(daily, 'Europe/Berlin', at('2026-11-09T08:00:00Z'), at('2026-11-09T15:55:00Z'))).toBe(false);
    expect(digestDue(daily, 'Europe/Berlin', at('2026-11-09T08:00:00Z'), at('2026-11-09T16:05:00Z'))).toBe(true);
    const late = { rhythm: 'daily' as const, time: '23:55' };
    expect(digestDue(late, 'UTC', at('2026-11-09T23:50:00Z'), at('2026-11-10T00:05:00Z'))).toBe(true);
    const weekly = { rhythm: 'weekly' as const, time: '09:00', weekday: 'mon' as const };
    expect(digestDue(weekly, 'UTC', at('2026-11-10T08:00:00Z'), at('2026-11-14T10:00:00Z'))).toBe(false);
    expect(digestDue(weekly, 'UTC', at('2026-11-10T08:00:00Z'), at('2026-11-16T09:10:00Z'))).toBe(true);
  });
});

describe('delivery plan', () => {
  const q = qh('UTC', [{ days: EVERY, from: '22:00', to: '07:00' }]);
  const night = at('2026-11-10T02:00:00Z');
  const day = at('2026-11-10T12:00:00Z');
  const person = { personal: true, quietHours: q, digests: { timeZone: 'UTC', groups: { runs: { rhythm: 'daily' as const, time: '17:00' } } } };

  it('sends at once outside quiet hours and holds inside them', () => {
    expect(deliveryPlan(person, { event: 'credential.due' }, day)).toEqual({ send: true });
    expect(deliveryPlan(person, { event: 'credential.due' }, night)).toEqual({ send: false, hold: 'quiet' });
    // a digest group: held for the digest, also in quiet hours (the catch-up takes it when the digest falls inside)
    expect(deliveryPlan(person, { event: 'run.failed' }, day)).toEqual({ send: false, hold: 'daily' });
    expect(deliveryPlan(person, { event: 'run.failed' }, night)).toEqual({ send: false, hold: 'daily' });
    // channels have no digests
    expect(deliveryPlan({ personal: false, quietHours: q }, { event: 'run.failed' }, day)).toEqual({ send: true });
    // the administrators' switch
    expect(deliveryPlan(person, { event: 'credential.due' }, night, { allowed: false })).toEqual({ send: true });
  });

  it('lets emergency access, urgent sources and expiring decisions through', () => {
    expect(deliveryPlan(person, { event: 'security.emergency' }, night)).toEqual({ send: true, broke: 'emergency' });
    expect(deliveryPlan(person, { event: 'run.failed', urgent: true }, night)).toEqual({ send: true, broke: 'urgent' });
    expect(deliveryPlan(person, { event: 'run.failed', urgent: true }, day)).toEqual({ send: true });
    expect(deliveryPlan({ ...person, quietHours: { ...q, urgentBreaksThrough: false } }, { event: 'run.failed', urgent: true }, night)).toEqual({
      send: false,
      hold: 'quiet',
    });
    // expires at 03:10, inside the quiet hours
    const expiring = { event: 'mcp.request' as const, expiresAt: '2026-11-10T03:10:00Z' };
    expect(deliveryPlan(person, expiring, night)).toEqual({ send: true, broke: 'expires' });
    // within an hour after their end (07:00 + 1 h)
    expect(deliveryPlan(person, { ...expiring, expiresAt: '2026-11-10T07:45:00Z' }, night)).toEqual({ send: true, broke: 'expires' });
    // later: held
    expect(deliveryPlan(person, { ...expiring, expiresAt: '2026-11-10T09:00:00Z' }, night)).toEqual({ send: false, hold: 'quiet' });
    // somebody else can decide: held for this person
    expect(deliveryPlan(person, { ...expiring, otherDeciderReachable: true }, night)).toEqual({ send: false, hold: 'quiet' });
    // process decisions have no deadline: held
    expect(deliveryPlan(person, { event: 'task.assigned' }, night)).toEqual({ send: false, hold: 'quiet' });
  });
});
