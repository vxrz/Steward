import type { AclEntry, DataDiscoveryRunStatus, Locale, PlatformPermission, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso, parseJson } from '../util.js';
import type { AuthUser } from '../auth/context.js';
import { matches } from '../auth/permissions.js';
import { memberships, owningTeams, platformAccess } from '../auth/policy.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { t } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { productAccess } from './access.js';
import {
  chunks,
  consumersOf,
  consumingPorts,
  discoverySourceRow,
  elementsByIds,
  marks,
  membershipsOfElements,
  portRow,
  portsOf,
  productRow,
  productsByIds,
  type ConsumerRow,
  type PortRow,
  type ProductRow,
} from './store.js';

/**
 * The data products' notifications (ADR 0036 part 17, docs/DATA-PRODUCTS.md#notifications): in the app and by e-mail
 * by default, quiet-hours group _Data products_; each sent once (dp_notices: kind, item, key – claimed before sending).
 * Recipients only read what they may see: a product they may not see is never named – they are not told about it at
 * all – and of the consuming products, only those they may see are named.
 *
 *  - `dataproduct.deprecated` – a product or a port deprecated: to the registered consumers of its (output) ports – the
 *    teams and users registered, their contacts, the owners of a registered consuming product – and the owners of the
 *    products whose input ports consume them; with the sunset date and the successor. Once per item and sunset date;
 *    leaving _deprecated_ forgets it (a later deprecation tells again). Hooks: service.changeLifecycle,
 *    ports.updatePort, ports.deletePort.
 *  - `dataproduct.elements_missing` – once per product and discovery run, to the product's owners (else the members of
 *    its owning teams who may change it).
 *  - `dataproduct.discovery_failed` – once per source until a run succeeds, to the source's owner (who it runs as) and
 *    the platform's managers who may see the platform (else the administrators).
 *
 * The discovery job (WP2) calls noticeElementsMissing and noticeDiscoveryFailed (or noticeDiscoveryRun for both).
 */

const LINK = (productId: string) => `/data-products/${encodeURIComponent(productId)}`;
const MAX_NAMED = 10;

/** Claims a notice (true: not sent before, send it now). */
function claim(kind: string, itemId: string, key: string): boolean {
  return (
    db().run('INSERT INTO dp_notices (kind, item_id, notice_key, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', kind, itemId, key, nowIso()).changes ===
    1
  );
}

const forget = (kind: string, itemId: string, prefix: string): void => {
  db().run('DELETE FROM dp_notices WHERE kind = ? AND item_id = ? AND substr(notice_key, 1, ?) = ?', kind, itemId, prefix.length, prefix);
};

interface Person {
  info: UserInfo;
  auth: AuthUser;
}

/** Active users once per call, with their AuthUser (memberships are cached per AuthUser). */
function people(): Person[] {
  return listUsers()
    .filter((u) => u.active)
    .map((info) => ({ info, auth: toAuthUser(info) }));
}

/** The people `subjects` (`user:`, `team:`) name. */
const named = (all: Person[], subjects: readonly string[]): Person[] => (subjects.length ? all.filter((p) => subjects.some((s) => matches(p.auth, s))) : []);

const sees = (p: Person, product: ProductRow): boolean => productAccess(p.auth, product).permissions.length > 0;

/** A product's owners; without any, the members of its owning teams who may change it. */
function ownersOf(all: Person[], product: ProductRow): Person[] {
  const owners = named(all, parseJson<string[]>(product.owners, []));
  if (owners.length) return owners;
  const teams = owningTeams('data_product', product.id).map((x) => x.id);
  if (!teams.length) return [];
  return all.filter((p) => teams.some((id) => memberships(p.auth).has(id)) && productAccess(p.auth, product).permissions.includes('edit'));
}

// ---------- deprecated ----------

/**
 * The lifecycle hook of products and ports (service.changeLifecycle, ports.updatePort): becoming deprecated – or a new
 * sunset date while deprecated – tells the consumers once; leaving deprecated (but for retired) forgets that it was
 * told. Never throws: a notice that cannot be sent is logged, the change stays. Returns the number of recipients.
 */
export function onLifecycleChanged(
  kind: 'product' | 'port',
  id: string,
  change: { from: string; to: string; sunsetDate: string | null; sunsetBefore?: string | null },
): number {
  try {
    if (change.to !== 'deprecated') {
      if (change.from === 'deprecated' && change.to !== 'retired') forget(kind, id, 'deprecated:');
      return 0;
    }
    if (change.from === 'deprecated' && (change.sunsetBefore ?? null) === change.sunsetDate) return 0;
    if (!claim(kind, id, `deprecated:${change.sunsetDate ?? ''}`)) return 0;
    return sendDeprecated(kind, id);
  } catch (err) {
    logger.warn({ err, kind, id }, 'deprecation notice could not be sent');
    return 0;
  }
}

