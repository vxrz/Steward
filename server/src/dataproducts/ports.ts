import {
  DATA_PRODUCT_ID_PREFIX,
  dataConsumerInput,
  dataPortBindingInput,
  dataPortInput,
  roleOfPort,
  type DataConsumer,
  type DataObjectives,
  type DataPort,
  type DataPortBinding,
  type DataPortLifecycle,
  type DataPortSource,
  type DataPortType,
  type DataRef,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { contractAccess } from '../auth/policy.js';
import type { AuthUser } from '../auth/context.js';
import { canViewCatalogue } from '../records/access.js';
import { factsOf, parseContract } from '../datacontracts/odcs.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { elementAccess, objectAccess, productAccess } from './access.js';
import { onLifecycleChanged, onPortDeleted } from './notices.js';
import { HIDDEN, L, actorName, elementNotFound, json, limitReached, objectNotFound, portNotFound, productNotFound, refOf } from './common.js';
import {
  bindingsOf,
  consumersOf,
  consumingPorts,
  elementTeamIds,
  elementsByIds,
  marks,
  objectsByIds,
  objectsOfElements,
  portObjectsOf,
  portRow,
  portsOf,
  productRow,
  productsByIds,
  type ConsumerRow,
  type ObjectRow,
  type PortRow,
} from './store.js';

/**
 * Ports of data products (ADR 0036 part 7): input and output, with a version and their own lifecycle; per environment a
 * binding names the elements a port exposes, the data contract (and its version and ODCS server) it is held to and the
 * objectives that differ; output ports expose data objects and have registered consumers; input ports name where their
 * data comes from – another product's output port, an element of a source system or a text. The service keeps the
 * member roles consistent with the ports: an element bound to an output port is an output member, to an input port
 * an input member. The rights are the product's (editableProduct in service.ts, passed in as `productId` checked).
 */

const DEPRECATED: readonly string[] = ['deprecated', 'retired'];

// ---------- reading ----------

/** The contracts of these bindings as `u` may see them. */
function contractRefs(u: AuthUser | null, ids: string[]): Map<string, DataRef> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = db().all<{ id: string; contract_key: string; name: string }>(
    `SELECT id, contract_key, name FROM data_contracts WHERE id IN (${marks(uniq.length)})`,
    ...uniq,
  );
  return new Map(
    rows.map((r) => [r.id, contractAccess(u, { id: r.id }).permissions.includes('view') ? { id: r.id, key: r.contract_key, name: r.name } : HIDDEN]),
  );
}

const objectives = (s: string): DataObjectives => parseJson<DataObjectives>(s, {});

/**
 * The ports of a product with bindings, contracts, objects, consumer counts and sources (bulk: a fixed number of
 * statements), as `u` sees them. `known`: data object rows the caller read already (the product page's rating floor
 * reads the exposed ones) – only the others are read here.
 */
