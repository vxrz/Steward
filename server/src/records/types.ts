import { z } from 'zod';
import {
  ACCESS_CHANGE_FIELD_KEYS,
  ACCESS_RECORD_TYPE,
  ACCESS_TYPE_ID,
  DEFAULT_RECORD_TYPES,
  RECORD_FIELD_KEY_RE,
  RECORD_FIELD_KINDS,
  RECORD_TYPE_KEY_RE,
  RECORD_WORKFLOW_KEYS,
  type RecordFieldDef,
  type RecordType,
  type RecordWorkflowKey,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canManageRecordTypes, forbid } from './access.js';

/**
 * Record types: number prefix, name, description, workflow, Markdown template
 * and structured fields. The defaults (CR, ADR, DR, SDR) are created on first
 * use; administrators edit, archive and add types.
 */

export interface TypeRow {
  id: string;
  key: string;
  name: string;
  description: string;
  workflow: RecordWorkflowKey;
  template: string;
  fields: string;
  builtin: number;
  archived: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export const fieldDef = z
  .object({
    key: z.string().regex(RECORD_FIELD_KEY_RE, 'Field keys are camelCase letters and digits, e.g. rollbackPlan'),
    label: z.string().trim().min(1).max(80),
    kind: z.enum(RECORD_FIELD_KINDS),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    help: z.string().trim().max(300).optional(),
  })
  .strict();

export const typeInput = z
  .object({
    key: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.string().regex(RECORD_TYPE_KEY_RE, 'The key is 2–10 capital letters or digits, starting with a letter (e.g. CR)')),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(''),
    workflow: z.enum(RECORD_WORKFLOW_KEYS),
    template: z.string().max(20000).default(''),
    fields: z.array(fieldDef).max(30).default([]),
    archived: z.boolean().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const keys = new Set<string>();
    t.fields.forEach((f, i) => {
      if (keys.has(f.key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `Duplicate field key ${f.key}` });
      keys.add(f.key);
      if (f.kind === 'select' && !f.options?.length) ctx.addIssue({ code: 'custom', path: ['fields', i, 'options'], message: 'A select field needs options' });
    });
  });
export type TypeInput = z.infer<typeof typeInput>;

let seeded = false;
/** Creates the default record types once (an installation that deleted or renamed them keeps its own). */
export function ensureDefaultTypes(): void {
  if (seeded) return;
  ensureAccessType();
  if (db().get("SELECT 1 FROM settings WHERE key = 'records.defaultTypesSeeded'")) {
    seeded = true;
    return;
  }
  db().tx(() => {
    if (db().get("SELECT 1 FROM settings WHERE key = 'records.defaultTypesSeeded'")) return;
    const now = nowIso();
    for (const t of DEFAULT_RECORD_TYPES) {
      if (db().get('SELECT 1 FROM record_types WHERE key = ?', t.key)) continue;
      db().run(
        `INSERT INTO record_types (id, key, name, description, workflow, template, fields, builtin, archived, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'system')`,
        `rty_${t.key.toLowerCase()}`,
        t.key,
        t.name,
        t.description,
        t.workflow,
        t.template,
        JSON.stringify(t.fields),
        now,
        now,
      );
    }
    db().run("INSERT INTO settings (key, value) VALUES ('records.defaultTypesSeeded', ?) ON CONFLICT (key) DO NOTHING", now);
  });
  seeded = true;
}
/**
 * The built-in type for access change entries (compliance), also in installations created before it
 * existed. Its id is fixed (rty_ac); the key is AC unless an installation already uses that key.
 */
function ensureAccessType(): void {
  if (db().get('SELECT 1 FROM record_types WHERE id = ?', ACCESS_TYPE_ID)) return;
  db().tx(() => {
    if (db().get('SELECT 1 FROM record_types WHERE id = ?', ACCESS_TYPE_ID)) return;
    const key = ['AC', 'ACC', 'ACE', 'ACCESS'].find((k) => !db().get('SELECT 1 FROM record_types WHERE key = ?', k)) ?? 'ACX';
    const now = nowIso();
    const t = ACCESS_RECORD_TYPE;
    db().run(
      `INSERT INTO record_types (id, key, name, description, workflow, template, fields, builtin, archived, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'system') ON CONFLICT (id) DO NOTHING`,
      ACCESS_TYPE_ID,
      key,
      t.name,
      t.description,
      t.workflow,
      t.template,
      JSON.stringify(t.fields),
      now,
      now,
    );
  });
}

/** For tests that swap the database. */
export function resetTypeSeed(): void {
  seeded = false;
}

