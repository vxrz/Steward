import {
  STATE_LIMITS,
  worstStatus,
  type CheckDef,
  type CheckOf,
  type MonitorDefinition,
  type MonitorStatus,
  type StateCase,
  type StateCell,
} from './monitors.js';

/**
 * Monitor states (0.13, ADR 0021): the decision table of a monitor, evaluated without I/O so the engine and the
 * editor's "Try it" give the same answer.
 *
 * 1. Select the state with the confirmed check statuses: the first row whose condition (and required checks) match;
 *    `unknown` in a condition keeps the current state; a follower takes its leader's state.
 * 2. Compare the selected row's cells with the checks. A deviating expectation is a contradiction once the settle
 *    time of the latest state change has passed; a required check that is not up makes the monitor down at once.
 * 3. Status: off or up (aggregated over the checks expected up) while everything agrees; down (or degraded) on a
 *    contradiction, root cause the deviating cells of the closest row; degraded when off for longer than the maximum
 *    (planned downtime does not count) or when the state changes more than 4 times within an hour.
 */

export type CellVerdict = 'agrees' | 'contradicts' | 'settling' | 'unknown';
export type StateRole = 'when' | 'requires' | 'expect';

export interface StateCellView {
  checkId: string;
  role: StateRole;
  /** up, down or off (a required check: up) */
  expected: Exclude<StateCell, 'any'>;
  /** The check's confirmed status */
  actual: MonitorStatus;
  verdict: CellVerdict;
}

/** Why the monitor shows its status (the "Why this state" panel). */
export type StateReason = 'agree' | 'settling' | 'contradiction' | 'required' | 'maxOff' | 'flapping' | 'unknown' | 'otherwise';

export interface MonitorStateInfo {
  /** The selected state; null: Otherwise (as without states) */
  id: string | null;
  name: string | null;
  /** The status the state shows while everything agrees */
  shows: 'up' | 'off' | null;
  since: string | null;
  /** End of the settle time (while it lasts, deviations do not count) */
  settlingUntil: string | null;
  reason: StateReason;
  /** English, like the engine's other messages: "Running, but Machine data flow is down" */
  message: string;
  cells: StateCellView[];
  /** On a contradiction: the closest state and the checks that deviate from it */
  contradiction: { closest: string; closestName: string; checks: { checkId: string; expected: string; actual: MonitorStatus }[] } | null;
  /** Required checks that are not up */
  required: string[];
  /** Off states: off time so far (planned downtime not counted) and the maximum (0: none), seconds */
  offSeconds: number | null;
  maxOffSeconds: number | null;
  /** Planned downtime (a catalogue window of kind downtime) is active now */
  plannedDowntime: boolean;
  changesLastHour: number;
  /** Expected checks that could not be checked */
  unknownChecks: number;
  /** Followers: the monitor whose state they follow */
  follows: string | null;
}

/** What the engine stores per monitor between evaluations. */
export interface StateMemory {
  id: string | null;
  since: number | null;
  settleUntil: number | null;
  /** Times of the state changes within the last hour */
  changes: number[];
}

export interface StateInput {
  def: MonitorDefinition;
  /** Confirmed statuses (after flapping control) of the enabled checks */
  statuses: Map<string, MonitorStatus>;
  /** null: never evaluated with states */
  memory: StateMemory | null;
  now: number;
  /** Followers: the leader's current state id (null: none) */
  leaderState?: string | null;
  /** Planned downtime: active now, and its time within [from, now] in ms */
  downtime?: { active: boolean; msSince: (from: number) => number };
  /** The settle time a sub-monitor column needs (its own checks), seconds */
  subSettle?: (check: CheckOf<'monitor'>, cell: Exclude<StateCell, 'any'>) => number;
}

export interface StateOutcome {
  memory: StateMemory;
  /** The state changed in this evaluation */
  changed: boolean;
  previous: string | null;
  row: StateCase | null;
  /** The monitor status the states decide; null: the evaluation without states applies (only flapping may degrade it) */
  status: MonitorStatus | null;
  /** Checks that agree with an expected down: they show off */
  offChecks: Set<string>;
  /** Root-cause check ids (deviating cells of the closest row, or failing required checks) */
  causes: string[];
  /** The selected state is too unsettled: at least degraded */
  flapping: boolean;
  info: MonitorStateInfo;
}

