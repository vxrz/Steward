import {
  currentPeriod,
  fromMicros,
  prepaidDrawdown,
  volumeEstimate,
  volumePeriods,
  volumeWarnings,
  type CostVolumeStatus,
  type CostVolumeWarning,
  type VolumePeriod,
  type VolumeUseItem,
} from '@sm/shared';
import { db } from '../db.js';
import { visibleContracts } from '../suppliers/links.js';
import { scopeInfo, type ScopeInfo } from './access.js';
import { instanceTimeZone, localDate } from '../duties/periods.js';
import { isVolume, schedulesWhere, type Schedule } from './schedule-model.js';

/**
 * Volumes of contracts (0.19.0, ADR 0032 part 3, docs/COSTS.md#volumes): the use of a volume schedule – from the cost
 * entries booked to its contract (any service or platform), or from its paying platform's read costs; never both –
 * read in bulk for a page, the status of its current period, what a prepaid volume covers, and the warnings.
 *
 * - Entries count for a volume when they name its contract, are in its currency and dated in a period, and are not
 *   booked on a line of another payment schedule (the contract's fixed payments) or on the payment line of a prepaid
 *   volume (the payment is not use). One volume schedule per contract and currency (schedules.ts).
 * - The use counts entries of every service and platform that books to the contract. A reader who may not see all of
 *   them gets the warnings only (`stateOnly`): the figures would give the others' costs away by subtraction – the rule
 *   of budgets (docs/COSTS.md#budgets).
 * - A prepaid volume covers use until it is used up (prepaidDrawdown): the cost plan does not count that part of an
 *   entry or of a platform's read costs as incurred again – the payment is the cost. Only for a reader who sees the
 *   volume's payer with amounts and every service and platform using it; others count the entry in full, marked
 *   (security review 0.19.0 M2).
 * - Warnings: used up, running out before the period ends, a ceiling passed or expected to be passed, a shortfall
 *   against the committed minimum; their notices: volume-notices.ts.
 */

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayOf = (now: number) => {
  const d = localDate(now, instanceTimeZone());
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
};

interface UseEntry {
  id: string;
  service_id: string;
  platform_id: string | null;
  entry_date: string;
  amount: number;
  currency: string;
  supplier_contract_id: string;
  plan_line_id: string | null;
}