export function portViews(u: AuthUser | null, productId: string, known?: ReadonlyMap<string, ObjectRow>): DataPort[] {
  const ports = portsOf([productId]);
  if (!ports.length) return [];
  const ids = ports.map((p) => p.id);
  const bindings = bindingsOf(ids);
  const declared = portObjectsOf(ids);
  const boundElements = [...new Set(bindings.flatMap((b) => b.elementIds))];
  const implemented = objectsOfElements(boundElements);
  const wanted = [...new Set([...declared.map((d) => d.object_id), ...implemented.map((i) => i.object_id)])];
  const objectRows = new Map([...wanted.flatMap((id) => (known?.has(id) ? [[id, known.get(id)!] as const] : []))]);
  for (const [id, o] of objectsByIds(wanted.filter((id) => !known?.has(id)))) objectRows.set(id, o);
  const objectRef = (id: string): DataRef | null => {
    const o = objectRows.get(id);
    if (!o) return null;
    return objectAccess(u, o).permissions.length ? refOf(o) : HIDDEN;
  };
  const contracts = contractRefs(
    u,
    bindings.map((b) => b.contract_id).filter((x): x is string => !!x),
  );
  const registered = new Map<string, number>();
  for (const c of consumersOf(ids)) registered.set(c.port_id, (registered.get(c.port_id) ?? 0) + 1);
  const derived = new Map<string, number>();
  for (const c of consumingPorts(ids)) if (c.source_port_id) derived.set(c.source_port_id, (derived.get(c.source_port_id) ?? 0) + 1);
  // where input ports' data comes from: the other products' output ports, named only where the reader sees the product
  const sourceIds = ports.map((p) => p.source_port_id).filter((x): x is string => !!x);
  const sources = new Map(
    (sourceIds.length ? db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(new Set(sourceIds).size)})`, ...new Set(sourceIds)) : []).map((r) => [
      r.id,
      r,
    ]),
  );
  const sourceProducts = productsByIds([...sources.values()].map((s) => s.product_id));
  const elementOf = new Map<string, string[]>();
  for (const b of bindings) for (const e of b.elementIds) elementOf.set(b.port_id, [...(elementOf.get(b.port_id) ?? []), e]);
  return ports.map((p): DataPort => {
    let source: DataPortSource | null = null;
    let consumesDeprecated = false;
    if (p.source_kind === 'port' && p.source_port_id) {
      const sp = sources.get(p.source_port_id);
      const prod = sp ? sourceProducts.get(sp.product_id) : undefined;
      const seen = !!prod && productAccess(u, prod).permissions.length > 0;
      consumesDeprecated = !!sp && DEPRECATED.includes(sp.lifecycle);
      source = {
        kind: 'port',
        portId: p.source_port_id,
        product: seen ? refOf(prod) : HIDDEN,
        portName: seen ? sp!.name : null,
        version: seen ? sp!.version : null,
        lifecycle: sp ? (sp.lifecycle as DataPortLifecycle) : null,
        sunsetDate: sp?.sunset_date ?? null,
      };
    } else if (p.source_kind === 'element' && p.source_element_id) source = { kind: 'element', elementId: p.source_element_id };
    else if (p.source_kind === 'text') source = { kind: 'text', text: p.source_text };
    const declaredRefs = declared
      .filter((d) => d.port_id === p.id)
      .map((d) => objectRef(d.object_id))
      .filter((x): x is DataRef => !!x);
    const portElements = new Set(elementOf.get(p.id) ?? []);
    const through = [...new Set(implemented.filter((i) => portElements.has(i.element_id)).map((i) => i.object_id))]
      .map(objectRef)
      .filter((x): x is DataRef => !!x);
    return {
      id: p.id,
      productId: p.product_id,
      direction: p.direction,
      name: p.name,
      type: p.port_type as DataPortType,
      version: p.version,
      description: p.description,
      lifecycle: p.lifecycle as DataPortLifecycle,
      lifecycleDates: parseJson(p.lifecycle_dates, {}),
      sunsetDate: p.sunset_date,
      successorId: p.successor_id,
      objectives: objectives(p.objectives),
      source,
      objects: { declared: declaredRefs, throughElements: through },
      bindings: bindings
        .filter((b) => b.port_id === p.id)
        .map((b): DataPortBinding => ({
          id: b.id,
          portId: b.port_id,
          environment: b.environment,
          contractId: b.contract_id && contracts.get(b.contract_id)?.id ? b.contract_id : null,
          contractVersion: b.contract_version === null ? null : Number(b.contract_version),
          // a contract the reader may not see is counted, never named: neither is its server
          contractServer: b.contract_id && contracts.get(b.contract_id)?.hidden ? null : b.contract_server,
          // a contract that is gone (deleted since) is none; one the reader may not see is counted, never named
          contract: b.contract_id ? (contracts.get(b.contract_id) ?? null) : null,
          objectives: objectives(b.objectives),
          elementIds: b.elementIds,
        })),
      consumers: { registered: registered.get(p.id) ?? 0, derived: derived.get(p.id) ?? 0 },
      consumesDeprecated,
      position: Number(p.position),
      revision: p.revision,
    };
  });
}

/** A port of this product (404 otherwise). */
function portOf(productId: string, portId: string): PortRow {
  const p = portRow(portId);
  if (!p || p.product_id !== productId) throw portNotFound(portId);
  return p;
}

// ---------- writing ports ----------

type PortInput = ReturnType<typeof dataPortInput.parse>;

/** Checks what a port names: its source (input ports), its successor (a port of the same product), its data objects. */
function checkPortRefs(productId: string, input: PortInput, self: string | null): void {
  const u = me();
  if (input.source && input.direction !== 'input')
    throw new HttpError(400, 'Only input ports have a source', 'DATA_PORT_INVALID', { context: 'sourceOnOutput' });
  if (input.source?.kind === 'port') {
    const sp = portRow(input.source.portId);
    const prod = sp ? productRow(sp.product_id) : undefined;
    if (!sp || !prod || !productAccess(u, prod).permissions.length) throw portNotFound(input.source.portId);
    if (sp.direction !== 'output' || sp.product_id === productId)
      throw new HttpError(400, "An input port consumes another product's output port", 'DATA_PORT_INVALID', { context: 'sourcePort' });
  }
  if (input.source?.kind === 'element') {
    const el = elementsByIds([input.source.elementId]).get(input.source.elementId);
    if (!el || !elementAccess(u, elementTeamIds([el.id]).get(el.id) ?? []).permissions.length) throw elementNotFound(input.source.elementId);
  }
  if (input.successorId) {
    const s = portRow(input.successorId);
    if (!s || s.product_id !== productId || s.id === self) throw portNotFound(input.successorId);
  }
  if (input.lifecycle === 'deprecated' && !input.sunsetDate)
    throw new HttpError(409, 'A deprecated port needs a sunset date', 'DATA_PRODUCT_LIFECYCLE', { lifecycle: 'deprecated', context: 'needsSunsetDate' });
  const objects = objectsByIds(input.objectIds);
  for (const oid of input.objectIds) {
    const o = objects.get(oid);
    if (!o || !objectAccess(u, o).permissions.length) throw objectNotFound(oid);
  }
}

/** Two versions of a port are two ports: name and version are unique per product and direction. */
function refuseTakenPort(productId: string, input: PortInput, except = ''): void {
  if (
    db().get(
      'SELECT 1 FROM dp_ports WHERE product_id = ? AND direction = ? AND name = ? AND version = ? AND id <> ?',
      productId,
      input.direction,
      input.name,
      input.version,
      except,
    )
  )
    throw new HttpError(409, `The product has a ${input.direction} port "${input.name}" ${input.version} already`, 'DATA_PORT_EXISTS', {
      name: input.name,
      version: input.version,
    });
}

function writePortObjects(portId: string, objectIds: string[], keepHidden: boolean): void {
  // objects the editor may not see stay (counted, never removed by someone who cannot see them)
  const u = me();
  const before = portObjectsOf([portId]).map((r) => r.object_id);
  const rows = objectsByIds(before);
  const hidden = keepHidden ? before.filter((id) => rows.has(id) && !objectAccess(u, rows.get(id)!).permissions.length) : [];
  db().run('DELETE FROM dp_port_objects WHERE port_id = ?', portId);
  for (const oid of new Set([...objectIds, ...hidden])) db().run('INSERT INTO dp_port_objects (port_id, object_id) VALUES (?, ?)', portId, oid);
}

const sourceColumns = (input: PortInput): [string | null, string | null, string | null, string] => [
  input.source?.kind ?? null,
  input.source?.kind === 'port' ? input.source.portId : null,
  input.source?.kind === 'element' ? input.source.elementId : null,
  input.source?.kind === 'text' ? input.source.text : '',
];

export function addPort(productId: string, productName: string, body: unknown): DataPort {
  const input = dataPortInput.parse(body);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_ports WHERE product_id = ?', productId)!.n) >= L.portsPerProduct)
    throw limitReached('portsPerProduct', L.portsPerProduct);
  refuseTakenPort(productId, input);
  checkPortRefs(productId, input, null);
  const id = newId(DATA_PRODUCT_ID_PREFIX.port);
  const now = nowIso();
  const position = input.position ?? Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_ports WHERE product_id = ?', productId)!.n);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_ports (id, product_id, direction, name, port_type, version, description, lifecycle, lifecycle_dates, sunset_date, successor_id, objectives,
         source_kind, source_port_id, source_element_id, source_text, position, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      productId,
      input.direction,
      input.name,
      input.type,
      input.version,
      input.description,
      input.lifecycle,
      json({ [input.lifecycle]: now.slice(0, 10) }),
      input.sunsetDate,
      input.successorId,
      json(input.objectives),
      ...sourceColumns(input),
      position,
      now,
      actorName(),
      now,
      actorName(),
    );
    writePortObjects(id, input.objectIds, false);
    audit({
      action: 'dataproduct.port_added',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": ${input.direction} port "${input.name}"${input.version ? ` ${input.version}` : ''} added`,
      details: { portId: id, direction: input.direction, name: input.name, version: input.version, type: input.type },
    });
  });
  return portViews(me(), productId).find((p) => p.id === id)!;
}

