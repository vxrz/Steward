import { dataCheckLinkAddInput, type CheckDef, type DataCheckPurpose, type DataElementCheck, type DataElementChecks, type MonitorDefinition } from '@sm/shared';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { db } from '../db.js';
import { monitorRow, permissionsOfRow } from '../monitors/model.js';
import { HttpError, parseJson } from '../util.js';
import { elementAccess, productAccess } from './access.js';
import { elementNotFound, L, limitReached } from './common.js';
import { checkRuns, checkStates, elementHealthOf, monitorFacts } from './health.js';
import { addCheckLink, checkLinksOf, elementRow, elementTeamIds, membershipsOfElements, productsByIds, removeCheckLink, type ElementRow } from './store.js';

/**
 * Checks linked to elements (ADR 0036 part 10): made by _Create monitor_, linked by a person, or **found** – a check
 * whose fields name the element (a `data-element` check), or its platform and object (a `snowflake` check on the
 * table, a `kafka` check on the topic). Found checks are offered on the element until someone links them; _Create
 * monitor_ stores them, so it does not repeat them. A check of a monitor the reader may not see is shown by its status
 * only: _a check you may not see_.
 */

/** What a check says it watches, as candidates: (platform, kind family, name) or an element id. */
function watched(c: CheckDef): { element?: string; platform?: string; family?: 'snowflake' | 'kafka'; name?: string; purpose: DataCheckPurpose } | null {
  if (c.type === 'data-element') return { element: c.element, purpose: c.mode === 'schema' ? 'schema' : 'freshness' };
  if (c.type === 'snowflake' && c.mode === 'freshness')
    return { platform: c.platform, family: 'snowflake', name: c.object.toLowerCase(), purpose: 'freshness' };
  if (c.type === 'snowflake' && c.mode === 'tasks') return { platform: c.platform, family: 'snowflake', name: c.object.toLowerCase(), purpose: 'quality' };
  if (c.type === 'kafka') return { platform: c.platform, family: 'kafka', name: c.topic.toLowerCase(), purpose: 'freshness' };
  return null;
}

export interface FoundCheck {
  elementId: string;
  monitorId: string;
  checkId: string;
  purpose: DataCheckPurpose;
}

/**
 * Checks that name these elements, from the monitors' definitions (templates left out). One statement: the monitors
 * whose definition mentions a check type that can name an element (a text filter before parsing).
 */
