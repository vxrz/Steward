import { describe, expect, it } from 'vitest';
import {
  contractYearOf,
  earliestExit,
  noticeWarning,
  proposalParts,
  scheduleEnd,
  scheduleOwed,
  schedulePayments,
  spreadAmount,
  toMicros,
  yearAmountsFromPercent,
  type ContractTerms,
  type ScheduleSpec,
} from '@sm/shared';

/**
 * The arithmetic of payment schedules (0.18.0, ADR 0030, shared/src/costContracts.ts): payment dates, contract years
 * against fiscal years, proposals per fiscal year, minor units, earliest exit and commitments as of a day. Pure
 * functions – no server.
 */

const M = (v: string) => toMicros(v)!;
const spec = (x: Partial<ScheduleSpec>): ScheduleSpec => ({
  billing: 'monthly',
  amount: M('1000'),
  currency: 'EUR',
  firstPaymentOn: null,
  startsOn: null,
  endsOn: null,
  yearAmounts: [],
  payments: [],
  ...x,
});
const terms = (x: Partial<ContractTerms>): ContractTerms => ({
  startsOn: null,
  endsOn: null,
  noticeDays: null,
  renewal: 'fixedEnd',
  renewalMonths: null,
  ...x,
});
const money = (n: number) => n / 1_000_000;