const HOUR = 3600000;
export const hasStates = (def: Pick<MonitorDefinition, 'states'>): boolean => !!def.states && (def.states.cases.length > 0 || !!def.states.from);

/** Does the status match the cell? null: unknown (confirms nothing, contradicts nothing). */
export function cellMatches(cell: StateCell, s: MonitorStatus | undefined): boolean | null {
  if (cell === 'any') return true;
  if (s === undefined || s === 'unknown' || s === 'maintenance') return null;
  if (cell === 'up') return s === 'up' || s === 'degraded';
  // blocked is consistent with its parent being down; an off sub-monitor is not running either
  if (cell === 'down') return s === 'down' || s === 'blocked' || s === 'off';
  return s === 'off';
}

const fmtSpan = (ms: number): string => {
  const min = Math.round(ms / 60000);
  if (min < 120) return `${min} min`;
  const h = ms / HOUR;
  return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
};

/** Freshness window of freshness and heartbeat checks (as the engine's freshnessWindowSeconds); 0 for others. */
function windowSeconds(c: CheckDef): number {
  if (c.type !== 'freshness' && c.type !== 'heartbeat') return 0;
  const base = c.mode === 'maxAge' ? (c.maxAgeSeconds ?? 3600) : (c.expectedIntervalSeconds ?? 60) * (c.downAfterMissed ?? 4);
  return base + Math.max(0, c.allowedDelaySeconds ?? 0);
}

/** Settle time of one check for an expected cell: freshness window + interval × confirmations. */
export function checkSettleSeconds(def: MonitorDefinition, c: CheckDef, cell: Exclude<StateCell, 'any'>, sub?: StateInput['subSettle']): number {
  if (c.type === 'monitor') return sub?.(c, cell) ?? 0;
  const interval = c.intervalSeconds ?? def.intervalSeconds;
  const confirmations = cell === 'up' ? (c.successesBeforeUp ?? def.successesBeforeUp) : (c.failuresBeforeDown ?? def.failuresBeforeDown);
  return windowSeconds(c) + interval * confirmations;
}

/** The largest settle time of a monitor's checks (what a parent's sub-monitor column needs). */
export function monitorSettleSeconds(def: MonitorDefinition, cell: Exclude<StateCell, 'any'>): number {
  let max = 0;
  for (const c of def.checks) if (c.enabled !== false && c.type !== 'monitor') max = Math.max(max, checkSettleSeconds(def, c, cell === 'off' ? 'down' : cell));
  return max;
}

/** The settle time of a row: its own value, else derived from its expected checks (seconds). */
export function derivedSettleSeconds(def: MonitorDefinition, row: StateCase, sub?: StateInput['subSettle']): number {
  let max = 0;
  for (const [cid, cell] of Object.entries(row.expect ?? {})) {
    if (cell === 'any') continue;
    const c = def.checks.find((x) => x.id === cid);
    if (c && c.enabled !== false) max = Math.max(max, checkSettleSeconds(def, c, cell, sub));
  }
  return max;
}
export const settleSecondsOf = (def: MonitorDefinition, row: StateCase, sub?: StateInput['subSettle']): number =>
  row.settleSeconds ?? derivedSettleSeconds(def, row, sub);

/** The maximum off time of an off row in seconds (0: none). */
export function maxOffSecondsOf(def: MonitorDefinition, row: StateCase): number {
  if (row.status !== 'off' || def.states?.from) return 0;
  const h = row.maxOffHours ?? def.states?.maxOffHours ?? STATE_LIMITS.defaultMaxOffHours;
  return Math.round(h * 3600);
}

/** The cells of a row in table order: condition, required, expectations ("any" left out). */
export function rowCells(row: StateCase): { checkId: string; role: StateRole; expected: Exclude<StateCell, 'any'> }[] {
  const out: { checkId: string; role: StateRole; expected: Exclude<StateCell, 'any'> }[] = [];
  for (const [checkId, cell] of Object.entries(row.when ?? {})) if (cell !== 'any') out.push({ checkId, role: 'when', expected: cell });
  for (const checkId of row.requires ?? []) out.push({ checkId, role: 'requires', expected: 'up' });
  for (const [checkId, cell] of Object.entries(row.expect ?? {})) if (cell !== 'any') out.push({ checkId, role: 'expect', expected: cell });
  return out;
}

