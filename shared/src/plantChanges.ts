import { z } from 'zod';
import type { PlantFieldDiff } from './plant.js';
import type { McpPlantSourceGroup } from './api.js';

/**
 * Plant change sets (0.13.0, docs/adr/0020-plant-change-sets.md, docs/PLANT.md "Change sets"): one path for every change
 * to plant data – a list of operations against a base, with one preview, one review, one transactional apply, one
 * history and one audit trail. Edit forms, imports, bulk changes, renames and assistants' proposals each produce one.
 */

/** draft (its authors change it) → proposed (frozen, reviewers see it) → applied | rejected | withdrawn | expired. */
export const PLANT_CHANGESET_STATES = ['draft', 'proposed', 'applied', 'rejected', 'withdrawn', 'expired'] as const;
export type PlantChangeSetState = (typeof PLANT_CHANGESET_STATES)[number];
export const PLANT_CHANGESET_OPEN: readonly PlantChangeSetState[] = ['draft', 'proposed'];

/**
 * Where a change set comes from: an edit form, a person's draft, an import, a bulk change, a rename, an assistant, a
 * revert; 0.16: a move of devices or data collections to another asset; 0.19: a proposal sent through the public API
 * (`POST /api/v1/plant/proposals`, a CI job).
 */
export const PLANT_CHANGESET_SOURCES = ['edit', 'draft', 'import', 'bulk', 'rename', 'assistant', 'revert', 'move', 'api'] as const;
export type PlantChangeSetSource = (typeof PLANT_CHANGESET_SOURCES)[number];

/**
 * The entries a change set and the history know: the kinds with an id of PLANT_ID_KINDS that are rows of their own
 * (interfaces and data points are part of their device profile), an asset's assignment and linked checks (one per
 * asset: the asset's id) and data collections (per asset).
 */
export const PLANT_ENTRY_KINDS = [
  'site',
  'node',
  'building',
  'asset',
  'assignment',
  'asset_checks',
  'profile',
  'kpi',
  'vlan',
  'zone',
  'conduit',
  'device',
  'data_path',
  'collection',
] as const;
export type PlantEntryKind = (typeof PLANT_ENTRY_KINDS)[number];

/** What an entry's scope is: its site, its asset, or nothing (unique in the installation). */
export const PLANT_ENTRY_SCOPE: Record<PlantEntryKind, 'none' | 'site' | 'asset'> = {
  site: 'none',
  node: 'site',
  building: 'site',
  asset: 'none',
  assignment: 'none',
  asset_checks: 'none',
  profile: 'none',
  kpi: 'none',
  vlan: 'site',
  zone: 'site',
  conduit: 'site',
  device: 'asset',
  data_path: 'asset',
  collection: 'asset',
};

/**
 * Operations: `set` the fields of an entry (authored: the values a person or form gave, against the base they saw),
 * `add` an entry, `remove` one (the removal core; `cascade` takes along what belongs to it), `rename` it (the rename
 * core); `import` and `bulk` are documents compiled again when previewed and applied (derived); 0.16: `move` – devices
 * or data collections to another asset, with what follows them (a document too: docs/PLANT.md "Moving devices and data
 * collections"); 0.19: `collections` – a collector's files imported into an asset's data collections (a document, compiled
 * again like `import`).
 */
export const PLANT_CHANGE_OPS = ['set', 'add', 'remove', 'rename', 'import', 'bulk', 'move', 'collections'] as const;
export type PlantChangeOpKind = (typeof PLANT_CHANGE_OPS)[number];