export function updatePort(productId: string, productName: string, portId: string, body: unknown): DataPort {
  const cur = portOf(productId, portId);
  const input = dataPortInput.parse(body);
  if (input.direction !== cur.direction)
    throw new HttpError(400, 'A port keeps its direction – add a new port instead', 'DATA_PORT_INVALID', { context: 'direction' });
  refuseTakenPort(productId, input, cur.id);
  checkPortRefs(productId, input, cur.id);
  const dates = parseJson<Record<string, string>>(cur.lifecycle_dates, {});
  if (input.lifecycle !== cur.lifecycle) dates[input.lifecycle] = nowIso().slice(0, 10);
  db().tx(() => {
    db().run(
      `UPDATE dp_ports SET name = ?, port_type = ?, version = ?, description = ?, lifecycle = ?, lifecycle_dates = ?, sunset_date = ?, successor_id = ?, objectives = ?,
         source_kind = ?, source_port_id = ?, source_element_id = ?, source_text = ?, position = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      input.name,
      input.type,
      input.version,
      input.description,
      input.lifecycle,
      json(dates),
      input.sunsetDate,
      input.successorId,
      json(input.objectives),
      ...sourceColumns(input),
      input.position ?? cur.position,
      nowIso(),
      actorName(),
      cur.id,
    );
    writePortObjects(cur.id, input.objectIds, true);
    audit({
      action: 'dataproduct.port_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": port "${input.name}"${input.version ? ` ${input.version}` : ''} changed${input.lifecycle !== cur.lifecycle ? ` (${cur.lifecycle} → ${input.lifecycle}${input.sunsetDate ? `, sunset ${input.sunsetDate}` : ''})` : ''}`,
      details: { portId: cur.id, lifecycle: input.lifecycle, sunsetDate: input.sunsetDate, successorId: input.successorId },
    });
  });
  // deprecated: the consumers are told once (notices.ts, WP4)
  onLifecycleChanged('port', cur.id, { from: cur.lifecycle, to: input.lifecycle, sunsetDate: input.sunsetDate, sunsetBefore: cur.sunset_date });
  return portViews(me(), productId).find((p) => p.id === cur.id)!;
}

