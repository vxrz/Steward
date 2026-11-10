/**
 * The module registry (0.11.0, ADR 0016, docs/MODULES.md): the optional areas of Steward, each with an id, a maturity,
 * the pages and sidebar entries of the web app, the routes of the server and the background jobs it owns. An
 * administrator switches a module off in Settings → Modules: its sidebar entries and pages go, its routes answer 404
 * (the internal API and the public API), its jobs do not run, Home leaves out its tiles and the search skips it. The
 * data stays; switched on again, everything is back.
 *
 * Everything is on by default (new and upgraded installations), except the plant registry and its map, which keep
 * their own switches and stay off until an administrator turns them on (ADR 0007, ADR 0015).
 */

/** How far an area or a connector is: stable · beta (complete, little use or only checked against mocks) · preview (new, may change). */
export const MATURITY_LEVELS = ['stable', 'beta', 'preview'] as const;
export type Maturity = (typeof MATURITY_LEVELS)[number];

export const MODULE_IDS = [
  'compliance',
  'statusPages',
  'scorecard',
  'costs',
  'dataContracts',
  'ai',
  'teamsBot',
  'libraries',
  'versionWatch',
  'changedetection',
  'plant',
  'plantMap',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const isModuleId = (x: unknown): x is ModuleId => typeof x === 'string' && (MODULE_IDS as readonly string[]).includes(x);

export interface ModuleDef {
  id: ModuleId;
  /** English name (audit entries, docs); the web app translates `settings:modules.items.<id>` */
  name: string;
  maturity: Maturity;
  /** On in a new installation and after an upgrade (only the plant registry and its map are not) */
  defaultOn: boolean;
  /** Only on while this module is on, too */
  requires?: ModuleId;
  /**
   * Switched in Settings → Modules. The map of sites is not: it is on while the plant registry is on and a tile
   * source is chosen (Settings → Modules → Plant registry → Map).
   */
  switchable: boolean;
  /** Sidebar entries and tabs of the web app (NavKey of web/src/components/AppNav.tsx) */
  nav: readonly string[];
  /** Addresses of the web app that belong to it (prefixes): they show "This area is switched off" while it is off */
  pages: readonly string[];
  /**
   * Routes of the server that belong to it, as registered (prefixes: a route matches when it is one of these or
   * starts with one followed by "/"). While the module is off they answer 404 MODULE_OFF (PLANT_MODULE_OFF for the
   * plant registry), before the route's own code runs.
   */
  routes: readonly string[];
  /** Background jobs it owns (the manifests in server/src/features/): not started while it is off */
  jobs: readonly string[];
  /** Platform kinds that only make sense with it (left out of the connector list while it is off) */
  platformKinds?: readonly string[];
  /** Built-in datasets (process id prefixes) it publishes: hidden while it is off */
  datasets?: readonly string[];
}

export const MODULES: readonly ModuleDef[] = [
  {
    id: 'compliance',
    name: 'Compliance and evidence',
    maturity: 'stable',
    defaultOn: true,
    switchable: true,
    nav: ['controls', 'accessChanges', 'reconciliation', 'personReviews', 'correctiveActions', 'evidencePacks'],
    pages: ['/compliance'],
    routes: [
      '/api/compliance',
      '/api/v1/access-changes',
      '/api/v1/access-findings',
      '/api/v1/control-catalogues',
      '/api/v1/controls',
      '/api/v1/control-coverage',
      '/api/v1/corrective-actions',
    ],
    jobs: ['corrective-actions'],
    datasets: ['compliance:'],
  },
  {
    id: 'statusPages',
    name: 'Status pages',
    maturity: 'beta',
    defaultOn: true,
    switchable: true,
    nav: ['statusPages'],
    pages: ['/status-pages'],
    routes: ['/api/status-pages', '/api/public/status-page'],
    jobs: [],
  },
  {
    id: 'scorecard',
    name: 'Scorecard and availability objectives',
    maturity: 'beta',
    defaultOn: true,
    switchable: true,
    nav: ['scorecard'],
    pages: ['/scorecard'],
    routes: ['/api/scorecard', '/api/objectives', '/api/v1/scorecard', '/api/v1/objectives', '/api/v1/services/:serviceId/scorecard'],
    jobs: ['scorecard'],
  },
  {
    id: 'costs',
    name: 'Costs',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: ['costs'],
    pages: ['/costs'],
    routes: ['/api/costs', '/api/hooks/costs', '/api/v1/costs', '/api/v1/services/:serviceId/cost-plan'],
    jobs: ['costs'],
    datasets: ['costs:'],
  },
  {
    id: 'dataContracts',
    name: 'Data contracts',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: ['dataContracts'],
    pages: ['/data-contracts'],
    routes: ['/api/data-contracts'],
    jobs: [],
    platformKinds: ['datacontract'],
  },
  {
    id: 'ai',
    name: 'AI models',
    maturity: 'beta',
    defaultOn: true,
    switchable: true,
    nav: [],
    pages: [],
    routes: ['/api/ai'],
    jobs: ['ai-usage'],
    platformKinds: ['llm-gateway'],
    datasets: ['ai:'],
  },
  {
    id: 'teamsBot',
    name: 'Approvals in Microsoft Teams',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: [],
    pages: [],
    routes: ['/api/settings/teams-bot'],
    jobs: [],
  },
  {
    id: 'libraries',
    name: 'Shared procedure libraries',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: ['libraries'],
    pages: ['/libraries', '/settings/libraries'],
    routes: ['/api/libraries', '/api/library-keys', '/api/library-origins', '/api/library-publishers', '/api/library-releases'],
    jobs: [],
  },
  {
    id: 'versionWatch',
    name: 'Version watch and end of life',
    maturity: 'beta',
    defaultOn: true,
    switchable: true,
    nav: [],
    pages: [],
    routes: ['/api/catalogue/versions', '/api/catalogue/lifecycle'],
    jobs: ['version-watch', 'end-of-life'],
    datasets: ['catalogue:versions'],
  },
  {
    id: 'changedetection',
    name: 'changedetection.io',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: [],
    pages: [],
    routes: ['/api/changedetection'],
    jobs: ['changedetection'],
    platformKinds: ['changedetection'],
  },
  {
    id: 'plant',
    name: 'Plant registry',
    maturity: 'preview',
    defaultOn: false,
    switchable: true,
    nav: ['plantSites', 'plantAssets', 'plantMap', 'plantProfiles', 'plantKpis', 'plantExplore', 'plantChecks', 'plantImport', 'plantChanges'],
    pages: ['/plant'],
    routes: ['/api/plant', '/api/v1/plant'],
    jobs: ['plant-changes', 'plant-advisories'],
  },
  {
    id: 'plantMap',
    name: 'Map of sites',
    maturity: 'preview',
    defaultOn: false,
    requires: 'plant',
    switchable: false,
    nav: [],
    pages: [],
    routes: [],
    jobs: [],
  },
];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));
export const moduleDef = (id: ModuleId): ModuleDef => BY_ID.get(id)!;

