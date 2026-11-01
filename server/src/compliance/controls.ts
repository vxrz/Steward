import { z } from 'zod';
import {
  ACCESS_TYPE_ID,
  CONTROL_TAG_KINDS,
  type Control,
  type ControlCatalogue,
  type ControlCoverage,
  type CoverageStatus,
  type ControlTag,
  type ControlTagKind,
  type EvidenceItem,
  type EvidenceKind,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { permissionsOfRow } from '../monitors/model.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canManageCatalogues, canReadCheck, canTagControls, forbid, me, readsEverything, same, SYSTEM_USER } from './access.js';
import { BUILTIN_CATALOGUES, DEFAULT_ACCESS_CONTROLS } from './catalogues.js';
import { toAccessChange } from './access-changes.js';
import { personReviewEvidence } from './person-reviews.js';
import type { RecordRow } from '../records/model.js';
import { canReadRecordRow } from '../records/access.js';
import { documentEvidence } from '../records/document-model.js';
import { ensureDefaultTypes } from '../records/types.js';
import { parseYamlDocument } from '../yaml-safe.js';

/**
 * Control catalogues (ISO/IEC 27001 Annex A, IEC 62443-2-1, NIS2 Art. 21 built in – identifiers and
 * Steward's own short topic names only), tags that map Steward items to controls, and the evidence
 * coverage of a control in a period: runs and their PDF protocols, records, access change entries,
 * access snapshots and findings, monitor results and scheduled reports. Every item is filtered by
 * what the reader may see.
 */

export const LIMITS = {
  controls: 2000,
  title: 300,
  description: 4000,
  importBytes: 1024 * 1024,
  /** YAML is capped lower than JSON and CSV (parsing it is more expensive) */
  yamlBytes: 256 * 1024,
  yamlKeys: 50_000,
  evidencePerControl: 200,
  tagsPerControl: 200,
};

interface CatalogueRow {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  builtin: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}
interface ControlRow {
  id: string;
  catalogue_id: string;
  ref: string;
  title: string;
  description: string;
  sort: number;
}
interface TagRow {
  control_id: string;
  kind: ControlTagKind;
  target_id: string;
  created_at: string;
  created_by: string;
  /** Mapped from an AI assistant's proposal (#74, JSON) */
  suggestion?: string | null;
}

// ---------- seeding ----------

let seeded = false;
/** Creates the built-in catalogues and the default mapping of access change entries once. */
export function ensureCatalogues(): void {
  if (seeded) return;
  if (db().get("SELECT 1 FROM settings WHERE key = 'compliance.cataloguesSeeded'")) {
    seeded = true;
    return;
  }
  db().tx(() => {
    if (db().get("SELECT 1 FROM settings WHERE key = 'compliance.cataloguesSeeded'")) return;
    const now = nowIso();
    for (const c of BUILTIN_CATALOGUES) {
      if (db().get('SELECT 1 FROM control_catalogues WHERE key = ?', c.key)) continue;
      const id = `ctc_${c.key.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      db().run(
        `INSERT INTO control_catalogues (id, key, name, version, description, builtin, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'system')`,
        id,
        c.key,
        c.name,
        c.version,
        c.description,
        now,
        now,
      );
      c.controls.forEach((x, i) =>
        db().run('INSERT INTO controls (id, catalogue_id, ref, title, description, sort) VALUES (?, ?, ?, ?, ?, ?)', newId('ctl_'), id, x.ref, x.title, '', i),
      );
    }
    for (const d of DEFAULT_ACCESS_CONTROLS) {
      const ctl = db().get<{ id: string }>(
        'SELECT c.id FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE k.key = ? AND c.ref = ?',
        d.catalogue,
        d.ref,
      );
      if (ctl)
        db().run(
          "INSERT INTO control_tags (control_id, kind, target_id, created_at, created_by) VALUES (?, 'recordType', ?, ?, 'system') ON CONFLICT DO NOTHING",
          ctl.id,
          ACCESS_TYPE_ID,
          now,
        );
    }
    db().run("INSERT INTO settings (key, value) VALUES ('compliance.cataloguesSeeded', ?) ON CONFLICT (key) DO NOTHING", now);
  });
  seeded = true;
}
export function resetCatalogueSeed(): void {
  seeded = false;
}

// ---------- catalogues ----------

const toCatalogue = (r: CatalogueRow): ControlCatalogue => ({
  id: r.id,
  key: r.key,
  name: r.name,
  version: r.version,
  description: r.description,
  builtin: !!r.builtin,
  controlCount: Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM controls WHERE catalogue_id = ?', r.id)!.n),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listCatalogues(): ControlCatalogue[] {
  me();
  ensureCatalogues();
  return db().all<CatalogueRow>('SELECT * FROM control_catalogues ORDER BY builtin DESC, key').map(toCatalogue);
}

function catalogueRow(idOrKey: string): CatalogueRow {
  ensureCatalogues();
  const r = db().get<CatalogueRow>('SELECT * FROM control_catalogues WHERE id = ? OR key = ?', idOrKey, idOrKey);
  if (!r) throw new HttpError(404, `Control catalogue ${idOrKey} not found`, 'CATALOGUE_NOT_FOUND', { id: idOrKey });
  return r;
}

export const catalogueInput = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9._-]{1,39}$/, 'The key is 2–40 letters, digits, . _ - (e.g. ISO27001)'),
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().max(40).default(''),
    description: z.string().trim().max(LIMITS.description).default(''),
  })
  .strict();

export const controlText = z.object({
  ref: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(LIMITS.title),
  description: z.string().trim().max(LIMITS.description).default(''),
});

export function createCatalogue(input: z.infer<typeof catalogueInput>): ControlCatalogue {
  if (!canManageCatalogues(me())) forbid('manage control catalogues', 'manageCatalogues');
  ensureCatalogues();
  if (db().get('SELECT 1 FROM control_catalogues WHERE lower(key) = lower(?)', input.key))
    throw new HttpError(409, `A catalogue with the key ${input.key} exists already`, 'CATALOGUE_EXISTS', { key: input.key });
  const id = newId('ctc_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO control_catalogues (id, key, name, version, description, builtin, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id,
      input.key,
      input.name,
      input.version,
      input.description,
      now,
      now,
      me().username,
    );
    audit({
      action: 'control_catalogue.created',
      entityType: 'control_catalogue',
      entityId: id,
      summary: `Control catalogue ${input.key} "${input.name}" created`,
    });
  });
  return toCatalogue(catalogueRow(id));
}

export function updateCatalogue(id: string, input: Omit<z.infer<typeof catalogueInput>, 'key'>): ControlCatalogue {
  if (!canManageCatalogues(me())) forbid('manage control catalogues', 'manageCatalogues');
  const c = catalogueRow(id);
  db().tx(() => {
    db().run(
      'UPDATE control_catalogues SET name = ?, version = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.name,
      input.version,
      input.description,
      nowIso(),
      me().username,
      c.id,
    );
    audit({ action: 'control_catalogue.updated', entityType: 'control_catalogue', entityId: c.id, summary: `Control catalogue ${c.key} changed` });
  });
  return toCatalogue(catalogueRow(c.id));
}

/** Custom catalogues can be deleted (with their tags); built-in ones stay (edit their texts instead). */
export function deleteCatalogue(id: string): void {
  if (!canManageCatalogues(me())) forbid('manage control catalogues', 'manageCatalogues');
  const c = catalogueRow(id);
  if (c.builtin) throw new HttpError(409, 'Built-in catalogues cannot be deleted – edit or import their texts instead', 'CATALOGUE_BUILTIN');
  db().tx(() => {
    db().run('DELETE FROM control_tags WHERE control_id IN (SELECT id FROM controls WHERE catalogue_id = ?)', c.id);
    db().run('DELETE FROM controls WHERE catalogue_id = ?', c.id);
    db().run('DELETE FROM control_catalogues WHERE id = ?', c.id);
    audit({ action: 'control_catalogue.deleted', entityType: 'control_catalogue', entityId: c.id, summary: `Control catalogue ${c.key} "${c.name}" deleted` });
  });
}

// ---------- import ----------

/** RFC 4180 CSV (quotes, doubled quotes, CRLF), bounded by the import size limit. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') ((cell += '"'), i++);
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',' || ch === ';') (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export interface ParsedCatalogue {
  key?: string;
  name?: string;
  version?: string;
  description?: string;
  controls: z.infer<typeof controlText>[];
}

/** Reads a catalogue file: JSON or YAML ({ key, name, version, description, controls: [{ ref, title, description }] } or a list of controls), or CSV (ref, title, description). */
export function parseCatalogueFile(filename: string, content: string): ParsedCatalogue {
  if (Buffer.byteLength(content) > LIMITS.importBytes)
    throw new HttpError(413, `The file is too large (at most ${LIMITS.importBytes / 1024} KB)`, 'CATALOGUE_TOO_LARGE', { kb: LIMITS.importBytes / 1024 });
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  let controls: unknown[];
  let meta: Record<string, unknown> = {};
  if (ext === 'csv' || ext === 'txt') {
    const rows = parseCsv(content.replace(/^\uFEFF/, ''));
    if (!rows.length) throw new HttpError(400, 'The CSV file is empty', 'CATALOGUE_CSV_EMPTY');
    const head = rows[0]!.map((h) => h.trim().toLowerCase());
    const col = (names: string[]) => head.findIndex((h) => names.includes(h));
    const ref = col(['ref', 'id', 'control', 'number', 'nr']);
    const title = col(['title', 'name', 'control title', 'topic']);
    const desc = col(['description', 'text', 'guidance']);
    if (ref < 0 || title < 0)
      throw new HttpError(400, 'The CSV file needs a header row with the columns ref and title (optional: description)', 'CATALOGUE_CSV_HEADER');
    controls = rows.slice(1).map((r) => ({ ref: r[ref] ?? '', title: r[title] ?? '', description: desc >= 0 ? (r[desc] ?? '') : '' }));
  } else {
    if (ext !== 'json' && Buffer.byteLength(content) > LIMITS.yamlBytes)
      throw new HttpError(413, `The file is too large (at most ${LIMITS.yamlBytes / 1024} KB for YAML)`, 'CATALOGUE_TOO_LARGE', {
        kb: LIMITS.yamlBytes / 1024,
      });
    let data: unknown;
    try {
      if (ext === 'json') data = JSON.parse(content);
      else {
        const doc = parseYamlDocument(content, {
          schema: 'core',
          merge: false,
          prettyErrors: false,
          strict: true,
          customTags: [],
          maxBytes: LIMITS.yamlBytes,
          maxKeys: LIMITS.yamlKeys,
        });
        if (doc.errors.length) throw new Error(doc.errors[0]!.message);
        data = doc.toJS({ maxAliasCount: 20 });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `The file cannot be read: ${(e as Error).message.slice(0, 200)}`, 'CATALOGUE_UNREADABLE', {
        detail: (e as Error).message.slice(0, 200),
      });
    }
    if (Array.isArray(data)) controls = data;
    else if (data && typeof data === 'object' && Array.isArray((data as { controls?: unknown }).controls)) {
      meta = data as Record<string, unknown>;
      controls = meta.controls as unknown[];
    } else throw new HttpError(400, 'Expected a list of controls or an object with "controls"', 'CATALOGUE_SHAPE');
  }
  if (controls.length > LIMITS.controls)
    throw new HttpError(400, `At most ${LIMITS.controls} controls per catalogue`, 'CATALOGUE_TOO_MANY', { max: LIMITS.controls });
  const parsed = controls.map((c, i) => {
    const r = controlText.safeParse(c);
    if (!r.success)
      throw new HttpError(400, `Control ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`, 'CATALOGUE_CONTROL_INVALID', {
        n: i + 1,
        details: r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; '),
      });
    return r.data;
  });
  const refs = new Set<string>();
  for (const c of parsed) {
    if (refs.has(c.ref.toLowerCase())) throw new HttpError(400, `Control ${c.ref} appears twice`, 'CONTROL_DUPLICATE', { ref: c.ref });
    refs.add(c.ref.toLowerCase());
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { key: str(meta.key), name: str(meta.name), version: str(meta.version), description: str(meta.description), controls: parsed };
}

/**
 * Writes controls into a catalogue (inside the caller's transaction): texts of existing refs are replaced, new refs are
 * added at the end, and the refs in `remove` are deleted with their mappings. Shared by the file import and accepted
 * proposals of AI assistants (#74).
 */
export function upsertControls(
  catalogueId: string,
  controls: z.infer<typeof controlText>[],
  remove: string[] = [],
): { added: number; updated: number; removed: number } {
  const existing = new Map(
    db()
      .all<ControlRow>('SELECT * FROM controls WHERE catalogue_id = ?', catalogueId)
      .map((c) => [c.ref.toLowerCase(), c]),
  );
  const dropped = new Set(remove.map((r) => r.toLowerCase()).filter((r) => existing.has(r)));
  const adding = controls.filter((c) => !existing.has(c.ref.toLowerCase())).length;
  if (existing.size - dropped.size + adding > LIMITS.controls)
    throw new HttpError(400, `At most ${LIMITS.controls} controls per catalogue`, 'CATALOGUE_TOO_MANY', { max: LIMITS.controls });
  let added = 0;
  let updated = 0;
  let sort = existing.size;
  for (const c of controls) {
    const cur = existing.get(c.ref.toLowerCase());
    if (cur) {
      if (cur.title !== c.title || cur.description !== c.description) {
        db().run('UPDATE controls SET title = ?, description = ? WHERE id = ?', c.title, c.description, cur.id);
        updated++;
      }
    } else {
      db().run(
        'INSERT INTO controls (id, catalogue_id, ref, title, description, sort) VALUES (?, ?, ?, ?, ?, ?)',
        newId('ctl_'),
        catalogueId,
        c.ref,
        c.title,
        c.description,
        sort++,
      );
      added++;
    }
  }
  for (const ref of dropped) {
    const cur = existing.get(ref)!;
    db().run('DELETE FROM control_tags WHERE control_id = ?', cur.id);
    db().run('DELETE FROM controls WHERE id = ?', cur.id);
  }
  return { added, updated, removed: dropped.size };
}

/** The catalogue's controls with how many items are mapped to each (for comparing a proposal, #74). */
export function catalogueControls(catalogueId: string): { id: string; ref: string; title: string; description: string; mapped: number }[] {
  return db()
    .all<{ id: string; ref: string; title: string; description: string; mapped: number }>(
      `SELECT c.id, c.ref, c.title, c.description, (SELECT COUNT(*) FROM control_tags t WHERE t.control_id = c.id) AS mapped
     FROM controls c WHERE c.catalogue_id = ? ORDER BY c.sort, c.ref`,
      catalogueId,
    )
    .map((c) => ({ ...c, mapped: Number(c.mapped) }));
}

/** The catalogue of a key or id, or null. */
export function findCatalogue(idOrKey: string): { id: string; key: string; name: string; version: string; builtin: boolean } | null {
  ensureCatalogues();
  const r = db().get<CatalogueRow>('SELECT * FROM control_catalogues WHERE id = ? OR lower(key) = lower(?)', idOrKey, idOrKey);
  return r ? { id: r.id, key: r.key, name: r.name, version: r.version, builtin: !!r.builtin } : null;
}

/**
 * Imports controls: into an existing catalogue (texts of existing refs are replaced, new refs are
 * added, nothing is removed) or as a new catalogue.
 */
export function importCatalogue(o: { catalogueId?: string; key?: string; name?: string; filename: string; content: string }): {
  catalogue: ControlCatalogue;
  added: number;
  updated: number;
} {
  if (!canManageCatalogues(me())) forbid('manage control catalogues', 'manageCatalogues');
  const parsed = parseCatalogueFile(o.filename, o.content);
  let cat: CatalogueRow;
  if (o.catalogueId) cat = catalogueRow(o.catalogueId);
  else {
    const created = createCatalogue(
      catalogueInput.parse({
        key: o.key ?? parsed.key,
        name: o.name ?? parsed.name ?? o.key ?? parsed.key,
        version: parsed.version ?? '',
        description: parsed.description ?? '',
      }),
    );
    cat = catalogueRow(created.id);
  }
  let counts = { added: 0, updated: 0, removed: 0 };
  db().tx(() => {
    counts = upsertControls(cat.id, parsed.controls);
    db().run('UPDATE control_catalogues SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), me().username, cat.id);
    audit({
      action: 'control_catalogue.imported',
      entityType: 'control_catalogue',
      entityId: cat.id,
      summary: `${counts.added} control(s) added and ${counts.updated} changed in catalogue ${cat.key} (import of ${o.filename.slice(0, 100)})`,
      details: { added: counts.added, updated: counts.updated, filename: o.filename.slice(0, 200) },
    });
  });
  const { added, updated } = counts;
  return { catalogue: toCatalogue(catalogueRow(cat.id)), added, updated };
}

// ---------- controls ----------

/** A mapped item as the reader sees it: the id only when they may see the item (ids can carry names, e.g. process slugs). */
function tagInfo(t: TagRow, u: AuthUser | null): ControlTag {
  const r = resolveTarget(t.kind, t.target_id, u);
  const suggestion = t.suggestion ? parseJson<ControlTag['suggestion'] | null>(t.suggestion, null) : null;
  return {
    kind: t.kind,
    targetId: r ? t.target_id : null,
    label: r?.label ?? '',
    path: r?.path ?? null,
    visible: !!r,
    ...(suggestion && r ? { suggestion } : {}),
  };
}

function toControl(c: ControlRow, cat: Pick<CatalogueRow, 'key'>, u: AuthUser | null, tags?: TagRow[]): Control {
  return {
    id: c.id,
    catalogueId: c.catalogue_id,
    catalogueKey: cat.key,
    ref: c.ref,
    title: c.title,
    description: c.description,
    tags: (tags ?? db().all<TagRow>('SELECT * FROM control_tags WHERE control_id = ? ORDER BY kind, target_id', c.id)).map((t) => tagInfo(t, u)),
  };
}

export function listControls(catalogueIdOrKey?: string): Control[] {
  const u = me();
  ensureCatalogues();
  const cats = new Map(
    db()
      .all<CatalogueRow>('SELECT * FROM control_catalogues')
      .map((c) => [c.id, c]),
  );
  const cat = catalogueIdOrKey ? catalogueRow(catalogueIdOrKey) : null;
  const rows = cat
    ? db().all<ControlRow>('SELECT * FROM controls WHERE catalogue_id = ? ORDER BY sort, ref', cat.id)
    : db().all<ControlRow>('SELECT * FROM controls ORDER BY catalogue_id, sort, ref');
  const tags = new Map<string, TagRow[]>();
  for (const t of db().all<TagRow>('SELECT * FROM control_tags ORDER BY kind, target_id')) tags.set(t.control_id, [...(tags.get(t.control_id) ?? []), t]);
  return rows.map((c) => toControl(c, cats.get(c.catalogue_id)!, u, tags.get(c.id) ?? []));
}

function controlRow(id: string): ControlRow & { catalogue_key: string } {
  ensureCatalogues();
  const r = db().get<ControlRow & { catalogue_key: string }>(
    'SELECT c.*, k.key AS catalogue_key FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE c.id = ?',
    id,
  );
  if (!r) throw new HttpError(404, `Control ${id} not found`, 'CONTROL_NOT_FOUND', { id });
  return r;
}

export function getControl(id: string): Control {
  const u = me();
  const c = controlRow(id);
  return toControl(c, { key: c.catalogue_key }, u);
}

export function updateControl(id: string, input: { title: string; description: string }): Control {
  if (!canManageCatalogues(me())) forbid('edit controls', 'manageCatalogues');
  const c = controlRow(id);
  const v = controlText.omit({ ref: true }).parse(input);
  db().tx(() => {
    db().run('UPDATE controls SET title = ?, description = ? WHERE id = ?', v.title, v.description, c.id);
    audit({ action: 'control.updated', entityType: 'control', entityId: c.id, summary: `Control ${c.catalogue_key} ${c.ref} changed` });
  });
  return getControl(c.id);
}

export function addControl(catalogueId: string, input: z.infer<typeof controlText>): Control {
  if (!canManageCatalogues(me())) forbid('edit controls', 'manageCatalogues');
  const cat = catalogueRow(catalogueId);
  const v = controlText.parse(input);
  if (db().get('SELECT 1 FROM controls WHERE catalogue_id = ? AND lower(ref) = lower(?)', cat.id, v.ref))
    throw new HttpError(409, `Control ${v.ref} exists already`, 'CONTROL_EXISTS', { ref: v.ref });
  const id = newId('ctl_');
  const sort = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM controls WHERE catalogue_id = ?', cat.id)!.n);
  if (sort >= LIMITS.controls) throw new HttpError(400, `At most ${LIMITS.controls} controls per catalogue`, 'CATALOGUE_TOO_MANY', { max: LIMITS.controls });
  db().tx(() => {
    db().run(
      'INSERT INTO controls (id, catalogue_id, ref, title, description, sort) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      cat.id,
      v.ref,
      v.title,
      v.description,
      sort,
    );
    audit({ action: 'control.created', entityType: 'control', entityId: id, summary: `Control ${cat.key} ${v.ref} added` });
  });
  return getControl(id);
}

// ---------- tags ----------

interface Target {
  label: string;
  path: string;
}

/** Label and path of a tagged item, or null when the reader may not see it (or it is gone). */
export function resolveTarget(kind: ControlTagKind, id: string, u: AuthUser | null = currentUser()): Target | null {
  switch (kind) {
    case 'process': {
      const p = db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id);
      return p && permissionsFor(id).includes('view') ? { label: p.name, path: `/processes/${id}` } : null;
    }
    case 'recordType': {
      ensureDefaultTypes();
      const t = db().get<{ key: string; name: string }>('SELECT key, name FROM record_types WHERE id = ?', id);
      return t ? { label: `${t.key} – ${t.name}`, path: `/records?type=${encodeURIComponent(t.key)}` } : null;
    }
    case 'record': {
      const r = db().get<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string }>(
        'SELECT id, number, title, type_id, fields, owner FROM records WHERE id = ?',
        id,
      );
      return r && canReadRecordRow(u, r) ? { label: `${r.number} ${r.title}`, path: `/records/${id}` } : null;
    }
    case 'monitor': {
      const m = db().get<{ id: string; name: string; owner: string; acl: string }>('SELECT id, name, owner, acl FROM monitors WHERE id = ?', id);
      return m && permissionsOfRow(m, u).includes('view') ? { label: m.name, path: `/monitors/${id}` } : null;
    }
    case 'reportSchedule': {
      const s = db().get<{ name: string; owner: string }>('SELECT name, owner FROM report_schedules WHERE id = ?', id);
      return s && u && (capabilities(u).viewAudit || same(s.owner, u.username)) ? { label: s.name, path: `/reports?schedule=${encodeURIComponent(id)}` } : null;
    }
    case 'accessCheck': {
      const c = db().get<{ name: string; owner: string; platform_id: string }>('SELECT name, owner, platform_id FROM access_checks WHERE id = ?', id);
      return c && canReadCheck(u, c) ? { label: c.name, path: `/compliance/reconciliation?check=${encodeURIComponent(id)}` } : null;
    }
  }
}

export const tagInput = z.object({ kind: z.enum(CONTROL_TAG_KINDS), targetId: z.string().trim().min(1).max(200) }).strict();

/** `suggestion`: the mapping comes from an AI assistant's proposal that `u` accepted (#74). */
export function addTag(controlId: string, input: z.infer<typeof tagInput>, suggestion?: NonNullable<ControlTag['suggestion']>): Control {
  const u = me();
  if (!canTagControls(u)) forbid('map items to controls', 'tagControls');
  const c = controlRow(controlId);
  // only items the user can see can be tagged (no probing for ids)
  const target = resolveTarget(input.kind, input.targetId, u);
  if (!target) throw new HttpError(404, `${input.kind} ${input.targetId} not found`, 'TAG_TARGET_NOT_FOUND', { id: input.targetId });
  if (db().get('SELECT 1 FROM control_tags WHERE control_id = ? AND kind = ? AND target_id = ?', c.id, input.kind, input.targetId)) return getControl(c.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM control_tags WHERE control_id = ?', c.id)!.n) >= LIMITS.tagsPerControl)
    throw new HttpError(400, `At most ${LIMITS.tagsPerControl} items per control`, 'CONTROL_TOO_MANY_TAGS', { max: LIMITS.tagsPerControl });
  db().tx(() => {
    db().run(
      'INSERT INTO control_tags (control_id, kind, target_id, created_at, created_by, suggestion) VALUES (?, ?, ?, ?, ?, ?)',
      c.id,
      input.kind,
      input.targetId,
      nowIso(),
      u.username,
      suggestion ? JSON.stringify(suggestion) : null,
    );
    audit({
      action: 'control.tagged',
      entityType: 'control',
      entityId: c.id,
      summary: `${target.label} (${input.kind}) mapped to control ${c.catalogue_key} ${c.ref}${suggestion ? ` (proposed by ${suggestion.requestedBy}'s AI assistant)` : ''}`,
      details: { kind: input.kind, targetId: input.targetId, ...(suggestion ? { requestId: suggestion.requestId, requestedBy: suggestion.requestedBy } : {}) },
    });
  });
  return getControl(c.id);
}

export function removeTag(controlId: string, kind: ControlTagKind, targetId: string): Control {
  const u = me();
  if (!canTagControls(u)) forbid('map items to controls', 'tagControls');
  const c = controlRow(controlId);
  // only items the user can see (administrators: any), as when adding them – no probing for hidden ids
  if (!isAdmin(u) && !resolveTarget(kind, targetId, u)) throw new HttpError(404, 'This item is not mapped to the control', 'TAG_NOT_FOUND');
  const n = db().run('DELETE FROM control_tags WHERE control_id = ? AND kind = ? AND target_id = ?', c.id, kind, targetId).changes;
  if (!n) throw new HttpError(404, 'This item is not mapped to the control', 'TAG_NOT_FOUND');
  audit({
    action: 'control.untagged',
    entityType: 'control',
    entityId: c.id,
    summary: `${kind} ${targetId} removed from control ${c.catalogue_key} ${c.ref}`,
    details: { kind, targetId },
  });
  return getControl(c.id);
}

/** Controls an item is mapped to (for the item's own pages). */
export function controlsOf(kind: ControlTagKind, targetId: string): Control[] {
  const u = me();
  ensureCatalogues();
  // not for items the user cannot see (no probing which hidden items are mapped)
  if (!resolveTarget(kind, targetId, u)) return [];
  return db()
    .all<ControlRow & { catalogue_key: string }>(
      'SELECT c.*, k.key AS catalogue_key FROM control_tags t JOIN controls c ON c.id = t.control_id JOIN control_catalogues k ON k.id = c.catalogue_id WHERE t.kind = ? AND t.target_id = ? ORDER BY k.key, c.sort',
      kind,
      targetId,
    )
    .map((c) => toControl(c, { key: c.catalogue_key }, u));
}

// ---------- evidence ----------

export interface Period {
  from: string;
  to: string;
}

const inPeriodSql = (col: string) => `${col} >= ? AND ${col} <= ?`;

/** Evidence of one tagged item in the period (only what the reader may see). */
export function evidenceOf(tag: Pick<TagRow, 'kind' | 'target_id'>, p: Period, u: AuthUser | null = currentUser()): EvidenceItem[] {
  const target = resolveTarget(tag.kind, tag.target_id, u);
  if (!target) return [];
  const via = { kind: tag.kind, id: tag.target_id, label: target.label };
  const items: EvidenceItem[] = [];
  switch (tag.kind) {
    case 'process': {
      const runs = db().all<{ id: string; process_name: string; status: string; started_at: string; finished_at: string | null }>(
        `SELECT id, process_name, status, started_at, finished_at FROM runs WHERE process_id = ? AND dry_run = 0 AND ${inPeriodSql('started_at')} ORDER BY started_at DESC LIMIT 1000`,
        tag.target_id,
        p.from,
        p.to,
      );
      const reports = runs.length
        ? new Set(
            db()
              .all<{ run_id: string }>(`SELECT DISTINCT run_id FROM reports WHERE run_id IN (${runs.map(() => '?').join(', ')})`, ...runs.map((r) => r.id))
              .map((r) => r.run_id),
          )
        : new Set<string>();
      for (const r of runs)
        items.push({
          kind: 'run',
          id: r.id,
          label: `${r.process_name} · ${r.id}`,
          at: r.finished_at ?? r.started_at,
          path: `/runs/${r.id}`,
          status: r.status,
          detail: reports.has(r.id) ? 'pdf' : '',
          via,
        });
      break;
    }
    case 'recordType':
    case 'record': {
      // living documents are evidence while an edition is valid, also without changes in the period
      const documents =
        tag.kind === 'recordType'
          ? !!db().get("SELECT 1 FROM record_types WHERE id = ? AND workflow = 'document'", tag.target_id)
          : !!db().get("SELECT 1 FROM records r JOIN record_types t ON t.id = r.type_id WHERE r.id = ? AND t.workflow = 'document'", tag.target_id);
      const rows =
        tag.kind === 'record'
          ? db().all<RecordRow>('SELECT * FROM records WHERE id = ?', tag.target_id)
          : documents
            ? db().all<RecordRow>(
                'SELECT * FROM records r WHERE r.type_id = ? AND EXISTS (SELECT 1 FROM record_editions e WHERE e.record_id = r.id AND e.approved_at <= ?) ORDER BY r.number LIMIT 2000',
                tag.target_id,
                p.to,
              )
            : db().all<RecordRow>(
                `SELECT * FROM records r WHERE r.type_id = ? AND EXISTS (SELECT 1 FROM record_events e WHERE e.record_id = r.id AND ${inPeriodSql('e.created_at')}) ORDER BY r.updated_at DESC LIMIT 2000`,
                tag.target_id,
                p.from,
                p.to,
              );
      for (const r of rows) {
        if (!canReadRecordRow(u, r)) continue;
        if (documents) {
          const doc = documentEvidence(r.id, p.from, p.to);
          if (!doc) continue;
          items.push({
            kind: 'record',
            id: r.id,
            label: `${r.number} ${r.title}`,
            at: doc.lastReviewedAt && doc.lastReviewedAt > doc.approvedAt ? doc.lastReviewedAt : doc.approvedAt,
            path: `/records/${r.id}`,
            status: r.status,
            detail: '',
            via,
            document: doc,
          });
          continue;
        }
        if (tag.kind === 'record' && !db().get(`SELECT 1 FROM record_events WHERE record_id = ? AND ${inPeriodSql('created_at')}`, r.id, p.from, p.to))
          continue;
        if (r.type_id === ACCESS_TYPE_ID) {
          const a = toAccessChange(r, u);
          items.push({
            kind: 'accessChange',
            id: r.id,
            label: `${r.number} ${r.title}`,
            at: a.performedAt || r.updated_at,
            path: `/records/${r.id}`,
            status: r.status,
            detail: a.afterTheFact ? 'afterTheFact' : a.origin,
            via,
          });
        } else
          items.push({
            kind: 'record',
            id: r.id,
            label: `${r.number} ${r.title}`,
            at: r.updated_at,
            path: `/records/${r.id}`,
            status: r.status,
            detail: '',
            via,
          });
      }
      break;
    }
    case 'monitor': {
      const s = db().get<{ ok: number | null; down: number | null; other: number | null }>(
        `SELECT SUM(ok) AS ok, SUM(down) AS down, SUM(other) AS other FROM monitor_samples WHERE monitor_id = ? AND ${inPeriodSql('bucket')}`,
        tag.target_id,
        p.from,
        p.to,
      );
      const changes = Number(
        db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM monitor_history WHERE monitor_id = ? AND ${inPeriodSql('ts')}`, tag.target_id, p.from, p.to)!.n,
      );
      const ok = Number(s?.ok ?? 0);
      const total = ok + Number(s?.down ?? 0) + Number(s?.other ?? 0);
      if (total || changes)
        items.push({
          kind: 'monitor',
          id: tag.target_id,
          label: target.label,
          at: p.to,
          path: target.path,
          status: total ? `${Math.round((ok / total) * 1000) / 10} %` : '',
          detail: `${total} result(s), ${changes} status change(s)`,
          via,
        });
      break;
    }
    case 'reportSchedule': {
      for (const r of db().all<{ id: string; title: string; created_at: string; filename: string }>(
        `SELECT id, title, created_at, filename FROM reports WHERE kind = 'scheduled' AND schedule_id = ? AND ${inPeriodSql('created_at')} ORDER BY created_at DESC LIMIT 500`,
        tag.target_id,
        p.from,
        p.to,
      ))
        items.push({
          kind: 'report',
          id: r.id,
          label: r.title,
          at: r.created_at,
          path: `/reports?report=${encodeURIComponent(r.id)}`,
          status: 'generated',
          detail: r.filename,
          via,
        });
      break;
    }
    case 'accessCheck': {
      for (const s of db().all<{ id: string; seq: number; taken_at: string; subject_count: number; same_as: string | null }>(
        `SELECT id, seq, taken_at, subject_count, same_as FROM access_snapshots WHERE check_id = ? AND ${inPeriodSql('taken_at')} ORDER BY seq DESC LIMIT 1000`,
        tag.target_id,
        p.from,
        p.to,
      ))
        items.push({
          kind: 'snapshot',
          id: s.id,
          label: `${target.label} #${s.seq}`,
          at: s.taken_at,
          path: target.path,
          status: s.same_as ? 'unchanged' : 'stored',
          detail: `${s.subject_count} subject(s)`,
          via,
        });
      for (const f of db().all<{
        id: string;
        subject_id: string;
        subject_name: string;
        kind: string;
        status: string;
        record_id: string | null;
        detected_at: string;
      }>(
        `SELECT id, subject_id, subject_name, kind, status, record_id, detected_at FROM access_findings WHERE check_id = ? AND ${inPeriodSql('detected_at')} ORDER BY detected_at DESC LIMIT 1000`,
        tag.target_id,
        p.from,
        p.to,
      ))
        items.push({
          kind: 'finding',
          id: f.id,
          label: `${f.subject_name || f.subject_id} (${f.kind})`,
          at: f.detected_at,
          path: target.path,
          status: f.status,
          detail: f.record_id ?? '',
          via,
        });
      items.push(...personReviewEvidence(tag.target_id, p, u, via));
      break;
    }
  }
  return items;
}