type Selection = { row: StateCase | null; required: string[]; requiredRow: StateCase | null; requiredUnknown: boolean };

/** Step 1: the state the confirmed statuses select. */
export function selectState(def: MonitorDefinition, statuses: Map<string, MonitorStatus>, current: string | null, leaderState?: string | null): Selection {
  const st = def.states;
  const none: Selection = { row: null, required: [], requiredRow: null, requiredUnknown: false };
  if (!st) return none;
  if (st.from) return { ...none, row: st.cases.find((r) => r.id === leaderState) ?? null };
  const enabled = (id: string) => statuses.has(id);
  for (const row of st.cases) {
    let ok = true;
    for (const [cid, cell] of Object.entries(row.when ?? {})) {
      if (cell === 'any' || !enabled(cid)) continue;
      const m = cellMatches(cell, statuses.get(cid));
      // unknown keeps the current state; it never selects another one
      if (m === false || (m === null && row.id !== current)) {
        ok = false;
        break;
      }
    }
    if (!ok || !Object.entries(row.when ?? {}).some(([cid, cell]) => cell !== 'any' && enabled(cid))) continue;
    const failing: string[] = [];
    let unknown = false;
    for (const cid of row.requires ?? []) {
      if (!enabled(cid)) continue;
      const m = cellMatches('up', statuses.get(cid));
      if (m === false) failing.push(cid);
      else if (m === null && row.id !== current) unknown = true;
    }
    if (failing.length) return { row: null, required: failing, requiredRow: row, requiredUnknown: false };
    if (unknown) return { row: null, required: [], requiredRow: row, requiredUnknown: true };
    return { ...none, row };
  }
  return none;
}

/** Deviating cells of a row against the statuses (unknown and "any" do not count). */
function deviations(row: StateCase, statuses: Map<string, MonitorStatus>): { checkId: string; expected: string; actual: MonitorStatus }[] {
  return rowCells(row)
    .filter((c) => statuses.has(c.checkId) && cellMatches(c.expected, statuses.get(c.checkId)) === false)
    .map((c) => ({ checkId: c.checkId, expected: c.expected, actual: statuses.get(c.checkId)! }));
}

