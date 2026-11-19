import { describe, expect, it } from 'vitest';

/**
 * Server review 0.27.0: regression tests of the fixes in the process engine, the scheduler, platform calls, monitors,
 * maintenance windows and datasets. Each test failed before its fix.
 */

describe('maintenance windows', () => {
  it('a monthly window started years ago keeps all its occurrences (the skip-ahead estimate never passes them)', async () => {
    const { occurrencesBetween } = await import('../../shared/src/maintenance.js');
    const monthly = { startsAt: '2020-01-15T02:00:00Z', endsAt: '2020-01-15T04:00:00Z', recurrence: { freq: 'monthly' as const, interval: 1 }, timeZone: 'UTC' };
    const starts = (from: string, to: string, w = monthly) => occurrencesBetween(w, Date.parse(from), Date.parse(to)).map((o) => new Date(o.start).toISOString());
    expect(starts('2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual(['2026-03-15T02:00:00.000Z', '2026-04-15T02:00:00.000Z', '2026-05-15T02:00:00.000Z']);
    // the occurrence going on is found from inside it (what "in maintenance now" asks)
    expect(starts('2026-03-15T03:00:00Z', '2026-03-15T03:00:01Z')).toEqual(['2026-03-15T02:00:00.000Z']);
    // every third month, the 31st (the last day of shorter months), in a zone with daylight saving time
    const quarterly = {
      startsAt: '2019-01-31T21:00:00Z',
      endsAt: '2019-01-31T23:00:00Z',
      recurrence: { freq: 'monthly' as const, interval: 3 },
      timeZone: 'Europe/Berlin',
    };
    expect(starts('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', quarterly)).toEqual([
      '2026-01-31T21:00:00.000Z',
      '2026-04-30T20:00:00.000Z',
      '2026-07-31T20:00:00.000Z',
      '2026-10-31T21:00:00.000Z',
    ]);
  });
});