const chunks = <T>(xs: readonly T[], n = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const marks = (xs: readonly unknown[]) => xs.map(() => '?').join(', ');

/** The use of a set of volume schedules, read in bulk: one statement for their entries, one for the lines to leave out, one for read costs. */
export class VolumeUse {
  private readonly schedules: Schedule[];
  private readonly itemsOf = new Map<string, VolumeUseItem[]>();
  private readonly ownersOf = new Map<string, Set<string>>();
  /** Per entry: the prepaid volumes billed from entries it counts for, and what each of them covers of it */
  private readonly drawnEntries = new Map<string, Map<string, number>>();
  private readonly drawnRead = new Map<string, number>();
  private readonly periodsOf = new Map<string, VolumePeriod[]>();

  constructor(
    list: readonly Schedule[],
    readonly today: string,
  ) {
    this.schedules = list.filter(isVolume);
    for (const s of this.schedules) this.periodsOf.set(s.row.id, volumePeriods(s.spec, s.terms));
    this.load();
  }

  /**
   * For a cost plan: the owner's volume schedules (their status, a platform's prepaid read costs), and the prepaid
   * volumes billed from entries whose contracts the plan's entries name (what they cover).
   */
  static forPlan(own: readonly Schedule[], entries: readonly { supplier_contract_id: string | null }[], now: number): VolumeUse {
    const contracts = [...new Set(entries.map((e) => e.supplier_contract_id).filter((x): x is string => !!x))];
    const mine = new Set(own.map((s) => s.row.id));
    const more = contracts.length ? schedulesWhere('contract_id', contracts).filter((s) => !mine.has(s.row.id) && isPrepaidEntries(s)) : [];
    return new VolumeUse([...own, ...more], todayOf(now));
  }

  static forSchedules(list: readonly Schedule[], now: number): VolumeUse {
    return new VolumeUse(list, todayOf(now));
  }

  private load(): void {
    const byEntries = this.schedules.filter((s) => s.spec.volume!.consumption === 'entries');
    const byRead = this.schedules.filter((s) => s.spec.volume!.consumption === 'read' && !!s.row.platform_id);
    if (byEntries.length) {
      const contracts = [...new Set(byEntries.map((s) => s.contract.id))];
      const rows: UseEntry[] = [];
      const lineSchedule = new Map<string, string>();
      for (const part of chunks(contracts)) {
        rows.push(
          ...db().all<UseEntry>(
            `SELECT id, service_id, platform_id, entry_date, amount, currency, supplier_contract_id, plan_line_id FROM cost_entries
              WHERE supplier_contract_id IN (${marks(part)}) ORDER BY entry_date, id`,
            ...part,
          ),
        );
        for (const l of db().all<{ id: string; schedule_id: string }>(
          `SELECT id, schedule_id FROM cost_plan_lines WHERE supplier_contract_id IN (${marks(part)}) AND schedule_id IS NOT NULL`,
          ...part,
        ))
          lineSchedule.set(l.id, l.schedule_id);
      }
      for (const s of byEntries) {
        const periods = this.periodsOf.get(s.row.id) ?? [];
        const first = periods[0]?.from ?? '9999';
        const last = periods[periods.length - 1]?.to ?? '0000';
        const prepaid = s.spec.volume!.billing === 'prepaid';
        const items: VolumeUseItem[] = [];
        const owners = new Set<string>();
        for (const e of rows) {
          if (e.supplier_contract_id !== s.contract.id || e.currency !== s.row.currency || e.entry_date < first || e.entry_date > last) continue;
          // not use: the contract's fixed payments, and the payment of a prepaid volume
          const of = e.plan_line_id ? lineSchedule.get(e.plan_line_id) : undefined;
          if (of && (of !== s.row.id || prepaid)) continue;
          items.push({ date: e.entry_date, amount: Number(e.amount), key: e.id });
          owners.add(e.platform_id ? `platform:${e.platform_id}` : `service:${e.service_id}`);
        }
        this.itemsOf.set(s.row.id, items);
        this.ownersOf.set(s.row.id, owners);
        if (prepaid) {
          const drawn = prepaidDrawdown(periods, items);
          for (const x of items) {
            if (!x.key) continue;
            const m = this.drawnEntries.get(x.key) ?? new Map<string, number>();
            m.set(s.row.id, (m.get(s.row.id) ?? 0) + (drawn.get(x.key) ?? 0));
            this.drawnEntries.set(x.key, m);
          }
        }
      }
    }
    if (byRead.length) {
      const platforms = [...new Set(byRead.map((s) => s.row.platform_id!))];
      const from = byRead.flatMap((s) => (this.periodsOf.get(s.row.id) ?? []).map((p) => p.from)).sort()[0] ?? this.today;
      const days: { platform_id: string; currency: string; d: string; e: number }[] = [];
      for (const part of chunks(platforms))
        days.push(
          ...db().all<{ platform_id: string; currency: string; d: string; e: number }>(
            `SELECT platform_id, billing_currency AS currency, substr(charge_period_start, 1, 10) AS d, SUM(effective_cost) AS e FROM cost_records
              WHERE platform_id IN (${marks(part)}) AND charge_period_start >= ? GROUP BY platform_id, billing_currency, substr(charge_period_start, 1, 10)`,
            ...part,
            from,
          ),
        );
      for (const s of byRead) {
        const items = days
          .filter((d) => d.platform_id === s.row.platform_id && d.currency === s.row.currency)
          .map((d) => ({ date: d.d, amount: Number(d.e ?? 0), key: d.d }));
        this.itemsOf.set(s.row.id, items);
        this.ownersOf.set(s.row.id, new Set([`platform:${s.row.platform_id}`]));
        if (s.spec.volume!.billing === 'prepaid')
          for (const [day, v] of prepaidDrawdown(this.periodsOf.get(s.row.id) ?? [], items)) {
            const k = `${s.row.platform_id}|${s.row.currency}|${day.slice(0, 7)}`;
            this.drawnRead.set(k, (this.drawnRead.get(k) ?? 0) + v);
          }
      }
    }
  }

  /**
   * The part of an entry prepaid volumes cover (micros), from the volumes `usable` for the reader only (security review
   * 0.19.0 M2: who sees the volume's payer with its amounts and every service and platform using it – else what is left
   * of another payer's volume would show by subtraction). `hidden`: the entry counts for a prepaid volume the reader may
   * not use that way – it then counts in full, nothing of that volume is drawn.
   */
  drawnEntry(entryId: string, usable: (s: Schedule) => boolean): { drawn: number; hidden: boolean } {
    let drawn = 0;
    let hidden = false;
    for (const [id, v] of this.drawnEntries.get(entryId) ?? []) {
      const s = this.schedules.find((x) => x.row.id === id);
      if (s && usable(s)) drawn += v;
      else hidden = true;
    }
    return { drawn, hidden };
  }

  /** The part of a platform's read costs of a month a prepaid volume covers (micros). */
  drawnReadMonth(platformId: string, currency: string, month: string): number {
    return this.drawnRead.get(`${platformId}|${currency}|${month}`) ?? 0;
  }

  /** The schedule is a volume billed by use from its platform's read costs (its lines take those read costs). */
  readByUse(scheduleId: string | null): boolean {
    const s = scheduleId ? this.schedules.find((x) => x.row.id === scheduleId) : undefined;
    return !!s && s.spec.volume!.billing === 'byUse' && s.spec.volume!.consumption === 'read';
  }

  items(scheduleId: string): VolumeUseItem[] {
    return this.itemsOf.get(scheduleId) ?? [];
  }

  /** The use of a period up to today (for what is owed). */
  usedIn(s: Schedule, p: Pick<VolumePeriod, 'from' | 'to'>): number {
    const upto = this.today < p.to ? this.today : p.to;
    return this.items(s.row.id).reduce((a, x) => (x.date >= p.from && x.date <= upto ? a + x.amount : a), 0);
  }

  /** The average use per month so far in the current period (Book's suggestion on a line billed by use). */
  monthlyAverage(s: Schedule, today = this.today): number {
    const p = currentPeriod(this.periodsOf.get(s.row.id) ?? [], today);
    if (!p || p.from > today) return 0;
    const used = this.usedIn(s, p);
    const months = (Number(today.slice(0, 4)) - Number(p.from.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(p.from.slice(5, 7)) + 1;
    return Math.round(used / Math.max(1, months));
  }

  /** Whether the reader sees every service and platform whose entries count for the volume. */
  seesAllOwners(s: Schedule, cache = new Map<string, boolean>()): boolean {
    for (const k of this.ownersOf.get(s.row.id) ?? []) {
      if (!cache.has(k)) {
        const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)] as ['service' | 'platform', string];
        cache.set(k, !!scopeInfo(kind, id));
      }
      if (!cache.get(k)) return false;
    }
    return true;
  }

  /** The current period of a volume, its estimate and warnings (no reader: figures only for the caller to shape). */
  evaluate(s: Schedule): { period: VolumePeriod; estimate: ReturnType<typeof volumeEstimate>; warnings: CostVolumeWarning[] } | null {
    const v = s.spec.volume;
    const period = currentPeriod(this.periodsOf.get(s.row.id) ?? [], this.today);
    if (!v || !period) return null;
    const estimate = volumeEstimate(period, this.items(s.row.id), this.today, s.row.currency);
    return { period, estimate, warnings: volumeWarnings(v, period, estimate) };
  }

  /** The status of a volume's current period as the reader sees it (`info`: the payer the reader sees). */
  status(s: Schedule, info: Pick<ScopeInfo, 'amounts'>, cache?: Map<string, boolean>): CostVolumeStatus | null {
    const v = s.spec.volume;
    const x = this.evaluate(s);
    if (!v || !x) return null;
    const { period: p, estimate: e, warnings } = x;
    const stateOnly = !this.seesAllOwners(s, cache);
    const figures = info.amounts && !stateOnly;
    const show = (n: number | null) => (figures && n !== null ? fromMicros(n) : null);
    return {
      per: v.per,
      billing: v.billing,
      committed: v.committed,
      consumption: v.consumption,
      currency: s.row.currency,
      period: { index: p.index, from: p.from, to: p.to },
      amount: info.amounts ? fromMicros(p.amount) : null,
      minimum: info.amounts ? fromMicros(p.minimum) : null,
      used: show(e.used),
      left: show(p.amount - e.used),
      sharePct: figures && p.amount > 0 ? Math.round((e.used / p.amount) * 1000) / 10 : null,
      expectedAtEnd: show(e.expectedAtEnd),
      runsOutOn: figures ? e.runsOutOn : null,
      ratePerDay: figures && e.rate !== null ? fromMicros(Math.round(e.rate)) : null,
      window: figures ? e.window : null,
      warnings,
      stateOnly,
    };
  }
}

/** Prepaid volumes whose use is entries: entries naming their contract are covered until the volume is used up. */
const isPrepaidEntries = (s: Schedule) => isVolume(s) && s.spec.volume!.billing === 'prepaid' && s.spec.volume!.consumption === 'entries';

/** The volumes the plan's owner pays, each with its current period (CostPlanYear.volumes). */
export function volumeView(
  vu: VolumeUse,
  own: readonly Schedule[],
  info: ScopeInfo,
): (CostVolumeStatus & {
  scheduleId: string;
  title: string;
  contractId: string;
  contractHidden: boolean;
})[] {
  const list = own.filter(isVolume);
  if (!list.length) return [];
  const seen = visibleContracts(list.map((s) => s.contract.id));
  const cache = new Map<string, boolean>();
  return list.flatMap((s) => {
    const st = vu.status(s, info, cache);
    if (!st) return [];
    const visible = seen.has(s.contract.id);
    return [
      {
        ...st,
        scheduleId: s.row.id,
        title: visible ? `${s.contract.title} – ${s.row.title}` : s.row.title,
        contractId: s.contract.id,
        contractHidden: !visible,
      },
    ];
  });
}