export const periodQuery = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .refine((p) => Date.parse(p.from) <= Date.parse(p.to), { error: 'from must be before to' })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= 3 * 366 * 86400000, { error: 'The period may be at most three years' });

const normPeriod = (p: Period): Period => ({ from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() });

const evidenceKey = (e: EvidenceItem) => `${e.kind}|${e.id}`;

const uniqueEvidence = (items: EvidenceItem[]) => {
  const seen = new Set<string>();
  return items.filter((e) => (seen.has(evidenceKey(e)) ? false : (seen.add(evidenceKey(e)), true)));
};

/** Evidence items in `everything` that are not in `visible`. */
const countHidden = (everything: EvidenceItem[], visible: EvidenceItem[]): number => {
  const seen = new Set(visible.map(evidenceKey));
  return everything.filter((e) => !seen.has(evidenceKey(e))).length;
};

/** Evidence coverage of every control of a catalogue (or the given controls) in a period. */
export function coverage(p: Period, o: { catalogue?: string; controlIds?: string[] } = {}): ControlCoverage[] {
  const u = me();
  const period = normPeriod(p);
  let controls = listControls(o.catalogue);
  if (o.controlIds) controls = controls.filter((c) => o.controlIds!.includes(c.id));
  const tags = new Map<string, TagRow[]>();
  for (const t of db().all<TagRow>('SELECT * FROM control_tags')) tags.set(t.control_id, [...(tags.get(t.control_id) ?? []), t]);
  // evidence per tagged item is computed once even when it is mapped to several controls
  const cache = new Map<string, EvidenceItem[]>();
  const complete = readsEverything(u);
  const allCache = new Map<string, EvidenceItem[]>();
  return controls.map((control) => {
    const mine = tags.get(control.id) ?? [];
    const all: EvidenceItem[] = [];
    for (const t of mine) {
      const k = `${t.kind}|${t.target_id}`;
      if (!cache.has(k)) cache.set(k, evidenceOf(t, period, u));
      all.push(...cache.get(k)!);
    }
    const unique = uniqueEvidence(all).sort((a, b) => b.at.localeCompare(a.at));
    const counts: Partial<Record<EvidenceKind, number>> = {};
    for (const e of unique) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    let hidden = 0;
    if (!complete && mine.length) {
      // what everyone could see, compared with what this reader sees (counted, never named)
      const everything = uniqueEvidence(
        mine.flatMap((t) => {
          const k = `${t.kind}|${t.target_id}`;
          if (!allCache.has(k))
            allCache.set(
              k,
              runAs(SYSTEM_USER, () => evidenceOf(t, period, SYSTEM_USER)),
            );
          return allCache.get(k)!;
        }),
      );
      hidden = countHidden(everything, unique);
    }
    return {
      control,
      status: coverageStatus(mine.length, unique.length, hidden),
      counts,
      evidence: unique.slice(0, LIMITS.evidencePerControl),
      truncated: Math.max(0, unique.length - LIMITS.evidencePerControl),
      hidden,
    };
  });
}

