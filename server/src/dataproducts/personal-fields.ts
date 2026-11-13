import type { DataPersonalField, DataPersonalFieldGroup, DataPersonalFields } from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { contractAccess } from '../auth/policy.js';
import { isObj, parseContract, str } from '../datacontracts/odcs.js';
import { elementAccess, objectAccess, productAccess } from './access.js';
import { elementNotFound, objectNotFound } from './common.js';
import { visibleProduct } from './service.js';
import { bindingsOf, chunks, elementRow, elementTeamIds, marks, objectsByIds, portsOf, productsByIds, type BindingWithElements, type PortRow } from './store.js';

/**
 * Field-level personal data from contracts (0.24.0, ADR 0036 part 2 phase 2, docs/DATA-PRODUCTS.md#personal-data-in-fields):
 * a property of a bound contract's schema object is **personal** when it carries the Steward convention
 * `customProperties: [{ property: personalData, value: true }]` (or an ODCS classification that says so – `pii`,
 * `personal`, `gdpr`, `sensitive`), and **classified** when its ODCS `classification` is anything but public. Steward
 * marks nothing itself: the contract says it.
 *
 * Shown on a product (its output ports' bindings), an element (the output bindings that expose it) and a data object
 * (the output ports that expose it, declared or through their elements). A contract the reader may not see is counted,
 * never named, and its fields are not shown. Parsed versions are kept in memory (a stored version never changes).
 */

const MAX_FIELDS = 500;
const PERSONAL_CLASSES = new Set(['pii', 'personal', 'personal data', 'personal_data', 'gdpr', 'sensitive', 'spi']);
const CACHE = new Map<string, DataPersonalField[]>();
const CACHE_MAX = 1_000;

const truthy = (v: unknown): boolean => v === true || (typeof v === 'string' && ['true', 'yes', '1'].includes(v.trim().toLowerCase()));

/** The personal and classified fields of an ODCS document (all levels, iteratively; at most MAX_FIELDS + 1). */
export function personalFieldsOfDoc(doc: Record<string, unknown>): DataPersonalField[] {
  const out: DataPersonalField[] = [];
  const schemas = Array.isArray(doc.schema) ? doc.schema.filter(isObj) : [];
  for (const s of schemas) {
    const schema = str(s.name) ?? '';
    const stack: [unknown, string][] = (Array.isArray(s.properties) ? s.properties : []).map((p) => [p, ''] as [unknown, string]).reverse();
    let budget = 20_000;
    while (stack.length && out.length <= MAX_FIELDS && budget-- > 0) {
      const [p, parent] = stack.pop()!;
      if (!isObj(p)) continue;
      const name = str(p.name) ?? '';
      const path = parent ? `${parent}.${name}` : name;
      const custom = Array.isArray(p.customProperties) ? p.customProperties.filter(isObj) : [];
      const flagged = custom.some((c) => str(c.property)?.toLowerCase() === 'personaldata' && truthy(c.value));
      const cls = str(p.classification)?.trim() || null;
      const personal = flagged || (!!cls && PERSONAL_CLASSES.has(cls.toLowerCase()));
      if (personal || (cls && cls.toLowerCase() !== 'public')) out.push({ schema, field: path, classification: cls, personal });
      const kids = [...(Array.isArray(p.properties) ? p.properties : []), ...(isObj(p.items) ? [p.items] : [])];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], path]);
    }
  }
  return out;
}

/**
 * The fields of these contract versions (version null: the contract's current one), keyed `contract#version` – one
 * statement for the current versions and one per 500 versions not yet in memory.
 */
