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
  /** Who may use it (ADR 0034): whether it can be restricted, and the parts that leave with access */
  access?: ModuleAccessDef;
}

/**
 * The `access` part of a module (ADR 0034 part 8): read by the server and the web app alike. A module an administrator
 * restricted to selected teams and users is left out for everyone else – its routes answer 404 MODULE_NO_ACCESS, and
 * the parts named here (notification events, MCP tools, report sections, export parts, item kinds) go from every
 * surface the way they go while the module is off. server/test/modules.test.ts checks that every event, tool, report
 * section and export part of a module is named here.
 */
export interface ModuleAccessDef {
  /** Whether an administrator may restrict it to selected teams and users (status pages and the map: no) */
  restrictable: boolean;
  /** Not restrictable on its own: whoever uses that module uses this one (the map of sites follows the plant registry) */
  follows?: ModuleId;
  /** Notification events that are its own: not sent to people who do not use it, in no channel */
  events?: readonly string[];
  /** MCP tools (by name) that are its own: not listed for, and refused to, people who do not use it */
  mcpTools?: readonly string[];
  /** Sections of scheduled reports (by id): left out of a report for an owner or a recipient who does not use it */
  reportSections?: readonly string[];
  /** Parts of exports (by id, server/src/export/parts.ts) */
  exportParts?: readonly string[];
  /**
   * Kinds of the items it owns (link kinds, owning-team kinds): a link from a core item to one of them is counted, not
   * named, for a person who does not use it, and a share of one to such a person is refused
   */
  itemKinds?: readonly string[];
}

