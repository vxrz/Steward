import { moduleOfNav, type AreaVisibility, type Role, type VisibilityArea, type VisibilitySummary } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { me, hasRole } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { moduleEnabled } from './registry.js';
import { HttpError } from '../util.js';

/**
 * What a signed-in person can see, area by area (GET /api/me/visibility, 0.11.0): the web app's sidebar shows an entry
 * only when the person may see something there or may add something (U2), and an empty list tells "nothing you may
 * see" from "nothing yet" (U3).
 *
 * The server is the source of truth: every area asks the same permission-filtered service its page uses, as the
 * person, and the role rules its create route checks. Nothing else leaves this module than two booleans per area:
 *  - `show`: the person's role may see the area's items by default, or the person may see at least one item, or may
 *    add one – an area the role has no right to and that holds nothing for the person is left out;
 *  - `hiddenByPermissions`: items exist that the person may not see – never how many, never which.
 * An area of a module that is switched off is left out (the sidebar hides it anyway).
 */

interface AreaRule {
  /**
   * Roles whose people may see the area's items by default – every item without an access list or owning team
   * (the role defaults of auth/policy.ts and the services). For them the area shows even while it is empty.
   */
  roles: readonly Role[];
  /** The person may see at least one item (the page's own filtered list) */
  any: () => boolean;
  /** The person may add one */
  create: (u: AuthUser) => boolean;
  /** At least one item exists, whoever may see it (left out: "hidden" is never reported for the area) */
  exists?: () => boolean;
}

/** Every role that works in Steward (status and plant viewers never reach these areas) */
const WORKING: readonly Role[] = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer'];
const READS_ALL: readonly Role[] = ['admin', 'auditor'];
const row = (sql: string) => () => !!db().get(sql);

