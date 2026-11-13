import {
  DATA_SEMANTIC_LIMITS as L,
  dataElementPeekInput,
  dataPortRecordingInput,
  type DataContractExamples,
  type DataExampleProperty,
  type DataPortPreview,
  type DataPortRecordingPreview,
  type PeekedMessage,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { contractAccess } from '../auth/policy.js';
import { isObj, str } from '../datacontracts/odcs.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { elementFor } from './checks/element.js';
import { elementNotFound } from './common.js';
import { defaultEnvironment } from './health.js';
import { personalFieldsOfDoc } from './personal-fields.js';
import { contractDocsOf } from './semantic-lint.js';
import { editableProduct, touchProduct, visibleProduct } from './service.js';
import { bindingsOf, chunks, environmentsOf, marks, portRow, type BindingWithElements } from './store.js';

/**
 * Previews (ADR 0037 part 6, docs/DATA-PRODUCTS.md#previews): what a port or a topic carries, without reading data
 * values of a platform into Steward beyond what was allowed before.
 *
 * - **Contract examples:** the `examples` of the properties of the data contract bound to an output port (the version it
 *   is held to) – the contract's own text, shown to who may see the contract (a hidden one is said, not shown).
 * - **Recorded responses** (#105) linked to a port: answers the platform team recorded, shown masked to who may use
 *   their platform (recordings can hold personal data; others are counted). Linking changes the product.
 * - **The Kafka peek on elements:** the existing peek (KAFKA.md#peek) offered on `kafka.topic` elements and their
 *   bindings with its rules – the platform's managers only, off unless the platform allows it, at most 5 messages of
 *   4 KB, masked, audited without values – and it also masks the fields the contracts bound with the topic mark
 *   personal. Session only; never over MCP or /api/v1.
 * - **No sample rows** from Snowflake or SQL databases: ADR 0036's "metadata only" stays (reading production rows would
 *   put personal and business data into Steward and widen its audit and GDPR scope).
 */

const recordingInvalid = (message: string, context: string) => new HttpError(400, message, 'DATA_PORT_RECORDING_INVALID', { context });

/** The bindings of a port in an environment (else its production binding, else its first). */
function bindingOf(portId: string, environment: string | undefined, envs: readonly string[]): BindingWithElements | null {
  const all = bindingsOf([portId]);
  if (environment !== undefined) return all.find((b) => b.environment === environment) ?? null;
  const def = defaultEnvironment(envs);
  return all.find((b) => b.environment === def) ?? all[0] ?? null;
}

/** The personal keys of contract documents, lower case: the full path and its last part (`customer.email`, `email`). */
export function personalKeys(docs: Iterable<Record<string, unknown> | null>): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    if (!d) continue;
    for (const f of personalFieldsOfDoc(d).filter((x) => x.personal)) {
      out.add(f.field.toLowerCase());
      out.add(f.field.split('.').pop()!.toLowerCase());
    }
  }
  return out;
}

const exampleText = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > L.exampleChars ? `${s.slice(0, L.exampleChars)}…` : s;
};

/** The examples of a contract document's properties (nested ones by path), with what the contract marks personal. */
export function examplesOf(doc: Record<string, unknown>): { objects: DataContractExamples['objects']; more: number } {
  const personal = new Set(
    personalFieldsOfDoc(doc)
      .filter((f) => f.personal)
      .map((f) => `${f.schema}\u0000${f.field}`),
  );
  let count = 0;
  let more = 0;
  const objects: DataContractExamples['objects'] = [];
  for (const s of Array.isArray(doc.schema) ? doc.schema.filter(isObj) : []) {
    const schema = str(s.name) ?? '';
    const properties: DataExampleProperty[] = [];
    const stack: [unknown, string][] = (Array.isArray(s.properties) ? s.properties : []).map((p) => [p, ''] as [unknown, string]).reverse();
    let budget = 20_000;
    while (stack.length && budget-- > 0) {
      const [p, parent] = stack.pop()!;
      if (!isObj(p)) continue;
      const name = str(p.name) ?? '';
      const path = parent ? `${parent}.${name}` : name;
      const examples = Array.isArray(p.examples) ? p.examples.slice(0, L.examplesPerProperty).map(exampleText) : [];
      if (examples.length) {
        if (count < L.exampleProperties) {
          properties.push({ name: path, logicalType: str(p.logicalType), personal: personal.has(`${schema}\u0000${path}`), examples });
          count++;
        } else more++;
      }
      const kids = [...(Array.isArray(p.properties) ? p.properties : []), ...(isObj(p.items) && Array.isArray(p.items.properties) ? p.items.properties : [])];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], path]);
    }
    objects.push({ name: schema, properties });
  }
  return { objects, more };
}

