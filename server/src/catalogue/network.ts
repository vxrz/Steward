import { z } from 'zod';
import {
  boundedRecord,
  EMPTY_NETWORK_ATTRIBUTES,
  FIREWALL_MANAGERS,
  NETWORK_LIMITS,
  isCidr,
  isNetworkAddress,
  type NetworkAttributes,
  type SegmentMember,
  type SystemAttributes,
  type SystemKind,
  type SystemSegmentLink,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { forbid, me, canViewCatalogue, canEditService } from '../records/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

/**
 * Network context of systems (#208), opt-in: the attributes of a network segment (a system of kind "network") and
 * the segments a system is in, with its address there. Format checks only – Steward is no IP address management.
 *
 * Rights follow the systems (auth/policy.ts through canViewCatalogue / canEditService): who may change a system
 * changes its segments; a segment or member the reader may not see is left out.
 */

// ---------- attributes ----------

const trimmed = (max: number) => z.string().trim().max(max).default('');

export const networkAttributesInput = z
  .object({
    vlanId: z.number().int().min(1, 'A VLAN ID is 1–4094').max(4094, 'A VLAN ID is 1–4094').nullable().default(null),
    subnets: z
      .array(z.string().trim().min(1).max(50).refine(isCidr, 'Use CIDR notation, e.g. 10.20.30.0/24 or 2001:db8::/48'))
      .max(NETWORK_LIMITS.subnets)
      .default([]),
    zone: trimmed(NETWORK_LIMITS.zone),
    site: trimmed(NETWORK_LIMITS.site),
    firewallManagedBy: z.enum(FIREWALL_MANAGERS).nullable().default(null),
    firewallProvider: trimmed(NETWORK_LIMITS.provider),
  })
  .strict();

/** Attributes as given (validated by the kind on save): an object, at most a few keys. */
export const attributesInput = boundedRecord(z.unknown(), 20);

/**
 * The attributes stored for a kind: a network segment's checked attributes (subnets once each, a provider only when
 * a provider manages the firewall), {} for every other kind – other kinds have none, so giving some is refused.
 */
export function attributesFor(kind: SystemKind, input: Record<string, unknown> | undefined, current: SystemAttributes | null): SystemAttributes {
  if (kind !== 'network') {
    if (input && Object.keys(input).length) throw new HttpError(400, `Systems of kind ${kind} have no attributes`, 'SYSTEM_ATTRIBUTES_KIND', { kind });
    return {};
  }
  // missing: unchanged (a system that was a segment before keeps its attributes)
  const source = input ?? (current && 'subnets' in current ? current : {});
  const parsed = networkAttributesInput.safeParse(source);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path[0] ?? 'attributes');
    throw new HttpError(400, `Network segment: ${field} – ${issue.message}`, 'SYSTEM_ATTRIBUTE_INVALID', { field, message: issue.message });
  }
  const a = parsed.data;
  const subnets: string[] = [];
  for (const s of a.subnets) if (!subnets.some((x) => x.toLowerCase() === s.toLowerCase())) subnets.push(s);
  return { ...a, subnets, firewallProvider: a.firewallManagedBy === 'provider' ? a.firewallProvider : '' };
}

/** Stored attributes as the API shows them: a segment always has every key. */
export function attributesOf(kind: string, stored: string | null | undefined): SystemAttributes {
  if (kind !== 'network') return {};
  return { ...EMPTY_NETWORK_ATTRIBUTES, ...parseJson<Partial<NetworkAttributes>>(stored ?? '{}', {}) };
}

/** Attribute keys whose value differs (for the audit entry). */
export function changedAttributes(before: SystemAttributes, after: SystemAttributes): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k as keyof SystemAttributes]) !== JSON.stringify(after[k as keyof SystemAttributes])).sort();
}

// ---------- systems in segments ----------

interface SegmentRow {
  id: string;
  system_id: string;
  segment_id: string;
  address: string;
  note: string;
  created_at: string;
  created_by: string;
}

type SystemRef = { id: string; name: string; kind: string; owners: string; attributes: string };