/** Whether a registered route (or an address) is `prefix` or below it. */
export const underPrefix = (url: string, prefix: string): boolean => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);

/** The module a registered server route belongs to (the longest matching prefix), if any. */
export function moduleOfRoute(url: string): ModuleId | undefined {
  let best: ModuleId | undefined;
  let len = -1;
  for (const m of MODULES)
    for (const p of m.routes)
      if (p.length > len && underPrefix(url, p)) {
        best = m.id;
        len = p.length;
      }
  return best;
}

/** The module an address of the web app belongs to, if any. */
export function moduleOfPage(pathname: string): ModuleId | undefined {
  for (const m of MODULES) if (m.pages.some((p) => underPrefix(pathname, p))) return m.id;
  return undefined;
}

/** The module a sidebar entry belongs to, if any. */
export function moduleOfNav(key: string): ModuleId | undefined {
  for (const m of MODULES) if (m.nav.includes(key)) return m.id;
  return undefined;
}

/** The module a platform kind belongs to, if any. */
export function moduleOfPlatformKind(kind: string): ModuleId | undefined {
  for (const m of MODULES) if (m.platformKinds?.includes(kind)) return m.id;
  return undefined;
}

/** On/off per module, as the web app gets it (Capabilities.modules; a module missing there is on). */
export type ModuleStates = Partial<Record<ModuleId, boolean>>;

/** GET /api/settings/modules: one row per module. */
export interface ModuleState {
  id: ModuleId;
  name: string;
  maturity: Maturity;
  enabled: boolean;
  defaultOn: boolean;
  switchable: boolean;
  requires: ModuleId | null;
  /** Its own settings in Settings (the plant registry; the map's switch is there) */
  settingsArea: string | null;
}

export interface ModulesView {
  modules: ModuleState[];
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---------- maturity of the connectors (platform kinds) ----------

/**
 * Where a connector was checked: against a real system of that product (in CI or by hand), only against Steward's own
 * mock server (server/src/mock), or not at all because it talks to no product of its own (the generic HTTP kind).
 */
export const VERIFIED_AGAINST = ['real', 'mock', 'none'] as const;
export type VerifiedAgainst = (typeof VERIFIED_AGAINST)[number];

export interface KindMaturity {
  maturity: Maturity;
  verified: VerifiedAgainst;
}

/** The maturity of every built-in platform kind is part of its descriptor: PLATFORM_KINDS in platformKinds.ts (kindMaturity). */

// ---------- what a signed-in person can see (the sidebar, honest empty states) ----------

/**
 * The areas whose sidebar entry depends on what the person may see (GET /api/me/visibility). The keys are the
 * sidebar's (NavKey); areas not listed here are always shown (Home, My tasks) or follow a capability.
 */
export const VISIBILITY_AREAS = [
  'runs',
  'monitors',
  'dashboards',
  'statusPages',
  'reports',
  'mcpRequests',
  'maintenance',
  'processes',
  'services',
  'applications',
  'systems',
  'platforms',
  'dataContracts',
  'records',
  'tickets',
  'duties',
  'controls',
  'accessChanges',
  'reconciliation',
  'personReviews',
  'correctiveActions',
] as const;
export type VisibilityArea = (typeof VISIBILITY_AREAS)[number];

export interface AreaVisibility {
  /** The sidebar shows the entry: the person may see something there, or may add something */
  show: boolean;
  /**
   * There are items the person may not see (never how many, never which). Lets an empty list say "nothing you may
   * see" instead of "nothing yet".
   */
  hiddenByPermissions: boolean;
}

/** GET /api/me/visibility */
export interface VisibilitySummary {
  areas: Partial<Record<VisibilityArea, AreaVisibility>>;
}