export function fieldsOfVersions(pairs: readonly { contractId: string; version: number | null }[]): {
  fields: Map<string, DataPersonalField[]>;
  resolved: (contractId: string, version: number | null) => number | null;
  contracts: Map<string, { id: string; contract_key: string; name: string; current_version: number }>;
} {
  const ids = [...new Set(pairs.map((p) => p.contractId))];
  const contracts = new Map(
    chunks(ids).flatMap((part) =>
      db()
        .all<{ id: string; contract_key: string; name: string; current_version: number }>(
          `SELECT id, contract_key, name, current_version FROM data_contracts WHERE id IN (${marks(part.length)})`,
          ...part,
        )
        .map((r) => [r.id, { ...r, current_version: Number(r.current_version) }] as const),
    ),
  );
  const resolved = (contractId: string, version: number | null) => version ?? contracts.get(contractId)?.current_version ?? null;
  const keys = [
    ...new Set(
      pairs.flatMap((p) => {
        const v = resolved(p.contractId, p.version);
        return v === null || !contracts.has(p.contractId) ? [] : [`${p.contractId}#${v}`];
      }),
    ),
  ];
  const missing = keys.filter((k) => !CACHE.has(k));
  for (const part of chunks(missing)) {
    const where = part.map(() => '(contract_id = ? AND version = ?)').join(' OR ');
    const args = part.flatMap((k) => {
      const [c, v] = k.split('#') as [string, string];
      return [c, Number(v)];
    });
    for (const r of db().all<{ contract_id: string; version: number; yaml: string }>(
      `SELECT contract_id, version, yaml FROM data_contract_versions WHERE ${where}`,
      ...args,
    )) {
      let fields: DataPersonalField[] = [];
      try {
        fields = personalFieldsOfDoc(parseContract(r.yaml).doc);
      } catch {
        fields = [];
      }
      if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
      CACHE.set(`${r.contract_id}#${Number(r.version)}`, fields);
    }
  }
  return { fields: new Map(keys.map((k) => [k, CACHE.get(k) ?? []])), resolved, contracts };
}

/** Groups of fields per contract version for these output bindings, as `u` may see them. */
function groupsOf(
  u: AuthUser | null,
  bindings: readonly (BindingWithElements & { port: PortRow })[],
  portShown: (b: BindingWithElements & { port: PortRow }) => boolean,
): DataPersonalFields {
  const withContract = bindings.filter((b) => b.contract_id);
  const { fields, resolved, contracts } = fieldsOfVersions(withContract.map((b) => ({ contractId: b.contract_id!, version: b.contract_version })));
  const groups = new Map<string, DataPersonalFieldGroup>();
  const hiddenIds = new Set<string>();
  for (const b of withContract) {
    const c = contracts.get(b.contract_id!);
    const version = resolved(b.contract_id!, b.contract_version);
    if (!c || version === null) continue;
    const key = `${c.id}#${version}`;
    const sees = contractAccess(u, { id: c.id }).permissions.includes('view');
    if (!sees) {
      // counted, never named: its fields are not shown
      hiddenIds.add(c.id);
      continue;
    }
    const g =
      groups.get(key) ??
      ((): DataPersonalFieldGroup => {
        const all = fields.get(key) ?? [];
        return {
          contract: { id: c.id, key: c.contract_key, name: c.name },
          version,
          ports: [],
          fields: all.slice(0, MAX_FIELDS),
          more: Math.max(0, all.length - MAX_FIELDS),
        };
      })();
    if (portShown(b)) g.ports.push({ productId: b.port.product_id, portId: b.port.id, portName: `${b.port.name}${b.port.version ? ` ${b.port.version}` : ''}`, environment: b.environment });
    groups.set(key, g);
  }
  const shown = [...groups.values()].filter((g) => g.fields.length);
  return {
    groups: shown.sort((a, b) => (a.contract.name < b.contract.name ? -1 : a.contract.name > b.contract.name ? 1 : a.version - b.version)),
    personal: shown.reduce((n, g) => n + g.fields.filter((f) => f.personal).length, 0),
    classified: shown.reduce((n, g) => n + g.fields.filter((f) => f.classification).length, 0),
    hiddenContracts: hiddenIds.size,
  };
}