/** The row with the fewest contradicted cells (the selected row wins a tie, then the earlier row). */
export function closestRow(def: MonitorDefinition, statuses: Map<string, MonitorStatus>, selected: StateCase | null): StateCase | null {
  const rows = def.states?.cases ?? [];
  let best: StateCase | null = null;
  let bestN = Infinity;
  for (const r of rows) {
    const n = deviations(r, statuses).length;
    if (n < bestN || (n === bestN && r === selected)) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

const nameOf = (r: StateCase): string => r.name || r.id;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Steps 1–3 for one evaluation. */
export function evaluateStates(input: StateInput): StateOutcome {
  const { def, statuses, now } = input;
  const nameOfCheck = (id: string) => def.checks.find((c) => c.id === id)?.name ?? id;
  const mem: StateMemory = input.memory ?? { id: null, since: null, settleUntil: null, changes: [] };
  const sel = selectState(def, statuses, mem.id, input.leaderState);
  const row = sel.row;
  const nextId = row?.id ?? null;
  const changed = !input.memory || nextId !== mem.id;
  const changes = mem.changes.filter((t) => t > now - HOUR);
  if (changed && input.memory) changes.push(now);
  const since = changed ? now : (mem.since ?? now);
  const settleUntil = !row ? null : changed ? now + settleSecondsOf(def, row, input.subSettle) * 1000 : mem.settleUntil;
  const settling = settleUntil !== null && now < settleUntil;
  const memory: StateMemory = { id: nextId, since, settleUntil, changes };
  const flapping = changes.length > STATE_LIMITS.changesPerHour;
  const info: MonitorStateInfo = {
    id: nextId,
    name: row ? nameOf(row) : null,
    shows: row ? (row.status ?? 'up') : null,
    since: new Date(since).toISOString(),
    settlingUntil: settling ? new Date(settleUntil!).toISOString() : null,
    reason: 'otherwise',
    message: '',
    cells: [],
    contradiction: null,
    required: sel.required,
    offSeconds: null,
    maxOffSeconds: null,
    plannedDowntime: !!input.downtime?.active,
    changesLastHour: changes.length,
    unknownChecks: 0,
    follows: def.states?.from ?? null,
  };
  const out: StateOutcome = { memory, changed, previous: mem.id, row, status: null, offChecks: new Set(), causes: [], flapping, info };
  const tooOften = () => `Changes state too often: ${changes.length} times in the last hour`;

  // a required check is not up: the state cannot be trusted – down at once (unknown: not known yet)
  if (!row && sel.requiredRow) {
    const r = sel.requiredRow;
    info.cells = rowCells(r).map((c) => ({
      ...c,
      actual: statuses.get(c.checkId) ?? 'unknown',
      verdict: verdictOf(c.expected, statuses.get(c.checkId), false),
    }));
    if (sel.requiredUnknown) {
      out.status = 'unknown';
      info.reason = 'unknown';
      info.message = `${nameOf(r)} cannot be trusted: a required check could not be checked`;
    } else {
      out.status = 'down';
      out.causes = sel.required;
      info.reason = 'required';
      info.message = `${sel.required.map(nameOfCheck).join(', ')} ${plural(sel.required.length, 'is', 'are')} silent – ${nameOf(r)} cannot be told from an outage`;
    }
    return out;
  }
  if (!row) {
    info.message = def.states?.from ? 'Follows no state of the leading monitor: evaluated as without states' : 'No state matches: evaluated as without states';
    if (flapping) {
      info.reason = 'flapping';
      info.message = tooOften();
    }
    return out;
  }

  // step 2: compare
  const cells: StateCellView[] = rowCells(row)
    .filter((c) => statuses.has(c.checkId))
    .map((c) => {
      const actual = statuses.get(c.checkId) ?? 'unknown';
      return { ...c, actual, verdict: verdictOf(c.expected, actual, c.role === 'expect' && settling) };
    });
  info.cells = cells;
  for (const c of cells) if (c.verdict === 'agrees' && c.expected !== 'up') out.offChecks.add(c.checkId);
  const contradicting = cells.filter((c) => c.verdict === 'contradicts');
  const expectations = cells.filter((c) => c.role === 'expect');
  info.unknownChecks = expectations.filter((c) => c.verdict === 'unknown').length;

  if (contradicting.length) {
    const closest = closestRow(def, statuses, row) ?? row;
    let devs = deviations(closest, statuses);
    if (!devs.length) {
      // the closest row agrees (it comes after the selected one): the selected row's deviations count
      devs = contradicting.map((c) => ({ checkId: c.checkId, expected: c.expected, actual: c.actual }));
    }
    out.causes = devs.filter((d) => d.actual !== 'blocked').map((d) => d.checkId);
    if (!out.causes.length) out.causes = devs.map((d) => d.checkId);
    const critical = contradicting.some((c) => def.checks.find((x) => x.id === c.checkId)?.critical !== false);
    out.status = row.contradiction === 'degraded' || !critical ? 'degraded' : 'down';
    info.reason = 'contradiction';
    info.contradiction = { closest: closest.id, closestName: nameOf(closest), checks: devs };
    const isWord = (d: { checkId: string; actual: MonitorStatus }) => `${nameOfCheck(d.checkId)} is ${d.actual === 'blocked' ? 'down' : d.actual}`;
    if (closest === row) info.message = `${nameOf(row)}, but ${devs.map(isWord).join(', ')}`;
    else {
      const agreeing = rowCells(closest).filter((c) => statuses.has(c.checkId) && cellMatches(c.expected, statuses.get(c.checkId)) === true).length;
      info.message = `${devs.map(isWord).join(', ')}, but ${agreeing} ${plural(agreeing, 'check says', 'checks say')} ${nameOf(closest)}`;
    }
  } else if (expectations.length && expectations.every((c) => c.verdict === 'unknown')) {
    out.status = 'unknown';
    info.reason = 'unknown';
    info.message = `${nameOf(row)}: none of the expected checks could be checked`;
  } else {
    if ((row.status ?? 'up') === 'off') out.status = 'off';
    else {
      // up: today's aggregation over the checks expected up that agree (a degraded check still degrades)
      const up = cells.filter((c) => c.expected === 'up' && c.verdict === 'agrees').map((c) => c.actual);
      out.status = up.length ? worstStatus(up) : 'up';
      if (out.status !== 'up' && out.status !== 'degraded') out.status = 'up';
    }
    info.reason = settling && cells.some((c) => c.verdict === 'settling') ? 'settling' : 'agree';
    const unknownNote = info.unknownChecks ? ` – ${info.unknownChecks} ${plural(info.unknownChecks, 'check', 'checks')} could not be checked` : '';
    info.message =
      info.reason === 'settling'
        ? `${nameOf(row)} – settling until ${new Date(settleUntil!).toISOString()}${unknownNote}`
        : `${nameOf(row)} – all checks agree${unknownNote}`;
  }

  // maximum off time: from when the state became off, planned downtime not counted
  if ((row.status ?? 'up') === 'off') {
    const max = maxOffSecondsOf(def, row);
    const offMs = Math.max(0, now - since - (input.downtime?.msSince(since) ?? 0));
    info.offSeconds = Math.round(offMs / 1000);
    info.maxOffSeconds = max;
    if (max > 0 && out.status === 'off' && !input.downtime?.active && offMs > max * 1000) {
      out.status = 'degraded';
      info.reason = 'maxOff';
      info.message = `Off for longer than expected (${fmtSpan(offMs)}, maximum ${fmtSpan(max * 1000)})`;
    }
  }
  if (flapping && out.status !== 'down') {
    out.status = 'degraded';
    info.reason = 'flapping';
    info.message = tooOften();
  }
  return out;
}

function verdictOf(expected: Exclude<StateCell, 'any'>, actual: MonitorStatus | undefined, settling: boolean): CellVerdict {
  const m = cellMatches(expected, actual);
  if (m === null) return 'unknown';
  if (m) return 'agrees';
  return settling ? 'settling' : 'contradicts';
}

/**
 * Folds deviating checks along links (a deviating check whose parent deviates too is likely caused by it): the
 * deviating checks without a deviating ancestor.
 */
export function foldDeviations(def: MonitorDefinition, ids: string[]): string[] {
  const set = new Set(ids);
  const parents = new Map<string, string[]>();
  for (const l of def.links) parents.set(l.to, [...(parents.get(l.to) ?? []), l.from]);
  const hasDeviatingAncestor = (id: string, seen: Set<string>): boolean =>
    (parents.get(id) ?? []).some((p) => !seen.has(p) && (set.has(p) || hasDeviatingAncestor(p, new Set(seen).add(p))));
  const out = ids.filter((id) => !hasDeviatingAncestor(id, new Set([id])));
  return out.length ? out : ids;
}

/** "Try it" of the editor: what the monitor would report for the given check statuses (nothing settles, nothing is stored). */
export function tryStates(
  def: MonitorDefinition,
  statuses: Record<string, MonitorStatus>,
  opts: { leaderState?: string | null; current?: string | null } = {},
) {
  const map = new Map(def.checks.filter((c) => c.enabled !== false).map((c) => [c.id, statuses[c.id] ?? 'unknown'] as const));
  const now = 0;
  const outcome = evaluateStates({
    def,
    statuses: map,
    // the current state, settled: a contradiction shows at once
    memory: { id: opts.current ?? null, since: now, settleUntil: null, changes: [] },
    now,
    leaderState: opts.leaderState,
  });
  // a changed state settles in the engine; "Try it" shows the settled answer
  if (outcome.changed && outcome.row) {
    return evaluateStates({
      def,
      statuses: map,
      memory: { id: outcome.row.id, since: now, settleUntil: null, changes: [] },
      now,
      leaderState: opts.leaderState,
    });
  }
  return outcome;
}
