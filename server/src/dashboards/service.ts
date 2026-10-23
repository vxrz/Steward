import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { dashboardDefinitionSchema, type Dashboard, type DashboardDefinition } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { HttpError, MAX_DEFINITION_TEXT, nowIso, parseJson, slugify } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { currentUser } from '../auth/context.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { logger } from '../log.js';

interface DashRow {
  id: string;
  name: string;
  definition: string;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

function canEdit(owner: string | null): boolean {
  const u = currentUser();
  if (!u) return false;
  return isAdmin(u) || (!!owner && owner.toLowerCase() === u.username.toLowerCase());
}

function toDashboard(r: DashRow): Dashboard {
  const definition = parseJson<DashboardDefinition>(r.definition, { name: r.name, widgets: [] });
  return {
    id: r.id,
    name: r.name,
    description: definition.description ?? '',
    definition,
    owner: r.owner,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    canEdit: canEdit(r.owner),
  };
}

export function parseDashboardText(text: string): DashboardDefinition {
  let raw: unknown;
  try {
    raw = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text, { maxBytes: MAX_DEFINITION_TEXT });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Could not parse: ${(e as Error).message}`);
  }
  return checked(raw);
}

function checked(raw: unknown): DashboardDefinition {
  const r = dashboardDefinitionSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'Invalid dashboard: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const ids = new Set<string>();
  for (const w of r.data.widgets) {
    if (ids.has(w.id)) throw new HttpError(400, `Duplicate widget id "${w.id}"`);
    ids.add(w.id);
  }
  return r.data;
}

export function listDashboards(): Dashboard[] {
  return db().all<DashRow>('SELECT * FROM dashboards ORDER BY name').map(toDashboard);
}

export function getDashboard(id: string): Dashboard {
  const r = db().get<DashRow>('SELECT * FROM dashboards WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Dashboard not found');
  return toDashboard(r);
}

export function createDashboard(def: unknown, opts: { id?: string } = {}): Dashboard {
  if (!capabilities(currentUser()).createProcesses) throw new HttpError(403, 'You are not allowed to create dashboards');
  const d = checked(def);
  const base = slugify(opts.id ?? d.name);
  let id = base;
  for (let n = 2; db().get('SELECT 1 FROM dashboards WHERE id = ?', id); n++) id = `${base}-${n}`;
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO dashboards (id, name, definition, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      d.name,
      JSON.stringify(d),
      currentUser()?.username ?? null,
      ts,
      ts,
    );
    audit({ action: 'dashboard.created', entityType: 'dashboard', entityId: id, summary: `Dashboard "${d.name}" created (${d.widgets.length} widgets)` });
  });
  return getDashboard(id);
}

export function saveDashboard(id: string, def: unknown): Dashboard {
  const before = getDashboard(id);
  if (!before.canEdit) throw new HttpError(403, 'Only the owner or an administrator can change this dashboard');
  const d = checked(def);
  db().tx(() => {
    db().run('UPDATE dashboards SET name = ?, definition = ?, updated_at = ? WHERE id = ?', d.name, JSON.stringify(d), nowIso(), id);
    audit({ action: 'dashboard.updated', entityType: 'dashboard', entityId: id, summary: `Dashboard "${d.name}" updated (${d.widgets.length} widgets)` });
  });
  return getDashboard(id);
}

export function deleteDashboard(id: string): void {
  const d = getDashboard(id);
  if (!d.canEdit) throw new HttpError(403, 'Only the owner or an administrator can delete this dashboard');
  db().tx(() => {
    db().run('DELETE FROM dashboards WHERE id = ?', id);
    audit({ action: 'dashboard.deleted', entityType: 'dashboard', entityId: id, summary: `Dashboard "${d.name}" deleted` });
  });
}

export function dashboardYaml(d: Dashboard): string {
  return YAML.stringify(d.definition, { lineWidth: 0 });
}

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  definition: DashboardDefinition;
}

export function listDashboardTemplates(): DashboardTemplate[] {
  const dir = (config as { dashboardsDir?: string }).dashboardsDir;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .flatMap((f) => {
      try {
        const d = parseDashboardText(fs.readFileSync(path.join(dir, f), 'utf8'));
        return [{ id: f.replace(/\.ya?ml$/, ''), name: d.name, description: d.description ?? '', definition: d }];
      } catch (e) {
        logger.warn({ template: f, error: (e as Error).message }, 'invalid dashboard template');
        return [];
      }
    });
}

/** Datasets referenced by a dashboard. */
export function datasetsOf(def: DashboardDefinition): string[] {
  return [...new Set(def.widgets.map((w) => w.dataset).filter((x): x is string => !!x))];
}