/** A port was removed (ports.deletePort): its bookkeeping goes with it. */
export function onPortDeleted(portId: string): void {
  db().run("DELETE FROM dp_notices WHERE kind = 'port' AND item_id = ?", portId);
}

interface Why {
  /** Ports (names with versions) the person is registered on */
  registered: Set<string>;
  /** Consuming products the person owns (ids) */
  consuming: Set<string>;
}

function sendDeprecated(kind: 'product' | 'port', id: string): number {
  const port = kind === 'port' ? portRow(id) : undefined;
  const product = productRow(kind === 'port' ? (port?.product_id ?? '') : id);
  if (!product || (kind === 'port' && !port)) return 0;
  const ports: PortRow[] = port ? [port] : portsOf([product.id]).filter((p) => p.direction === 'output' && p.lifecycle !== 'retired');
  if (!ports.length) return 0;
  const portLabel = new Map(ports.map((p) => [p.id, `${p.name}${p.version ? ` ${p.version}` : ''}`]));
  const all = people();
  const why = new Map<string, Why & { person: Person }>();
  const add = (p: Person, f: (w: Why) => void) => {
    const w = why.get(p.info.id) ?? { person: p, registered: new Set<string>(), consuming: new Set<string>() };
    f(w);
    why.set(p.info.id, w);
  };
  const consumers: ConsumerRow[] = consumersOf(ports.map((p) => p.id));
  const consumingIn = consumingPorts(ports.map((p) => p.id)).filter((c) => c.product_id !== product.id);
  const consuming = productsByIds([
    ...consumers.flatMap((c) => (c.consumer_kind === 'product' && c.ref_id ? [c.ref_id] : [])),
    ...consumingIn.map((c) => c.product_id),
  ]);
  for (const c of consumers) {
    const label = portLabel.get(c.port_id) ?? '';
    for (const p of named(all, [...parseJson<string[]>(c.consumer_subjects, []), ...parseJson<string[]>(c.contacts, [])]))
      add(p, (w) => w.registered.add(label));
    const cp = c.consumer_kind === 'product' && c.ref_id ? consuming.get(c.ref_id) : undefined;
    if (cp) for (const p of ownersOf(all, cp)) add(p, (w) => w.consuming.add(cp.id));
  }
  for (const c of consumingIn) {
    const cp = consuming.get(c.product_id);
    if (cp && cp.lifecycle !== 'retired') for (const p of ownersOf(all, cp)) add(p, (w) => w.consuming.add(cp.id));
  }
  // only who may see the deprecated product is told; of the consuming products only those they may see are named
  const recipients = [...why.values()].filter((w) => sees(w.person, product));
  if (!recipients.length) return 0;
  const successorProduct = kind === 'product' && product.successor_id ? productRow(product.successor_id) : undefined;
  const successorPort = port?.successor_id ? portRow(port.successor_id) : undefined;
  const sunset = kind === 'port' ? (port!.sunset_date ?? null) : product.sunset_date;
  const portName = port ? portLabel.get(port.id)! : '';
  const byUser = new Map(recipients.map((w) => [w.person.info.id, w]));
  const text = (l: Locale, u?: UserInfo) => {
    const w = u ? byUser.get(u.id) : undefined;
    const successor =
      successorProduct && w && sees(w.person, successorProduct)
        ? successorProduct.name
        : successorPort
          ? `${successorPort.name}${successorPort.version ? ` ${successorPort.version}` : ''}`
          : null;
    const mine = w
      ? [...w.consuming]
          .map((pid) => consuming.get(pid))
          .filter((p): p is ProductRow => !!p && sees(w.person, p))
          .map((p) => p.name)
          .sort()
      : [];
    const lines = [
      kind === 'port'
        ? t(l, 'dataProducts.deprecated.portBody', { port: portName, product: product.name })
        : t(l, 'dataProducts.deprecated.productBody', { product: product.name }),
      sunset ? t(l, 'dataProducts.deprecated.sunset', { date: sunset }) : t(l, 'dataProducts.deprecated.noSunset'),
      ...(successor ? [t(l, 'dataProducts.deprecated.successor', { successor })] : []),
      ...(w?.registered.size ? [t(l, 'dataProducts.deprecated.registered', { ports: [...w.registered].sort().join(', ') })] : []),
      ...(mine.length ? [t(l, 'dataProducts.deprecated.consuming', { products: mine.join(', ') })] : []),
      t(l, 'dataProducts.deprecated.hint'),
    ];
    return {
      title:
        kind === 'port'
          ? t(l, 'dataProducts.deprecated.portTitle', { port: titleName(portName, 60), product: titleName(product.name) })
          : t(l, 'dataProducts.deprecated.productTitle', { product: titleName(product.name) }),
      body: lines.join('\n'),
    };
  };
  notify({
    event: 'dataproduct.deprecated',
    personal: true,
    text,
    link: LINK(product.id),
    recipients: recipients.map((w) => w.person.info),
    about: { kind: 'data_product', id: product.id },
    inAppKey: `${kind}:${id}:${sunset ?? ''}`,
    externalKey: `${kind}:${id}:${sunset ?? ''}`,
    data: { productId: product.id, ...(port ? { portId: port.id } : {}), sunsetDate: sunset },
  });
  return recipients.length;
}