export function deletePort(productId: string, productName: string, portId: string): void {
  const cur = portOf(productId, portId);
  db().tx(() => {
    db().run('DELETE FROM dp_port_elements WHERE binding_id IN (SELECT id FROM dp_port_bindings WHERE port_id = ?)', cur.id);
    db().run('DELETE FROM dp_port_bindings WHERE port_id = ?', cur.id);
    db().run('DELETE FROM dp_port_objects WHERE port_id = ?', cur.id);
    db().run('DELETE FROM dp_consumers WHERE port_id = ?', cur.id);
    db().run('UPDATE dp_ports SET successor_id = NULL WHERE successor_id = ?', cur.id);
    // input ports of other products keep a note of what they consumed
    db().run(
      "UPDATE dp_ports SET source_kind = 'text', source_port_id = NULL, source_text = ? WHERE source_port_id = ?",
      `${cur.name}${cur.version ? ` ${cur.version}` : ''} (removed)`,
      cur.id,
    );
    db().run('DELETE FROM dp_ports WHERE id = ?', cur.id);
    onPortDeleted(cur.id);
    audit({
      action: 'dataproduct.port_removed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": ${cur.direction} port "${cur.name}"${cur.version ? ` ${cur.version}` : ''} removed`,
      details: { portId: cur.id },
    });
  });
}