export function findChecks(elements: readonly ElementRow[]): FoundCheck[] {
  if (!elements.length) return [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const byName = new Map<string, ElementRow[]>();
  for (const e of elements) {
    const family = e.kind.startsWith('snowflake.') ? 'snowflake' : e.kind === 'kafka.topic' ? 'kafka' : null;
    if (!family || !e.platform_id) continue;
    const k = `${e.platform_id}|${family}|${e.name_norm}`;
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }
  const rows = db().all<{ id: string; definition: string }>(
    `SELECT id, definition FROM monitors WHERE is_template = 0 AND (lower(definition) LIKE '%"data-element"%' OR lower(definition) LIKE '%"snowflake"%' OR lower(definition) LIKE '%"kafka"%')`,
  );
  const out: FoundCheck[] = [];
  for (const r of rows) {
    const def = parseJson<Partial<MonitorDefinition>>(r.definition, {});
    for (const c of def.checks ?? []) {
      const w = watched(c);
      if (!w) continue;
      const hits = w.element ? (byId.has(w.element) ? [byId.get(w.element)!] : []) : (byName.get(`${w.platform}|${w.family}|${w.name}`) ?? []);
      for (const e of hits) out.push({ elementId: e.id, monitorId: r.id, checkId: c.id, purpose: w.purpose });
    }
  }
  return out;
}

/** Stores found checks that are not linked yet (origin `found`); returns how many were stored. */
export function storeFound(found: FoundCheck[], by: string): number {
  if (!found.length) return 0;
  const have = new Set(checkLinksOf([...new Set(found.map((f) => f.elementId))]).map((l) => `${l.element_id}|${l.monitor_id}|${l.check_id}`));
  let n = 0;
  for (const f of found) {
    const k = `${f.elementId}|${f.monitorId}|${f.checkId}`;
    if (have.has(k)) continue;
    have.add(k);
    addCheckLink({ element_id: f.elementId, step_id: null, monitor_id: f.monitorId, check_id: f.checkId, purpose: f.purpose, origin: 'found', created_by: by });
    n++;
  }
  return n;
}

/** The element as the reader sees it (404 like a missing one), and whether they may link checks to it. */
function elementOf(u: AuthUser, id: string): { row: ElementRow; canLink: boolean } {
  const row = elementRow(id);
  if (!row) throw elementNotFound(id);
  const perms = elementAccess(u, elementTeamIds([row.id]).get(row.id) ?? []).permissions;
  // the element's own page, or a product it is part of (decision 15): its editors document its checks too
  const ms = membershipsOfElements([row.id]);
  const products = [...productsByIds(ms.map((m) => m.product_id)).values()].map((p) => productAccess(u, p).permissions);
  if (!perms.length && !products.some((p) => p.length)) throw elementNotFound(id);
  return { row, canLink: perms.includes('edit') || products.some((p) => p.includes('edit')) };
}

/** GET /api/data-elements/:id/checks */
export function elementChecks(id: string): DataElementChecks & { canLink: boolean } {
  const u = me();
  const { row, canLink } = elementOf(u, id);
  const links = checkLinksOf([row.id]);
  const found = findChecks([row]).filter((f) => !links.some((l) => l.monitor_id === f.monitorId && l.check_id === f.checkId));
  const monitors = monitorFacts([...links.map((l) => l.monitor_id), ...found.map((f) => f.monitorId)]);
  const states = checkStates([...monitors.keys()], true);
  const defs = new Map<string, Map<string, CheckDef>>();
  const checkOf = (mid: string, cid: string): CheckDef | undefined => {
    if (!defs.has(mid)) {
      const r = monitorRow(mid);
      defs.set(mid, new Map((parseJson<Partial<MonitorDefinition>>(r?.definition, {}).checks ?? []).map((c) => [c.id, c])));
    }
    return defs.get(mid)!.get(cid);
  };
  const view = (l: {
    id: string | null;
    monitorId: string;
    checkId: string;
    purpose: DataCheckPurpose;
    origin: DataElementCheck['origin'];
    at: string;
    by: string;
  }) => {
    const m = monitors.get(l.monitorId);
    const st = states.get(`${l.monitorId}|${l.checkId}`);
    const visible = !!m && permissionsOfRow(m, u).includes('view');
    const c = visible ? checkOf(l.monitorId, l.checkId) : undefined;
    const result = visible ? parseJson<{ message?: string } | null>(st?.last_result, null) : null;
    return {
      linkId: l.id,
      purpose: l.purpose,
      origin: l.origin,
      status: st?.status ?? 'unknown',
      since: st?.since ?? null,
      active: checkRuns(m, l.checkId, states),
      hidden: !visible,
      monitor: visible ? { id: m!.id, key: m!.key, name: m!.name, enabled: !!m!.enabled } : null,
      check: visible ? { id: l.checkId, name: c?.name ?? l.checkId, type: c?.type ?? 'unknown' } : null,
      message: result?.message?.slice(0, 1000) ?? null,
      createdAt: l.at,
      createdBy: visible ? l.by : '',
    } satisfies DataElementCheck;
  };
  const checks = [
    ...links
      .filter((l) => monitors.has(l.monitor_id))
      .map((l) => view({ id: l.id, monitorId: l.monitor_id, checkId: l.check_id, purpose: l.purpose, origin: l.origin, at: l.created_at, by: l.created_by })),
    // found and not linked: only checks the reader may see (a hidden one is not offered)
    ...found
      .map((f) => view({ id: null, monitorId: f.monitorId, checkId: f.checkId, purpose: f.purpose, origin: 'found', at: '', by: '' }))
      .filter((c) => !c.hidden),
  ];
  return { elementId: row.id, health: elementHealthOf(u, [row.id]).get(row.id)!, checks, canLink };
}

/** POST /api/data-elements/:id/checks – links a check the person may see. */
export function linkCheck(id: string, body: unknown): DataElementChecks & { canLink: boolean } {
  const u = me();
  const input = dataCheckLinkAddInput.parse(body);
  const { row, canLink } = elementOf(u, id);
  if (!canLink) forbid('link checks to this element', 'dataProducts');
  const m = monitorRow(input.monitor);
  if (!m || m.is_template || !permissionsOfRow(m, u).includes('view')) throw new HttpError(400, 'Monitor not found', 'MONITOR_NOT_FOUND');
  const c = (parseJson<Partial<MonitorDefinition>>(m.definition, {}).checks ?? []).find((x) => x.id === input.checkId);
  if (!c) throw new HttpError(400, `The monitor has no check "${input.checkId}"`, 'DATA_CHECK_NOT_FOUND', { id: input.checkId });
  const links = checkLinksOf([row.id]);
  if (!links.some((l) => l.monitor_id === m.id && l.check_id === c.id)) {
    if (links.length >= L.checkLinksPerElement) throw limitReached('checkLinksPerElement', L.checkLinksPerElement);
    db().tx(() => {
      addCheckLink({ element_id: row.id, step_id: null, monitor_id: m.id, check_id: c.id, purpose: input.purpose, origin: 'linked', created_by: u.username });
      audit({
        action: 'dataelement.check_linked',
        entityType: 'data_element',
        entityId: row.id,
        summary: `Check "${c.name}" of monitor "${m.name}" linked to element ${row.qualified_name} (${input.purpose})`,
        details: { monitor: m.id, check: c.id, purpose: input.purpose },
      });
    });
  }
  return elementChecks(row.id);
}

/** DELETE /api/data-elements/:id/checks/:linkId */
export function unlinkCheck(id: string, linkId: string): void {
  const u = me();
  const { row, canLink } = elementOf(u, id);
  const link = checkLinksOf([row.id]).find((l) => l.id === linkId);
  if (!link) throw new HttpError(404, `Check link ${linkId} not found`, 'DATA_CHECK_NOT_FOUND', { id: linkId });
  if (!canLink) forbid('unlink checks from this element', 'dataProducts');
  db().tx(() => {
    removeCheckLink(link.id);
    audit({
      action: 'dataelement.check_unlinked',
      entityType: 'data_element',
      entityId: row.id,
      summary: `Check ${link.check_id} of a monitor unlinked from element ${row.qualified_name}`,
      details: { monitor: link.monitor_id, check: link.check_id },
    });
  });
}
