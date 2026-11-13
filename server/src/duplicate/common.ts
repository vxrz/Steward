/**
 * Duplicating things (0.4.0): the rules every kind follows (shared/src/duplicate.ts).
 *
 * Each kind brings a Duplicator (server/src/duplicate/kinds.ts): how to read the original as the caller may see it,
 * who may create the kind, and how a copy is made from it with the kind's own create function – so a copy is
 * validated exactly like something new. This module does what is the same for all: input, suggested names and
 * keys, the "copy access settings" right, where the copy came from and the audit entry.
 */
import { z } from 'zod';
import {
  DUPLICATE_OPTIONS,
  type CopiedFrom,
  type DuplicateKind,
  type DuplicateOption,
  type DuplicateResult,
  type DuplicateSuggestion,
  type OwnedKind,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, nowIso } from '../util.js';
import { me, forbid } from '../auth/access.js';
import { owningTeams, setOwningTeams } from '../auth/policy.js';
import { copyShares } from '../auth/shares.js';
import { getUser } from '../auth/users.js';
import { getSettings } from '../settings.js';
import { resolveLocale, t } from '../i18n/index.js';

/** The body of every duplicate endpoint (each kind accepts only what applies to it). */
export const duplicateInput = z
  .object({
    /** The copy's name (default: the suggestion) */
    name: z.string().trim().min(1).max(200).optional(),
    /** The copy's key or id (default: the suggestion), for kinds that have one */
    key: z.string().trim().min(1).max(120).optional(),
    /** Copy the original's access list and owning teams (only for who may manage the original) */
    copyAccess: z.boolean().default(false),
    /** What to copy along (applications and services; default: all of them) */
    options: z.array(z.enum(DUPLICATE_OPTIONS)).max(DUPLICATE_OPTIONS.length).optional(),
    /** Monitors: save as a template, with these fields as parameters */
    template: z
      .object({
        parameters: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(64),
                label: z.string().trim().max(120).optional(),
                fields: z
                  .array(z.object({ checkId: z.string().min(1).max(200), field: z.string().min(1).max(64) }).strict())
                  .min(1)
                  .max(100),
              })
              .strict(),
          )
          .max(30),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DuplicateInput = z.infer<typeof duplicateInput>;

/** The original, as the caller sees it. */
export interface DuplicateSource<R = unknown> {
  id: string;
  name: string;
  /** The original's key or id the copy's key is suggested from (null: the kind has none to choose) */
  key: string | null;
  /** The caller may manage the original: its access settings may be copied */
  mayManage: boolean;
  /** The original as read for the caller */
  data: R;
}

/** What a kind's duplicate step returns: the copy, and what goes into the audit entry. */
export interface MadeCopy {
  id: string;
  name: string;
  key: string | null;
  skipped?: { what: string; count: number }[];
  secrets?: DuplicateResult['secrets'];
  details?: Record<string, unknown>;
}

export interface Duplicator<R = unknown> {
  kind: DuplicateKind;
  /** The audit log's entity type (`<entityType>.duplicated`) */
  entityType: string;
  /** For the audit summary: "Monitor", "Process" … */
  label: string;
  /** The kind has an access list or owning teams (the "copy access settings" checkbox) */
  accessApplies: boolean;
  /** Copies start disabled (schedules, report schedules, maintenance windows, access checks) */
  startsDisabled?: boolean;
  /** The options this kind takes (applications and services) */
  options?: readonly DuplicateOption[];
  /** The original as the caller may see it; 404 otherwise */
  view(id: string): DuplicateSource<R>;
  /** The caller may create this kind (from this original: a schedule needs the run right on its process …) */
  mayCreate(src: DuplicateSource<R>): boolean;
  /** Is this name or key taken (used for the suggestion and checked before saving) */
  nameTaken?(name: string): boolean;
  keyTaken?(key: string): boolean;
  /** Longest key the kind accepts */
  keyMax?: number;
  /** How many things each option would copy */
  optionCounts?(src: DuplicateSource<R>): { option: DuplicateOption; count: number }[];
  /** The copy is a template (monitors) */
  allowsTemplate?: boolean;
  /** Make the copy: in one transaction with the audit entry, unless the kind's create function is asynchronous */
  copy(src: DuplicateSource<R>, input: CopyInput): MadeCopy | Promise<MadeCopy>;
  /** `copy` returns a promise (monitors validate templates asynchronously) */
  async?: boolean;
  /** The copy's page and editor in the web app */
  paths(id: string): { path: string; editPath: string | null };
}

/** What a kind's copy step gets: the input with the name and key settled. */
export interface CopyInput extends Omit<DuplicateInput, 'name' | 'key' | 'options'> {
  name: string;
  key: string | null;
  options: DuplicateOption[];
}

// ---------- names and keys ----------

/** The caller's language for the suggested name ("… (copy)" / "… (Kopie)"). */
function callerLocale(lang?: string) {
  try {
    return resolveLocale(lang, getUser(me().id).locale, getSettings().defaultLocale);
  } catch {
    return resolveLocale(lang);
  }
}

/** "Name (copy)", then "Name (copy 2)" … – the first one that is free. */
export function copyName(name: string, taken: (n: string) => boolean = () => false, opts: { max?: number; lang?: string } = {}): string {
  const max = opts.max ?? 200;
  const locale = callerLocale(opts.lang);
  for (let i = 1; i < 1000; i++) {
    const text = (stem: string) => (i === 1 ? t(locale, 'duplicate.copyName', { name: stem }) : t(locale, 'duplicate.copyNameN', { name: stem, n: i }));
    const over = text('').length;
    const candidate = text(name.length + over > max ? name.slice(0, Math.max(1, max - over)).trimEnd() : name);
    if (!taken(candidate)) return candidate;
  }
  throw new HttpError(409, 'No free name found for the copy – enter one', 'DUPLICATE_NAME_TAKEN', { name });
}

/** "key-copy", then "key-copy-2" … – the first one that is free (keys keep their own character rules). */
export function copyKey(key: string, taken: (k: string) => boolean, max = 64): string {
  const base = key.replace(/-copy(-\d+)?$/, '');
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? '-copy' : `-copy-${i}`;
    const candidate = base.slice(0, max - suffix.length).replace(/[-_.]+$/, '') + suffix;
    if (!taken(candidate)) return candidate;
  }
  throw new HttpError(409, 'No free key found for the copy – enter one', 'DUPLICATE_KEY_TAKEN', { key });
}