const address = z
  .string()
  .trim()
  .max(NETWORK_LIMITS.address)
  .refine((s) => !s || isNetworkAddress(s), 'Use an IP address (IPv4 or IPv6) or a host name')
  .default('');

export const segmentLinkInput = z
  .object({
    segmentId: z.string().trim().min(1).max(100),
    address,
    note: z.string().trim().max(NETWORK_LIMITS.note).default(''),
  })
  .strict();
export const segmentLinkUpdate = segmentLinkInput.omit({ segmentId: true });

const visible = (u: AuthUser | null, s: Pick<SystemRef, 'id' | 'owners'>) =>
  !u || canViewCatalogue(u, { kind: 'system', id: s.id, owners: parseJson<string[]>(s.owners, []) });

/** The segments a system is in (the ones the reader may see). */
export function segmentsOf(systemId: string): SystemSegmentLink[] {
  const u = currentUser();
  return db()
    .all<SegmentRow & { name: string; owners: string; attributes: string }>(
      `SELECT l.*, s.name, s.owners, s.attributes FROM system_segments l JOIN systems s ON s.id = l.segment_id WHERE l.system_id = ? ORDER BY s.name`,
      systemId,
    )
    .filter((r) => visible(u, { id: r.segment_id, owners: r.owners }))
    .map((r) => {
      const a = attributesOf('network', r.attributes);
      return {
        id: r.id,
        segmentId: r.segment_id,
        segmentName: r.name,
        vlanId: a.vlanId ?? null,
        subnets: a.subnets ?? [],
        zone: a.zone ?? '',
        address: r.address,
        note: r.note,
        createdAt: r.created_at,
        createdBy: r.created_by,
      };
    });
}

/** The systems in a segment (the ones the reader may see). */
export function membersOf(segmentId: string): SegmentMember[] {
  const u = currentUser();
  return db()
    .all<SegmentRow & { name: string; kind: string; owners: string }>(
      `SELECT l.*, s.name, s.kind, s.owners FROM system_segments l JOIN systems s ON s.id = l.system_id WHERE l.segment_id = ? ORDER BY s.name`,
      segmentId,
    )
    .filter((r) => visible(u, { id: r.system_id, owners: r.owners }))
    .map((r) => ({ linkId: r.id, systemId: r.system_id, name: r.name, kind: r.kind, address: r.address, note: r.note }));
}

function systemRef(id: string, asSegment = false): SystemRef {
  const r = db().get<SystemRef>('SELECT id, name, kind, owners, attributes FROM systems WHERE id = ?', id);
  if (!r || !visible(currentUser(), r)) {
    if (asSegment) throw new HttpError(404, `Network segment ${id} not found`, 'SEGMENT_NOT_FOUND', { id });
    throw new HttpError(404, `System ${id} not found`, 'SYSTEM_NOT_FOUND', { id });
  }
  return r;
}

/** The system, when the user may change it (its network context is part of it). */
function editableSystem(id: string): SystemRef {
  const s = systemRef(id);
  if (!canEditService(currentUser(), { kind: 'system', id: s.id, owners: parseJson<string[]>(s.owners, []) })) forbid('change this system', 'changeSystem');
  return s;
}

function linkRow(systemId: string, linkId: string): SegmentRow {
  const l = db().get<SegmentRow>('SELECT * FROM system_segments WHERE id = ? AND system_id = ?', linkId, systemId);
  if (!l) throw new HttpError(404, 'The system is not in this segment', 'SEGMENT_LINK_NOT_FOUND', { id: linkId });
  return l;
}

