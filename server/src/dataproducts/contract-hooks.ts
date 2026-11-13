import type { DataContractChange, Locale, UserInfo } from '@sm/shared';
import { qualityDimensionOf } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { parseJson } from '../util.js';
import { contractAccess } from '../auth/policy.js';
import { moduleEnabled } from '../modules/registry.js';
import { t } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { claim, named, ownersOf, people, sees, type Person } from './notices.js';
import { recordQualityResults } from './quality.js';
import { chunks, consumersOf, consumingPorts, elementsByIds, marks, productsByIds, type PortRow, type ProductRow } from './store.js';

/**
 * What the data contracts service tells the data products module (0.24.0, ADR 0036 parts 7, 10 and 17 phase 2). The
 * contract service calls these lazily (datacontracts/service.ts and testing.ts, `await import()`), only while the
 * module is on; both never throw – a notice or a result that cannot be stored is logged, the contract's change stays.
 *
 *  - **onContractVersionSaved** – a new version that the existing comparison (datacontracts/diff.ts) calls breaking,
 *    of a contract bound to an output port that follows the contract's current version (a binding held to a fixed
 *    version is not moved by a new one): `dataproduct.contract_breaking` to the port's registered consumers – the teams
 *    and users registered, their contacts, the owners of a registered consuming product – and the owners of the
 *    products whose input ports consume it. Once per port and contract version (dp_notices). Only who may see the
 *    product is told; the contract is named, and its breaking changes listed, only to who may see the contract; of the
 *    consuming products only those the recipient may see are named.
 *  - **onContractTested** – a real test of the contract (not a dry run) through the datacontract CLI: its checks that
 *    map to an ISO/IEC 25012 dimension become quality results (source `contract`) of the elements of the output
 *    bindings held to the tested version (quality.ts).
 */

const LINK = (productId: string) => `/data-products/${encodeURIComponent(productId)}`;
const MAX_CHANGES = 5;

interface BoundPort extends PortRow {
  binding_id: string;
  environment: string;
  contract_server: string | null;
  contract_version: number | null;
}

/** Output ports bound to the contract (not retired), with the binding's environment and version. */
function boundPorts(contractId: string): BoundPort[] {
  return db().all<BoundPort>(
    `SELECT p.*, b.id AS binding_id, b.environment, b.contract_server, b.contract_version FROM dp_port_bindings b JOIN dp_ports p ON p.id = b.port_id
     WHERE b.contract_id = ? AND p.direction = 'output' AND p.lifecycle <> 'retired' ORDER BY p.product_id, p.position, p.id, b.environment`,
    contractId,
  );
}

const portLabel = (p: Pick<PortRow, 'name' | 'version'>): string => `${p.name}${p.version ? ` ${p.version}` : ''}`;

const changeText = (c: DataContractChange): string =>
  `${[c.schema, c.field ?? c.rule].filter(Boolean).join('.') || '–'}: ${c.kind}${c.reason ? ` (${c.reason})` : ''}`;

/**
 * A version of a contract was saved (datacontracts/service.ts saveVersion). Breaking changes tell the consumers of the
 * output ports that follow the current version, once per port and version. Returns the number of people told.
 */
export function onContractVersionSaved(e: {
  contractId: string;
  contractName: string;
  contractKey: string;
  version: number;
  breaking: number;
  changes: readonly DataContractChange[];
}): number {
  if (e.breaking <= 0 || !moduleEnabled('dataProducts')) return 0;
  try {
    // a binding held to a fixed version is not moved by a new version
    const ports = boundPorts(e.contractId).filter((p) => p.contract_version === null);
    const byPort = new Map<string, BoundPort[]>();
    for (const p of ports) byPort.set(p.id, [...(byPort.get(p.id) ?? []), p]);
    if (!byPort.size) return 0;
    const all = people();
    const products = productsByIds([...new Set(ports.map((p) => p.product_id))]);
    const consumers = consumersOf([...byPort.keys()]);
    const consumingIn = consumingPorts([...byPort.keys()]);
    const consuming = productsByIds([
      ...consumers.flatMap((c) => (c.consumer_kind === 'product' && c.ref_id ? [c.ref_id] : [])),
      ...consumingIn.map((c) => c.product_id),
    ]);
    let told = 0;
    for (const [portId, rows] of byPort) {
      const port = rows[0]!;
      const product = products.get(port.product_id);
      if (!product || product.lifecycle === 'retired') continue;
      if (!claim('port', portId, `breaking:${e.contractId}#${e.version}`)) continue;
      told += sendBreaking(e, port, rows.map((r) => r.environment).filter(Boolean), product, all, {
        consumers: consumers.filter((c) => c.port_id === portId),
        consumingIn: consumingIn.filter((c) => c.source_port_id === portId && c.product_id !== product.id),
        consuming,
      });
    }
    return told;
  } catch (err) {
    logger.warn({ err, contract: e.contractId }, 'breaking-change notice could not be sent');
    return 0;
  }
}