// ---------- bindings ----------

/**
 * Sets a port's binding in one environment (part 7): its elements (each in that environment, each one the editor may
 * see – elements already bound that they may not see stay), its contract (output ports only; a contract the editor
 * may see, the version and server must exist) and its objectives. Bound elements become members with the port's role.
 */
export function setBinding(productId: string, productName: string, portId: string, environment: string, body: unknown): DataPort {
  const port = portOf(productId, portId);
  const env = environment.trim();
  if (!env || env.length > 60) throw new HttpError(400, 'A binding is for one environment', 'DATA_PORT_BINDING', { context: 'environment' });
  const input = dataPortBindingInput.parse(body);
  const u = me();
  const existing = db().get<{ id: string; contract_id: string | null; contract_version: number | null; contract_server: string | null }>(
    'SELECT id, contract_id, contract_version, contract_server FROM dp_port_bindings WHERE port_id = ? AND environment = ?',
    port.id,
    env,
  );
  const before = existing ? (bindingsOf([port.id]).find((b) => b.id === existing.id)?.elementIds ?? []) : [];
  const all = [...new Set([...before, ...input.elementIds])];
  const rows = elementsByIds(all);
  const teams = elementTeamIds(all);
  const sees = (id: string) => elementAccess(u, teams.get(id) ?? []).permissions.length > 0;
  for (const id of input.elementIds) {
    const el = rows.get(id);
    if (!el || (!sees(id) && !before.includes(id))) throw elementNotFound(id);
    if (el.environment && el.environment !== env)
      throw new HttpError(400, `${el.qualified_name} is in ${el.environment}, not ${env}`, 'DATA_ELEMENT_ENVIRONMENT', {
        element: el.qualified_name,
        environment: el.environment,
        binding: env,
      });
  }
  const kept = before.filter((id) => rows.has(id) && !sees(id));
  const next = [...new Set([...input.elementIds, ...kept])];
  if (next.length > L.elementsPerBinding) throw limitReached('elementsPerBinding', L.elementsPerBinding);
  // a contract the editor may not see is not in their form (portViews names it hidden): it stays on save, as it was –
  // with its version and server – like the elements they may not see
  const stored = existing?.contract_id ?? null;
  if (
    stored &&
    (input.contractId === null || input.contractId === stored) &&
    db().get('SELECT 1 FROM data_contracts WHERE id = ?', stored) &&
    !contractAccess(u, { id: stored }).permissions.includes('view')
  ) {
    input.contractId = stored;
    input.contractVersion = existing!.contract_version === null ? null : Number(existing!.contract_version);
    input.contractServer = existing!.contract_server;
  } else if (input.contractId) {
    if (port.direction !== 'output') throw new HttpError(400, 'Only output ports are held to a data contract', 'DATA_PORT_CONTRACT', { context: 'inputPort' });
    const c = db().get<{ id: string; current_version: number }>('SELECT id, current_version FROM data_contracts WHERE id = ?', input.contractId);
    if (!c || !contractAccess(u, { id: c.id }).permissions.includes('view'))
      throw new HttpError(404, `Data contract ${input.contractId} not found`, 'DATA_PORT_CONTRACT', { context: 'notFound' });
    if (input.contractVersion && !db().get('SELECT 1 FROM data_contract_versions WHERE contract_id = ? AND version = ?', c.id, input.contractVersion))
      throw new HttpError(400, `The contract has no version ${input.contractVersion}`, 'DATA_PORT_CONTRACT', {
        context: 'version',
        version: input.contractVersion,
      });
    if (input.contractServer) {
      const v = db().get<{ yaml: string }>(
        'SELECT yaml FROM data_contract_versions WHERE contract_id = ? AND version = ?',
        c.id,
        input.contractVersion ?? Number(c.current_version),
      );
      // the ODCS servers of that version (stored versions always parse: they were checked on save)
      const servers = ((): string[] => {
        try {
          return v ? factsOf(parseContract(v.yaml).doc).servers.map((x) => x.server) : [];
        } catch {
          return [];
        }
      })();
      if (!servers.includes(input.contractServer))
        throw new HttpError(400, `The contract has no server "${input.contractServer}"`, 'DATA_PORT_CONTRACT', {
          context: 'server',
          server: input.contractServer,
        });
    }
  }
  const role = roleOfPort(port.direction);
  const now = nowIso();
  db().tx(() => {
    const id = existing?.id ?? newId(DATA_PRODUCT_ID_PREFIX.binding);
    if (existing)
      db().run(
        'UPDATE dp_port_bindings SET contract_id = ?, contract_version = ?, contract_server = ?, objectives = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        input.contractId,
        input.contractVersion,
        input.contractServer,
        json(input.objectives),
        now,
        actorName(),
        id,
      );
    else
      db().run(
        'INSERT INTO dp_port_bindings (id, port_id, environment, contract_id, contract_version, contract_server, objectives, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        port.id,
        env,
        input.contractId,
        input.contractVersion,
        input.contractServer,
        json(input.objectives),
        now,
        actorName(),
      );
    db().run('DELETE FROM dp_port_elements WHERE binding_id = ?', id);
    for (const e of next) db().run('INSERT INTO dp_port_elements (binding_id, element_id) VALUES (?, ?)', id, e);
    // bound elements are members with the port's role (an output binding wins over an earlier input role)
    for (const e of next) {
      const m = db().get<{ role: string }>('SELECT role FROM dp_members WHERE product_id = ? AND element_id = ?', productId, e);
      if (!m)
        db().run(
          'INSERT INTO dp_members (product_id, element_id, role, include_descendants, note, added_by, added_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
          productId,
          e,
          role,
          '',
          actorName(),
          now,
        );
      else if (m.role !== role && (role === 'output' || m.role === 'internal'))
        db().run('UPDATE dp_members SET role = ? WHERE product_id = ? AND element_id = ?', role, productId, e);
    }
    db().run(
      `INSERT INTO dp_product_environments (product_id, environment, state, updated_at, updated_by) VALUES (?, ?, 'planned', ?, ?) ON CONFLICT DO NOTHING`,
      productId,
      env,
      now,
      actorName(),
    );
    audit({
      action: 'dataproduct.binding_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": port "${port.name}"${port.version ? ` ${port.version}` : ''} in ${env} bound to ${next.length} element(s)${input.contractId ? ', with a data contract' : ''}`,
      details: {
        portId: port.id,
        environment: env,
        elements: next.length,
        contractId: input.contractId,
        contractVersion: input.contractVersion,
        contractServer: input.contractServer,
      },
    });
  });
  return portViews(u, productId).find((p) => p.id === port.id)!;
}