/** Masks a recorded body: the peek's rules and the personal keys of the bound contract. */
async function maskedBody(body: string | null, keys: ReadonlySet<string>): Promise<{ text: string; truncated: boolean }> {
  if (body === null) return { text: '', truncated: false };
  const { hideSensitive } = await import('../kafka/service.js');
  const value = parseJson<unknown>(body, null);
  const text = typeof value === 'string' ? (hideSensitive(value) as string) : JSON.stringify(hideSensitive(value, 0, keys), null, 2);
  return text.length > L.recordingPreviewChars ? { text: text.slice(0, L.recordingPreviewChars), truncated: true } : { text, truncated: false };
}

interface LinkRow {
  recording_id: string;
  platform_id: string;
  note: string;
  added_by: string;
  added_at: string;
  method: string;
  path: string;
  status: number;
  body: string | null;
  platform_name: string;
}

function portOfProduct(productId: string, portId: string) {
  const port = portRow(portId);
  if (!port || port.product_id !== productId) throw new HttpError(404, `Port ${portId} not found`, 'DATA_PORT_NOT_FOUND', { id: portId });
  return port;
}

/** GET /api/data-products/:id/ports/:portId/preview?environment= – contract examples and linked recordings, no platform read. */
export async function portPreview(productId: string, portId: string, raw: unknown): Promise<DataPortPreview> {
  const u = me();
  const { row: p, perms } = visibleProduct(productId, u);
  const port = portOfProduct(p.id, portId);
  const q = z
    .object({ environment: z.string().trim().max(60).optional() })
    .strict()
    .parse(raw ?? {});
  const envs = environmentsOf([p.id]).map((e) => e.environment);
  const b = bindingOf(port.id, q.environment, envs);
  let examples: DataContractExamples | null = null;
  let hiddenContract = false;
  let keys = new Set<string>();
  if (b?.contract_id) {
    const c = db().get<{ id: string; contract_key: string; name: string; current_version: number }>(
      'SELECT id, contract_key, name, current_version FROM data_contracts WHERE id = ?',
      b.contract_id,
    );
    if (c && contractAccess(u, { id: c.id }).permissions.includes('view')) {
      const version = b.contract_version ?? Number(c.current_version);
      const doc = contractDocsOf([`${c.id}#${version}`]).get(`${c.id}#${version}`) ?? null;
      if (doc) {
        const ex = examplesOf(doc);
        examples = { contract: { id: c.id, key: c.contract_key, name: c.name }, version, objects: ex.objects, more: ex.more };
        keys = personalKeys([doc]);
      }
    } else if (c) hiddenContract = true;
  }
  const links = db().all<LinkRow>(
    `SELECT l.recording_id, l.platform_id, l.note, l.added_by, l.added_at, r.method, r.path, r.status, r.body, pl.name AS platform_name
       FROM dp_port_recordings l JOIN platform_recordings r ON r.id = l.recording_id JOIN platforms pl ON pl.id = r.platform_id
      WHERE l.port_id = ? ORDER BY l.added_at, l.recording_id`,
    port.id,
  );
  const recordings: DataPortRecordingPreview[] = [];
  let hiddenRecordings = 0;
  const uses = new Map<string, boolean>();
  for (const l of links) {
    if (!uses.has(l.platform_id)) uses.set(l.platform_id, platformPermissions(u, { id: l.platform_id }).includes('use'));
    if (!uses.get(l.platform_id)) {
      hiddenRecordings++;
      continue;
    }
    const body = await maskedBody(l.body, keys);
    recordings.push({
      recordingId: l.recording_id,
      platform: { id: l.platform_id, name: l.platform_name },
      method: l.method,
      path: l.path,
      status: Number(l.status),
      note: l.note,
      body: body.text,
      truncated: body.truncated,
      addedBy: l.added_by,
      addedAt: l.added_at,
    });
  }
  return {
    portId: port.id,
    environment: b?.environment ?? q.environment ?? '',
    examples,
    hiddenContract,
    recordings,
    hiddenRecordings,
    mayLink: perms.includes('edit'),
  };
}