export const MODULES: readonly ModuleDef[] = [
  {
    id: 'compliance',
    name: 'Compliance and evidence',
    maturity: 'stable',
    defaultOn: true,
    switchable: true,
    nav: ['controls', 'soa', 'accessChanges', 'reconciliation', 'personReviews', 'correctiveActions', 'evidencePacks'],
    pages: ['/compliance'],
    routes: [
      '/api/compliance',
      '/api/v1/access-changes',
      '/api/v1/access-findings',
      '/api/v1/control-catalogues',
      '/api/v1/controls',
      '/api/v1/control-coverage',
      '/api/v1/corrective-actions',
      // the statement of applicability and the responsibility matrix of services (ADR 0029 part 2)
      '/api/services/:id/responsibilities',
      '/api/v1/statements-of-applicability',
      '/api/v1/services/:serviceId/responsibilities',
    ],
    jobs: ['corrective-actions', 'soa'],
    datasets: ['compliance:'],
    access: {
      restrictable: true,
      events: ['access.undocumented', 'corrective.action_due', 'soa.approval_waiting'],
      mcpTools: [
        'list_control_catalogues',
        'get_control_catalogue',
        'find_mapping_targets',
        'propose_control_catalogue',
        'propose_control_mappings',
        'list_corrective_actions',
        'get_statement_of_applicability',
        'get_service_responsibilities',
      ],
      reportSections: ['isms'],
      exportParts: ['correctiveActions', 'soa'],
    },
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
    // their purpose is to publish; the status viewer role and the link without sign-in stay as they are (ADR 0034)
    access: { restrictable: false },
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
    access: { restrictable: true, events: ['objective.breached'], reportSections: ['scorecard'] },
  },
  {
    id: 'costs',
    name: 'Costs',
    maturity: 'preview',
    defaultOn: true,
    switchable: true,
    nav: ['costs'],
    pages: ['/costs'],
    routes: [
      '/api/costs',
      '/api/hooks/costs',
      '/api/v1/costs',
      '/api/v1/cost-commitments',
      '/api/v1/services/:serviceId/cost-plan',
      // price books, calculators and estimates (0.21.0, ADR 0035)
      '/api/v1/cost-estimates',
      '/api/v1/price-books',
    ],
    jobs: ['costs'],
    datasets: ['costs:'],
    access: {
      restrictable: true,
      events: ['cost.budget', 'cost.booking_due', 'cost.volume', 'cost.estimate_changed'],
      mcpTools: ['get_service_cost_plan', 'get_platform_cost_plan', 'list_cost_commitments'],
      reportSections: ['costs'],
      exportParts: ['costPlans'],
    },
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
    // its data contracts have owning teams (owning-team kind `contract`): the access preview names those without it
    access: { restrictable: true, events: ['contract.failed'], reportSections: ['contracts'], itemKinds: ['contract'] },
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
    access: { restrictable: true, events: ['ai.budget'], reportSections: ['ai'] },
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
    access: { restrictable: true },
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
    access: { restrictable: true },
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
    access: { restrictable: true, events: ['stack.eol', 'stack.release'] },
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
    access: { restrictable: true },
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
    access: {
      restrictable: true,
      events: ['plant.change_proposed', 'plant.change_decided', 'plant.advisory_matched'],
      mcpTools: [
        'list_plant_sites',
        'get_plant_site',
        'list_plant_assets',
        'get_plant_asset',
        'list_device_profiles',
        'get_device_profile',
        'search_data_points',
        'get_data_point',
        'list_kpi_definitions',
        'get_kpi_definition',
        'list_data_collections',
        'get_data_collection',
        'get_insights_hub_mapping',
        'get_plant_import_format',
        'propose_plant_changes',
        'list_plant_advisories',
        'get_plant_advisory',
      ],
      exportParts: ['plant'],
      itemKinds: ['site', 'asset', 'conduit', 'device-profile', 'data-collection', 'data-sink'],
    },
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
    // it follows the plant registry: whoever uses the registry uses its map
    access: { restrictable: false, follows: 'plant' },
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

// ---------- module access (ADR 0034) ----------

/** Whether an administrator may restrict a module to selected teams and users. */
export const moduleRestrictable = (id: ModuleId): boolean => moduleDef(id).access?.restrictable === true;

/** The module whose access decides who uses `id` (itself, or the module it follows: the map → the plant registry). */
export const accessModule = (id: ModuleId): ModuleId => moduleDef(id).access?.follows ?? id;

const owner = (pick: (a: ModuleAccessDef) => readonly string[] | undefined) => {
  const map = new Map<string, ModuleId>();
  for (const m of MODULES) for (const x of (m.access && pick(m.access)) ?? []) map.set(x, m.id);
  return (x: string): ModuleId | undefined => map.get(x);
};
/** The module a notification event belongs to, if any. */
export const moduleOfEvent = owner((a) => a.events);
/** The module an MCP tool belongs to, if any. */
export const moduleOfMcpTool = owner((a) => a.mcpTools);
/** The module a section of scheduled reports belongs to, if any. */
export const moduleOfReportSection = owner((a) => a.reportSections);
/** The module a part of exports belongs to, if any. */
export const moduleOfExportPart = owner((a) => a.exportParts);
/** The module that owns an item kind (a link kind, an owning-team kind), if any. */
export const moduleOfItemKind = owner((a) => a.itemKinds);

/** Module access: everyone signed in (the default), or only selected teams and users. */
export const MODULE_ACCESS_MODES = ['everyone', 'selected'] as const;
export type ModuleAccessMode = (typeof MODULE_ACCESS_MODES)[number];

/** How a module looks to the signed-in person (Capabilities.moduleAccess): on, switched off, or on but not used by them. */
export const MODULE_USE_STATES = ['on', 'off', 'notYours'] as const;
export type ModuleUseState = (typeof MODULE_USE_STATES)[number];

/** Limits of module access (zod and the settings form). */
export const MODULE_ACCESS_LIMITS = { grants: 500 } as const;

/** One team or user that uses a restricted module: the subject strings of access lists (`team:<name>`, `user:<name>`). */
export interface ModuleGrant {
  subject: string;
  /** Who gave it and when */
  createdBy: string;
  createdAt: string;
  /** Whether the user or team exists (a deleted team stays as a grant that matches nobody) */
  known: boolean;
}

/** GET /api/settings/modules/:id/access */
export interface ModuleAccessView {
  module: ModuleId;
  restrictable: boolean;
  mode: ModuleAccessMode;
  grants: ModuleGrant[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** PUT /api/settings/modules/:id/access and POST …/access/preview */
export interface ModuleAccessInput {
  mode: ModuleAccessMode;
  /** The teams and users that use it while it is restricted (ignored for `everyone`) */
  grants: { subject: string }[];
}

/** POST /api/settings/modules/:id/access/preview: who gains and who loses use of the module, nothing changed. */
export interface ModuleAccessPreview {
  module: ModuleId;
  /** Whether the change widens access (asks for a step-up) */
  widens: boolean;
  gains: { username: string; displayName: string }[];
  loses: { username: string; displayName: string }[];
  /** Teams that own items of the module but would not use it */
  owningTeamsWithout: string[];
}

/**
 * Why a person uses a module (ADR 0034 part 7: access reviews, _Why do I have access?_, the test sign-in): everyone
 * signed in (an open module), as an administrator or auditor, named on its list, or through a team on its list.
 */
export interface ModuleUseReason {
  source: 'everyone' | 'admin' | 'auditor' | 'user' | 'team';
  /** source team: the team's name as stored on the list */
  team?: string;
}

/** Whether a person uses a module that is on, and through what (empty `through`: they do not use it). */
export interface ModuleUse {
  module: ModuleId;
  /** Whether the module is switched on */
  enabled: boolean;
  /** Whether it is restricted to selected teams and users */
  restricted: boolean;
  uses: boolean;
  through: ModuleUseReason[];
}

/**
 * POST /api/report-schedules/recipients-preview (ADR 0034 decision 12): per restricted module whose sections a
 * schedule holds, the recipients who get the report without them – named users, teams not on the module's list (their
 * members get it only when they use the module otherwise) and the number of e-mail addresses outside Steward.
 */
export interface ReportModuleRecipients {
  modules: { module: ModuleId; ownerUses: boolean; users: string[]; teams: string[]; emails: number }[];
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
  /** Whether an administrator may restrict it to selected teams and users (ADR 0034) */
  restrictable: boolean;
  /** Its module access: everyone signed in, or selected teams and users */
  accessMode: ModuleAccessMode;
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
