import path from 'node:path';
import YAML from 'yaml';
import { BUNDLE_FORMATS, SYNC_LIMITS, dashboardDefinitionSchema, validateProcess, type ProcessDefinition, type SyncKind } from '@sm/shared';
import { parseYamlDocument } from '../yaml-safe.js';
import { db } from '../db.js';
import { canonicalJson, HttpError, parseJson, sha256, slugify } from '../util.js';
import { currentUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { findSecret } from '../credentials/secrets.js';
import * as processes from '../processes/service.js';
import * as dashboards from '../dashboards/service.js';
import * as monitors from '../monitors/service.js';
import { validateMonitorFile } from '../monitors/validation.js';
import { canCreateMonitors, monitorRow, permissionsOfRow } from '../monitors/model.js';
import { resolvePlatformRef } from '../monitors/platforms.js';
import * as recordTypes from '../records/types.js';
import { canManageRecordTypes } from '../records/access.js';

/**
 * The four kinds of items a Git sync source can bring in, in the formats Steward already
 * imports and exports: process YAML/JSON (graph or sequential steps), dashboard YAML,
 * monitor files (`kind: monitor` / `kind: monitorTemplate`, platforms by name or id) and
 * record type files (`kind: recordType`). Files are parsed as data only – nothing in them is run.
 */

export interface ParsedItem {
  kind: SyncKind;
  /** The Steward id (process, dashboard), key (monitor, record type) the file stands for */
  identity: string;
  name: string;
  /** What is applied on acceptance */
  content: unknown;
  /** Hash of the normalised content (unchanged files are recognised by it) */
  hash: string;
}

export type ParseResult = { ok: true; item: ParsedItem } | { ok: false; kind: SyncKind | null; identity: string | null; errors: string[]; hash: string };

/** Parse YAML as plain data: core schema, unique keys (checked in linear time), bounded size and aliases (no "billion laughs"), no custom tags. */
export function parseData(text: string, file: string): unknown {
  if (file.toLowerCase().endsWith('.json')) return JSON.parse(text);
  const doc = parseYamlDocument(text, { schema: 'core', customTags: [], maxBytes: SYNC_LIMITS.maxFileBytes });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  if (doc.warnings.some((w) => w.code === 'TAG_RESOLVE_FAILED')) throw new Error('unknown YAML tags are not allowed');
  return doc.toJS({ maxAliasCount: 100 });
}

/** "10-ih-health-check.yaml" → "ih-health-check" (the example library's numbering is dropped, like for templates). */
const baseId = (file: string) =>
  slugify(
    path.posix
      .basename(file)
      .replace(/\.(ya?ml|json)$/i, '')
      .replace(/^\d+-/, ''),
  );

export function classify(raw: unknown): SyncKind | 'bundle' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if ((BUNDLE_FORMATS as readonly unknown[]).includes(o.format)) return 'bundle';
  if (o.kind === 'monitor' || o.kind === 'monitorTemplate') return 'monitor';
  if (o.kind === 'recordType') return 'recordType';
  if (Array.isArray(o.widgets)) return 'dashboard';
  if (Array.isArray(o.nodes) || Array.isArray(o.steps)) return 'process';
  return null;
}

/** Platform references of a monitor file (checks and outputs) – names or ids, never credentials. */
function monitorPlatformRefs(raw: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const list of [raw.checks, raw.outputs]) {
    if (!Array.isArray(list)) continue;
    for (const c of list)
      if (c && typeof c === 'object' && typeof (c as { platform?: unknown }).platform === 'string') refs.push((c as { platform: string }).platform);
  }
  return refs;
}