describe('payment dates', () => {
  it('fall on the same day every 1, 3 or 12 months – on the last day of a shorter month', () => {
    const c = terms({ startsOn: '2026-01-31', endsOn: '2027-01-30' });
    expect(
      schedulePayments(spec({}), c)
        .map((p) => p.date)
        .slice(0, 4),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    // a leap year: 29 February, and the 31st again after it
    const leap = schedulePayments(spec({}), terms({ startsOn: '2028-01-31', endsOn: '2028-04-30' })).map((p) => p.date);
    expect(leap).toEqual(['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
    expect(schedulePayments(spec({ billing: 'quarterly' }), c).map((p) => p.date)).toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
    const yearly = schedulePayments(spec({ billing: 'yearly', firstPaymentOn: '2024-02-29' }), terms({ startsOn: '2024-02-29', endsOn: '2027-03-31' }));
    expect(yearly.map((p) => p.date)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
    // a yearly payment covers its twelve months (capped by the end): prepaid
    expect(yearly[3]).toMatchObject({ coversFrom: '2027-02-28', coversTo: '2027-03-31' });
    expect(yearly[0]).toMatchObject({ coversFrom: '2024-02-29', coversTo: '2025-02-27' });
  });

  it('dated payments keep their dates, amounts and what they cover', () => {
    const s = spec({
      billing: 'dates',
      payments: [
        { date: '2026-03-15', amount: M('250.5'), coversUntil: null },
        { date: '2026-02-01', amount: M('100'), coversUntil: '2026-12-31' },
      ],
    });
    const ps = schedulePayments(s, terms({ startsOn: '2026-02-01', endsOn: '2027-01-31' }));
    expect(ps.map((p) => [p.date, money(p.amount), p.coversTo])).toEqual([
      ['2026-02-01', 100, '2026-12-31'],
      ['2026-03-15', 250.5, null],
    ]);
  });

  it('end with the schedule, a fixed contract end, or ten years for an automatic renewal', () => {
    expect(scheduleEnd(spec({ endsOn: '2027-06-30' }), terms({ startsOn: '2026-01-01', endsOn: '2028-12-31' }))).toBe('2027-06-30');
    // never past a fixed end
    expect(scheduleEnd(spec({ endsOn: '2030-06-30' }), terms({ startsOn: '2026-01-01', endsOn: '2028-12-31' }))).toBe('2028-12-31');
    expect(scheduleEnd(spec({}), terms({ startsOn: '2026-01-01', endsOn: '2028-12-31', renewal: 'byAgreement' }))).toBe('2028-12-31');
    // term by term: at most ten years from the start
    expect(scheduleEnd(spec({}), terms({ startsOn: '2026-01-01', endsOn: '2026-12-31', renewal: 'automatic', renewalMonths: 12 }))).toBe('2035-12-31');
    expect(scheduleEnd(spec({}), terms({ startsOn: '2026-01-01' }))).toBe('2035-12-31');
    expect(schedulePayments(spec({}), terms({ startsOn: '2026-01-01' }))).toHaveLength(120);
    // no start anywhere: nothing to compute
    expect(scheduleEnd(spec({}), terms({}))).toBeNull();
  });

  it('count contract years from the start in twelve-month steps', () => {
    expect(contractYearOf('2026-02-01', '2026-02-01')).toBe(1);
    expect(contractYearOf('2027-01-31', '2026-02-01')).toBe(1);
    expect(contractYearOf('2027-02-01', '2026-02-01')).toBe(2);
    expect(contractYearOf('2029-01-31', '2026-02-01')).toBe(3);
    // twelve months after 29 February: 28 February (the last day of the shorter month)
    expect(contractYearOf('2025-02-27', '2024-02-29')).toBe(1);
    expect(contractYearOf('2025-02-28', '2024-02-29')).toBe(2);
  });
});

describe('proposals per fiscal year', () => {
  // ADR 0030's example: monthly 1,000.00 EUR from 1 February 2026 to 31 January 2029, +3 % per contract year
  const example = spec({ yearAmounts: yearAmountsFromPercent(M('1000'), 3, 'EUR') });
  const contract = terms({ startsOn: '2026-02-01', endsOn: '2029-01-31' });
  const lines = (fy: number, start: number) =>
    proposalParts(example, contract, fy, start).map((p) => ({ part: p.part, cadence: p.cadence, from: p.fromIndex, to: p.toIndex, amount: money(p.amount) }));

  it('fill contract years from + x % per year in minor units (EUR, JPY, KWD)', () => {
    expect(yearAmountsFromPercent(M('1000'), 3, 'EUR', 3).map(money)).toEqual([1030, 1060.9, 1092.73]);
    expect(yearAmountsFromPercent(M('1000'), 3.3, 'JPY', 2).map(money)).toEqual([1033, 1067]);
    expect(yearAmountsFromPercent(M('12.345'), 2.5, 'KWD', 1).map(money)).toEqual([12.654]);
  });

  it('give the example’s lines with the fiscal year from October', () => {
    expect(lines(2025, 10)).toEqual([{ part: 'y1', cadence: 'monthly', from: 4, to: 11, amount: 1000 }]);
    expect(lines(2026, 10)).toEqual([
      { part: 'y1', cadence: 'monthly', from: 0, to: 3, amount: 1000 },
      { part: 'y2', cadence: 'monthly', from: 4, to: 11, amount: 1030 },
    ]);
    expect(lines(2027, 10)).toEqual([
      { part: 'y2', cadence: 'monthly', from: 0, to: 3, amount: 1030 },
      { part: 'y3', cadence: 'monthly', from: 4, to: 11, amount: 1060.9 },
    ]);
    expect(lines(2028, 10)).toEqual([{ part: 'y3', cadence: 'monthly', from: 0, to: 3, amount: 1060.9 }]);
    expect(lines(2029, 10)).toEqual([]);
    // and the sums of what the lines plan are the payments of the year
    const sum = (fy: number) => proposalParts(example, contract, fy, 10).reduce((a, p) => a + p.months.reduce((x, y) => x + y, 0), 0);
    expect(money(sum(2026))).toBe(4 * 1000 + 8 * 1030);
  });

  it('follow fiscal years that start in January, April and December', () => {
    expect(lines(2026, 1)).toEqual([{ part: 'y1', cadence: 'monthly', from: 1, to: 11, amount: 1000 }]);
    expect(lines(2027, 1)).toEqual([
      { part: 'y1', cadence: 'monthly', from: 0, to: 0, amount: 1000 },
      { part: 'y2', cadence: 'monthly', from: 1, to: 11, amount: 1030 },
    ]);
    expect(lines(2025, 4)).toEqual([{ part: 'y1', cadence: 'monthly', from: 10, to: 11, amount: 1000 }]);
    expect(lines(2028, 4)).toEqual([{ part: 'y3', cadence: 'monthly', from: 0, to: 9, amount: 1060.9 }]);
    expect(lines(2025, 12)).toEqual([{ part: 'y1', cadence: 'monthly', from: 2, to: 11, amount: 1000 }]);
    expect(lines(2026, 12)).toEqual([
      { part: 'y1', cadence: 'monthly', from: 0, to: 1, amount: 1000 },
      { part: 'y2', cadence: 'monthly', from: 2, to: 11, amount: 1030 },
    ]);
    // a whole year in one contract year: no from and to
    const whole = proposalParts(spec({}), terms({ startsOn: '2026-01-01', endsOn: '2027-12-31' }), 2026, 1);
    expect(whole).toMatchObject([{ part: 'y1', fromIndex: null, toIndex: null }]);
  });

  it('give quarterly, yearly, one-off and dated lines with their payment dates', () => {
    const c = terms({ startsOn: '2026-02-15', endsOn: '2029-02-14' });
    expect(proposalParts(spec({ billing: 'quarterly' }), c, 2026, 1).map((p) => [p.part, p.cadence, p.fromIndex, p.toIndex])).toEqual([
      ['y1', 'quarterly', 1, 10],
    ]);
    const yearly = proposalParts(spec({ billing: 'yearly', amount: M('12000') }), c, 2025, 10);
    expect(yearly.map((p) => [p.part, p.cadence, p.onceIndex, money(p.amount), p.coversFrom, p.coversTo])).toEqual([
      ['p2026-02-15', 'once', 4, 12000, '2026-02-15', '2027-02-14'],
    ]);
    expect(yearly[0]!.paymentDates[4]).toBe('2026-02-15');
    // a prepaid licence for three years: one line in the year it is paid, covering the term
    const once = proposalParts(spec({ billing: 'once', amount: M('36000') }), c, 2025, 10);
    expect(once).toMatchObject([{ part: 'p2026-02-15', cadence: 'once', coversFrom: '2026-02-15', coversTo: '2029-02-14' }]);
    expect(proposalParts(spec({ billing: 'once', amount: M('36000') }), c, 2026, 10)).toEqual([]);
    const dated = proposalParts(
      spec({
        billing: 'dates',
        payments: [
          { date: '2026-03-01', amount: M('100'), coversUntil: null },
          { date: '2026-03-01', amount: M('50'), coversUntil: null },
        ],
      }),
      c,
      2026,
      1,
    );
    expect(dated.map((p) => [p.part, p.onceIndex, money(p.amount)])).toEqual([
      ['p2026-03-01', 2, 100],
      ['p2026-03-01#2', 2, 50],
    ]);
  });

  it('spread yearly amounts that add up in minor units', () => {
    expect(spreadAmount(M('1000'), 12, 'EUR').reduce((a, b) => a + b, 0)).toBe(M('1000'));
    expect(spreadAmount(M('1000'), 12, 'JPY').every((v) => v % 1_000_000 === 0)).toBe(true);
    expect(spreadAmount(M('1'), 3, 'KWD').map(money)).toEqual([0.333, 0.333, 0.334]);
  });
});

describe('commitments', () => {
  // the supplier documentation's example: ends 31 January 2027, 90 days' notice, renews by 12 months
  const contract = terms({ startsOn: '2024-02-01', endsOn: '2027-01-31', noticeDays: 90, renewal: 'automatic', renewalMonths: 12 });
  const schedule = spec({ startsOn: '2024-02-01', endsOn: '2029-01-31' });

  it('owe to contract end and to the earliest exit as of a day', () => {
    const o = scheduleOwed(schedule, contract, '2026-11-11', 10);
    expect(money(o.toContractEnd)).toBe(26_000);
    expect(money(o.toEarliestExit)).toBe(14_000);
    expect(o.earliestExit).toBe('2028-01-31');
    expect(o.nextPayment).toEqual({ date: '2026-12-01', amount: M('1000') });
    expect(o.byFiscalYear.map((y) => [y.fiscalYear, money(y.toContractEnd), money(y.toEarliestExit)])).toEqual([
      [2026, 10_000, 10_000],
      [2027, 12_000, 4_000],
      [2028, 4_000, 0],
    ]);
    // a payment dated today still counts
    expect(money(scheduleOwed(schedule, contract, '2026-12-01', 10).toContractEnd)).toBe(26_000);
  });

  it('find the earliest exit for each kind of renewal and without an end date', () => {
    expect(earliestExit(contract, '2026-11-11')).toBe('2028-01-31');
    // before the notice-by date: the current term
    expect(earliestExit(contract, '2026-10-01')).toBe('2027-01-31');
    expect(earliestExit(terms({ endsOn: '2027-06-30', renewal: 'fixedEnd' }), '2026-11-11')).toBe('2027-06-30');
    expect(earliestExit(terms({ endsOn: '2027-06-30', renewal: 'byAgreement', noticeDays: 30 }), '2026-11-11')).toBe('2027-06-30');
    expect(earliestExit(terms({ noticeDays: 30 }), '2026-11-11')).toBe('2026-12-11');
    expect(earliestExit(terms({}), '2026-11-11')).toBe('2026-11-11');
    // automatic renewal without an own end: to contract end is the earliest exit (no later end is agreed)
    const o = scheduleOwed(spec({ startsOn: '2024-02-01' }), contract, '2026-11-11', 10);
    expect(o.toContractEnd).toBe(o.toEarliestExit);
    expect(money(o.toContractEnd)).toBe(14_000);
    // a fixed end: both are the end
    const f = scheduleOwed(spec({}), terms({ startsOn: '2026-01-01', endsOn: '2027-06-30' }), '2026-11-11', 1);
    expect(money(f.toContractEnd)).toBe(7_000);
    expect(money(f.toEarliestExit)).toBe(7_000);
  });

  it('warn before a notice-by date when the next term’s fiscal year is not planned', () => {
    const w = noticeWarning(contract, '2026-11-11', 10, new Set([2026]));
    expect(w).toMatchObject({ noticeBy: '2027-11-02', fiscalYear: 2027, label: 'FY 2027/28', soon: false });
    expect(noticeWarning(contract, '2026-11-11', 10, new Set([2027]))).toBeNull();
    expect(noticeWarning(contract, '2027-09-01', 10, new Set())).toMatchObject({ soon: true });
    expect(noticeWarning(terms({ endsOn: '2027-01-31', noticeDays: 90 }), '2026-09-01', 10, new Set())).toBeNull();
    // the schedule ends before the next term
    expect(noticeWarning(contract, '2026-11-11', 10, new Set(), '2028-01-31')).toBeNull();
  });
});