export function removeBinding(productId: string, productName: string, portId: string, environment: string): DataPort {
  const port = portOf(productId, portId);
  const b = db().get<{ id: string }>('SELECT id FROM dp_port_bindings WHERE port_id = ? AND environment = ?', port.id, environment);
  if (!b) throw new HttpError(404, `The port has no binding in ${environment}`, 'DATA_PORT_BINDING', { context: 'notFound', environment });
  db().tx(() => {
    db().run('DELETE FROM dp_port_elements WHERE binding_id = ?', b.id);
    db().run('DELETE FROM dp_port_bindings WHERE id = ?', b.id);
    audit({
      action: 'dataproduct.binding_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": binding of port "${port.name}" in ${environment} removed`,
      details: { portId: port.id, environment, removed: true },
    });
  });
  return portViews(me(), productId).find((p) => p.id === port.id)!;
}

// ---------- consumers ----------

type ConsumerInput = ReturnType<typeof dataConsumerInput.parse>;

/** The name of a consumer as `u` may see it (null: hidden or gone). */
function consumerLabel(
  u: AuthUser | null,
  c: Pick<ConsumerRow, 'consumer_kind' | 'ref_id' | 'consumer_subjects' | 'consumer_text'>,
  names: Map<string, string | null>,
): string | null {
  if (c.consumer_kind === 'text') return c.consumer_text;
  if (c.consumer_kind === 'team' || c.consumer_kind === 'user') return parseJson<string[]>(c.consumer_subjects, [])[0] ?? null;
  return c.ref_id ? (names.get(`${c.consumer_kind}:${c.ref_id}`) ?? null) : null;
}