/** Validates one file with the existing validators. Never throws. */
export async function parseFile(file: string, text: string, kinds: SyncKind[]): Promise<ParseResult> {
  const hash = sha256(text);
  const fail = (kind: SyncKind | null, errors: string[], identity: string | null = null): ParseResult => ({ ok: false, kind, identity, errors, hash });
  // credentials never belong in a repository: refuse the whole file (the value is not echoed)
  const secret = findSecret(text);
  if (secret) return fail(null, [`The file looks like it contains ${secret}. Keep credentials in Steward's vault; files in Git may only name platforms.`]);
  let raw: unknown;
  try {
    raw = parseData(text, file);
  } catch (e) {
    return fail(null, [`Cannot parse: ${(e as Error).message}`]);
  }
  const kind = classify(raw);
  if (kind === 'bundle') return fail(null, ['Bundles are not synced – keep one process, dashboard, monitor or record type per file']);
  if (!kind) return fail(null, ['Not a Steward definition (process, dashboard, monitor or record type)']);
  if (!kinds.includes(kind)) return fail(kind, [`This source does not sync ${kind} files`]);
  const o = raw as Record<string, unknown>;
  const fileId = typeof o.id === 'string' && o.id.trim() ? slugify(o.id) : baseId(file);
  switch (kind) {
    case 'process': {
      const r = validateProcess(raw);
      if (!r.ok || !r.definition)
        return fail(
          kind,
          r.issues.map((i) => `${i.nodeId ? `[${i.nodeId}] ` : ''}${i.path} ${i.message}`.trim()),
          fileId,
        );
      return { ok: true, item: { kind, identity: fileId, name: r.definition.name, content: r.definition, hash: processes.definitionHash(r.definition) } };
    }
    case 'dashboard': {
      const r = dashboardDefinitionSchema.safeParse(raw);
      if (!r.success)
        return fail(
          kind,
          r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          fileId,
        );
      const ids = r.data.widgets.map((w) => w.id);
      if (new Set(ids).size !== ids.length) return fail(kind, ['Duplicate widget ids'], fileId);
      return { ok: true, item: { kind, identity: fileId, name: r.data.name, content: r.data, hash: sha256(canonicalJson(r.data)) } };
    }
    case 'monitor': {
      const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim().toLowerCase() : baseId(file);
      const r = await validateMonitorFile(raw);
      if (!r.ok) return fail(kind, r.issues, key);
      const errors: string[] = [];
      for (const ref of monitorPlatformRefs(o)) {
        try {
          resolvePlatformRef(ref);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (errors.length) return fail(kind, errors, key);
      const content = { ...o, key };
      return { ok: true, item: { kind, identity: key, name: String(o.name ?? key), content, hash: sha256(canonicalJson(content)) } };
    }
    case 'recordType': {
      const { kind: _k, ...rest } = o;
      const r = recordTypes.typeInput.safeParse(rest);
      if (!r.success)
        return fail(
          kind,
          r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          typeof o.key === 'string' ? o.key.toUpperCase() : null,
        );
      return { ok: true, item: { kind, identity: r.data.key, name: r.data.name, content: r.data, hash: sha256(canonicalJson(r.data)) } };
    }
  }
}

// ---------- the local side ----------

export interface LocalItem {
  /** Steward id (process/dashboard id, monitor id, record type id) */
  id: string;
  name: string;
}

/** The local item a file identity stands for (archived processes count as gone). */
export function findLocal(kind: SyncKind, identity: string): LocalItem | null {
  switch (kind) {
    case 'process': {
      const r = db().get<{ id: string; name: string }>('SELECT id, name FROM processes WHERE id = ? AND archived = 0', identity);
      return r ?? null;
    }
    case 'dashboard':
      return db().get<{ id: string; name: string }>('SELECT id, name FROM dashboards WHERE id = ?', identity) ?? null;
    case 'monitor': {
      const r = monitorRow(identity);
      return r ? { id: r.id, name: r.name } : null;
    }
    case 'recordType': {
      const r = db().get<{ id: string; name: string }>('SELECT id, name FROM record_types WHERE key = ?', identity.toUpperCase());
      return r ?? null;
    }
  }
}

/** A local item by its Steward id (for mapped items). */
export function localById(kind: SyncKind, id: string): LocalItem | null {
  switch (kind) {
    case 'process':
      return db().get<{ id: string; name: string }>('SELECT id, name FROM processes WHERE id = ? AND archived = 0', id) ?? null;
    case 'dashboard':
      return db().get<{ id: string; name: string }>('SELECT id, name FROM dashboards WHERE id = ?', id) ?? null;
    case 'monitor':
      return db().get<{ id: string; name: string }>('SELECT id, name FROM monitors WHERE id = ?', id) ?? null;
    case 'recordType':
      return db().get<{ id: string; name: string }>('SELECT id, name FROM record_types WHERE id = ?', id) ?? null;
  }
}

const typeShape = (r: recordTypes.TypeRow) => ({
  key: r.key,
  name: r.name,
  description: r.description,
  workflow: r.workflow,
  template: r.template,
  fields: parseJson(r.fields, []),
  ...(r.workflow === 'document' ? { reviewIntervalMonths: recordTypes.typeReviewInterval(r) } : {}),
  ...(r.archived ? { archived: true } : {}),
});

/** Hash of the local item as stored now (compared with the hash recorded when it was last synced). */
export function localHash(kind: SyncKind, id: string): string | null {
  switch (kind) {
    case 'process': {
      const r = db().get<{ hash: string }>(
        'SELECT v.hash FROM processes p JOIN process_versions v ON v.process_id = p.id AND v.version = p.current_version WHERE p.id = ?',
        id,
      );
      return r?.hash ?? null;
    }
    case 'dashboard': {
      const r = db().get<{ definition: string }>('SELECT definition FROM dashboards WHERE id = ?', id);
      return r ? sha256(canonicalJson(parseJson(r.definition, {}))) : null;
    }
    case 'monitor': {
      const r = db().get<{ definition: string; key: string; is_template: number }>('SELECT definition, key, is_template FROM monitors WHERE id = ?', id);
      return r ? sha256(canonicalJson({ key: r.key, template: !!r.is_template, def: parseJson(r.definition, {}) })) : null;
    }
    case 'recordType': {
      const r = db().get<recordTypes.TypeRow>('SELECT * FROM record_types WHERE id = ?', id);
      return r ? sha256(canonicalJson(typeShape(r))) : null;
    }
  }
}

/** Whether the incoming content is already what is stored locally (an item can then be linked without an update). */
export function sameAsLocal(item: ParsedItem, id: string): boolean {
  if (item.kind === 'monitor') return false; // stored with resolved platform ids: never byte-identical
  return localHash(item.kind, id) === item.hash;
}

const yaml = (v: unknown) => YAML.stringify(JSON.parse(JSON.stringify(v)), { lineWidth: 0 });

/** The local item as YAML in the same format as the incoming file (for the diff). */
export function localText(kind: SyncKind, id: string): { text: string; definition?: unknown } | null {
  try {
    switch (kind) {
      case 'process': {
        const p = processes.getProcess(id);
        return { text: yaml(p.definition), definition: p.definition };
      }
      case 'dashboard':
        return { text: yaml(dashboards.getDashboard(id).definition) };
      case 'monitor':
        return { text: monitors.exportMonitor(id) };
      case 'recordType': {
        const r = db().get<recordTypes.TypeRow>('SELECT * FROM record_types WHERE id = ?', id);
        return r ? { text: yaml({ kind: 'recordType', ...typeShape(r) }) } : null;
      }
    }
  } catch {
    return null;
  }
}

export function incomingText(kind: SyncKind, content: unknown): string {
  return yaml(kind === 'recordType' ? { kind: 'recordType', ...(content as object) } : content);
}

// ---------- permissions and applying ----------

/**
 * May the current user see the local item an update maps to? Processes and monitors have access
 * lists; dashboards and record types are visible to every signed-in user. An item that no longer
 * exists hides nothing.
 */
export function canView(kind: SyncKind, entityId: string): boolean {
  switch (kind) {
    case 'process': {
      if (!db().get('SELECT 1 FROM processes WHERE id = ?', entityId)) return true;
      return processes.permissionsFor(entityId).includes('view');
    }
    case 'monitor': {
      const r = db().get<Parameters<typeof permissionsOfRow>[0]>('SELECT owner, acl FROM monitors WHERE id = ?', entityId);
      return !r || permissionsOfRow(r).includes('view');
    }
    case 'dashboard':
    case 'recordType':
      return true;
  }
}

/** May the current user accept or reject this update (the same rights as creating or editing the item by hand)? */
export function canDecide(kind: SyncKind, entityId: string | null): boolean {
  const u = currentUser();
  if (!u) return false;
  const local = entityId ? localById(kind, entityId) : null;
  switch (kind) {
    case 'process':
      return local ? processes.permissionsFor(local.id).includes('edit') : capabilities(u).createProcesses;
    case 'dashboard': {
      if (!local) return capabilities(u).createProcesses;
      const owner = db().get<{ owner: string | null }>('SELECT owner FROM dashboards WHERE id = ?', local.id)?.owner;
      return isAdmin(u) || (!!owner && owner.toLowerCase() === u.username.toLowerCase());
    }
    case 'monitor': {
      if (!local) return canCreateMonitors(u);
      const r = monitorRow(local.id);
      return !!r && permissionsOfRow(r, u).includes('edit');
    }
    case 'recordType':
      return canManageRecordTypes(u);
  }
}

export interface ApplyResult {
  entityId: string;
  version: number | null;
}

/**
 * Creates or updates the item through the normal services (their own validation and permission
 * checks apply). Processes get a new version; monitors from Git are created disabled when `disabled`.
 */
export async function applyItem(
  kind: SyncKind,
  content: unknown,
  target: string | null,
  o: { identity: string; comment: string; disabled?: boolean },
): Promise<ApplyResult> {
  switch (kind) {
    case 'process': {
      if (target) {
        const p = processes.permissionsFor(target);
        if (!p.includes('view')) throw new HttpError(404, `Process ${target} not found`, 'PROCESS_NOT_FOUND', { id: target });
        if (!p.includes('edit')) throw new HttpError(403, 'You are not allowed to edit this process', 'FORBIDDEN', { context: 'editProcess' });
        const d = processes.saveProcess(target, content, o.comment);
        return { entityId: d.id, version: d.currentVersion };
      }
      if (!capabilities(currentUser()).createProcesses)
        throw new HttpError(403, 'You are not allowed to create processes', 'FORBIDDEN', { context: 'createProcess' });
      const d = processes.createProcess(content as ProcessDefinition, { id: o.identity, comment: o.comment });
      return { entityId: d.id, version: d.currentVersion };
    }
    case 'dashboard': {
      const d = target ? dashboards.saveDashboard(target, content) : dashboards.createDashboard(content, { id: o.identity });
      return { entityId: d.id, version: null };
    }
    case 'monitor': {
      const { kind: k, key, enabled, ...definition } = content as Record<string, unknown>;
      const isTemplate = k === 'monitorTemplate';
      if (target) {
        const r = await monitors.updateMonitor(target, { key: key as string, isTemplate, definition });
        return { entityId: r.monitor.id, version: r.monitor.version };
      }
      const r = await monitors.createMonitor({
        key: key as string,
        enabled: o.disabled ? false : (enabled as boolean | undefined),
        isTemplate,
        definition,
      });
      return { entityId: r.monitor.id, version: r.monitor.version };
    }
    case 'recordType': {
      const input = recordTypes.typeInput.parse(content);
      const t = target ? recordTypes.updateType(target, input) : recordTypes.createType(input);
      return { entityId: t.id, version: null };
    }
  }
}
