import { describe, expect, it } from 'vitest';
import { dashboardWidgetSchema, sumSeries, type MetricSeries } from '@sm/shared';

/** KPI widgets that add up the sources of a dataset (e.g. users of three tenants) into one number. */

const series = (source: string, points: [string, number][]): MetricSeries => ({
  name: 'total',
  source,
  points: points.map(([ts, value]) => ({ ts, value })),
});

describe('sumSeries', () => {
  it('adds the latest value of every source at each moment', () => {
    const eu = series('eu', [
      ['2026-10-01T00:00:00Z', 10],
      ['2026-10-03T00:00:00Z', 12],
    ]);
    const us = series('us', [
      ['2026-10-02T00:00:00Z', 5],
      ['2026-10-03T00:00:00Z', 6],
    ]);
    expect(sumSeries([eu, us])).toEqual([
      { ts: '2026-10-01T00:00:00Z', value: 10 },
      { ts: '2026-10-02T00:00:00Z', value: 15 },
      // both sources report at this moment: one point, after both
      { ts: '2026-10-03T00:00:00Z', value: 18 },
    ]);
  });

  it('keeps a source that reports less often at its last value', () => {
    const hourly = series('a', [
      ['2026-10-01T00:00:00Z', 1],
      ['2026-10-01T01:00:00Z', 2],
      ['2026-10-01T02:00:00Z', 3],
    ]);
    const daily = series('b', [['2026-10-01T00:30:00Z', 100]]);
    expect(sumSeries([hourly, daily]).map((p) => p.value)).toEqual([1, 101, 102, 103]);
  });

  it('is empty without points and skips points that are not numbers or times', () => {
    expect(sumSeries([])).toEqual([]);
    expect(sumSeries([series('a', [])])).toEqual([]);
    expect(
      sumSeries([
        series('a', [
          ['not a time', 4],
          ['2026-10-01T00:00:00Z', Number.NaN],
          ['2026-10-02T00:00:00Z', 7],
        ]),
      ]),
    ).toEqual([{ ts: '2026-10-02T00:00:00Z', value: 7 }]);
  });
});

describe('the KPI widget setting', () => {
  const kpi = { id: 'k', type: 'kpi', dataset: 'ih.users', metric: 'total' };
  it('accepts each and sum, and nothing else', () => {
    expect(dashboardWidgetSchema.safeParse({ ...kpi, combine: 'sum' }).success).toBe(true);
    expect(dashboardWidgetSchema.safeParse({ ...kpi, combine: 'each' }).success).toBe(true);
    expect(dashboardWidgetSchema.safeParse(kpi).success).toBe(true);
    expect(dashboardWidgetSchema.safeParse({ ...kpi, combine: 'average' }).success).toBe(false);
  });
});
