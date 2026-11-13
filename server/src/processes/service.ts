import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  SYNC_MIN_VERSION_RE,
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
import { processPermissions } from '../auth/permissions.js';
import { runOutcome, type ProcessPermission } from '@sm/shared';
import { aclOf, aliasWidens, writeAlias } from '../auth/acl-shares.js';
import { heldOn, isRestricted } from '../auth/shares.js';
import { ACCESS_AUDIT, auditAccessChange, requireAccessGrant } from '../auth/access-change.js';
import { me } from '../auth/access.js';
import { PROCESS_SHARE_KIND } from './shares.js';
import { HttpError, MAX_DEFINITION_TEXT, canonicalJson, nowIso, parseJson, sha256, slugify } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { assignCreatorTeams } from '../auth/policy.js';
import { datasetsOf, listDashboardTemplates } from '../dashboards/service.js';

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

type LastRunRow = { lr_id: string | null; lr_status: RunStatus | null; lr_started_at: string | null; lr_stats: string | null };

/**
 * The process row with its latest run (debug runs left out) in the same statement: an indexed lookup per process inside
 * the database (runs_process), not a statement each (security review 0.19.0 H2).
 */
const WITH_LAST_RUN = `SELECT p.*, lr.id AS lr_id, lr.status AS lr_status, lr.started_at AS lr_started_at, lr.stats AS lr_stats
  FROM processes p
  LEFT JOIN runs lr ON lr.id = (SELECT x.id FROM runs x WHERE x.process_id = p.id AND x.debug IS NULL ORDER BY x.started_at DESC LIMIT 1)`;

function lastRunOf(r: LastRunRow): ProcessSummary['lastRun'] {
  if (!r.lr_id) return null;
  // outcome: "findings" when it succeeded with failed checks (the status stays)
  const outcome = runOutcome(r.lr_status!, parseJson<{ checksFailed?: number }>(r.lr_stats ?? '{}', {}).checksFailed ?? 0);
  return { id: r.lr_id, status: r.lr_status!, outcome, startedAt: r.lr_started_at! };
}

function toSummary(r: ProcessRow & LastRunRow): ProcessSummary {
  const permissions = processPermissions(currentUser(), { id: r.id, owner: r.owner });
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    tags: parseJson<string[]>(r.tags, []),
    currentVersion: r.current_version,
    updatedAt: r.updated_at,
    lastRun: lastRunOf(r),
    owner: r.owner,
    // deprecated (0.23.0): the shares as the former access list, for who may change them
    acl: permissions.includes('manage') ? aclOf('process', r.id) : [],
    restricted: isRestricted('process', r.id),
    permissions,
  };
}

/** Processes the current user may see. */
export function listProcesses(): ProcessSummary[] {
  return db()
    .all<ProcessRow & LastRunRow>(`${WITH_LAST_RUN} WHERE p.archived = 0 ORDER BY p.name`)
    .map(toSummary)
    .filter((p) => p.permissions.includes('view'));
}

/** Permissions of the current user on a process (also for archived ones). */
export function permissionsFor(processId: string): ProcessPermission[] {
  const r = db().get<ProcessRow>('SELECT * FROM processes WHERE id = ?', processId);
  if (!r) return [];
  return processPermissions(currentUser(), { id: r.id, owner: r.owner, acl: parseJson(r.acl, []) });
}

/** The current user's permissions on every process (also archived ones), in one statement – for lists of schedules, triggers … */
export function processPermissionMap(): Map<string, ProcessPermission[]> {
  const u = currentUser();
  return new Map(
    db()
      .all<{ id: string; owner: string | null; acl: string }>('SELECT id, owner, acl FROM processes')
      .map((r) => [r.id, processPermissions(u, { id: r.id, owner: r.owner, acl: parseJson(r.acl, []) })]),
  );
}

/**
 * The processes the current user may view (also archived ones), in one statement: for run, task and dataset lists of
 * the web app, the public API and MCP (each had its own copy before, two of them with a statement per process).
 */
export function visibleProcessIds(): Set<string> {
  const ids = new Set<string>();
  for (const [id, perms] of processPermissionMap()) if (perms.includes('view')) ids.add(id);
  return ids;
}

