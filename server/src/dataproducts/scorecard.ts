import {
  CIA_DIMENSIONS,
  ISO_25012_DIMENSIONS,
  maturityLevel,
  worstHealth,
  type DataHealthStatus,
  type DataObjectives,
  type DataProductScorecard,
  type DataScorecardPart,
  type DataScorecardPartId,
  type DataScorecardState,
  type ElementHealth,
  type Iso25012Dimension,
  type MonitorStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { currentScale } from '../catalogue/cia.js';
import { statusPointsOf, upAndDown, uptimeHundredths } from '../monitors/stats.js';
import { parseJson } from '../util.js';
import { elementHealthOf } from './health.js';
import { personalFieldCounts } from './personal-fields.js';
import { completenessCounts, latestQualityResults, summariseQuality } from './quality.js';
import { floorsOf, ratingsByItem } from './ratings.js';
import { sortEnvironments, visibleProduct } from './service.js';
import {
  bindingsOf,
  checkLinksOf,
  chunks,
  elementsByIds,
  environmentsOf,
  marks,
  membersOf,
  portsOf,
  productsByIds,
  stepsAround,
  type BindingWithElements,
  type ObjectRow,
  type PortRow,
} from './store.js';

/**
 * The scorecard of data products (ADR 0036 part 13, docs/DATA-PRODUCTS.md#scorecard): per product and environment,
 * computed on read in bulk (a fixed number of statements for any number of products), never typed – the parts
 * _documented_, _rated_, _ports_, _contracted_, _observed_, _healthy_, _objectives met_, _dependencies_, _costs known_,
 * and the ISO/IEC 25012 dimensions with the evidence Steward has (the others: _no evidence yet_) – since 0.24.0 also
 * _accuracy_, _completeness_ and _consistency_ from the quality results of the output elements (quality.ts), the
 * completeness objective of ports, and the personal fields of the bound contracts as evidence of _confidentiality_
 * (personal-fields.ts). The maturity follows
 * (shared maturityLevel): 1 documented and rated, 2 observed, 3 contracted, 4 objectives met for 30 days; 5 (endorsed)
 * is phase 2.
 *
 * Evidence is i18n keys with values (`evidence.<part>.<fact>`), counts and statuses only – never the name of a
 * contract, check or product the reader may not see.
 */

// ---------- the seam to the health of elements (WP3) ----------

/**
 * The health of elements (each lives in one environment), as `u` may see it: the scorecard's one dependency on the
 * module's health (health.ts) – never OK without a check.
 */
export function scorecardElementHealth(u: AuthUser | null, elementIds: readonly string[]): Map<string, ElementHealth> {
  return elementHealthOf(u, elementIds);
}

// ---------- helpers ----------

const DAY = 24 * 3600_000;
const WINDOW = 30 * DAY;
/** A freshness objective counts as met over 30 days when the freshness checks were green in this share of the hourly samples (or the port's availability target). */
export const FRESHNESS_DEFAULT_TARGET = 99;

type Evidence = DataScorecardPart['evidence'];
const ev = (key: string, values?: Record<string, string | number>): Evidence[number] =>
  values ? { key: `evidence.${key}`, values } : { key: `evidence.${key}` };

/** met when all, notMet when none, partial between; `none` when there is nothing to count. */
const share = (done: number, of: number, none: DataScorecardState = 'notMet'): DataScorecardState =>
  of === 0 ? none : done === of ? 'met' : done === 0 ? 'notMet' : 'partial';

/** The worst of the output elements' health, in the module's one order (DATA_HEALTH_ORDER: No data is the least). */
const worst = (xs: DataHealthStatus[]): DataHealthStatus => worstHealth(xs) ?? 'noData';

const healthState = (s: DataHealthStatus): DataScorecardState => (s === 'up' ? 'met' : s === 'degraded' ? 'partial' : s === 'down' ? 'notMet' : 'noEvidence');

const objectivesOf = (port: PortRow, binding: BindingWithElements | undefined): DataObjectives => {
  const own = parseJson<DataObjectives>(port.objectives, {});
  const differ = binding ? parseJson<DataObjectives>(binding.objectives, {}) : {};
  const out: DataObjectives = { ...own };
  for (const [k, v] of Object.entries(differ) as [keyof DataObjectives, never][]) if (v !== null && v !== undefined) out[k] = v;
  return out;
};

function rowsIn<T>(sql: (m: string) => string, ids: readonly string[], ...before: unknown[]): T[] {
  return chunks([...new Set(ids)]).flatMap((part) => db().all<T>(sql(marks(part.length)), ...before, ...part));
}

// ---------- the scorecard ----------

/**
 * The scorecards of these products, each in `environment` (else its first: production first), as `u` sees them – in
 * bulk. Products that do not exist are left out; rights are the caller's.
 */
export function scorecardsOf(u: AuthUser | null, productIds: readonly string[], environment?: string, now = Date.now()): Map<string, DataProductScorecard> {
  const out = new Map<string, DataProductScorecard>();
  const products = productsByIds(productIds);
  const ids = [...products.keys()];
  if (!ids.length) return out;
  const scale = currentScale();
  const ratings = ratingsByItem('product', ids, scale);
  const read: { objects?: Map<string, ObjectRow> } = {};
  const floors = floorsOf([...products.values()], ratings, scale, read);
  const objects = read.objects ?? new Map<string, ObjectRow>();
  const envRows = environmentsOf(ids);
  const ports = portsOf(ids);
  const bindings = bindingsOf(ports.map((p) => p.id));
  const members = membersOf(ids);
  // where input ports' data comes from: the lifecycle of the source ports
  const sourceIds = ports.flatMap((p) => (p.direction === 'input' && p.source_port_id ? [p.source_port_id] : []));
  const sources = new Map(
    rowsIn<{ id: string; lifecycle: string }>((m) => `SELECT id, lifecycle FROM dp_ports WHERE id IN (${m})`, sourceIds).map((r) => [r.id, r.lifecycle]),
  );
  // contracts of the output bindings: lint errors (of the version held to) and the last test
  const contractIds = bindings.flatMap((b) => (b.contract_id ? [b.contract_id] : []));
  const contracts = new Map(
    rowsIn<{ id: string; lint_errors: number }>((m) => `SELECT id, lint_errors FROM data_contracts WHERE id IN (${m})`, contractIds).map((r) => [
      r.id,
      Number(r.lint_errors),
    ]),
  );
  const versionLint = new Map(
    rowsIn<{ contract_id: string; version: number; lint_errors: number }>(
      (m) => `SELECT contract_id, version, lint_errors FROM data_contract_versions WHERE contract_id IN (${m})`,
      bindings.filter((b) => b.contract_id && b.contract_version !== null).map((b) => b.contract_id!),
    ).map((r) => [`${r.contract_id}#${Number(r.version)}`, Number(r.lint_errors)]),
  );
  const lastRun = new Map(
    rowsIn<{ contract_id: string; result: string }>(
      (m) => `SELECT r.contract_id, r.result FROM data_contract_runs r WHERE r.dry_run = 0 AND r.contract_id IN (${m})
               AND r.started_at = (SELECT MAX(x.started_at) FROM data_contract_runs x WHERE x.contract_id = r.contract_id AND x.dry_run = 0)`,
      contractIds,
    ).map((r) => [r.contract_id, r.result]),
  );
  // output elements of every binding, their freshness links and those checks' last 30 days
  const outputPortIds = new Set(ports.filter((p) => p.direction === 'output').map((p) => p.id));
  const outputElementIds = [...new Set(bindings.filter((b) => outputPortIds.has(b.port_id)).flatMap((b) => b.elementIds))];
  const links = checkLinksOf(outputElementIds).filter((l) => l.purpose === 'freshness');
  const since = new Date(Math.floor((now - WINDOW) / 3600_000) * 3600_000).toISOString();
  const samples = new Map(
    rowsIn<{ monitor_id: string; check_id: string; first: string; ok: number | string; down: number | string }>(
      (m) => `SELECT monitor_id, check_id, MIN(bucket) AS first, SUM(ok) AS ok, SUM(down) AS down FROM monitor_samples
               WHERE bucket >= ? AND monitor_id IN (${m}) GROUP BY monitor_id, check_id`,
      links.map((l) => l.monitor_id),
      since,
    ).map((r) => [`${r.monitor_id}/${r.check_id}`, { first: r.first, ok: Number(r.ok), down: Number(r.down) }]),
  );
  // the products' monitors per environment: their status now and their last 30 days
  const monitorIds = [...new Set(envRows.flatMap((e) => (e.monitor_id ? [e.monitor_id] : [])))];
  const monitorStatus = new Map(
    rowsIn<{ monitor_id: string; status: MonitorStatus }>((m) => `SELECT monitor_id, status FROM monitor_state WHERE monitor_id IN (${m})`, monitorIds).map(
      (r) => [r.monitor_id, r.status],
    ),
  );
  const points = monitorIds.length ? statusPointsOf(monitorIds, now - WINDOW, now + 1) : new Map();
  // cost matches: own, and inherited from member elements (in the element's environment)
  const memberIds = [...new Set(members.map((m) => m.element_id))];
  const ownMatches = rowsIn<{ product_id: string; environment: string }>(
    (m) => `SELECT product_id, environment FROM dp_cost_matches WHERE product_id IN (${m})`,
    ids,
  );
  const elementMatches = rowsIn<{ element_id: string }>((m) => `SELECT element_id FROM dp_cost_matches WHERE element_id IN (${m})`, memberIds);
  const elements = elementsByIds([...new Set([...outputElementIds, ...elementMatches.map((r) => r.element_id), ...members.map((m) => m.element_id)])]);
  // lineage of the output elements, for traceability (one statement per level and direction)
  const lineage = outputElementIds.length
    ? stepsAround(outputElementIds, undefined, 2_000)
    : { steps: [], elements: [], truncated: { upstream: 0, downstream: 0 } };
  const writers = new Map<string, string[]>();
  for (const s of lineage.steps) for (const o of s.outputs) writers.set(o, [...(writers.get(o) ?? []), ...s.inputs]);

  // the health of every output element, read once for all products (never per product)
  const outputHealth = outputElementIds.length ? scorecardElementHealth(u, outputElementIds) : new Map<string, ElementHealth>();
  // 0.24.0: quality results of the output elements (the latest per test, 30 days), completeness results for the
  // completeness objectives, personal fields of the bound contracts – one statement each per chunk
  const quality = outputElementIds.length ? latestQualityResults(outputElementIds, since) : [];
  const completeness = outputElementIds.length ? completenessCounts(outputElementIds, since) : new Map<string, { passed: number; total: number }>();
  const personalByBinding = personalFieldCounts(bindings.filter((b) => outputPortIds.has(b.port_id)));

  for (const p of products.values()) {
    const envs = sortEnvironments(envRows.filter((e) => e.product_id === p.id).map((e) => e.environment));
    const env = environment ?? envs[0] ?? null;
    const parts: DataScorecardPart[] = [];
    const part = (id: DataScorecardPartId, state: DataScorecardState, evidence: Evidence) => parts.push({ id, group: 'part', state, evidence });
    const dim = (id: Iso25012Dimension, state: DataScorecardState, evidence: Evidence) => parts.push({ id, group: 'iso25012', state, evidence });
    const floor = floors.get(p.id)!;
    const rating = ratings.get(p.id)!;
    const myPorts = ports.filter((x) => x.product_id === p.id);
    const outputs = myPorts.filter((x) => x.direction === 'output' && x.lifecycle !== 'retired');
    const inputs = myPorts.filter((x) => x.direction === 'input');
    const outBindings = new Map<string, BindingWithElements>();
    for (const b of bindings) if (env && b.environment === env && outputs.some((o) => o.id === b.port_id)) outBindings.set(b.port_id, b);
    const outElements = [...new Set([...outBindings.values()].flatMap((b) => b.elementIds))];
    const myMembers = members.filter((m) => m.product_id === p.id);

    // documented
    const doc = {
      description: !!p.description.trim(),
      owner: parseJson<string[]>(p.owners, []).length > 0,
      domain: !!p.domain_id,
      type: !!p.type,
      objects: floor.objectIds.length > 0,
    };
    const docDone = Object.values(doc).filter(Boolean).length;
    part('documented', share(docDone, 5), [
      ev('documented.has', { done: docDone, of: 5 }),
      ...Object.entries(doc)
        .filter(([, v]) => !v)
        .map(([k]) => ev(`documented.missing.${k}`)),
    ]);

    // rated: every dimension rated (not waiting for a re-rating) and at least the floor (or below with a reason)
    const rated = CIA_DIMENSIONS.filter((d) => rating[d] && !rating[d]!.needsRerating).length;
    const rerate = CIA_DIMENSIONS.filter((d) => rating[d]?.needsRerating).length;
    const below = floor.findings.filter((f) => !f.reason).map((f) => f.dimension);
    const withReason = floor.findings.filter((f) => f.reason).length;
    part('rated', rated === 3 && !floor.warning ? 'met' : rated === 0 ? 'notMet' : 'partial', [
      ev('rated.dimensions', { rated, of: 3 }),
      ...(rerate ? [ev('rated.needsRerating', { count: rerate })] : []),
      ...(below.length ? [ev('rated.belowFloor', { dimensions: below.join(', ') })] : []),
      ...(withReason ? [ev('rated.belowWithReason', { count: withReason })] : []),
    ]);

    // ports: every output port has a binding in the environment
    part('ports', outputs.length ? share(outBindings.size, outputs.length) : 'notMet', [
      outputs.length ? ev('ports.bound', { bound: outBindings.size, of: outputs.length }) : ev('ports.noOutput'),
    ]);

    // contracted: a contract per output binding, lint clean, the last test passed
    let withContract = 0;
    let lintErrors = 0;
    let failed = 0;
    let untested = 0;
    let passed = 0;
    for (const b of outBindings.values()) {
      if (!b.contract_id || !contracts.has(b.contract_id)) continue;
      withContract++;
      const lint = b.contract_version !== null ? (versionLint.get(`${b.contract_id}#${b.contract_version}`) ?? 0) : contracts.get(b.contract_id)!;
      if (lint > 0) lintErrors++;
      const r = lastRun.get(b.contract_id);
      if (!r) untested++;
      else if (r === 'passed' || r === 'warning') passed++;
      else failed++;
    }
    const contractOk = [...outBindings.values()].filter((b) => {
      if (!b.contract_id || !contracts.has(b.contract_id)) return false;
      const lint = b.contract_version !== null ? (versionLint.get(`${b.contract_id}#${b.contract_version}`) ?? 0) : contracts.get(b.contract_id)!;
      const r = lastRun.get(b.contract_id);
      return lint === 0 && (r === 'passed' || r === 'warning');
    }).length;
    part('contracted', !outputs.length || !outBindings.size ? 'notMet' : contractOk === outputs.length ? 'met' : withContract ? 'partial' : 'notMet', [
      ev('contracted.withContract', { count: withContract, of: outputs.length }),
      ...(lintErrors ? [ev('contracted.lintErrors', { count: lintErrors })] : []),
      ...(failed ? [ev('contracted.testFailed', { count: failed })] : []),
      ...(untested ? [ev('contracted.notTested', { count: untested })] : []),
    ]);

    // observed: every output element has a freshness check
    const watched = outElements.filter((e) => links.some((l) => l.element_id === e));
    part('observed', share(watched.length, outElements.length), [
      outElements.length ? ev('observed.withFreshness', { count: watched.length, of: outElements.length }) : ev('observed.noOutputElements'),
    ]);

    // healthy: the product's monitor in the environment, else its output elements' worst (the seam to WP3)
    const envRow = env ? envRows.find((e) => e.product_id === p.id && e.environment === env) : undefined;
    const monitorId = envRow?.monitor_id ?? null;
    const health: DataHealthStatus = monitorId
      ? (monitorStatus.get(monitorId) ?? 'unknown')
      : outElements.length
        ? worst(outElements.map((e) => outputHealth.get(e)?.status ?? 'noData'))
        : 'noData';
    part('healthy', healthState(health), [ev('healthy.status', { status: health, source: monitorId ? 'monitor' : outElements.length ? 'elements' : 'none' })]);

    // objectives met over 30 days: availability from the monitor's uptime, freshness from the freshness checks' samples
    const availabilityTarget = Math.max(0, ...outputs.map((o) => objectivesOf(o, outBindings.get(o.id)).availabilityPct ?? 0).filter((x) => x > 0));
    const freshnessPorts = outputs.filter((o) => (objectivesOf(o, outBindings.get(o.id)).freshnessMinutes ?? 0) > 0 && outBindings.has(o.id));
    const objEvidence: Evidence = [];
    const verdicts: DataScorecardState[] = [];
    let uptime: number | null = null;
    let monitorCovers = false;
    if (monitorId) {
      const pts = (points.get(monitorId) ?? []) as { t: number; status: MonitorStatus }[];
      monitorCovers = pts.length > 0 && pts[0]!.t <= now - WINDOW;
      const h = uptimeHundredths(upAndDown(pts, now - WINDOW, now));
      uptime = h === null ? null : h / 100;
    }
    if (availabilityTarget > 0) {
      if (uptime === null || !monitorCovers) {
        verdicts.push('noEvidence');
        objEvidence.push(ev(monitorId ? 'objectives.availabilityShort' : 'objectives.availabilityNoMonitor', { target: availabilityTarget }));
      } else {
        verdicts.push(uptime >= availabilityTarget ? 'met' : 'notMet');
        objEvidence.push(ev('objectives.availability', { uptime, target: availabilityTarget }));
      }
    }
    // completeness (0.24.0): the share of the completeness results of the port's elements that passed over 30 days
    for (const o of outputs) {
      const target = objectivesOf(o, outBindings.get(o.id)).completenessPct ?? 0;
      if (!(target > 0) || !outBindings.has(o.id)) continue;
      let ok = 0;
      let total = 0;
      for (const e of outBindings.get(o.id)!.elementIds) {
        const c = completeness.get(e);
        if (c) {
          ok += c.passed;
          total += c.total;
        }
      }
      if (!total) {
        verdicts.push('noEvidence');
        objEvidence.push(ev('objectives.completenessNoResults', { port: o.name, target }));
      } else {
        const pct = Math.round((ok / total) * 10000) / 100;
        verdicts.push(pct >= target ? 'met' : 'notMet');
        objEvidence.push(ev('objectives.completeness', { port: o.name, share: pct, target }));
      }
    }
    for (const o of freshnessPorts) {
      const target = objectivesOf(o, outBindings.get(o.id)).availabilityPct ?? FRESHNESS_DEFAULT_TARGET;
      const els = outBindings.get(o.id)!.elementIds;
      let ok = 0;
      let down = 0;
      let covered = els.length > 0;
      for (const e of els) {
        const ls = links.filter((l) => l.element_id === e);
        if (!ls.length) covered = false;
        for (const l of ls) {
          const s = samples.get(`${l.monitor_id}/${l.check_id}`);
          if (!s || Date.parse(s.first) > Date.parse(since) + DAY) covered = false;
          if (s) {
            ok += s.ok;
            down += s.down;
          }
        }
      }
      if (!covered || ok + down === 0) {
        verdicts.push('noEvidence');
        objEvidence.push(ev('objectives.freshnessShort', { port: o.name, target }));
      } else {
        const pct = Math.round((ok / (ok + down)) * 10000) / 100;
        verdicts.push(pct >= target ? 'met' : 'notMet');
        objEvidence.push(ev('objectives.freshness', { port: o.name, uptime: pct, target }));
      }
    }
    const objectivesState: DataScorecardState = !verdicts.length
      ? 'notMet'
      : verdicts.includes('notMet')
        ? 'notMet'
        : verdicts.every((v) => v === 'met')
          ? 'met'
          : verdicts.includes('met')
            ? 'partial'
            : 'noEvidence';
    part('objectivesMet', objectivesState, verdicts.length ? objEvidence : [ev('objectives.none')]);

    // dependencies: no input on a deprecated or retired port
    const fromDeprecated = inputs.filter((i) => i.source_port_id && ['deprecated', 'retired'].includes(sources.get(i.source_port_id) ?? '')).length;
    part('dependencies', fromDeprecated ? 'notMet' : 'met', [
      inputs.length
        ? fromDeprecated
          ? ev('dependencies.deprecated', { count: fromDeprecated, of: inputs.length })
          : ev('dependencies.ok', { inputs: inputs.length })
        : ev('dependencies.none'),
    ]);

    // costs known: matches exist in the environment (own, or inherited from its elements there)
    const memberSet = new Set(myMembers.map((m) => m.element_id));
    const matchCount =
      ownMatches.filter((m) => m.product_id === p.id && m.environment === env).length +
      elementMatches.filter((m) => memberSet.has(m.element_id) && elements.get(m.element_id)?.environment === env).length;
    part('costsKnown', matchCount ? 'met' : 'notMet', [matchCount ? ev('costsKnown.matches', { count: matchCount }) : ev('costsKnown.none')]);

    // ---------- ISO/IEC 25012 ----------
    const fresh = outElements.filter((e) => links.some((l) => l.element_id === e));
    const freshStatus = fresh.map((e) => outputHealth.get(e)?.status ?? 'noData');
    const stale = freshStatus.filter((s) => s === 'down').length;
    const green = freshStatus.filter((s) => s === 'up').length;
    const isoState = new Map<Iso25012Dimension, [DataScorecardState, Evidence]>();
    isoState.set('currentness', [
      !fresh.length || green + stale === 0 ? 'noEvidence' : stale ? 'notMet' : green === fresh.length ? 'met' : 'partial',
      fresh.length ? [ev('currentness.checks', { fresh: green, stale, of: fresh.length })] : [ev('currentness.noChecks')],
    ]);
    isoState.set('availability', [
      uptime === null ? 'noEvidence' : availabilityTarget > 0 ? (uptime >= availabilityTarget ? 'met' : 'notMet') : 'met',
      uptime === null
        ? [ev(monitorId ? 'availability.noData' : 'availability.noMonitor')]
        : [ev('availability.uptime', { uptime, ...(availabilityTarget > 0 ? { target: availabilityTarget } : {}) })],
    ]);
    isoState.set('compliance', [
      passed + failed === 0 ? 'noEvidence' : failed ? 'notMet' : 'met',
      withContract ? [ev('compliance.tests', { passed, failed, untested })] : [ev('compliance.noContract')],
    ]);
    // traceability: each output element's lineage reaches an input of the product or data from outside it
    const inputEls = new Set([
      ...myMembers.filter((m) => m.role === 'input').map((m) => m.element_id),
      ...inputs.flatMap((i) => (i.source_element_id ? [i.source_element_id] : [])),
    ]);
    const traced = outElements.filter((e) => {
      const seen = new Set([e]);
      let frontier = [e];
      for (let level = 0; level < 4 && frontier.length; level++) {
        const next: string[] = [];
        for (const x of frontier)
          for (const up of writers.get(x) ?? []) {
            if (inputEls.has(up) || !memberSet.has(up)) return true;
            if (!seen.has(up)) {
              seen.add(up);
              next.push(up);
            }
          }
        frontier = next;
      }
      return false;
    }).length;
    isoState.set('traceability', [
      outElements.length ? share(traced, outElements.length) : 'noEvidence',
      outElements.length ? [ev('traceability.traced', { count: traced, of: outElements.length })] : [ev('traceability.noOutputElements')],
    ]);
    const exposed = floor.objectIds.map((o) => objects.get(o)).filter((o): o is ObjectRow => !!o);
    const defined = exposed.filter((o) => o.definition.trim()).length;
    isoState.set('understandability', [
      exposed.length ? share(defined, exposed.length) : 'noEvidence',
      exposed.length ? [ev('understandability.defined', { count: defined, of: exposed.length })] : [ev('understandability.noObjects')],
    ]);
    // accuracy, completeness, consistency (0.24.0): the latest result of each test of the output elements, 30 days
    const outSet = new Set(outElements);
    for (const q of summariseQuality(quality.filter((r) => outSet.has(r.elementId)))) {
      if (q.dimension === 'currentness') continue;
      isoState.set(q.dimension, [
        !q.tests ? 'noEvidence' : q.failed ? 'notMet' : q.warning ? 'partial' : 'met',
        q.tests ? [ev('quality.results', { tests: q.tests, passed: q.passed, warning: q.warning, failed: q.failed })] : [ev('quality.none')],
      ]);
    }
    const c = rating.confidentiality;
    const cBelow = floor.findings.some((f) => f.dimension === 'confidentiality' && !f.reason);
    // personal fields of the bound contracts (0.24.0): a product whose contracts mark personal fields while none of
    // the data objects it exposes holds personal data does not say what it carries
    const personalFields = [...outBindings.values()].reduce((n, b) => n + (personalByBinding.get(b.id) ?? 0), 0);
    const exposedPersonal = floor.objectIds.some((id) => (objects.get(id)?.personal_data ?? 'none') !== 'none');
    const undocumented = personalFields > 0 && !exposedPersonal;
    isoState.set('confidentiality', [
      !c || c.needsRerating ? 'notMet' : cBelow || undocumented ? 'partial' : 'met',
      [
        !c || c.needsRerating ? ev('confidentiality.notRated') : ev(cBelow ? 'confidentiality.belowFloor' : 'confidentiality.rated', { level: c.level }),
        ...(personalFields
          ? [ev(undocumented ? 'confidentiality.personalFieldsUndocumented' : 'confidentiality.personalFields', { count: personalFields })]
          : []),
      ],
    ]);
    for (const d of ISO_25012_DIMENSIONS) {
      const x = isoState.get(d);
      dim(d, x?.[0] ?? 'noEvidence', x?.[1] ?? [ev('noEvidenceYet')]);
    }

    const state = (id: DataScorecardPartId) => parts.find((x) => x.group === 'part' && x.id === id)?.state;
    out.set(p.id, { productId: p.id, environment: env, environments: envs, parts, maturity: maturityLevel(state) });
  }
  return out;
}

/** GET /api/data-products/:id/scorecard: the scorecard and maturity of a product the caller may see. */
export function productScorecard(productId: string, q: { environment?: string }): DataProductScorecard {
  const u = me();
  const { row } = visibleProduct(productId, u);
  return scorecardsOf(u, [row.id], q.environment).get(row.id)!;
}