/** POST /api/data-products/:id/ports/:portId/recordings – who may change the product and use the recording's platform. */
export async function linkPortRecording(productId: string, portId: string, body: unknown): Promise<DataPortPreview> {
  const u = me();
  const { row: p } = editableProduct(productId);
  const port = portOfProduct(p.id, portId);
  const input = dataPortRecordingInput.parse(body);
  const r = db().get<{ id: string; platform_id: string; method: string; path: string }>(
    'SELECT id, platform_id, method, path FROM platform_recordings WHERE id = ?',
    input.recordingId,
  );
  if (!r || !platformPermissions(u, { id: r.platform_id }).includes('use'))
    throw recordingInvalid(`Recorded response ${input.recordingId} not found`, 'notFound');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_port_recordings WHERE port_id = ?', port.id)?.n ?? 0);
  if (db().get('SELECT 1 FROM dp_port_recordings WHERE port_id = ? AND recording_id = ?', port.id, r.id))
    throw recordingInvalid('The recorded response is linked already', 'linked');
  if (n >= L.recordingsPerPort) throw recordingInvalid(`At most ${L.recordingsPerPort} recorded responses per port`, 'tooMany');
  db().tx(() => {
    db().run(
      'INSERT INTO dp_port_recordings (port_id, recording_id, platform_id, note, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      port.id,
      r.id,
      r.platform_id,
      input.note,
      u.username,
      nowIso(),
    );
    touchProduct(p.id);
    audit({
      action: 'dataproduct.port_recording_linked',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": recorded response ${r.method} ${r.path} linked to the port ${port.name}`,
      details: { portId: port.id, recordingId: r.id, platformId: r.platform_id },
    });
  });
  return portPreview(p.id, port.id, {});
}

/** DELETE /api/data-products/:id/ports/:portId/recordings/:recordingId – who may change the product. */
export function unlinkPortRecording(productId: string, portId: string, recordingId: string): void {
  const { row: p } = editableProduct(productId);
  const port = portOfProduct(p.id, portId);
  const cur = db().get<{ platform_id: string }>('SELECT platform_id FROM dp_port_recordings WHERE port_id = ? AND recording_id = ?', port.id, recordingId);
  if (!cur) throw recordingInvalid(`Recorded response ${recordingId} is not linked to this port`, 'notLinked');
  db().tx(() => {
    db().run('DELETE FROM dp_port_recordings WHERE port_id = ? AND recording_id = ?', port.id, recordingId);
    touchProduct(p.id);
    audit({
      action: 'dataproduct.port_recording_unlinked',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": a recorded response unlinked from the port ${port.name}`,
      details: { portId: port.id, recordingId, platformId: cur.platform_id },
    });
  });
}

// ---------- the Kafka peek on topic elements ----------

/** The personal keys of every contract bound with an element (whoever may see the contracts: masking more is safe). */
function personalKeysOfElement(elementId: string): Set<string> {
  const bindings = db().all<{ contract_id: string | null; contract_version: number | null }>(
    `SELECT b.contract_id, b.contract_version FROM dp_port_elements pe JOIN dp_port_bindings b ON b.id = pe.binding_id
      WHERE pe.element_id = ? AND b.contract_id IS NOT NULL`,
    elementId,
  );
  if (!bindings.length) return new Set();
  const ids = [...new Set(bindings.map((b) => b.contract_id!))];
  const current = new Map<string, number>();
  for (const part of chunks(ids))
    for (const c of db().all<{ id: string; current_version: number }>(
      `SELECT id, current_version FROM data_contracts WHERE id IN (${marks(part.length)})`,
      ...part,
    ))
      current.set(c.id, Number(c.current_version));
  const keys = bindings.flatMap((b) => (current.has(b.contract_id!) ? [`${b.contract_id}#${b.contract_version ?? current.get(b.contract_id!)}`] : []));
  return personalKeys(contractDocsOf(keys).values());
}

/**
 * POST /api/data-elements/:id/peek (session only): the newest messages of a `kafka.topic` element – the peek's rules
 * (peekTopic: the platform allows it, its managers only, at most 5 of 4 KB, masked, audited without values), and the
 * fields the contracts bound with the topic mark personal masked too.
 */
export async function peekElement(elementId: string, body: unknown, u: AuthUser = me()): Promise<{ messages: PeekedMessage[]; maskedFields: number }> {
  const el = elementFor(u, elementId);
  if (!el) throw elementNotFound(elementId);
  if (el.kind !== 'kafka.topic' || !el.platform_id)
    throw new HttpError(400, 'Only Kafka topics are peeked', 'DATA_ELEMENT_PEEK_INVALID', { context: 'kind', kind: el.kind });
  const input = dataElementPeekInput.parse(body ?? {});
  const canManage = platformPermissions(u, { id: el.platform_id }).includes('manage');
  const keys = personalKeysOfElement(el.id);
  const { peekTopic } = await import('../kafka/service.js');
  const messages = await peekTopic(el.platform_id, el.qualified_name, input.count, u.username, canManage, {
    maskKeys: keys,
    details: { elementId: el.id, maskedByContract: keys.size },
  });
  return { messages, maskedFields: keys.size };
}