/** Each area's rule; the services are loaded on first use (most areas are large modules). */
async function rules(): Promise<Record<VisibilityArea, AreaRule>> {
  const [
    helpers,
    processes,
    platforms,
    monitors,
    dashboards,
    statusPages,
    reports,
    mcpRequests,
    mcpConfig,
    maintenance,
    services,
    applications,
    systems,
    contracts,
    records,
    recordAccess,
    tickets,
    duties,
    controls,
    accessChanges,
    reconciliation,
    personReviews,
    complianceAccess,
  ] = await Promise.all([
    import('../routes/helpers.js'),
    import('../processes/service.js'),
    import('../platforms/service.js'),
    import('../monitors/service.js'),
    import('../dashboards/service.js'),
    import('../catalogue/status-pages.js'),
    import('../reports/service.js'),
    import('../mcp/requests.js'),
    import('../mcp/config.js'),
    import('../catalogue/maintenance.js'),
    import('../catalogue/service.js'),
    import('../catalogue/applications.js'),
    import('../catalogue/systems.js'),
    import('../datacontracts/service.js'),
    import('../records/service.js'),
    import('../records/access.js'),
    import('../tickets/service.js'),
    import('../duties/service.js'),
    import('../compliance/controls.js'),
    import('../compliance/access-changes.js'),
    import('../compliance/reconciliation.js'),
    import('../compliance/person-reviews.js'),
    import('../compliance/access.js'),
  ]);
  const editor = (u: AuthUser) => recordAccess.canCreateServices(u);
  const usable = () => platforms.listPlatforms().filter((p) => p.permissions?.includes('use'));
  return {
    runs: {
      roles: WORKING,
      any: () => helpers.visibleRuns({ limit: 1 }).length > 0,
      create: () => processes.listProcesses().some((p) => p.permissions.includes('run')),
      exists: row('SELECT 1 FROM runs WHERE debug IS NULL LIMIT 1'),
    },
    monitors: {
      roles: WORKING,
      any: () => monitors.listMonitors({ templates: false }).length > 0,
      create: (u) => capabilities(u).createMonitors,
      exists: row('SELECT 1 FROM monitors WHERE is_template = 0 LIMIT 1'),
    },
    dashboards: {
      roles: WORKING,
      any: () => dashboards.listDashboards().length > 0,
      create: (u) => capabilities(u).createProcesses,
      exists: row('SELECT 1 FROM dashboards LIMIT 1'),
    },
    statusPages: {
      roles: WORKING,
      any: () => statusPages.listPages().length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM status_pages LIMIT 1'),
    },
    reports: {
      roles: WORKING,
      // the summary reports the person may read (routes/reports.ts); a run's reports are on the run
      any: () =>
        reports
          .listSummaryReports(200)
          .some(
            (r) =>
              r.processIds.every((p) => processes.permissionsFor(p).includes('view')) ||
              (capabilities(me()).viewAudit && r.processIds.some((p) => !processes.permissionsFor(p).length)),
          ),
      create: () => processes.listProcesses().some((p) => p.permissions.includes('run')),
    },
    mcpRequests: {
      roles: [],
      // requests of AI assistants: only while the MCP server is on, or when the person still has requests to read
      any: () => mcpRequests.listRequests('all').length > 0,
      create: (u) => mcpConfig.mcpEnabled() && (hasRole(u, ['admin', 'auditor']) || usable().length > 0),
      exists: row('SELECT 1 FROM mcp_requests LIMIT 1'),
    },
    maintenance: {
      roles: WORKING,
      any: () => maintenance.listMaintenance({}).windows.length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM maintenance_windows WHERE cancelled_at IS NULL LIMIT 1'),
    },
    processes: {
      roles: WORKING,
      any: () => processes.listProcesses().length > 0,
      create: (u) => capabilities(u).createProcesses,
      exists: row('SELECT 1 FROM processes LIMIT 1'),
    },
    services: {
      roles: WORKING,
      any: () => services.listServices({}).length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM services WHERE archived = 0 LIMIT 1'),
    },
    applications: {
      roles: WORKING,
      any: () => applications.listApplications({}).length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM applications WHERE archived = 0 LIMIT 1'),
    },
    systems: {
      roles: WORKING,
      any: () => systems.listSystems().length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM systems LIMIT 1'),
    },
    platforms: {
      roles: WORKING,
      any: () => platforms.listPlatforms().length > 0,
      create: (u) => capabilities(u).createPlatforms,
      exists: row('SELECT 1 FROM platforms LIMIT 1'),
    },
    dataContracts: {
      roles: WORKING,
      any: () => contracts.listContracts().length > 0,
      create: (u) => capabilities(u).createProcesses,
      exists: row('SELECT 1 FROM data_contracts LIMIT 1'),
    },
    records: {
      roles: WORKING,
      any: () => records.listRecords({ limit: 1 }).length > 0,
      create: (u) => recordAccess.canCreateRecords(u),
      exists: row('SELECT 1 FROM records LIMIT 1'),
    },
    tickets: {
      roles: WORKING,
      any: () => tickets.listTickets({}).length > 0,
      create: (u) => tickets.canCreateTickets(u),
      exists: row('SELECT 1 FROM ticket_refs LIMIT 1'),
    },
    duties: {
      roles: WORKING,
      any: () => duties.listDuties({}).length > 0,
      create: (u) => editor(u),
      exists: row('SELECT 1 FROM service_duties LIMIT 1'),
    },
    controls: {
      roles: WORKING,
      any: () => controls.listCatalogues().length > 0,
      create: (u) => complianceAccess.canManageCatalogues(u),
      exists: row('SELECT 1 FROM control_catalogues LIMIT 1'),
    },
    accessChanges: {
      roles: [...READS_ALL, 'approver'],
      any: () => accessChanges.listAccessChanges({ limit: 1 }).length > 0,
      create: (u) => usable().some((p) => complianceAccess.canDocumentAccessOn(u, p.id)),
    },
    reconciliation: {
      roles: READS_ALL,
      any: () => reconciliation.listChecks().length > 0,
      create: (u) => complianceAccess.canCreateChecks(u),
      exists: row('SELECT 1 FROM access_checks LIMIT 1'),
    },
    personReviews: {
      roles: [...READS_ALL, 'approver'],
      any: () => personReviews.listReviews().length > 0,
      create: (u) => complianceAccess.canCreateChecks(u),
      exists: row('SELECT 1 FROM person_reviews LIMIT 1'),
    },
  };
}

/** The person sees an item of the area; a list the person may not read at all (403) counts as nothing to see. */
function see(rule: AreaRule): boolean {
  try {
    return rule.any();
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 403) return false;
    throw err;
  }
}

/** The areas the signed-in person may see, with whether some items are hidden from them. */
export async function visibilitySummary(): Promise<VisibilitySummary> {
  const u = me();
  const all = await rules();
  const areas: VisibilitySummary['areas'] = {};
  for (const [key, rule] of Object.entries(all) as [VisibilityArea, AreaRule][]) {
    const mod = moduleOfNav(key);
    if (mod && !moduleEnabled(mod)) continue;
    let any: boolean;
    let show: boolean;
    try {
      any = see(rule);
      show = any || hasRole(u, rule.roles) || rule.create(u);
    } catch (err) {
      // an area whose list cannot be read now is shown, as before (its page says what is wrong)
      logger.warn({ err: (err as Error).message, area: key }, 'visibility: area not decided');
      areas[key] = { show: true, hiddenByPermissions: false };
      continue;
    }
    let hidden = false;
    if (!any && rule.exists)
      try {
        hidden = rule.exists();
      } catch {
        hidden = false;
      }
    areas[key] = { show, hiddenByPermissions: hidden } satisfies AreaVisibility;
  }
  return { areas };
}