/**
 * `PUT /processes/:id/access` (deprecated since 0.23.0, ADR 0033 phase 2): the access list – written as shares and the
 * Restricted scope (auth/acl-shares.ts) – and the owner. Either may be left out. A new owner has every right: a
 * widening, confirmed by the route's step-up and audited as `access.owner_changed`.
 */
export function setProcessAccess(id: string, input: { acl?: unknown; owner?: string | null }): ProcessDetail {
  const before = getProcess(id);
  const owner = input.owner === undefined ? before.owner : input.owner?.trim() || null;
  const label = `process "${before.name}"`;
  // a new owner has every right: a widening unless they had them all (decided before anything is written)
  const ownerWidens = aliasWidens('process', id, undefined, { before: before.owner ?? null, after: owner ?? null });
  db().tx(() => {
    if (input.acl !== undefined) writeAlias({ kind: 'process', id, aclInput: input.acl, held: heldOn(PROCESS_SHARE_KIND, me(), id), label });
    if ((owner ?? '').toLowerCase() !== (before.owner ?? '').toLowerCase()) {
      if (ownerWidens) requireAccessGrant();
      db().run('UPDATE processes SET owner = ?, updated_at = ? WHERE id = ?', owner, nowIso(), id);
      auditAccessChange({
        action: ACCESS_AUDIT.ownerChanged,
        entityType: 'process',
        entityId: id,
        summary: `Owner of ${label}: ${before.owner ?? '–'} → ${owner ?? '–'}${owner ? ' (every right on it)' : ''}`,
        details: { field: 'owner', before: before.owner, after: owner, ...(owner ? { granted: [{ subject: `user:${owner.toLowerCase()}`, rights: ['all'] }] } : {}) },
      });
    }
  });
  return getProcess(id);
}

