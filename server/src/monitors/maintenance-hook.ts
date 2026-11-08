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