export function toType(r: TypeRow, recordCount?: number): RecordType {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    workflow: r.workflow,
    template: r.template,
    fields: parseJson<RecordFieldDef[]>(r.fields, []),
    builtin: !!r.builtin,
    archived: !!r.archived,
    recordCount: recordCount ?? Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM records WHERE type_id = ?', r.id)?.n ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listTypes(opts: { archived?: boolean } = {}): RecordType[] {
  ensureDefaultTypes();
  const counts = new Map(
    db()
      .all<{ type_id: string; n: number }>('SELECT type_id, COUNT(*) AS n FROM records GROUP BY type_id')
      .map((r) => [r.type_id, Number(r.n)]),
  );
  return db()
    .all<TypeRow>('SELECT * FROM record_types ORDER BY key')
    .filter((r) => opts.archived || !r.archived)
    .map((r) => toType(r, counts.get(r.id) ?? 0));
}

/** A type by id or key. */
export function typeRow(idOrKey: string): TypeRow | undefined {
  ensureDefaultTypes();
  return db().get<TypeRow>('SELECT * FROM record_types WHERE id = ? OR key = ?', idOrKey, idOrKey.toUpperCase());
}

export function requireType(idOrKey: string): TypeRow {
  const r = typeRow(idOrKey);
  if (!r) throw new HttpError(404, `Record type ${idOrKey} not found`, 'RECORD_TYPE_NOT_FOUND', { type: idOrKey });
  return r;
}

export function createType(input: TypeInput): RecordType {
  if (!canManageRecordTypes()) forbid('manage record types', 'manageRecordTypes');
  ensureDefaultTypes();
  if (db().get('SELECT 1 FROM record_types WHERE key = ?', input.key))
    throw new HttpError(409, `A record type with the key ${input.key} exists already`, 'RECORD_TYPE_EXISTS', { type: input.key });
  const id = newId('rty_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO record_types (id, key, name, description, workflow, template, fields, builtin, archived, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id,
      input.key,
      input.name,
      input.description,
      input.workflow,
      input.template,
      JSON.stringify(input.fields),
      input.archived ? 1 : 0,
      now,
      now,
      currentActor(),
    );
    audit({
      action: 'record_type.created',
      entityType: 'record_type',
      entityId: id,
      summary: `Record type ${input.key} "${input.name}" created`,
      details: { key: input.key, workflow: input.workflow },
    });
  });
  return toType(requireType(id));
}

/**
 * Updates a type. The key and the workflow of a type with records cannot
 * change: the key is part of their numbers and of the content hash frozen
 * records were approved with, and their statuses belong to the workflow.
 * Name, description, template and fields stay editable.
 */
export function updateType(id: string, input: TypeInput): RecordType {
  if (!canManageRecordTypes()) forbid('manage record types', 'manageRecordTypes');
  const cur = requireType(id);
  if (input.key !== cur.key && db().get('SELECT 1 FROM record_types WHERE key = ? AND id <> ?', input.key, cur.id)) {
    throw new HttpError(409, `A record type with the key ${input.key} exists already`, 'RECORD_TYPE_EXISTS', { type: input.key });
  }
  const used = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM records WHERE type_id = ?', cur.id)!.n);
  if (input.key !== cur.key && used > 0)
    throw new HttpError(
      409,
      'The key of a type that has records cannot be changed (it is part of their numbers and content hashes) – change the name instead',
      'TYPE_KEY_LOCKED',
    );
  if (input.workflow !== cur.workflow && used > 0)
    throw new HttpError(409, 'The workflow of a type that has records cannot be changed – create a new type instead', 'TYPE_WORKFLOW_LOCKED');
  if (cur.id === ACCESS_TYPE_ID) {
    // the reconciliation, automatic entries and evidence packs read these fields
    const keys = new Set(input.fields.map((f) => f.key));
    const missing = ACCESS_CHANGE_FIELD_KEYS.filter((k) => !keys.has(k));
    if (missing.length || input.workflow !== 'access')
      throw new HttpError(
        409,
        `The access change type keeps its workflow and the fields ${missing.join(', ') || ACCESS_CHANGE_FIELD_KEYS.join(', ')}`,
        'TYPE_FIELDS_LOCKED',
        {
          fields: missing.length ? missing : ACCESS_CHANGE_FIELD_KEYS,
        },
      );
  }
  const changes = (['key', 'name', 'description', 'workflow', 'template'] as const).filter((k) => input[k] !== cur[k]);
  if (JSON.stringify(input.fields) !== cur.fields) changes.push('fields' as never);
  const archived = input.archived ?? !!cur.archived;
  if (archived !== !!cur.archived) changes.push('archived' as never);
  db().tx(() => {
    db().run(
      'UPDATE record_types SET key = ?, name = ?, description = ?, workflow = ?, template = ?, fields = ?, archived = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.key,
      input.name,
      input.description,
      input.workflow,
      input.template,
      JSON.stringify(input.fields),
      archived ? 1 : 0,
      nowIso(),
      currentActor(),
      cur.id,
    );
    audit({
      action: 'record_type.updated',
      entityType: 'record_type',
      entityId: cur.id,
      summary: `Record type ${input.key} "${input.name}" changed (${changes.join(', ') || 'no changes'})`,
      details: { changes, previousKey: cur.key },
    });
  });
  return toType(requireType(cur.id));
}
