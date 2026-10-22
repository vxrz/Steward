import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  validateProcess,
  type ProcessDefinition,
  type ProcessDetail,
  type ProcessSummary,
  type ProcessTemplate,
  type ProcessVersion,
  type RunStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { currentActor, currentUser } from '../auth/context.js';
import { logger } from '../log.js';
import { cleanAcl, processPermissions } from '../auth/permissions.js';
import { PROCESS_PERMISSIONS, type AclEntry, type ProcessPermission } from '@sm/shared';
import { HttpError, canonicalJson, nowIso, parseJson, sha256, slugify } from '../util.js';

interface ProcessRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  current_version: number;
  archived: number;
  created_at: string;
  updated_at: string;
  acl: string;
  owner: string | null;
}

export const definitionHash = (d: ProcessDefinition): string => sha256(canonicalJson(d));

function lastRun(processId: string): ProcessSummary['lastRun'] {
  const r = db().get<{ id: string; status: RunStatus; started_at: string }>(
    'SELECT id, status, started_at FROM runs WHERE process_id = ? ORDER BY started_at DESC LIMIT 1',
    processId,
  );
  return r ? { id: r.id, status: r.status, startedAt: r.started_at } : null;
}

function toSummary(r: ProcessRow): ProcessSummary {
  const acl = parseJson<AclEntry<ProcessPermission>[]>(r.acl, []);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    tags: parseJson<string[]>(r.tags, []),
    currentVersion: r.current_version,
    updatedAt: r.updated_at,
    lastRun: lastRun(r.id),
    owner: r.owner,
    acl,
    permissions: processPermissions(currentUser(), { owner: r.owner, acl }),
  };
}

/** Processes the current user may see. */
export function listProcesses(): ProcessSummary[] {
  return db()
    .all<ProcessRow>('SELECT * FROM processes WHERE archived = 0 ORDER BY name')
    .map(toSummary)
    .filter((p) => p.permissions.includes('view'));
}

/** Permissions of the current user on a process (also for archived ones). */
export function permissionsFor(processId: string): ProcessPermission[] {
  const r = db().get<ProcessRow>('SELECT * FROM processes WHERE id = ?', processId);
  if (!r) return [];
  return processPermissions(currentUser(), { owner: r.owner, acl: parseJson(r.acl, []) });
}

export function setProcessAccess(id: string, input: { acl: unknown; owner?: string | null }): ProcessDetail {
  const before = getProcess(id);
  const acl = cleanAcl(input.acl, PROCESS_PERMISSIONS);
  const owner = input.owner === undefined ? before.owner : input.owner;
  db().tx(() => {
    db().run('UPDATE processes SET acl = ?, owner = ?, updated_at = ? WHERE id = ?', JSON.stringify(acl), owner ?? null, nowIso(), id);
    audit({
      action: 'process.access_changed',
      entityType: 'process',
      entityId: id,
      summary: `Access of "${before.name}" changed: ${acl.length ? acl.map((e) => `${e.subject} (${e.permissions.join('/')})`).join(', ') : 'default role rights'}${owner !== before.owner ? `; owner ${before.owner ?? '–'} → ${owner ?? '–'}` : ''}`,
      details: { acl, owner, previous: { acl: before.acl, owner: before.owner } },
    });
  });
  return getProcess(id);
}