function sendBreaking(
  e: Parameters<typeof onContractVersionSaved>[0],
  port: BoundPort,
  environments: string[],
  product: ProductRow,
  all: Person[],
  x: { consumers: ReturnType<typeof consumersOf>; consumingIn: PortRow[]; consuming: Map<string, ProductRow> },
): number {
  const why = new Map<string, { person: Person; registered: boolean; consuming: Set<string> }>();
  const add = (p: Person, f: (w: { registered: boolean; consuming: Set<string> }) => void) => {
    const w = why.get(p.info.id) ?? { person: p, registered: false, consuming: new Set<string>() };
    f(w);
    why.set(p.info.id, w);
  };
  for (const c of x.consumers) {
    for (const p of named(all, [...parseJson<string[]>(c.consumer_subjects, []), ...parseJson<string[]>(c.contacts, [])]))
      add(p, (w) => {
        w.registered = true;
      });
    const cp = c.consumer_kind === 'product' && c.ref_id ? x.consuming.get(c.ref_id) : undefined;
    if (cp && cp.lifecycle !== 'retired') for (const p of ownersOf(all, cp)) add(p, (w) => w.consuming.add(cp.id));
  }
  for (const c of x.consumingIn) {
    const cp = x.consuming.get(c.product_id);
    if (cp && cp.lifecycle !== 'retired') for (const p of ownersOf(all, cp)) add(p, (w) => w.consuming.add(cp.id));
  }
  // only who may see the product is told (team scope of names: they are not told about it at all otherwise)
  const recipients = [...why.values()].filter((w) => sees(w.person, product));
  if (!recipients.length) return 0;
  const byUser = new Map(recipients.map((w) => [w.person.info.id, w]));
  const breaking = e.changes.filter((c) => c.breaking);
  const label = portLabel(port);
  const envs = [...new Set(environments)].sort().join(', ');
  const text = (l: Locale, u?: UserInfo) => {
    const w = u ? byUser.get(u.id) : undefined;
    // the contract by name, and its changes, only to who may see it
    const seesContract = !!w && contractAccess(w.person.auth, { id: e.contractId }).permissions.includes('view');
    const mine = w
      ? [...w.consuming]
          .map((id) => x.consuming.get(id))
          .filter((p): p is ProductRow => !!p && sees(w.person, p))
          .map((p) => p.name)
          .sort()
      : [];
    const lines = [
      seesContract
        ? t(l, 'dataProducts.breaking.body', {
            contract: e.contractName,
            key: e.contractKey,
            version: e.version,
            count: e.breaking,
            port: label,
            product: product.name,
          })
        : t(l, 'dataProducts.breaking.bodyHidden', { version: e.version, count: e.breaking, port: label, product: product.name }),
      ...(envs ? [t(l, 'dataProducts.breaking.environments', { environments: envs })] : []),
      ...(seesContract ? breaking.slice(0, MAX_CHANGES).map((c) => `- ${changeText(c)}`) : []),
      ...(seesContract && e.breaking > MAX_CHANGES ? [t(l, 'dataProducts.breaking.more', { count: e.breaking - Math.min(MAX_CHANGES, breaking.length) })] : []),
      ...(w?.registered ? [t(l, 'dataProducts.breaking.registered', { port: label })] : []),
      ...(mine.length ? [t(l, 'dataProducts.breaking.consuming', { products: mine.join(', ') })] : []),
      t(l, 'dataProducts.breaking.hint'),
    ];
    return { title: t(l, 'dataProducts.breaking.title', { port: titleName(label, 60), product: titleName(product.name) }), body: lines.join('\n') };
  };
  notify({
    event: 'dataproduct.contract_breaking',
    personal: true,
    text,
    link: LINK(product.id),
    recipients: recipients.map((w) => w.person.info),
    about: { kind: 'data_product', id: product.id },
    inAppKey: `breaking:${port.id}:${e.contractId}:${e.version}`,
    externalKey: `breaking:${port.id}:${e.contractId}:${e.version}`,
    data: { productId: product.id, portId: port.id, version: e.version, breaking: e.breaking },
  });
  return recipients.length;
}