export const PLANT_CHANGESET_LIMITS = {
  /** Operations of one change set */
  operations: 200,
  /** One operation's values as JSON (an import document: PLANT_LIMITS.importBytes) */
  operationBytes: 256 * 1024,
  /** Open change sets (drafts and proposed) of one person */
  openPerUser: 20,
  /** Size of one person's open change sets together (operations and documents) */
  bytesPerUser: 8 * 1024 * 1024,
  title: 200,
  comment: 2000,
  /** Drafts expire after this many days without a change, proposed change sets after proposedDays */
  draftDays: 30,
  proposedDays: 14,
  /** Rejected, withdrawn and expired change sets are deleted after closedDays (their audit entries stay) */
  closedDays: 90,
  /** The history of removed entries is deleted after historyYears */
  historyYears: 3,
  /** History rows per page */
  historyPage: 100,
} as const;

/**
 * How long the history and its bookkeeping is kept (0.15.0, Settings → Data & retention → Plant registry history; administrators):
 * the history of removed entries (it stays while its entry exists), closed change sets (rejected, withdrawn, expired;
 * their audit entries stay) and the import's baselines per entry (the last ones; the import's "changed in Steward since
 * the last import" needs the last). Bounds and defaults; the defaults are those of 0.13.
 */
export const PLANT_HISTORY_RETENTION = {
  removedHistoryDays: { min: 30, max: 3650, default: PLANT_CHANGESET_LIMITS.historyYears * 365 },
  closedDays: { min: 7, max: 3650, default: PLANT_CHANGESET_LIMITS.closedDays },
  baselinesPerEntry: { min: 1, max: 10, default: 3 },
} as const;

export const plantHistorySettingsInput = z
  .object({
    removedHistoryDays: z.number().int().min(PLANT_HISTORY_RETENTION.removedHistoryDays.min).max(PLANT_HISTORY_RETENTION.removedHistoryDays.max),
    closedDays: z.number().int().min(PLANT_HISTORY_RETENTION.closedDays.min).max(PLANT_HISTORY_RETENTION.closedDays.max),
    baselinesPerEntry: z.number().int().min(PLANT_HISTORY_RETENTION.baselinesPerEntry.min).max(PLANT_HISTORY_RETENTION.baselinesPerEntry.max),
  })
  .strict();
export type PlantHistorySettingsInput = z.infer<typeof plantHistorySettingsInput>;