// ---------- discovery: missing elements and failing sources ----------

/** What the discovery job (WP2) reports after a run. */
export interface DiscoveryRunNotice {
  sourceId: string;
  runId: string;
  status: DataDiscoveryRunStatus;
  /** The run's error (failed runs) – shown to the recipients, at most 500 characters */
  error?: string | null;
  /** When the source started failing (its failingSince; default the source's, else now) */
  failingSince?: string | null;
  /** Elements this run newly marked missing (store.markMissing) */
  missingElementIds?: readonly string[];
}

/**
 * All notices of one discovery run at once: a failed run tells (once per failing period), a run that succeeds (or is
 * truncated) clears the bookkeeping, elements the run marked missing tell their products. Never throws.
 */
export function noticeDiscoveryRun(run: DiscoveryRunNotice): { failed: number; missing: number } {
  const out = { failed: 0, missing: 0 };
  if (run.status === 'failed') out.failed = noticeDiscoveryFailed(run.sourceId, { message: run.error ?? '' }, run.failingSince ?? null, run.runId);
  else if (run.status === 'succeeded' || run.status === 'truncated') {
    try {
      forget('source', run.sourceId, 'failed:');
    } catch (err) {
      logger.warn({ err, sourceId: run.sourceId }, 'discovery notice bookkeeping could not be cleared');
    }
  }
  if (run.missingElementIds?.length) out.missing = noticeElementsMissing(run.sourceId, run.missingElementIds, run.runId);
  return out;
}

/**
 * `dataproduct.discovery_failed` – the call of the discovery job (discovery/job.ts) when a source starts failing:
 * once per source and failing period (the source's `failing_since`, or `failingSince`), to who it runs as and the
 * platform's managers who may see the platform (else the administrators). A source that fails again after a success
 * has a new failing period and tells again. Never throws; returns the number of recipients.
 */
export function noticeDiscoveryFailed(
  sourceId: string,
  problem: { code?: string; message: string },
  failingSince: string | null = null,
  runId: string | null = null,
): number {
  try {
    return sendDiscoveryFailed(sourceId, problem, failingSince, runId);
  } catch (err) {
    logger.warn({ err, sourceId }, 'discovery notice could not be sent');
    return 0;
  }
}

/**
 * `dataproduct.elements_missing` – the call of the discovery job (discovery/job.ts) with the elements a run newly
 * marked missing: once per product and run (`runId`, else the source's newest run), to the product's owners. Never
 * throws; returns the number of products told.
 */
export function noticeElementsMissing(sourceId: string, elementIds: readonly string[], runId: string | null = null): number {
  try {
    const run =
      runId ??
      db().get<{ id: string }>('SELECT id FROM dp_discovery_runs WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', sourceId)?.id ??
      nowIso();
    return sendElementsMissing(sourceId, run, elementIds);
  } catch (err) {
    logger.warn({ err, sourceId }, 'missing-element notice could not be sent');
    return 0;
  }
}