// ---------- contract tests as quality results ----------

/** A check of a datacontract CLI run, as the hook gets it (no reasons: they can carry values). */
export interface TestedCheck {
  type: string;
  name: string;
  model: string | null;
  field: string | null;
  result: string;
}

const STATUS: Record<string, 'passed' | 'warning' | 'failed' | 'error'> = { passed: 'passed', warning: 'warning', failed: 'failed', error: 'error' };

/**
 * A real test of a contract ran (datacontracts/testing.ts runContractTest): the checks that map to a quality dimension
 * become quality results of the bound elements – the output bindings held to the tested version (or following the
 * current one) whose server is the tested one (or none). A check's model is matched to an element by its schema
 * object's physical name or name against the element's last name part; a binding with one element takes every check.
 * Returns the number of results stored.
 */
export function onContractTested(e: {
  contractId: string;
  version: number;
  current: number;
  server: string;
  runId: string;
  startedAt: string;
  checks: readonly TestedCheck[];
  /** schema object name → physical name */
  physical: ReadonlyMap<string, string>;
}): number {
  if (!moduleEnabled('dataProducts')) return 0;
  try {
    const ports = boundPorts(e.contractId).filter(
      (p) =>
        (p.contract_version === null ? e.version === e.current : p.contract_version === e.version) && (!p.contract_server || p.contract_server === e.server),
    );
    if (!ports.length) return 0;
    const bindingIds = [...new Set(ports.map((p) => p.binding_id))];
    const elementIdsOf = new Map<string, string[]>();
    for (const part of chunks(bindingIds))
      for (const r of db().all<{ binding_id: string; element_id: string }>(
        `SELECT binding_id, element_id FROM dp_port_elements WHERE binding_id IN (${marks(part.length)})`,
        ...part,
      ))
        elementIdsOf.set(r.binding_id, [...(elementIdsOf.get(r.binding_id) ?? []), r.element_id]);
    const elements = elementsByIds([...elementIdsOf.values()].flat());
    const lastPart = (q: string) => q.split('.').pop()!.replaceAll('"', '').toLowerCase();
    const results: Parameters<typeof recordQualityResults>[0][number][] = [];
    for (const check of e.checks) {
      const dimension = qualityDimensionOf(null, check.type) ?? qualityDimensionOf(null, check.name);
      const status = STATUS[check.result];
      if (!dimension || !status) continue;
      const model = (check.model ?? '').toLowerCase();
      const physical = lastPart(e.physical.get(check.model ?? '') ?? check.model ?? '');
      for (const ids of elementIdsOf.values()) {
        const targets = ids.length === 1 ? ids : ids.filter((id) => [model, physical].includes(lastPart(elements.get(id)?.qualified_name ?? '')));
        for (const elementId of targets)
          results.push({
            elementId,
            source: 'contract',
            name: `${check.type}${check.model ? `:${check.model}` : ''}${check.field ? `.${check.field}` : ''}`.slice(0, 255),
            dimension,
            status,
            runRef: e.runId,
            observedAt: e.startedAt,
          });
      }
    }
    // one element may be bound to two ports with the contract: one result per element and test
    const uniq = new Map(results.map((r) => [`${r.elementId}|${r.name}`, r]));
    let stored = 0;
    const list = [...uniq.values()];
    for (let i = 0; i < list.length; i += 5_000) stored += recordQualityResults(list.slice(i, i + 5_000)).recorded;
    return stored;
  } catch (err) {
    logger.warn({ err, contract: e.contractId }, 'contract test results could not be stored as quality results');
    return 0;
  }
}