// ---------- access settings ----------

/** The owning teams of the original become the copy's (instead of the creator's default teams). */
export function copyOwningTeams(kind: OwnedKind, fromId: string, toId: string): string[] {
  const teams = owningTeams(kind, fromId).map((x) => x.id);
  setOwningTeams(kind, toId, teams);
  return teams;
}

/** The access settings of a kind switched to shares (0.23.0): owning teams, shares and the Restricted scope. */
export function copyAccessSettings(kind: OwnedKind, fromId: string, toId: string): string[] {
  const teams = copyOwningTeams(kind, fromId, toId);
  copyShares(kind, fromId, toId);
  return teams;
}

// ---------- where a copy came from ----------

function recordCopy(kind: DuplicateKind, id: string, source: { id: string; name: string }): void {
  db().run(
    'INSERT INTO copied_from (kind, id, source_id, source_name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    kind,
    id,
    source.id,
    source.name.slice(0, 300),
    nowIso(),
    me().username,
  );
}

// ---------- the flow every endpoint shares ----------

/** The original as the caller may duplicate it: view right (404), create right (403). */
function sourceFor<R>(d: Duplicator<R>, id: string): DuplicateSource<R> {
  const src = d.view(id);
  if (!d.mayCreate(src)) forbid(`create a copy of this ${d.label.toLowerCase()}`, 'duplicate');
  return src;
}

export function suggestion<R>(d: Duplicator<R>, id: string, lang?: string): DuplicateSuggestion {
  const src = sourceFor(d, id);
  return {
    kind: d.kind,
    sourceId: src.id,
    sourceName: src.name,
    name: copyName(src.name, d.nameTaken, { lang }),
    key: src.key !== null && d.keyTaken ? copyKey(src.key, d.keyTaken, d.keyMax) : null,
    accessApplies: d.accessApplies,
    canCopyAccess: d.accessApplies && src.mayManage,
    startsDisabled: !!d.startsDisabled,
    options: d.optionCounts?.(src) ?? [],
  };
}

