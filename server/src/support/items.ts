import {
  itemSupportInput,
  legacySupportOf,
  supportChannelInput,
  toolOfAddress,
  type Guide,
  type ItemSupport,
  type ItemSupportInput,
  type SupportChannel,
  type SupportItemKind,
  type SupportLevelRef,
  type SupportPurpose,
  type SupportTool,
  type SupportedByService,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { catalogueVisibleNow } from '../records/access.js';
import { HttpError, newId, nowIso } from '../util.js';
import { LEVEL_TABLES, levelOfTier, levelRef, levelRow, usableLevel } from './levels.js';

/**
 * The help and support of data products, services and applications (0.26.0, ADR 0039 parts 4–6): their channels
 * (support_channels), the level they pick (the item's support_level_id), the guides of data products (guides) and the
 * service that supports a product (dp_products.supported_by_service_id). The kinds check the rights – a channel changes
 * with the item's edit right and is seen with its view right – and audit the change as one of their fields; this
 * module reads and writes in bulk (one statement per kind of fact and chunk of ids, never one per item).
 *
 * A product supported by a service shows that service's channels and level, marked as such, unless it names its own –
 * only to a reader who may see the service; to anyone else the service is neither shown nor named.
 */

interface ChannelRow {
  id: string;
  kind: string;
  item_id: string;
  purpose: string;
  tool: string;
  name: string;
  address: string;
  hours: string;
  note: string;
  position: number;
}

interface GuideRow {
  id: string;
  kind: string;
  item_id: string;
  title: string;
  url: string;
  position: number;
}

const CHUNK = 500;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const keyOf = (kind: string, id: string) => `${kind}:${id}`;

const channelOf = (r: ChannelRow): SupportChannel => ({
  id: r.id,
  purpose: r.purpose as SupportPurpose,
  tool: r.tool as SupportTool,
  name: r.name,
  address: r.address,
  hours: r.hours,
  note: r.note,
});

/** Rows of items of several kinds in one statement per chunk (`kind:id` → rows, in their order). */
function rowsOf<T extends { kind: string; item_id: string }>(table: string, items: { kind: string; id: string }[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const byKind = new Map<string, string[]>();
  for (const i of items) byKind.set(i.kind, [...new Set([...(byKind.get(i.kind) ?? []), i.id])]);
  const parts: { kind: string; ids: string[] }[] = [];
  for (const [kind, ids] of byKind) for (let i = 0; i < ids.length; i += CHUNK) parts.push({ kind, ids: ids.slice(i, i + CHUNK) });
  // several kinds of few ids go together (a product page: the product and its service)
  let batch: typeof parts = [];
  let size = 0;
  const flush = () => {
    if (!batch.length) return;
    const where = batch.map((p) => `(kind = ? AND item_id IN (${marks(p.ids.length)}))`).join(' OR ');
    for (const r of db().all<T>(`SELECT * FROM ${table} WHERE ${where} ORDER BY position, id`, ...batch.flatMap((p) => [p.kind, ...p.ids]))) {
      const k = keyOf(r.kind, r.item_id);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    batch = [];
    size = 0;
  };
  for (const p of parts) {
    if (size + p.ids.length > CHUNK) flush();
    batch.push(p);
    size += p.ids.length;
  }
  flush();
  return out;
}

/** The channels of items (`kind:id` → channels in their order). */
export function channelsOf(items: { kind: SupportItemKind; id: string }[]): Map<string, SupportChannel[]> {
  return new Map([...rowsOf<ChannelRow>('support_channels', items)].map(([k, rows]) => [k, rows.map(channelOf)]));
}

/** The guides of items (`kind:id` → guides in their order). */
export function guidesOf(items: { kind: SupportItemKind; id: string }[]): Map<string, Guide[]> {
  return new Map([...rowsOf<GuideRow>('guides', items)].map(([k, rows]) => [k, rows.map((r) => ({ id: r.id, title: r.title, url: r.url }))]));
}

/** The level an item picks, as it shows it (null: none, or one removed meanwhile). */
export const levelOf = (id: string | null | undefined): SupportLevelRef | null => {
  const r = levelRow(id);
  return r ? levelRef(r) : null;
};

/** The level's name for lists and the deprecated `tier` (kept list: no statement). */
export function levelSummary(id: string | null | undefined): { level: { id: string; nameEn: string; nameDe: string } | null; tier: 1 | 2 | 3 | null } {
  const r = levelRow(id);
  if (!r) return { level: null, tier: null };
  const t = r.legacy_tier;
  return { level: { id: r.id, nameEn: r.name_en, nameDe: r.name_de }, tier: t === 1 || t === 2 || t === 3 ? t : null };
}

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  support_level_id: string | null;
}

/** The services of these ids the reader may see (one statement; a hidden or missing one is left out). */
export function visibleServices(ids: (string | null | undefined)[]): Map<string, ServiceRow> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, ServiceRow>();
  for (let i = 0; i < want.length; i += CHUNK) {
    const part = want.slice(i, i + CHUNK);
    for (const r of db().all<ServiceRow>(`SELECT id, name, owners, support_level_id FROM services WHERE id IN (${marks(part.length)})`, ...part))
      if (catalogueVisibleNow('service', r)) out.set(r.id, r);
  }
  return out;
}

/**
 * The help and support of items (bulk): channels, level and – for data products – guides and the supporting service
 * the reader may see. `items` carry the stored level and service ids of the item rows the caller read already.
 */
export function supportOf(
  kind: SupportItemKind,
  items: { id: string; levelId: string | null; serviceId?: string | null }[],
  opts: { guides?: boolean } = {},
): Map<string, ItemSupport> {
  const services = kind === 'data_product' ? visibleServices(items.map((i) => i.serviceId)) : new Map<string, ServiceRow>();
  const channels = channelsOf([...items.map((i) => ({ kind, id: i.id })), ...[...services.keys()].map((id) => ({ kind: 'service' as const, id }))]);
  const guides = opts.guides ? guidesOf(items.map((i) => ({ kind, id: i.id }))) : new Map<string, Guide[]>();
  const out = new Map<string, ItemSupport>();
  for (const i of items) {
    const svc = i.serviceId ? services.get(i.serviceId) : undefined;
    const supportedBy: SupportedByService | null = svc
      ? { service: { id: svc.id, name: svc.name }, channels: channels.get(keyOf('service', svc.id)) ?? [], level: levelOf(svc.support_level_id) }
      : null;
    out.set(i.id, {
      channels: channels.get(keyOf(kind, i.id)) ?? [],
      level: levelOf(i.levelId),
      guides: guides.get(keyOf(kind, i.id)) ?? [],
      supportedBy,
    });
  }
  return out;
}

// ---------- writing ----------

const strip = (c: SupportChannel | ReturnType<typeof supportChannelInput.parse>) => ({
  purpose: c.purpose,
  tool: c.tool,
  name: c.name,
  address: c.address,
  hours: c.hours,
  note: c.note,
});
const sameList = <T>(a: T[], b: T[]) => JSON.stringify(a) === JSON.stringify(b);

export interface SupportChange {
  /** The fields that changed: supportChannels, supportLevel, guides, supportedByService */
  changes: string[];
  details: Record<string, unknown>;
}

/** What an item holds now (for comparing and the audit entry's before). */
export interface StoredSupport {
  levelId: string | null;
  serviceId?: string | null;
}

/**
 * Writes the support of one item (inside the caller's transaction; the caller checked the edit right and audits the
 * change as one of the item's fields). Keys the input leaves out keep what the item has. A level must exist; a
 * supporting service must be one the caller may see (else SERVICE_NOT_FOUND, as for a missing one).
 */
export function writeSupport(kind: SupportItemKind, id: string, cur: StoredSupport, body: unknown): SupportChange {
  const input = itemSupportInput.parse(body);
  if (kind !== 'data_product' && (input.guides !== undefined || input.supportedByServiceId !== undefined))
    throw new HttpError(400, 'Only data products have guides and a supporting service', 'SUPPORT_INVALID', { context: 'kind' });
  return writeParsed(kind, id, cur, input);
}

function writeParsed(kind: SupportItemKind, id: string, cur: StoredSupport, input: ReturnType<typeof itemSupportInput.parse>): SupportChange {
  const changes: string[] = [];
  const details: Record<string, unknown> = {};
  const actor = currentUser()?.username ?? 'system';
  const now = nowIso();
  if (input.levelId !== undefined && (input.levelId ?? null) !== (cur.levelId ?? null)) {
    const next = input.levelId ? usableLevel(input.levelId) : null;
    db().run(`UPDATE ${LEVEL_TABLES[kind]} SET support_level_id = ? WHERE id = ?`, next?.id ?? null, id);
    changes.push('supportLevel');
    details.supportLevel = { before: levelRow(cur.levelId)?.name_en ?? null, after: next?.name_en ?? null };
  }
  if (kind === 'data_product' && input.supportedByServiceId !== undefined && (input.supportedByServiceId ?? null) !== (cur.serviceId ?? null)) {
    if (input.supportedByServiceId && !visibleServices([input.supportedByServiceId]).has(input.supportedByServiceId))
      throw new HttpError(404, `Service ${input.supportedByServiceId} not found`, 'SERVICE_NOT_FOUND', { id: input.supportedByServiceId });
    db().run('UPDATE dp_products SET supported_by_service_id = ? WHERE id = ?', input.supportedByServiceId ?? null, id);
    changes.push('supportedByService');
    details.supportedByService = { after: input.supportedByServiceId ?? null };
  }
  if (input.channels !== undefined) {
    const before = channelsOf([{ kind, id }]).get(keyOf(kind, id)) ?? [];
    const next = input.channels.map(strip);
    if (!sameList(before.map(strip), next)) {
      db().run('DELETE FROM support_channels WHERE kind = ? AND item_id = ?', kind, id);
      next.forEach((c, i) =>
        db().run(
          'INSERT INTO support_channels (id, kind, item_id, purpose, tool, name, address, hours, note, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          newId('spc_'),
          kind,
          id,
          c.purpose,
          c.tool,
          c.name,
          c.address,
          c.hours,
          c.note,
          i,
          now,
          actor,
        ),
      );
      changes.push('supportChannels');
      details.supportChannels = { before: before.map(strip), after: next };
    }
  }
  if (input.guides !== undefined) {
    const before = guidesOf([{ kind, id }]).get(keyOf(kind, id)) ?? [];
    const next = input.guides.map((g) => ({ title: g.title, url: g.url }));
    if (
      !sameList(
        before.map((g) => ({ title: g.title, url: g.url })),
        next,
      )
    ) {
      db().run('DELETE FROM guides WHERE kind = ? AND item_id = ?', kind, id);
      next.forEach((g, i) =>
        db().run(
          'INSERT INTO guides (id, kind, item_id, title, url, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newId('spg_'),
          kind,
          id,
          g.title,
          g.url,
          i,
          now,
          actor,
        ),
      );
      changes.push('guides');
      details.guides = { before, after: next };
    }
  }
  return { changes, details };
}

/** Removes an item's channels and guides (the item is deleted; inside the caller's transaction). */
export function forgetSupport(kind: SupportItemKind, id: string): void {
  db().run('DELETE FROM support_channels WHERE kind = ? AND item_id = ?', kind, id);
  db().run('DELETE FROM guides WHERE kind = ? AND item_id = ?', kind, id);
}

// ---------- the deprecated fields of data products (0.26.0: support, tier) ----------

/**
 * Maps the deprecated `support` and `tier` a client sent with a data product (they stay writable for one release) the
 * way the upgrade does: `support` sets the first channel with the purpose _questions_ (tool e-mail for a `mailto:`
 * address, else what it was or other), or removes it when empty; `tier` picks the level made from that tier ("Tier n",
 * made when missing). What equals the derived value is no change, so a client that sends back what it read changes
 * nothing. Returns the change for the caller's audit entry.
 */
export function writeLegacySupport(
  id: string,
  cur: StoredSupport,
  legacy: { support?: { channel: string; url: string; hours: string }; tier?: 1 | 2 | 3 | null },
): SupportChange {
  const input: ReturnType<typeof itemSupportInput.parse> = {};
  if (legacy.support !== undefined) {
    const channels = channelsOf([{ kind: 'data_product', id }]).get(keyOf('data_product', id)) ?? [];
    const derived = legacySupportOf(channels);
    const s = legacy.support;
    if (derived.channel !== s.channel || derived.url !== s.url || derived.hours !== s.hours) {
      const at = channels.findIndex((c) => c.purpose === 'questions');
      const empty = !s.channel && !s.url && !s.hours;
      const list = channels.map(strip);
      const tool = at >= 0 && list[at]!.address === s.url ? list[at]!.tool : s.url ? toolOfAddress(s.url) : (list[at]?.tool ?? 'other');
      const next = { purpose: 'questions' as const, tool, name: s.channel, address: s.url, hours: s.hours, note: at >= 0 ? list[at]!.note : '' };
      if (empty) {
        if (at >= 0) list.splice(at, 1);
      } else if (at >= 0) list[at] = next;
      else list.unshift(next);
      input.channels = list.map((c) => supportChannelInput.parse(c));
    }
  }
  if (legacy.tier !== undefined) {
    const derived = levelSummary(cur.levelId).tier;
    if (derived !== legacy.tier) input.levelId = legacy.tier ? levelOfTier(legacy.tier).id : null;
  }
  return writeParsed('data_product', id, cur, input);
}

export type { ItemSupportInput };