/**
 * The coverage status of a control (#21), the same on the Controls page, in the API and in evidence packs: "notVisible"
 * when there is evidence, but none the reader may see – not a gap.
 */
export function coverageStatus(mapped: number, visible: number, hidden: number): CoverageStatus {
  if (mapped === 0) return 'unmapped';
  if (visible) return 'covered';
  return hidden ? 'notVisible' : 'gap';
}

/** Coverage of a control in an evidence pack (the same statuses as everywhere). */
export type PackCoverageStatus = CoverageStatus;

/**
 * Full evidence of controls (no list limit) – for evidence packs. `hidden` counts the evidence items
 * the reader may not see (GOV-12): a pack of someone who cannot see everything says how much it
 * leaves out instead of reporting a gap.
 */
export function evidenceForControls(
  controlIds: string[],
  p: Period,
  u: AuthUser | null = currentUser(),
): { control: Control; evidence: EvidenceItem[]; status: PackCoverageStatus; hidden: number }[] {
  const period = normPeriod(p);
  const complete = readsEverything(u);
  return controlIds.map((id) => {
    const control = getControl(id);
    const mine = db().all<TagRow>('SELECT * FROM control_tags WHERE control_id = ?', id);
    const evidence = uniqueEvidence(mine.flatMap((t) => evidenceOf(t, period, u)));
    let hidden = 0;
    if (!complete && mine.length) {
      const all = runAs(SYSTEM_USER, () => uniqueEvidence(mine.flatMap((t) => evidenceOf(t, period, SYSTEM_USER))));
      hidden = countHidden(all, evidence);
    }
    const status = coverageStatus(mine.length, evidence.length, hidden);
    return { control, evidence, status, hidden };
  });
}