export async function duplicate<R>(d: Duplicator<R>, id: string, body: unknown): Promise<DuplicateResult> {
  const input = duplicateInput.parse(body ?? {});
  const src = sourceFor(d, id);
  if (input.copyAccess && !d.accessApplies)
    throw new HttpError(400, `A ${d.label.toLowerCase()} has no access settings to copy`, 'DUPLICATE_NO_ACCESS_SETTINGS');
  // copying the access settings shares the copy with everyone the original is shared with: only for its managers
  if (input.copyAccess && !src.mayManage) forbid('copy the access settings of this original – only who may manage it can', 'duplicateAccess');
  if (input.template && !d.allowsTemplate) throw new HttpError(400, 'Only monitors can be saved as a template', 'DUPLICATE_TEMPLATE_UNSUPPORTED');
  const allowed = d.options ?? [];
  const unknown = (input.options ?? []).filter((o) => !allowed.includes(o));
  if (unknown.length) throw new HttpError(400, `Options not available here: ${unknown.join(', ')}`, 'DUPLICATE_OPTION_UNKNOWN', { options: unknown });
  const name = input.name ?? copyName(src.name, d.nameTaken);
  if (input.name && d.nameTaken?.(input.name))
    throw new HttpError(409, `The name "${input.name}" is already used`, 'DUPLICATE_NAME_TAKEN', { name: input.name });
  let key: string | null = null;
  if (d.keyTaken && src.key !== null) {
    key = input.key ?? copyKey(src.key, d.keyTaken, d.keyMax);
    // checked before anything is saved
    if (d.keyTaken(key)) throw new HttpError(409, `The key "${key}" is already used`, 'DUPLICATE_KEY_TAKEN', { key });
  } else if (input.key) throw new HttpError(400, `A ${d.label.toLowerCase()} copy gets its id automatically`, 'DUPLICATE_KEY_UNSUPPORTED');
  const copyInput: CopyInput = { ...input, name, key, options: input.options ?? [...allowed] };

  const finish = (made: MadeCopy) => {
    recordCopy(d.kind, made.id, src);
    audit({
      action: `${d.entityType}.duplicated`,
      entityType: d.entityType,
      entityId: made.id,
      summary: `${d.label} "${made.name}" duplicated from "${src.name}" (${src.id})${d.startsDisabled ? ', disabled' : ''}${input.copyAccess ? ', with its access settings' : ''}`,
      details: {
        sourceId: src.id,
        sourceName: src.name,
        key: made.key,
        copyAccess: input.copyAccess,
        ...(allowed.length ? { options: copyInput.options } : {}),
        ...(made.skipped?.length ? { skipped: made.skipped } : {}),
        ...(made.details ?? {}),
      },
    });
  };
  let made: MadeCopy;
  if (d.async) {
    made = await d.copy(src, copyInput);
    db().tx(() => finish(made));
  } else {
    // one transaction: the copy, what was copied along, where it came from and the audit entry
    made = db().tx(() => {
      const m = d.copy(src, copyInput) as MadeCopy;
      finish(m);
      return m;
    });
  }
  return {
    kind: d.kind,
    id: made.id,
    name: made.name,
    key: made.key,
    ...d.paths(made.id),
    skipped: made.skipped ?? [],
    ...(made.secrets ? { secrets: made.secrets } : {}),
  };
}

/** Where a copy came from, for who may see the copy; the original's name only for who may see it too. */
export function copiedFrom<R>(d: Duplicator<R>, id: string): CopiedFrom | null {
  const copy = d.view(id);
  const r = db().get<{ source_id: string; source_name: string; created_at: string; created_by: string }>(
    'SELECT source_id, source_name, created_at, created_by FROM copied_from WHERE kind = ? AND id = ?',
    d.kind,
    copy.id,
  );
  if (!r) return null;
  let visible = false;
  try {
    d.view(r.source_id);
    visible = true;
  } catch (e) {
    if (!(e instanceof HttpError) || (e.statusCode !== 404 && e.statusCode !== 403)) throw e;
  }
  return {
    kind: d.kind,
    sourceId: visible ? r.source_id : null,
    sourceName: visible ? r.source_name : null,
    hidden: !visible,
    at: r.created_at,
    by: r.created_by,
  };
}
