import { z } from 'zod';
import type { PlantChangeEntryDiff } from './plantChanges.js';
import type { PlantReferenceCount } from './plantIds.js';

/**
 * Moving entries between assets (0.16, docs/PLANT.md "Moving devices and data collections"): devices to another asset
 * (one, or several selected) with their data paths and – when chosen – the data collections of those paths, and a data
 * collection on its own. A move keeps each entry's id under its new asset (`<asset>/<device>`); where the id is taken
 * there, the move names a new one. References follow through the rename core's registry (REFERENCES); a move is a
 * change set of its own (op `move`, ADR 0020).
 */

export const PLANT_MOVE_KINDS = ['device', 'collection'] as const;
export type PlantMoveKind = (typeof PLANT_MOVE_KINDS)[number];

/** What moves along, and what a move may give a new id. */
export const PLANT_MOVED_KINDS = ['device', 'data_path', 'collection'] as const;
export type PlantMovedKind = (typeof PLANT_MOVED_KINDS)[number];

/**
 * The data collections of the data paths that move with their devices: `leave` (the default) keeps them on their asset
 * and takes their link to the data path off – their items are mapped to that asset's model; `move` takes them along.
 */
export const PLANT_MOVE_COLLECTIONS = ['leave', 'move'] as const;
export type PlantMoveCollections = (typeof PLANT_MOVE_COLLECTIONS)[number];

export const PLANT_MOVE = {
  /** Entries chosen in one move */
  maxItems: 200,
  /** More than this many chosen entries ask for a step-up (plant.bulkChange), as an edit of many */
  stepUp: 25,
} as const;

const id = z.string().trim().min(1).max(120);

/** POST /api/plant/move[/preview] and the change set operation `move`. */
export const plantMoveInput = z
  .object({
    kind: z.enum(PLANT_MOVE_KINDS),
    /** The devices (or collections) to move: their asset and id */
    items: z
      .array(z.object({ asset: id, id }).strict())
      .min(1)
      .max(PLANT_MOVE.maxItems),
    toAsset: id,
    collections: z.enum(PLANT_MOVE_COLLECTIONS).default('leave'),
    /** New ids for entries whose id is taken on the target asset (or that should get one) */
    ids: z
      .array(z.object({ kind: z.enum(PLANT_MOVED_KINDS), asset: id, id, newId: id }).strict())
      .max(PLANT_MOVE.maxItems * 3)
      .default([]),
    /** The preview's fingerprint – a different result is refused (PLANT_MOVE_CHANGED); without it applies as before */
    fingerprint: z.string().trim().max(80).optional(),
  })
  .strict();
export type PlantMoveInput = z.infer<typeof plantMoveInput>;

/** One entry a move takes to the target asset. */
export interface PlantMoveEntry {
  kind: PlantMovedKind;
  /** Its asset now, its id and name */
  asset: string;
  id: string;
  name: string;
  /** Its id under the target asset */
  newId: string;
  /** chosen: one of the items; follows: a data path of moved devices, or a collection of such a path */
  why: 'chosen' | 'follows';
  /** The id is taken on the target asset (or by another entry of the move): give a new one */
  taken: boolean;
  /** A free id to suggest when it is taken */
  suggested: string | null;
  /** A device moved to another site leaves its VLAN (and so its zones): the VLAN it had */
  leavesVlan: string | null;
  /** A data collection moved without its data path loses the link to it: the data path it had */
  leavesDataPath: string | null;
}

/** POST /api/plant/move/preview */
export interface PlantMovePreview {
  kind: PlantMoveKind;
  toAsset: { id: string; name: string; siteId: string };
  /** The target asset is on another site than (some of) the entries */
  crossSite: boolean;
  /** Applied (POST /api/plant/move); a preview: false */
  applied: boolean;
  entries: PlantMoveEntry[];
  /** Data collections that stay on their asset and lose the link to their data path */
  unlinked: { asset: string; id: string; name: string; dataPath: string }[];
  /** What follows besides the entries (maintenance windows, links, history …), counted */
  references: PlantReferenceCount[];
  /** `max`: the limit a PLANT_LIMIT problem is about */
  problems: { code: string; message: string; kind?: PlantMovedKind; asset?: string; id?: string; max?: number }[];
  ok: boolean;
  /** Applying it asks for a step-up */
  stepUp: boolean;
  /** What applying writes, field by field (the change set's preview) */
  changes: PlantChangeEntryDiff[];
  fingerprint: string;
}

/** POST /api/plant/assets/:assetId/devices/:deviceId/duplicate: a copy of the device on this or another asset. */
export const plantDuplicateDeviceInput = z
  .object({
    toAsset: id,
    id,
  })
  .strict();
export type PlantDuplicateDeviceInput = z.infer<typeof plantDuplicateDeviceInput>;

/**
 * The fields a duplicate of a device leaves empty: what identifies the original on the network or as hardware (its
 * host name, address, MAC address, serial number, switch port, wall outlet, CMDB port) and what watches it (its checks
 * and monitoring). Its VLAN stays on the same site and is left empty on another.
 */
export const DEVICE_DUPLICATE_CLEARED = ['hostname', 'address', 'mac', 'serial', 'switchPort', 'wallOutlet', 'cmdbPort', 'monitoring', 'checks'] as const;
