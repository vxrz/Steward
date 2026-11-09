/**
 * The catalogue's maintenance windows (#108, ADR 0018) as the monitor engine sees them: catalogue/maintenance.ts
 * registers the lookup here. A module without imports, so the registration works whatever order the import cycle
 * between the catalogue and the monitors evaluates them in.
 */
export interface ActiveMaintenance {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_by: string;
  created_at: string;
}

let lookup: ((mid: string, now: number) => ActiveMaintenance | undefined) | null = null;

export function setCatalogueMaintenance(fn: typeof lookup): void {
  lookup = fn;
}

/** The catalogue window that affects the monitor now, if any (none until catalogue/maintenance.ts is loaded). */
export const catalogueMaintenance = (mid: string, now: number): ActiveMaintenance | undefined => lookup?.(mid, now);

/**
 * Planned downtime (0.13, ADR 0021): catalogue windows of kind "downtime" that list the monitor or reach a platform it
 * checks. They leave the status as it is; for monitors with states they suspend the maximum off time, and their time
 * is not counted as off time.
 */
export interface PlannedDowntime {
  /** A downtime window is active now */
  active: boolean;
  /** Its time within [from, to] in ms (overlapping windows counted once) */
  ms: number;
}

let downtimeLookup: ((mid: string, from: number, to: number) => PlannedDowntime) | null = null;

export function setPlannedDowntime(fn: typeof downtimeLookup): void {
  downtimeLookup = fn;
}

/** The planned downtime of a monitor between `from` and `to` (none until catalogue/maintenance.ts is loaded). */
export const plannedDowntime = (mid: string, from: number, to: number): PlannedDowntime => downtimeLookup?.(mid, from, to) ?? { active: false, ms: 0 };
