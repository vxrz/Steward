import {
  MAP_SOURCES,
  MODULES,
  moduleDef,
  moduleOfRoute,
  moduleRestrictable,
  moduleRolesOf,
  type ModuleAccessMode,
  type ModuleId,
  type ModuleStates,
  type ModulesView,
  type ModuleState,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { readSetting, writeSetting } from '../settings.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso } from '../util.js';
import { plantEnabled, plantSettings, updatePlantSettings } from '../plant/settings.js';

/**
 * The module registry (0.11.0, ADR 0016): which optional areas are on. The list of modules – their routes, pages,
 * sidebar entries and jobs – is in shared/src/modules.ts, so the server and the web app read the same one.
 *
 * Stored as one internal setting (modules.settings) that names the modules an administrator switched **off**: a
 * module missing there is on, so a new or upgraded installation has everything, and a module added later starts on.
 * The plant registry keeps its own switch (plant.settings, ADR 0007) and the map of sites its tile source
 * (plant.map, ADR 0015) – both off until an administrator turns them on.
 *
 * Switched off, a module's data is never touched: its routes answer 404 (app.ts, before the route's own code), its
 * jobs are not started (jobs/registry.ts), and the sidebar, Home, the search and the link pickers leave it out.
 */

const KEY = 'modules.settings';

interface Stored {
  off: ModuleId[];
  updatedAt: string | null;
  updatedBy: string | null;
}

function stored(): Stored {
  const s = readSetting<Partial<Stored>>(KEY, {});
  const off = Array.isArray(s.off) ? s.off.filter((id): id is ModuleId => MODULES.some((m) => m.id === id)) : [];
  return { off, updatedAt: s.updatedAt ?? null, updatedBy: s.updatedBy ?? null };
}

/** The map of sites is on while a tile source is chosen (plant.map, plant/map.ts; read here without loading the map). */
function mapSourceOn(): boolean {
  const source = readSetting<{ source?: string }>('plant.map', {}).source;
  return !!source && source !== 'off' && (MAP_SOURCES as readonly string[]).includes(source);
}

function ownSwitch(id: ModuleId, off: readonly ModuleId[]): boolean {
  if (id === 'plant') return plantEnabled();
  if (id === 'plantMap') return mapSourceOn();
  return !off.includes(id);
}

/** Whether a module is on (and the module it requires, too). */
export function moduleEnabled(id: ModuleId): boolean {
  const off = stored().off;
  for (let m: ModuleId | undefined = id; m; m = moduleDef(m).requires) if (!ownSwitch(m, off)) return false;
  return true;
}

/** Every module and whether it is on (the web app's Capabilities.modules). */
export function moduleStates(): ModuleStates {
  return Object.fromEntries(MODULES.map((m) => [m.id, moduleEnabled(m.id)])) as ModuleStates;
}

/** The code a switched-off module's routes answer with (the plant registry keeps its own, ADR 0007). */
export const moduleOffCode = (id: ModuleId): string => (id === 'plant' ? 'PLANT_MODULE_OFF' : 'MODULE_OFF');

/** 404 MODULE_OFF while the module is off: as if the route did not exist. */
export function requireModule(id: ModuleId): void {
  if (!moduleEnabled(id)) throw moduleOff(id);
}

export function moduleOff(id: ModuleId): HttpError {
  return new HttpError(404, `${moduleDef(id).name} is switched off (Settings → Modules)`, moduleOffCode(id), { module: id });
}

const routeModules = new Map<string, ModuleId | null>();
/** The module a registered route belongs to, if it is switched off (app.ts answers 404 then). */
export function switchedOffModuleOfRoute(url: string): ModuleId | undefined {
  let id = routeModules.get(url);
  if (id === undefined) {
    id = moduleOfRoute(url) ?? null;
    routeModules.set(url, id);
  }
  return id && !moduleEnabled(id) ? id : undefined;
}

/**
 * Who uses a module (ADR 0034): `everyone` signed in – the default, no row – or `selected` teams and users
 * (module_access; only restrictable modules). Deciding for a person: access.ts.
 */
export function moduleAccessMode(id: ModuleId): ModuleAccessMode {
  if (!moduleRestrictable(id)) return 'everyone';
  const r = db().get<{ mode: string }>('SELECT mode FROM module_access WHERE module_id = ?', id);
  return r?.mode === 'selected' ? 'selected' : 'everyone';
}

// ---------- Settings → Modules ----------

export function modulesView(): ModulesView {
  const s = stored();
  const modules: ModuleState[] = MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    maturity: m.maturity,
    enabled: moduleEnabled(m.id),
    defaultOn: m.defaultOn,
    switchable: m.switchable,
    requires: m.requires ?? null,
    settingsArea: m.id === 'plant' || m.id === 'plantMap' ? 'modules' : null,
    restrictable: moduleRestrictable(m.id),
    accessMode: moduleAccessMode(m.id),
    roles: moduleRolesOf(m.id),
  }));
  return { modules, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
}

/** Whether switching `id` to `enabled` changes anything (the step-up of PUT /api/settings/modules/:id asks only then). */
export function switchChanges(id: ModuleId, enabled: boolean): boolean {
  if (id === 'plant') return plantEnabled() !== enabled;
  return !stored().off.includes(id) !== enabled;
}

/** Switches a module on or off (administrators; the route asks for a step-up). Audited; the data stays. */
export function switchModule(id: ModuleId, enabled: boolean, onPlantEnabled?: () => void): ModulesView {
  const u = me();
  const def = moduleDef(id);
  if (!def.switchable) throw new HttpError(400, `${def.name} is switched in its own settings`, 'MODULE_NOT_SWITCHABLE', { module: id });
  if (!switchChanges(id, enabled)) return modulesView();
  if (id === 'plant') {
    // the plant registry's own switch (ADR 0007); it writes plant.module_enabled / plant.module_disabled
    const p = plantSettings();
    updatePlantSettings({ enabled, enterprise: p.enterprise, labels: p.labels, fields: p.fields }, onPlantEnabled);
  } else {
    const s = stored();
    const off = enabled ? s.off.filter((x) => x !== id) : [...s.off, id];
    writeSetting(KEY, { off, updatedAt: nowIso(), updatedBy: u.username } satisfies Stored);
    audit({
      action: enabled ? 'module.enabled' : 'module.disabled',
      entityType: 'settings',
      entityId: `module:${id}`,
      summary: enabled ? `Module "${def.name}" switched on` : `Module "${def.name}" switched off (its data is kept)`,
      details: { module: id },
    });
  }
  return modulesView();
}