const touch = (id: string, u: AuthUser) => db().run('UPDATE systems SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

/** Puts a system into a segment (a system of kind "network" the user may see, not the system itself). */
export function addToSegment(systemId: string, input: z.infer<typeof segmentLinkInput>): SystemSegmentLink[] {
  const u = me();
  const s = editableSystem(systemId);
  // the segment only needs to be visible: being in it changes the system, not the segment
  const seg = systemRef(input.segmentId, true);
  if (seg.kind !== 'network') throw new HttpError(400, `"${seg.name}" is not a network segment`, 'NOT_A_SEGMENT', { name: seg.name });
  if (seg.id === s.id) throw new HttpError(400, 'A segment cannot be in itself', 'SEGMENT_SELF');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM system_segments WHERE system_id = ?', s.id)?.n ?? 0);
  if (n >= NETWORK_LIMITS.segmentsPerSystem)
    throw new HttpError(409, `A system is in at most ${NETWORK_LIMITS.segmentsPerSystem} segments`, 'SEGMENT_LINK_LIMIT', {
      max: NETWORK_LIMITS.segmentsPerSystem,
    });
  if (db().get('SELECT 1 FROM system_segments WHERE system_id = ? AND segment_id = ?', s.id, seg.id))
    throw new HttpError(409, `"${s.name}" is in "${seg.name}" already`, 'SEGMENT_LINK_EXISTS', { name: seg.name });
  const id = newId('ssg_');
  db().tx(() => {
    db().run(
      'INSERT INTO system_segments (id, system_id, segment_id, address, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      s.id,
      seg.id,
      input.address,
      input.note,
      nowIso(),
      u.username,
    );
    touch(s.id, u);
    audit({
      action: 'system.segment_added',
      entityType: 'system',
      entityId: s.id,
      summary: `System "${s.name}" is in network segment "${seg.name}"${input.address ? ` (${input.address})` : ''}`,
      details: { linkId: id, segmentId: seg.id, segment: seg.name, address: input.address, note: input.note },
    });
  });
  return segmentsOf(s.id);
}

export function updateSegmentLink(systemId: string, linkId: string, input: z.infer<typeof segmentLinkUpdate>): SystemSegmentLink[] {
  const u = me();
  const s = editableSystem(systemId);
  const cur = linkRow(s.id, linkId);
  if (cur.address === input.address && cur.note === input.note) return segmentsOf(s.id);
  const seg = db().get<{ name: string }>('SELECT name FROM systems WHERE id = ?', cur.segment_id);
  db().tx(() => {
    db().run('UPDATE system_segments SET address = ?, note = ? WHERE id = ?', input.address, input.note, linkId);
    touch(s.id, u);
    audit({
      action: 'system.segment_changed',
      entityType: 'system',
      entityId: s.id,
      summary: `System "${s.name}" in network segment "${seg?.name ?? cur.segment_id}": ${cur.address || '–'} → ${input.address || '–'}`,
      details: { linkId, segmentId: cur.segment_id, address: { old: cur.address, new: input.address }, note: { old: cur.note, new: input.note } },
    });
  });
  return segmentsOf(s.id);
}

export function removeFromSegment(systemId: string, linkId: string): SystemSegmentLink[] {
  const u = me();
  const s = editableSystem(systemId);
  const cur = linkRow(s.id, linkId);
  const seg = db().get<{ name: string }>('SELECT name FROM systems WHERE id = ?', cur.segment_id);
  db().tx(() => {
    db().run('DELETE FROM system_segments WHERE id = ?', linkId);
    touch(s.id, u);
    audit({
      action: 'system.segment_removed',
      entityType: 'system',
      entityId: s.id,
      summary: `System "${s.name}" is no longer in network segment "${seg?.name ?? cur.segment_id}"`,
      details: { linkId, segmentId: cur.segment_id, segment: seg?.name ?? null, address: cur.address },
    });
  });
  return segmentsOf(s.id);
}

/** Systems in a segment, counted for deleting it (all of them, also those the reader may not see). */
export const memberCount = (segmentId: string): number =>
  Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM system_segments WHERE segment_id = ?', segmentId)?.n ?? 0);

/** The segment links of a system that is deleted (in the caller's transaction). */
export function forgetSegments(systemId: string): SegmentRow[] {
  const rows = db().all<SegmentRow>('SELECT * FROM system_segments WHERE system_id = ?', systemId);
  db().run('DELETE FROM system_segments WHERE system_id = ?', systemId);
  return rows;
}