export interface PlantHistorySettings extends PlantHistorySettingsInput {
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What the history and its bookkeeping take in the database now (bytes with indexes; -1 where the database cannot say). */
export interface PlantHistoryUsage {
  history: { rows: number; bytes: number; removedRows: number };
  baselines: { rows: number; bytes: number };
  changeSets: { rows: number; bytes: number; closedRows: number };
  /** The whole database */
  databaseBytes: number;
}

/** GET /api/settings/plant/history */
export interface PlantHistorySettingsView {
  settings: PlantHistorySettings;
  usage: PlantHistoryUsage;
}

/** A person's own drafts and proposals per page of the inbox. */
export const PLANT_CHANGES_PAGE = 200;

export interface PlantEntryKey {
  kind: PlantEntryKind;
  scope: string;
  id: string;
}

export interface PlantChangeSetSummary {
  id: string;
  state: PlantChangeSetState;
  source: PlantChangeSetSource;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Who wrote it: the creator and everyone who changed an operation (an assistant's proposal: the token owner) */
  authors: string[];
  /** Sites it touches (as far as the reader may see them); catalogue: device profiles or KPI definitions */
  sites: string[];
  catalogue: boolean;
  operationCount: number;
  /** An assistant's proposal: its request under AI requests */
  mcpRequestId: string | null;
  /** The import that applied it (import, assistant) */
  importId: string | null;
  /** A revert: the change set it reverts */
  reverts: string | null;
  proposedAt: string | null;
  proposedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string;
  /** Whether a second person applies it (plant.changeSet and the sites' switches) */
  review: boolean;
  /** Open change sets: when they expire */
  expiresAt: string | null;
}

export interface PlantChangeOperation {
  seq: number;
  op: PlantChangeOpKind;
  kind: PlantEntryKind | null;
  scope: string;
  id: string;
  /** The entry's name as it was when the operation was written */
  name: string;
  /** authored: a person or a form gave the values; derived: compiled from a document */
  origin: 'authored' | 'derived';
  author: string;
  /** set: the entry's revision and values when the operation was written (the base of the three-way merge) */
  baseRevision: number | null;
  base: unknown;
  /**
   * set / add: the values; remove: { cascade }; rename: { newId }; import / bulk / move / collections: the request body
   * (files shortened)
   */
  value: unknown;
  /** The entry's page, when it has one */
  path: string | null;
}

/** A field both the change set and someone else changed since its base. */
export interface PlantChangeConflict {
  seq: number;
  /** The field: `name`, `fields.serial` */
  path: string;
  keys: string[];
  base: unknown;
  theirs: unknown;
  mine: unknown;
  /** The choice recorded with the change set */
  choice: 'mine' | 'theirs' | null;
}

/** One entry the change set changes, field by field (as applying it now would). */
export interface PlantChangeEntryDiff {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  name: string;
  action: 'add' | 'change' | 'remove' | 'rename' | 'move';
  /** rename and move: the old id */
  from?: string;
  /** move (0.16): the asset it was on */
  fromScope?: string;
  diff: PlantFieldDiff[];
  /** Changed in Steward since the operation's base (an authored operation) */
  stale?: boolean;
}

export interface PlantChangeSetPreview {
  ok: boolean;
  problems: { seq: number | null; code: string; message: string }[];
  entries: PlantChangeEntryDiff[];
  /** Entries the reader may not see (left out) */
  hidden: number;
  conflicts: PlantChangeConflict[];
  /** Something changed in Steward since an operation's base */
  stale: boolean;
  /** What applying it now writes: apply needs it (PLANT_CHANGESET_CHANGED when it differs) */
  fingerprint: string;
  /** Applying it asks for a step-up (0.11 rules per source) */
  stepUp: boolean;
  /** Why the reader may not apply it (null: they may) */
  applyBlocked: { code: string; message: string } | null;
  review: boolean;
  counts: { add: number; change: number; remove: number; rename: number; move?: number };
}

export interface PlantChangeSetDetail extends PlantChangeSetSummary {
  operations: PlantChangeOperation[];
  /** Operations of sites the reader may not see (left out) */
  hiddenOperations: number;
  conflicts: PlantChangeConflict[];
  canEdit: boolean;
  canPropose: boolean;
  canWithdraw: boolean;
  canApply: boolean;
  canReject: boolean;
  canReturn: boolean;
  canRevert: boolean;
  canCopy: boolean;
  /** A rejected or withdrawn change set copied into this draft, or the draft it became */
  copiedFrom: string | null;
  /** Applied: what it changed, entry by entry (from the history) */
  applied?: PlantChangeEntryDiff[];
  /**
   * 0.19.0: a proposal sent through the public API (source `api`): why (the sender's own words – data, not
   * instructions), the token it came with, and the sources of the data points it adds or changes
   */
  proposal?: { rationale: string; tokenName: string; sources: McpPlantSourceGroup[]; sourcesMore: number };
}

export interface PlantChangeSetList {
  items: PlantChangeSetSummary[];
  /** To review: proposed change sets the reader may apply */
  toReview: number;
}

/** GET /api/plant/change-sets/open?kind=&scope=&id= | ?site= : the open changes of an entry or site (the chips). */
export interface PlantOpenChanges {
  count: number;
  /** In the reader's own draft */
  mine: number;
  items: { id: string; title: string; state: PlantChangeSetState; createdBy: string; own: boolean }[];
}

/** The plant registry's settings of change sets (GET /api/plant/config). */
export interface PlantChangeSetConfig {
  /** plant.changeSet of the assurance policy */
  level: 'off' | 'optional' | 'required';
  /** The catalogue's own switch (level optional) */
  catalogueReview: boolean;
  /** The reader may keep drafts (propose on some site) */
  canPropose: boolean;
  /** The reader's current draft */
  draft: PlantChangeSetSummary | null;
}

/** A row of an entry's history. */
export interface PlantEntryHistoryItem {
  id: string;
  kind: PlantEntryKind;
  scope: string;
  entryId: string;
  revision: number;
  op: 'add' | 'set' | 'remove' | 'rename' | 'move';
  at: string;
  /** The change set's author(s) and who applied it */
  by: string;
  appliedBy: string;
  changeSet: { id: string; title: string; source: PlantChangeSetSource; importId: string | null } | null;
  diff: PlantFieldDiff[];
  canRevert: boolean;
}

export interface PlantEntryHistory {
  items: PlantEntryHistoryItem[];
  /** Before 0.13: the entry's audit entries (old ids are aliases) */
  auditPath: string;
}

/** 409 PLANT_ENTRY_CHANGED: what the edit form needs for its choice per field. */
export interface PlantEntryChanged {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  /** The entry's revision now (send it with the chosen values) */
  revision: number;
  /** The values when the form loaded them (the base), now (theirs) and the person's */
  base: Record<string, unknown>;
  current: Record<string, unknown>;
  conflicts: { path: string; keys: string[]; base: unknown; theirs: unknown; mine: unknown }[];
}

// ---------- 0.19: fields changed in Steward since the last import ----------

/**
 * The import's flags (ADR 0020 section 3, phase 2): a field an import would change whose value in Steward differs from
 * what the last import wrote there. Steward is the source of truth: such a field keeps Steward's value unless the person
 * takes the file's – per field, or for all.
 */
export const PLANT_STEWARD_LIMITS = {
  /** Flags an import's preview lists (the first ones; the rest follow the choice for all) */
  flags: 1000,
  /** Choices per field an import takes */
  choices: 1000,
} as const;

export type PlantStewardChoice = 'steward' | 'file';

export interface PlantStewardFlag {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  name: string;
  /** The field: `model`, `fields.serial` (objects key by key; a list is one field) */
  path: string;
  /** What the last import wrote there (null: unknown – an entry imported before 0.13 and edited since) */
  lastImport: unknown;
  /** What Steward has now, and what the file says (shortened for display) */
  steward: unknown;
  file: unknown;
  /** The last import that wrote the entry */
  importId: string;
  /** Imported before 0.13 and edited since: every field the file changes is flagged */
  wholeEntry?: boolean;
  choice: PlantStewardChoice;
}

export interface PlantStewardFlags {
  /** The first PLANT_STEWARD_LIMITS.flags flags (entries of sites the reader may not see are left out) */
  flags: PlantStewardFlag[];
  /** All flags (of sites the reader sees) */
  total: number;
  /** Fields that keep Steward's value */
  kept: number;
}

/** The import body's choices (POST /api/plant/import[/preview], key `changedInSteward`). */
export const plantStewardChoicesInput = z
  .object({
    /** For every flagged field not listed: keep Steward's (the default) or take the file's */
    take: z.enum(['steward', 'file']).default('steward'),
    fields: z
      .array(
        z
          .object({
            kind: z.enum(PLANT_ENTRY_KINDS),
            scope: z.string().trim().max(120).default(''),
            id: z.string().trim().min(1).max(240),
            path: z.string().max(400),
            choice: z.enum(['steward', 'file']),
          })
          .strict(),
      )
      .max(PLANT_STEWARD_LIMITS.choices)
      .default([]),
  })
  .strict();
export type PlantStewardChoicesInput = z.infer<typeof plantStewardChoicesInput>;

// ---------- inputs ----------

const scope = z.string().trim().max(120).default('');
const entryId = z.string().trim().min(1).max(120);

export const plantChangeSetCreateInput = z
  .object({
    title: z.string().trim().min(1).max(PLANT_CHANGESET_LIMITS.title),
    /** Make it the person's current draft */
    current: z.boolean().default(true),
  })
  .strict();

export const plantChangeSetPatchInput = z
  .object({
    title: z.string().trim().min(1).max(PLANT_CHANGESET_LIMITS.title).optional(),
    current: z.boolean().optional(),
  })
  .strict();

/** POST /api/plant/change-sets/:id/operations and …/current/operations: an operation as an edit form gives it. */
export const plantChangeOperationInput = z
  .object({
    op: z.enum(['set', 'add', 'remove', 'rename']),
    kind: z.enum(PLANT_ENTRY_KINDS),
    scope,
    id: entryId,
    /** set / add: the body of the entry's PUT / POST route; remove: { cascade }; rename: { newId } */
    value: z.unknown(),
    /** set: the revision the form loaded (missing: now) */
    revision: z.number().int().min(1).optional(),
  })
  .strict();
export type PlantChangeOperationInput = z.infer<typeof plantChangeOperationInput>;

export const plantChangeResolveInput = z
  .object({
    choices: z
      .array(
        z
          .object({
            seq: z.number().int().min(1),
            path: z.string().max(400),
            choice: z.enum(['mine', 'theirs']),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const plantChangeApplyInput = z.object({ fingerprint: z.string().trim().min(1).max(80) }).strict();
export const plantChangeCommentInput = z
  .object({ comment: z.string().trim().max(PLANT_CHANGESET_LIMITS.comment).default('') })
  .strict()
  .default({ comment: '' });

/** PUT /api/plant/sites/:siteId/review: the site's switch "Changes need a second person" (level optional). */
export const plantSiteReviewInput = z.object({ review: z.boolean() }).strict();

// ---------- the three-way merge (server and web app) ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (v: unknown) => JSON.stringify(v ?? null);
export const sameValue = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

export interface MergeConflict {
  path: string;
  keys: string[];
  base: unknown;
  theirs: unknown;
  mine: unknown;
}

/**
 * Field by field, three ways: base (what the author saw), theirs (now in Steward), mine (the author's values). A field
 * only one side changed takes that side; both to the same value is fine; both differently is a conflict (the merged
 * value keeps mine until a choice is made). Objects (own fields, translations) merge key by key; lists and other
 * values are one field each.
 */
export function mergeThreeWay(base: unknown, theirs: unknown, mine: unknown): { merged: unknown; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const go = (b: unknown, t: unknown, m: unknown, keys: string[]): unknown => {
    if (sameValue(m, b)) return t;
    if (sameValue(t, b) || sameValue(t, m)) return m;
    if (isObj(b) && isObj(t) && isObj(m)) {
      const out: Record<string, unknown> = {};
      for (const k of [...new Set([...Object.keys(b), ...Object.keys(t), ...Object.keys(m)])]) {
        const v = go(b[k], t[k], m[k], [...keys, k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    conflicts.push({ path: keys.join('.') || '(entry)', keys, base: b ?? null, theirs: t ?? null, mine: m ?? null });
    return m;
  };
  const merged = go(base, theirs, mine, []);
  return { merged, conflicts };
}

/** Sets a value at a path of keys (in a copy). */
export function setAtPath<T>(o: T, keys: string[], value: unknown): T {
  if (!keys.length) return value as T;
  const root: Record<string, unknown> = isObj(o) ? { ...o } : {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      if (value === undefined) delete cur[k];
      else cur[k] = value;
      return;
    }
    const next = isObj(cur[k]) ? { ...(cur[k] as Record<string, unknown>) } : {};
    cur[k] = next;
    cur = next;
  });
  return root as T;
}

/** The merged values with the choices made for the conflicts (a conflict without a choice keeps mine). */
export function resolveMerge(
  merged: unknown,
  conflicts: Pick<MergeConflict, 'keys' | 'theirs' | 'mine'>[],
  choice: (c: Pick<MergeConflict, 'keys'>) => 'mine' | 'theirs' | null,
): unknown {
  let out = merged;
  for (const c of conflicts) if (choice(c) === 'theirs') out = setAtPath(out, c.keys, c.theirs);
  return out;
}