function sendDiscoveryFailed(sourceId: string, problem: { code?: string; message: string }, failingSince: string | null, runId: string | null): number {
  const src = discoverySourceRow(sourceId);
  if (!src) return 0;
  const since = failingSince ?? src.failing_since ?? nowIso();
  const key = `failed:${since}`;
  if (!claim('source', src.id, key)) return 0;
  // an earlier failing period's bookkeeping goes
  db().run("DELETE FROM dp_notices WHERE kind = 'source' AND item_id = ? AND notice_key <> ?", src.id, key);
  const platform = db().get<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM platforms WHERE id = ?', src.platform_id);
  if (!platform) return 0;
  const acl = parseJson<AclEntry<PlatformPermission>[]>(platform.acl, []);
  const all = people();
  const perms = (p: Person) => platformAccess(p.auth, { id: platform.id, acl }).permissions;
  // the source's owner (who it runs as) and the platform's managers – each only when they may see the platform
  let recipients = all.filter(
    (p) =>
      (p.info.username.toLowerCase() === src.run_as.toLowerCase() && perms(p).length > 0) || (perms(p).includes('manage') && !p.info.roles.includes('admin')),
  );
  if (!recipients.length) recipients = all.filter((p) => p.info.roles.includes('admin'));
  if (!recipients.length) return 0;
  const error = problem.message.replace(/\s+/g, ' ').trim().slice(0, 500);
  notify({
    event: 'dataproduct.discovery_failed',
    text: (l: Locale) => ({
      title: t(l, 'dataProducts.discoveryFailed.title', { source: titleName(src.name) }),
      body: [
        t(l, 'dataProducts.discoveryFailed.body', { source: src.name, platform: platform.name, since, error }),
        t(l, 'dataProducts.discoveryFailed.hint'),
      ].join('\n'),
    }),
    link: `/data-products/discovery?source=${encodeURIComponent(src.id)}`,
    recipients: recipients.map((p) => p.info),
    about: { kind: 'platform', id: platform.id },
    inAppKey: `source:${src.id}:${since}`,
    externalKey: `source:${src.id}:${since}`,
    data: { sourceId: src.id, platformId: platform.id, ...(runId ? { runId } : {}), ...(problem.code ? { code: problem.code } : {}) },
  });
  return recipients.length;
}

function sendElementsMissing(sourceId: string, runId: string, elementIds: readonly string[]): number {
  const src = discoverySourceRow(sourceId);
  const memberships = membershipsOfElements(elementIds);
  if (!memberships.length) return 0;
  const products = productsByIds(memberships.map((m) => m.product_id));
  const elements = elementsByIds([...new Set(memberships.map((m) => m.element_id))]);
  const byProduct = new Map<string, string[]>();
  for (const m of memberships) byProduct.set(m.product_id, [...(byProduct.get(m.product_id) ?? []), m.element_id]);
  // old bookkeeping of missing elements goes after 90 days (one row per product and run)
  db().run(
    "DELETE FROM dp_notices WHERE kind = 'product' AND substr(notice_key, 1, 8) = 'missing:' AND sent_at < ?",
    new Date(Date.now() - 90 * 86_400_000).toISOString(),
  );
  const all = people();
  let sent = 0;
  for (const [productId, ids] of byProduct) {
    const product = products.get(productId);
    if (!product || product.lifecycle === 'retired') continue;
    const recipients = ownersOf(all, product).filter((p) => sees(p, product));
    if (!recipients.length) continue;
    if (!claim('product', product.id, `missing:${runId}`)) continue;
    // the elements of a product are part of what its readers see (decision 15)
    const names = ids
      .map((id) => elements.get(id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => `${e.qualified_name} (${e.environment})`)
      .sort();
    const count = names.length;
    if (!count) continue;
    const sourceName = src?.name ?? sourceId;
    notify({
      event: 'dataproduct.elements_missing',
      text: (l: Locale) => ({
        title: t(l, 'dataProducts.missing.title', { product: titleName(product.name), count }),
        body: [
          t(l, 'dataProducts.missing.body', { product: product.name, source: sourceName, count }),
          ...names.slice(0, MAX_NAMED).map((n) => `- ${n}`),
          ...(count > MAX_NAMED ? [t(l, 'dataProducts.missing.more', { count: count - MAX_NAMED })] : []),
          t(l, 'dataProducts.missing.hint'),
        ].join('\n'),
      }),
      link: LINK(product.id),
      recipients: recipients.map((p) => p.info),
      about: { kind: 'data_product', id: product.id },
      inAppKey: `missing:${product.id}:${runId}`,
      externalKey: `missing:${product.id}:${runId}`,
      data: { productId: product.id, sourceId, runId, missing: count },
    });
    sent++;
  }
  return sent;
}

/** Notice bookkeeping rows of these items (tests, the product page's history). */
export function noticesOf(kind: string, itemIds: readonly string[]): { item_id: string; notice_key: string; sent_at: string }[] {
  return chunks([...new Set(itemIds)]).flatMap((part) =>
    db().all<{ item_id: string; notice_key: string; sent_at: string }>(
      `SELECT item_id, notice_key, sent_at FROM dp_notices WHERE kind = ? AND item_id IN (${marks(part.length)}) ORDER BY sent_at, notice_key`,
      kind,
      ...part,
    ),
  );
}