/** Output bindings of these ports with their port. */
function outputBindings(ports: readonly PortRow[], environment?: string): (BindingWithElements & { port: PortRow })[] {
  const out = ports.filter((p) => p.direction === 'output' && p.lifecycle !== 'retired');
  const byId = new Map(out.map((p) => [p.id, p]));
  return bindingsOf(out.map((p) => p.id))
    .filter((b) => !environment || b.environment === environment)
    .map((b) => ({ ...b, port: byId.get(b.port_id)! }));
}

/** GET /api/data-products/:id/personal-fields?environment=: the fields of the product's output ports' contracts. */
export function productPersonalFields(productId: string, q: { environment?: string } = {}): DataPersonalFields {
  const u = me();
  const { row } = visibleProduct(productId, u);
  return groupsOf(u, outputBindings(portsOf([row.id]), q.environment), () => true);
}

/** Personal fields per product (the scorecard's evidence), for the output bindings in each product's environment. */
export function personalFieldCounts(bindings: readonly BindingWithElements[]): Map<string, number> {
  const withContract = bindings.filter((b) => b.contract_id);
  const { fields, resolved } = fieldsOfVersions(withContract.map((b) => ({ contractId: b.contract_id!, version: b.contract_version })));
  const out = new Map<string, number>();
  for (const b of withContract) {
    const v = resolved(b.contract_id!, b.contract_version);
    out.set(b.id, (fields.get(`${b.contract_id}#${v}`) ?? []).filter((f) => f.personal).length);
  }
  return out;
}

/** GET /api/data-elements/:id/personal-fields: the contracts of the output bindings that expose the element. */
export function elementPersonalFields(elementId: string): DataPersonalFields {
  const u = me();
  const el = elementRow(elementId);
  if (!el || !elementAccess(u, elementTeamIds([el.id]).get(el.id) ?? []).permissions.includes('view')) throw elementNotFound(elementId);
  const portIds = db()
    .all<{ port_id: string }>('SELECT DISTINCT b.port_id FROM dp_port_elements pe JOIN dp_port_bindings b ON b.id = pe.binding_id WHERE pe.element_id = ?', el.id)
    .map((r) => r.port_id);
  const ports = portsByIds(portIds);
  const products = productsByIds(ports.map((p) => p.product_id));
  const bindings = outputBindings(ports).filter((b) => b.elementIds.includes(el.id));
  // a port of a product the reader may not see is not named; its contract still describes the element they may see
  return groupsOf(u, bindings, (b) => {
    const p = products.get(b.port.product_id);
    return !!p && productAccess(u, p).permissions.includes('view');
  });
}

/** GET /api/data-objects/:id/personal-fields: the contracts of the output ports that expose the data object. */
export function objectPersonalFields(objectId: string): DataPersonalFields {
  const u = me();
  const o = objectsByIds([objectId]).get(objectId);
  if (!o || !objectAccess(u, o).permissions.includes('view')) throw objectNotFound(objectId);
  // declared on a port, or implemented by an element a port's binding exposes
  const portIds = [
    ...db()
      .all<{ port_id: string }>('SELECT port_id FROM dp_port_objects WHERE object_id = ?', o.id)
      .map((r) => r.port_id),
    ...db()
      .all<{ port_id: string }>(
        `SELECT DISTINCT b.port_id FROM dp_object_elements oe JOIN dp_port_elements pe ON pe.element_id = oe.element_id
         JOIN dp_port_bindings b ON b.id = pe.binding_id WHERE oe.object_id = ?`,
        o.id,
      )
      .map((r) => r.port_id),
  ];
  const ports = portsByIds(portIds);
  const products = productsByIds(ports.map((p) => p.product_id));
  // only ports of products the reader may see count here: the object's page names no product they may not see
  const visible = ports.filter((p) => {
    const pr = products.get(p.product_id);
    return !!pr && productAccess(u, pr).permissions.includes('view');
  });
  return groupsOf(u, outputBindings(visible), () => true);
}

function portsByIds(ids: readonly string[]): PortRow[] {
  return chunks([...new Set(ids)]).flatMap((part) => db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(part.length)})`, ...part));
}