export function getProcess(id: string, version?: number): ProcessDetail {
  const r = db().get<ProcessRow & LastRunRow>(`${WITH_LAST_RUN} WHERE p.id = ?`, id);
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

export function createProcess(def: unknown, opts: { id?: string; comment?: string; exactId?: boolean } = {}): ProcessDetail {
  const d = checked(def);
  let id = opts.id ? slugify(opts.id) : slugify(d.name);
  // an id the person chose is not changed behind their back (archived processes keep theirs too)
  if (opts.exactId && db().get('SELECT 1 FROM processes WHERE id = ?', id))
    throw new HttpError(409, `A process with the id "${id}" exists already`, 'PROCESS_ID_TAKEN', { id });
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
    assignCreatorTeams('process', id, currentUser());
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
    .all<{ version: number; hash: string; author: string; comment: string; created_at: string; origin: string | null }>(
      'SELECT version, hash, author, comment, created_at, origin FROM process_versions WHERE process_id = ? ORDER BY version DESC',
      id,
    )
    .map((v) => ({
      version: v.version,
      hash: v.hash,
      author: v.author,
      comment: v.comment,
      createdAt: v.created_at,
      // the library release a version came from (0.10.0, ADR 0014)
      ...(v.origin ? { origin: parseJson<ProcessVersion['origin']>(v.origin, null) } : {}),
    }));
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
    return text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxBytes: MAX_DEFINITION_TEXT });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Could not parse: ${(e as Error).message}`);
  }
}

export function toYaml(def: ProcessDefinition): string {
  return YAML.stringify(def, { lineWidth: 0 });
}

// ---------- Templates ----------

/** The template files, sorted (the ids are the file names without .yaml). */
function templateFiles(): string[] {
  if (!fs.existsSync(config.templatesDir)) return [];
  return fs
    .readdirSync(config.templatesDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

/** One template file, parsed and validated (the definition falls back to the parsed text if it is invalid). */
function readTemplate(file: string): { text: string; def: ProcessDefinition; definition: ProcessDefinition } {
  const text = fs.readFileSync(path.join(config.templatesDir, file), 'utf8');
  const def = parseDefinitionText(text) as ProcessDefinition;
  const res = validateProcess(def);
  if (!res.ok) logger.warn({ template: file, issues: res.issues }, 'invalid template');
  return { text, def, definition: res.definition ?? def };
}

export function listTemplates(): ProcessTemplate[] {
  const files = templateFiles();
  if (!files.length) return [];
  const dashboards = templateDashboards();
  return files.map((f) => {
    const { text, def, definition } = readTemplate(f);
    const meta = templateMeta(def as unknown as Record<string, unknown>, definition, text);
    return {
      id: f.replace(/\.ya?ml$/, ''),
      name: def.name,
      description: def.description ?? '',
      tags: def.tags ?? [],
      definition,
      ...meta,
      dashboards: dashboards.filter((d) => d.datasets.some((x) => meta.datasets.includes(x))).map(({ id, name }) => ({ id, name })),
    };
  });
}

/** The dashboard templates with the datasets they read (for "feeds these dashboards"). */
function templateDashboards(): { id: string; name: string; datasets: string[] }[] {
  try {
    return listDashboardTemplates().map((t) => ({ id: t.id, name: t.name, datasets: datasetsOf(t.definition) }));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'dashboard templates not readable');
    return [];
  }
}

const CRON_RE = /^(\S+\s+){4}\S+$/;

/**
 * Gallery metadata of a template (0.3.1): what it needs, when to run it, what it writes. Read from the raw file, so
 * hints the definition schema does not keep (`recommendedSchedule`, `connections[].kinds`) are seen; a process created
 * from the template does not carry them, and older versions ignore them.
 */
function templateMeta(
  raw: Record<string, unknown>,
  def: ProcessDefinition,
  text: string,
): Pick<Required<ProcessTemplate>, 'connections' | 'connectionKinds' | 'recommendedSchedule' | 'datasets' | 'minVersion'> {
  const rawSlots = Array.isArray(raw.connections) ? (raw.connections as Record<string, unknown>[]) : [];
  const connections = (def.connections ?? []).map((c) => {
    const hint = rawSlots.find((x) => x && x.slot === c.slot)?.kinds;
    const kinds = c.kind ? [c.kind] : Array.isArray(hint) ? [...new Set(hint.filter((k): k is string => typeof k === 'string' && !!k))] : [];
    return { slot: c.slot, kinds, description: c.description ?? '' };
  });
  // the sentence ends at a full stop (not the one of "e.g." or "i.e.") or an empty line
  const sentence = /Recommended schedule:\s*([\s\S]*?)(?:(?<!\b(?:e\.g|i\.e))\.(?=\s|$)|\n\s*\n|$)/i
    .exec(def.description ?? '')?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
  const declared = typeof raw.recommendedSchedule === 'string' && CRON_RE.test(raw.recommendedSchedule.trim()) ? raw.recommendedSchedule.trim() : null;
  const inText = sentence ? [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).find((x) => CRON_RE.test(x)) : undefined;
  const datasets = new Set<string>();
  for (const n of def.nodes ?? []) if (n.type === 'publish' && n.dataset) datasets.add(n.dataset);
  let minVersion: string | null = null;
  for (const line of text.split(/\r?\n/, 30)) {
    const l = line.trim();
    if (l === '' || l === '---') continue;
    if (!l.startsWith('#')) break;
    const m = SYNC_MIN_VERSION_RE.exec(l);
    if (m) {
      minVersion = m[1]!;
      break;
    }
  }
  return {
    connections,
    connectionKinds: [...new Set(connections.flatMap((c) => c.kinds))].sort(),
    recommendedSchedule: sentence || declared ? { cron: declared ?? inText ?? null, text: sentence ?? '' } : null,
    datasets: [...datasets].sort(),
    minVersion,
  };
}

export function createFromTemplate(templateId: string): ProcessDetail {
  // reads only this template's file: the gallery metadata of listTemplates() is not needed here
  const file = templateFiles().find((f) => f.replace(/\.ya?ml$/, '') === templateId);
  if (!file) throw new HttpError(404, 'Template not found');
  const { definition } = readTemplate(file);
  return createProcess(definition, { id: templateId.replace(/^\d+-/, ''), comment: `Created from template ${templateId}` });
}