/** Names of the applications, services and products consumers name, as `u` may see them (bulk). */
function consumerNames(u: AuthUser | null, rows: Pick<ConsumerRow, 'consumer_kind' | 'ref_id'>[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const kind of ['application', 'service'] as const) {
    const ids = [...new Set(rows.filter((r) => r.consumer_kind === kind && r.ref_id).map((r) => r.ref_id!))];
    if (!ids.length) continue;
    for (const r of db().all<{ id: string; name: string; owners: string }>(
      `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'services'} WHERE id IN (${marks(ids.length)})`,
      ...ids,
    ))
      out.set(`${kind}:${r.id}`, canViewCatalogue(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }) ? r.name : null);
  }
  const pids = rows.filter((r) => r.consumer_kind === 'product' && r.ref_id).map((r) => r.ref_id!);
  for (const p of productsByIds(pids).values()) out.set(`product:${p.id}`, productAccess(u, p).permissions.length ? p.name : null);
  return out;
}

function consumerView(u: AuthUser | null, c: ConsumerRow, names: Map<string, string | null>): DataConsumer {
  const label = consumerLabel(u, c, names);
  const hiddenRef = (c.consumer_kind === 'application' || c.consumer_kind === 'service' || c.consumer_kind === 'product') && label === null;
  return {
    id: c.id,
    portId: c.port_id,
    kind: c.consumer_kind as DataConsumer['kind'],
    // an id of an item the reader may not see is not handed out
    refId: hiddenRef ? null : c.ref_id,
    subject: c.consumer_kind === 'team' || c.consumer_kind === 'user' ? (parseJson<string[]>(c.consumer_subjects, [])[0] ?? null) : null,
    text: c.consumer_text,
    label,
    purpose: c.purpose,
    since: c.since,
    endDate: c.end_date,
    agreement: parseJson(c.agreement, null),
    contacts: parseJson(c.contacts, []),
    createdAt: c.created_at,
    createdBy: c.created_by,
    updatedAt: c.updated_at,
    updatedBy: c.updated_by,
  };
}

export function listConsumers(productId: string, portId: string): DataConsumer[] {
  const port = portOf(productId, portId);
  const u = me();
  const rows = consumersOf([port.id]);
  const names = consumerNames(u, rows);
  return rows.map((c) => consumerView(u, c, names));
}

/** What a registration names must fit its kind, and an application, service or product must be one the editor may see. */
function checkConsumer(input: ConsumerInput): void {
  const u = me();
  const bad = (problem: string) => new HttpError(400, 'The consumer is not complete', 'DATA_CONSUMER_INVALID', { context: problem });
  if ((input.kind === 'team' || input.kind === 'user') && !input.subject?.startsWith(`${input.kind}:`)) throw bad('subject');
  if (input.kind === 'text' && !input.text) throw bad('text');
  if (input.kind === 'application' || input.kind === 'service' || input.kind === 'product') {
    if (!input.refId) throw bad('ref');
    const name = consumerNames(u, [{ consumer_kind: input.kind, ref_id: input.refId }]).get(`${input.kind}:${input.refId}`);
    if (!name)
      throw input.kind === 'product'
        ? productNotFound(input.refId)
        : new HttpError(404, `${input.kind} ${input.refId} not found`, 'DATA_CONSUMER_INVALID', { context: 'notFound' });
  }
  if (input.agreement?.kind === 'url' && !/^https?:\/\/\S+$/i.test(input.agreement.ref)) throw bad('agreement');
}