export function getProcess(id: string, version?: number): ProcessDetail {
  const r = db().get<ProcessRow>('SELECT * FROM processes WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Process ${id} not found`);
  const v = db().get<{ definition: string; hash: string }>(
    'SELECT definition, hash FROM process_versions WHERE process_id = ? AND version = ?',
    id,
    version ?? r.current_version,
  );
  if (!v) throw new HttpError(404, `Version ${version} not found`);
  let definition = JSON.parse(v.definition) as ProcessDefinition;
  if (!Array.isArray(definition.nodes)) definition = validateProcess(definition).definition ?? definition; // legacy step format
  return { ...toSummary(r), definition, definitionHash: v.hash };
}

function checked(def: unknown): ProcessDefinition {
  const res = validateProcess(def);
  if (!res.ok || !res.definition) {
    const err = new HttpError(400, 'Invalid process: ' + res.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    (err as HttpError & { issues: unknown }).issues = res.issues;
    throw err;
  }
  return res.definition;
}

export function createProcess(def: unknown, opts: { id?: string; comment?: string } = {}): ProcessDetail {
  const d = checked(def);
  let id = opts.id ? slugify(opts.id) : slugify(d.name);
  let n = 2;
  const base = id;
  while (db().get('SELECT 1 FROM processes WHERE id = ?', id)) id = `${base}-${n++}`;
  const ts = nowIso();
  const hash = definitionHash(d);
  db().tx(() => {
    db().run(
      'INSERT INTO processes (id, name, description, tags, current_version, created_at, updated_at, owner) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      id,
      d.name,
      d.description ?? '',
      JSON.stringify(d.tags ?? []),
      ts,
      ts,
      currentUser()?.username ?? null,
    );
    db().run(
      'INSERT INTO process_versions (process_id, version, definition, hash, author, comment, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)',
      id,
      JSON.stringify(d),
      hash,
      currentActor(),
      opts.comment ?? 'Created',
      ts,
    );
    audit({
      action: 'process.created',
      entityType: 'process',
      entityId: id,
      summary: `Process "${d.name}" created (v1)`,
      details: { version: 1, hash, comment: opts.comment },
    });
  });
  return getProcess(id);
}

export function saveProcess(id: string, def: unknown, comment = ''): ProcessDetail {
  const current = getProcess(id);
  const d = checked(def);
  const hash = definitionHash(d);
  if (hash === current.definitionHash) return current;
  const version = current.currentVersion + 1;
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO process_versions (process_id, version, definition, hash, author, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      version,
      JSON.stringify(d),
      hash,
      currentActor(),
      comment,
      ts,
    );
    db().run(
      'UPDATE processes SET name=?, description=?, tags=?, current_version=?, updated_at=? WHERE id=?',
      d.name,
      d.description ?? '',
      JSON.stringify(d.tags ?? []),
      version,
      ts,
      id,
    );
    audit({
      action: 'process.version_saved',
      entityType: 'process',
      entityId: id,
      summary: `Process "${d.name}" saved as v${version}${comment ? `: ${comment}` : ''}`,
      details: { version, hash, previousHash: current.definitionHash, comment },
    });
  });
  return getProcess(id);
}

export function listVersions(id: string): ProcessVersion[] {
  getProcess(id);
  return db()
    .all<{ version: number; hash: string; author: string; comment: string; created_at: string }>(
      'SELECT version, hash, author, comment, created_at FROM process_versions WHERE process_id = ? ORDER BY version DESC',
      id,
    )
    .map((v) => ({ version: v.version, hash: v.hash, author: v.author, comment: v.comment, createdAt: v.created_at }));
}

export function archiveProcess(id: string): void {
  const p = getProcess(id);
  db().tx(() => {
    db().run('UPDATE processes SET archived = 1, updated_at = ? WHERE id = ?', nowIso(), id);
    db().run('UPDATE schedules SET enabled = 0 WHERE process_id = ?', id);
    audit({ action: 'process.archived', entityType: 'process', entityId: id, summary: `Process "${p.name}" archived` });
  });
}

export function parseDefinitionText(text: string): unknown {
  try {
    return text.trim().startsWith('{') ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    throw new HttpError(400, `Could not parse: ${(e as Error).message}`);
  }
}

export function toYaml(def: ProcessDefinition): string {
  return YAML.stringify(def, { lineWidth: 0 });
}

// ---------- Templates ----------

export function listTemplates(): ProcessTemplate[] {
  if (!fs.existsSync(config.templatesDir)) return [];
  return fs
    .readdirSync(config.templatesDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const def = parseDefinitionText(fs.readFileSync(path.join(config.templatesDir, f), 'utf8')) as ProcessDefinition;
      const res = validateProcess(def);
      if (!res.ok) logger.warn({ template: f, issues: res.issues }, 'invalid template');
      return {
        id: f.replace(/\.ya?ml$/, ''),
        name: def.name,
        description: def.description ?? '',
        tags: def.tags ?? [],
        definition: res.definition ?? def,
      };
    });
}

export function createFromTemplate(templateId: string): ProcessDetail {
  const t = listTemplates().find((x) => x.id === templateId);
  if (!t) throw new HttpError(404, 'Template not found');
  return createProcess(t.definition, { id: t.id.replace(/^\d+-/, ''), comment: `Created from template ${t.id}` });
}