const consumerValues = (input: ConsumerInput): unknown[] => [
  input.kind,
  input.kind === 'application' || input.kind === 'service' || input.kind === 'product' ? input.refId : null,
  json(input.subject && (input.kind === 'team' || input.kind === 'user') ? [input.subject.toLowerCase()] : []),
  input.text,
  input.purpose,
  input.since,
  input.endDate,
  input.agreement ? json(input.agreement) : null,
  json(input.contacts.map((c) => c.toLowerCase())),
];

export function addConsumer(productId: string, productName: string, portId: string, body: unknown): DataConsumer {
  const port = portOf(productId, portId);
  if (port.direction !== 'output') throw new HttpError(400, 'Consumers register on output ports', 'DATA_CONSUMER_INVALID', { context: 'inputPort' });
  const input = dataConsumerInput.parse(body);
  checkConsumer(input);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_consumers WHERE port_id = ?', port.id)!.n) >= L.consumersPerPort)
    throw limitReached('consumersPerPort', L.consumersPerPort);
  const id = newId(DATA_PRODUCT_ID_PREFIX.consumer);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_consumers (id, port_id, consumer_kind, ref_id, consumer_subjects, consumer_text, purpose, since, end_date, agreement, contacts, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      port.id,
      ...consumerValues(input),
      now,
      actorName(),
      now,
      actorName(),
    );
    audit({
      action: 'dataproduct.consumer_added',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": consumer (${input.kind}) registered on port "${port.name}"`,
      details: { portId: port.id, consumerId: id, kind: input.kind, purpose: input.purpose.slice(0, 200) },
    });
  });
  return listConsumers(productId, port.id).find((c) => c.id === id)!;
}

function consumerOf(portId: string, consumerId: string): ConsumerRow {
  const c = db().get<ConsumerRow>('SELECT * FROM dp_consumers WHERE id = ? AND port_id = ?', consumerId, portId);
  if (!c) throw new HttpError(404, `Consumer ${consumerId} not found`, 'DATA_CONSUMER_NOT_FOUND', { id: consumerId });
  return c;
}

export function updateConsumer(productId: string, productName: string, portId: string, consumerId: string, body: unknown): DataConsumer {
  const port = portOf(productId, portId);
  const cur = consumerOf(port.id, consumerId);
  const input = dataConsumerInput.parse(body);
  // a consumer that names an item the editor may not see keeps it when the kind and reference stay
  const keepsRef = input.kind === cur.consumer_kind && input.refId === cur.ref_id;
  if (!keepsRef) checkConsumer(input);
  db().tx(() => {
    db().run(
      `UPDATE dp_consumers SET consumer_kind = ?, ref_id = ?, consumer_subjects = ?, consumer_text = ?, purpose = ?, since = ?, end_date = ?, agreement = ?, contacts = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`,
      ...consumerValues(input),
      nowIso(),
      actorName(),
      cur.id,
    );
    audit({
      action: 'dataproduct.consumer_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": consumer of port "${port.name}" changed`,
      details: { portId: port.id, consumerId: cur.id, kind: input.kind },
    });
  });
  return listConsumers(productId, port.id).find((c) => c.id === cur.id)!;
}

export function removeConsumer(productId: string, productName: string, portId: string, consumerId: string): void {
  const port = portOf(productId, portId);
  const cur = consumerOf(port.id, consumerId);
  db().tx(() => {
    db().run('DELETE FROM dp_consumers WHERE id = ?', cur.id);
    audit({
      action: 'dataproduct.consumer_removed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": consumer (${cur.consumer_kind}) of port "${port.name}" removed`,
      details: { portId: port.id, consumerId: cur.id },
    });
  });
}
