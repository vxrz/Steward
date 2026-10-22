import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowEmailDomains, authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Route permission matrix: every route the server registers, called by every role.
 *
 * The table below says which signed-in roles may get a 2xx answer from each route (on the demo data,
 * objects without access lists, owned by the administrator). A new route makes this test fail until it is
 * classified here, so its access rules are thought about once.
 *
 * Checks per route:
 *   - roles outside the list never get a 2xx (and never a 5xx),
 *   - roles in the list get a 2xx for GET routes (so the table is not vacuous; mutating routes are only
 *     called by roles that must be refused, to keep the fixtures intact),
 *   - without credentials every non-public route answers 401,
 *   - a read-only API token is refused on every changing route, an MCP token everywhere but /api/mcp,
 *   - identity, vault and sign-in settings need a signed-in session (no API token at all).
 *
 * SM_ROUTE_MATRIX_OBSERVE=<file> also sends the changing requests of allowed roles and writes every
 * "route role status" line to <file> – a starting point when classifying new routes.
 */

type Role = 'admin' | 'designer' | 'operator' | 'approver' | 'auditor' | 'viewer';
const ROLES: Role[] = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer'];
const USERS: Record<Role, string> = { admin: 'admin', designer: 'dana', operator: 'olivia', approver: 'adam', auditor: 'audrey', viewer: 'vera' };
const PW = 'Demo-password-1';

/** Reachable without signing in. */
const PUBLIC = 'public' as const;
/** Machine-to-machine endpoints authenticated by their own secret (webhooks, heartbeats). */
const HOOK = 'hook' as const;
type Access = typeof PUBLIC | typeof HOOK | Role[];

const ALL = ROLES;
const ADMIN: Role[] = ['admin'];
const ADMIN_AUDITOR: Role[] = ['admin', 'auditor'];
/** Roles that may create processes, dashboards, monitors, records and credentials. */
const DESIGN: Role[] = ['admin', 'designer'];
/** Roles that run processes (operator and designer by default). */
const RUN: Role[] = ['admin', 'designer', 'operator'];
/** Everyone but read-only accounts (viewer, auditor). */
const ACTIVE: Role[] = ['admin', 'designer', 'operator', 'approver'];
/** Roles with a default right to use platforms. */
const USE: Role[] = ['admin', 'designer', 'operator'];
/** Everyone but viewers (credentials register entries, report schedules). */
const NOT_VIEWER: Role[] = ['admin', 'designer', 'operator', 'approver', 'auditor'];

const EXPECT: Record<string, Access> = {
  // ---- health, instance, sign-in ----
  'GET /api/health': PUBLIC,
  'GET /api/ready': PUBLIC,
  'GET /api/instance': PUBLIC,
  'GET /api/client-config': PUBLIC,
  'GET /api/theme': PUBLIC,
  'GET /api/theme/logo': PUBLIC,
  'GET /manifest.webmanifest': PUBLIC,
  // the web UI: static files (GET /*) when web/dist is built, otherwise a hint page (GET /)
  'GET /': PUBLIC,
  'GET /*': PUBLIC,
  'GET /api/auth/status': PUBLIC,
  'GET /api/vault/status': PUBLIC,
  'POST /api/auth/setup': PUBLIC,
  'POST /api/auth/login': PUBLIC,
  'GET /api/auth/oidc/:id/start': PUBLIC,
  'GET /api/auth/oidc/callback': PUBLIC,
  'POST /api/auth/logout': ALL,
  'GET /api/auth/me': ALL,
  'POST /api/auth/password': ALL,
  'GET /api/about': ALL,
  'GET /api/system/status': ADMIN_AUDITOR,
  'GET /api/metrics': ADMIN_AUDITOR,
  'GET /api/public-api': ALL,

  // ---- vault ----
  'POST /api/vault/unlock': ADMIN,
  'POST /api/vault/passphrase': ADMIN,
  'GET /api/vault/info': ADMIN_AUDITOR,
  'POST /api/vault/lock': ADMIN,

  // ---- users, teams, tokens, single sign-on ----
  'GET /api/users': ADMIN,
  'POST /api/users': ADMIN,
  'PUT /api/users/:id': ADMIN,
  'POST /api/users/:id/reset-password': ADMIN,
  'GET /api/teams': ADMIN,
  'POST /api/teams': ADMIN,
  'PUT /api/teams/:id': ADMIN,
  'DELETE /api/teams/:id': ADMIN,
  'GET /api/subjects': ACTIVE,
  'PATCH /api/me': ALL,
  'GET /api/me/tokens': ALL,
  'POST /api/me/tokens': ALL,
  'DELETE /api/me/tokens/:id': ALL,
  'GET /api/tokens': ADMIN,
  'DELETE /api/tokens/:id': ADMIN,
  'GET /api/sso/providers': ADMIN,
  'POST /api/sso/providers': ADMIN,
  'PUT /api/sso/providers/:id': ADMIN,
  'DELETE /api/sso/providers/:id': ADMIN,
  'POST /api/sso/discover': ADMIN,
  'GET /api/sso/redirect-uri': ALL,

  // ---- settings, theme, notifications, maintenance ----
  'GET /api/settings': ADMIN,
  'PUT /api/settings': ADMIN,
  'GET /api/settings/notifications': ADMIN,
  'PUT /api/settings/notifications': ADMIN,
  'POST /api/settings/notifications/test': ADMIN,
  'GET /api/settings/theme': ADMIN,
  'PUT /api/settings/theme': ADMIN,
  'POST /api/settings/theme/reset': ADMIN,
  'POST /api/settings/theme/logo': ADMIN,
  'DELETE /api/settings/theme/logo': ADMIN,
  'GET /api/maintenance': ADMIN,
  'POST /api/maintenance/cleanup': ADMIN,
  'GET /api/notifications': ALL,
  'POST /api/notifications/read-all': ALL,
  'POST /api/notifications/:id/read': ALL,
  'GET /api/mcp-server': ALL,
  'PUT /api/mcp-server': ADMIN,
  'POST /api/demo/setup': ADMIN,

  // ---- audit ----
  'GET /api/audit': ADMIN_AUDITOR,
  'GET /api/audit/verify': ADMIN_AUDITOR,
  'POST /api/audit/verify': ADMIN_AUDITOR,
  'GET /api/audit/anchoring': ADMIN_AUDITOR,
  'PUT /api/audit/anchoring': ADMIN,
  'GET /api/audit/anchor.json': ADMIN_AUDITOR,
  'POST /api/audit/checkpoint': ADMIN_AUDITOR,
  'GET /api/audit/public-key.pem': ADMIN_AUDITOR,
  'GET /api/audit/export': ADMIN_AUDITOR,

  // ---- platforms (no access list: admins manage, designers and operators use) ----
  'GET /api/platform-presets': ALL,
  'POST /api/platform-types': ADMIN,
  'POST /api/platform-types/import': ADMIN,
  'DELETE /api/platform-types/:kind': ADMIN,
  'GET /api/platform-types/:kind/export': ALL, // connector types are shareable templates (see docs/REVIEW-2026-10.md)
  'GET /api/platforms': ALL,
  'POST /api/platforms': ADMIN,
  'GET /api/platforms/:id': USE,
  'PUT /api/platforms/:id': ADMIN,
  'DELETE /api/platforms/:id': ADMIN,
  'PUT /api/platforms/:id/access': ADMIN,
  'PUT /api/platforms/:id/mcp-gateway': ADMIN,
  'POST /api/platforms/:id/confirm-config': ADMIN,
  'POST /api/platforms/:id/contract-check': ADMIN,
  'PUT /api/platforms/:id/secrets': ADMIN,
  'POST /api/platforms/:id/test': USE,
  'POST /api/platforms/:id/request': USE,
  'GET /api/platforms/:id/specs': USE,
  'POST /api/platforms/:id/specs': ADMIN,
  'DELETE /api/platforms/:id/specs/:specId': ADMIN,
  'GET /api/platforms/:id/operations': USE,
  'GET /api/platforms/:id/docs': USE,
  'POST /api/platforms/:id/docs': ADMIN,
  'DELETE /api/platforms/:id/docs/:docId': ADMIN,
  'GET /api/docs/:docId/file': USE,
  'GET /api/specs/:specId/content': USE,
  'GET /api/gatus/sources': ALL,
  'GET /api/gatus/sources/:platformId': USE,
  'PUT /api/gatus/sources/:platformId': ADMIN,
  'DELETE /api/gatus/sources/:platformId': ADMIN,
  'POST /api/gatus/sources/:platformId/scrape': USE,
  'GET /api/gatus/sources/:platformId/endpoints': USE,

  // ---- processes, runs, tasks, schedules, triggers ----
  'GET /api/templates': ALL,
  'GET /api/processes': ALL,
  'POST /api/processes': DESIGN,
  'POST /api/processes/validate': ALL,
  'POST /api/processes/to-yaml': ALL,
  'GET /api/processes/:id': ALL,
  'PUT /api/processes/:id': DESIGN,
  'DELETE /api/processes/:id': ADMIN,
  'PUT /api/processes/:id/access': ADMIN,
  'GET /api/processes/:id/versions': ALL,
  'GET /api/processes/:id/export': ALL,
  'GET /api/processes/:id/scope': ALL,
  'POST /api/processes/:id/evaluate': RUN,
  'POST /api/runs': RUN,
  'GET /api/runs': ALL,
  'GET /api/runs/:id': ALL,
  'GET /api/runs/:id/steps/:stepId': ALL,
  'GET /api/runs/:id/inspect/:nodeId': ALL,
  'POST /api/runs/:id/cancel': RUN,
  'POST /api/runs/:id/resume': RUN,
  'GET /api/runs/:id/report.html': ALL,
  'GET /api/runs/:id/report.json': ALL,
  'GET /api/runs/:id/report.pdf': ALL,
  'POST /api/runs/:id/reports': ALL,
  'GET /api/runs/:id/reports': ALL,
  'GET /api/artifacts/:id': ALL,
  'GET /api/tasks': ALL,
  'GET /api/tasks/:id': ALL,
  'POST /api/tasks/:id/complete': ACTIVE,
  'GET /api/schedules': ALL,
  'POST /api/schedules': RUN,
  'PUT /api/schedules/:id': ADMIN,
  'DELETE /api/schedules/:id': ADMIN,
  'POST /api/schedules/:id/run': RUN,
  'POST /api/cron/preview': ALL,
  'GET /api/triggers': ALL,
  'POST /api/triggers': RUN,
  'POST /api/triggers/preview-mapping': RUN,
  'GET /api/triggers/:id': ALL,
  'PUT /api/triggers/:id': ADMIN,
  'DELETE /api/triggers/:id': ADMIN,
  'GET /api/triggers/:id/fires': ALL,
  'POST /api/triggers/:id/rotate': ADMIN,
  'POST /api/triggers/:id/test': ADMIN,
  'POST /api/hooks/:id': HOOK,
  'POST /api/hooks/monitor/:id': HOOK,
  'POST /api/hooks/monitors': HOOK,

  // ---- dashboards, datasets, bundles ----
  'GET /api/dashboard': ALL,
  'GET /api/dashboards': ALL,
  'POST /api/dashboards': DESIGN,
  'GET /api/dashboards/:id': ALL,
  'PUT /api/dashboards/:id': ADMIN,
  'DELETE /api/dashboards/:id': ADMIN,
  'GET /api/dashboards/:id/export': ALL,
  'POST /api/dashboards/:id/refresh': ALL,
  'GET /api/dashboard-templates': ALL,
  'GET /api/datasets': ALL,
  'GET /api/datasets/:key': ALL,
  'DELETE /api/datasets/:key': ADMIN,
  'GET /api/datasets/:key/metrics': ALL,
  'GET /api/bundle/export': ALL,
  'POST /api/bundle/import': ALL, // every item is checked on its own

  // ---- monitors ----
  'GET /api/monitors': ALL,
  'POST /api/monitors': DESIGN,
  'GET /api/monitors/meta': ALL,
  'GET /api/monitors/examples': ALL,
  'POST /api/monitors/examples/:file': DESIGN,
  'POST /api/monitors/import': DESIGN,
  'POST /api/monitors/validate': ALL,
  'GET /api/monitors/:id': ALL,
  'PUT /api/monitors/:id': DESIGN,
  'DELETE /api/monitors/:id': ADMIN,
  'POST /api/monitors/:id/enabled': DESIGN,
  'GET /api/monitors/:id/export': ALL,
  'PUT /api/monitors/:id/access': ADMIN,
  'POST /api/monitors/:id/acknowledge': RUN,
  'DELETE /api/monitors/:id/acknowledge': RUN,
  'GET /api/monitors/:id/history': ALL,
  'GET /api/monitors/:id/checks/:checkId/results': ALL,
  'POST /api/monitors/:id/checks/:checkId/rotate': DESIGN,
  'POST /api/monitors/:id/checks/:checkId/test-report': DESIGN,
  'POST /api/monitors/:id/run': RUN,
  'POST /api/monitors/:id/resync': DESIGN,
  'GET /api/monitors/:id/maintenance': ALL,
  'POST /api/monitors/:id/maintenance': RUN,
  'DELETE /api/monitors/:id/maintenance/:wid': RUN,
  'POST /api/monitors/:id/instances': DESIGN,
  'GET /api/monitor-gateways': DESIGN,
  'POST /api/monitor-gateways': DESIGN,
  'PUT /api/monitor-gateways/:id': ADMIN,
  'DELETE /api/monitor-gateways/:id': ADMIN,
  'POST /api/monitor-gateways/:id/rotate': ADMIN,

  // ---- reports ----
  'GET /api/reports': ALL,
  'POST /api/reports/summary': ALL,
  'GET /api/reports/branding': ADMIN,
  'PUT /api/reports/branding': ADMIN,
  'GET /api/reports/branding/logo': ADMIN,
  'POST /api/reports/branding/logo': ADMIN,
  'DELETE /api/reports/branding/logo': ADMIN,
  'POST /api/reports/branding/preview': ADMIN,
  'POST /api/reports/verify': ALL,
  'GET /api/reports/:id': ALL,
  'GET /api/reports/:id/download': ALL,
  'GET /api/report-schedules': ALL,
  'POST /api/report-schedules': NOT_VIEWER,
  'GET /api/report-schedules/reports': ALL,
  'GET /api/report-schedules/:id': ADMIN_AUDITOR,
  'PUT /api/report-schedules/:id': ADMIN,
  'DELETE /api/report-schedules/:id': ADMIN,
  'POST /api/report-schedules/:id/run': ADMIN,
  'GET /api/report-schedules/:id/reports': ADMIN_AUDITOR,

  // ---- records, service catalogue, links ----
  'GET /api/records': ALL,
  'POST /api/records': RUN,
  'GET /api/records/meta': ALL,
  'POST /api/records/import': RUN,
  'GET /api/records/:id': ALL,
  'PUT /api/records/:id': RUN,
  'GET /api/records/:id/versions': ALL,
  'GET /api/records/:id/versions/:version': ALL,
  'POST /api/records/:id/transition': ACTIVE,
  'POST /api/records/:id/revise': RUN,
  'POST /api/records/:id/comments': ACTIVE,
  'GET /api/records/:id/export': ALL,
  'POST /api/records/:id/links': RUN,
  'DELETE /api/records/:id/links/:linkId': RUN,
  'POST /api/records/:id/attachments': RUN,
  'DELETE /api/records/:id/attachments/:attId': RUN,
  'GET /api/records/:id/attachments/:attId/download': ALL,
  'POST /api/records/:id/pdf': ACTIVE,
  'POST /api/records/:id/signed': ACTIVE,
  'GET /api/record-types': ALL,
  'POST /api/record-types': ADMIN,
  'PUT /api/record-types/:id': ADMIN,
  'GET /api/link-targets': ALL,
  'GET /api/backlinks': ALL,
  'GET /api/services': ALL,
  'POST /api/services': DESIGN,
  'GET /api/services/:id': ALL,
  'PUT /api/services/:id': DESIGN,
  'POST /api/services/:id/archive': DESIGN,
  'POST /api/services/:id/links': DESIGN,
  'DELETE /api/services/:id/links/:linkId': DESIGN,

  // ---- credentials register ----
  'GET /api/credentials': ALL,
  'POST /api/credentials': RUN,
  'GET /api/credentials/export.csv': ALL,
  'GET /api/credentials/summary': ALL,
  'GET /api/credentials/settings': ALL,
  'PUT /api/credentials/settings': ADMIN,
  'POST /api/credentials/certificate/parse': ALL,
  'GET /api/credentials/:id': NOT_VIEWER,
  'PUT /api/credentials/:id': RUN,
  'DELETE /api/credentials/:id': ADMIN,
  'GET /api/credentials/:id/history': NOT_VIEWER,
  'POST /api/credentials/:id/rotated': RUN,
  'POST /api/credentials/:id/reviewed': RUN,
  'POST /api/credentials/:id/restore': ADMIN,
  'POST /api/credentials/:id/archive': ADMIN,

  // ---- MCP (bearer MCP tokens only; see mcp.test.ts) ----
  'POST /api/mcp': HOOK,
  'GET /api/mcp': HOOK,
  'PUT /api/mcp': HOOK,
  'PATCH /api/mcp': HOOK,
  'DELETE /api/mcp': HOOK,

  // ---- API documentation (Swagger UI; Settings → API documentation, default: signed-in users) ----
  'GET /api/docs': ALL,
  'GET /api/docs/static/index.html': ALL,
  'GET /api/docs/static/swagger-initializer.js': ALL,
  'GET /api/docs/*': ALL,
  'GET /api/docs/static/*': ALL,
  'GET /api/docs/json': ALL,
  'GET /api/docs/yaml': ALL,

  // ---- public read API /api/v1 (API tokens; called with a read token of each role) ----
  'GET /api/v1/health': PUBLIC,
  'GET /api/v1/openapi.json': PUBLIC,
  'GET /api/v1/openapi.yaml': PUBLIC,
  'GET /api/v1/*': PUBLIC,
  'POST /api/v1/*': PUBLIC,
  'PUT /api/v1/*': PUBLIC,
  'PATCH /api/v1/*': PUBLIC,
  'DELETE /api/v1/*': PUBLIC,
  'GET /api/v1/me': ALL,
  'GET /api/v1/processes': ALL,
  'GET /api/v1/processes/:processId': ALL,
  'GET /api/v1/processes/:processId/versions': ALL,
  'GET /api/v1/processes/:processId/versions/:version': ALL,
  'GET /api/v1/platforms': ALL,
  'GET /api/v1/platforms/:platformId': USE,
  'GET /api/v1/runs': ALL,
  'GET /api/v1/runs/:runId': ALL,
  'GET /api/v1/runs/:runId/steps': ALL,
  'GET /api/v1/runs/:runId/steps/:stepId': ALL,
  'GET /api/v1/runs/:runId/logs': ALL,
  'GET /api/v1/tasks': ALL,
  'GET /api/v1/tasks/:taskId': ALL,
  'GET /api/v1/triggers': ALL,
  'GET /api/v1/triggers/:triggerId': ALL,
  'GET /api/v1/teams': ADMIN,
  'GET /api/v1/schedules': ALL,
  'GET /api/v1/schedules/:scheduleId': ALL,
  'GET /api/v1/semantic-model': ALL,
  'GET /api/v1/datasets': ALL,
  'GET /api/v1/datasets/:datasetKey': ALL,
  'GET /api/v1/datasets/:datasetKey/rows': ALL,
  'GET /api/v1/datasets/:datasetKey/metrics': ALL,
  'GET /api/v1/dashboards': ALL,
  'GET /api/v1/dashboards/:dashboardId': ALL,
  'GET /api/v1/audit': ADMIN_AUDITOR,
  'GET /api/v1/audit/verify': ADMIN_AUDITOR,
  'GET /api/v1/users': ADMIN,
  'GET /api/v1/users/:userId': ADMIN,
  'GET /api/v1/monitors': ALL,
  'GET /api/v1/monitors/discovery': ALL,
  'GET /api/v1/monitors/:monitorId': ALL,
  'GET /api/v1/monitors/:monitorId/status': ALL,
  'GET /api/v1/monitors/:monitorId/history': ALL,
  'GET /api/v1/records': ALL,
  'GET /api/v1/records/:recordId': ALL,
  'GET /api/v1/records/:recordId/versions': ALL,
  'GET /api/v1/credentials': ALL,
  'GET /api/v1/credentials/:credentialId': NOT_VIEWER,

  // ---- Git sync (sources: administrators; updates inbox: designers; origins: everyone) ----
  'GET /api/sync-sources': ADMIN,
  'POST /api/sync-sources': ADMIN,
  'GET /api/sync-sources/:id': ADMIN,
  'PUT /api/sync-sources/:id': ADMIN,
  'DELETE /api/sync-sources/:id': ADMIN,
  'POST /api/sync-sources/:id/rotate-webhook-secret': ADMIN,
  'POST /api/sync-sources/:id/fetch': ADMIN,
  'GET /api/sync-updates': DESIGN,
  'GET /api/sync-updates/:id': DESIGN,
  'POST /api/sync-updates/:id/accept': DESIGN,
  'POST /api/sync-updates/:id/reject': DESIGN,
  'GET /api/sync-origins': ALL,
  'POST /api/hooks/sync/:id': HOOK,
};

/** Routes that only work with an interactive session: an API token must not manage identities, the vault or sign-in. */
const SESSION_ONLY = [
  'POST /api/me/tokens',
  'POST /api/users',
  'PUT /api/users/:id',
  'POST /api/users/:id/reset-password',
  'POST /api/teams',
  'PUT /api/teams/:id',
  'DELETE /api/teams/:id',
  'POST /api/sso/providers',
  'PUT /api/sso/providers/:id',
  'DELETE /api/sso/providers/:id',
  'PUT /api/settings',
  'POST /api/vault/passphrase',
  'POST /api/vault/lock',
  'POST /api/sync-sources',
  'PUT /api/sync-sources/:id',
  'DELETE /api/sync-sources/:id',
  'POST /api/sync-sources/:id/rotate-webhook-secret',
];

/** GET routes whose fixtures cannot give a 2xx (nothing to find); refusals are still checked. */
const NO_POSITIVE = new Set([
  'GET /api/artifacts/:id', // the demo runs write no artifacts
  'GET /api/tasks/:id', // no open approval
  'GET /api/v1/tasks/:taskId',
  'GET /api/records/:id/attachments/:attId/download',
  'GET /api/auth/oidc/callback', // redirects
  'GET /api/auth/oidc/:id/start',
  'GET /api/audit/anchor.json', // no checkpoint file yet
  'GET /api/reports/branding/logo', // no logo uploaded
  'GET /api/theme/logo',
  'GET /api/docs/*', // no such asset
  'GET /api/docs/static/*',
]);

type Fx = Record<string, string>;
let s: TestServer;
const cookies = {} as Record<Role, string>;
const readTokens = {} as Record<Role, string>;
let fullAdminToken = '';
let mcpAdminToken = '';
let fx: Fx = {};
let routes: { method: string; url: string }[] = [];

/** Fills the path parameters of a route with fixture ids. */
function fill(url: string): string {
  const seg = (name: string, fallback: string) => fx[name] ?? fallback;
  return url
    .replace(/\*/g, 'nothing-here')
    .replace(/\/api\/platform-types\/:kind/, `/api/platform-types/${fx.platformKind}`)
    .replace(/:platformId/g, url.startsWith('/api/gatus') ? fx.gatusPlatform! : fx.platform!)
    .replace(/:specId/g, fx.spec!)
    .replace(/:docId/g, fx.doc!)
    .replace(/:processId/g, fx.process!)
    .replace(/:runId/g, fx.run!)
    .replace(/:stepId/g, fx.step!)
    .replace(/:nodeId/g, fx.node!)
    .replace(/:taskId/g, 'tsk_none')
    .replace(/:triggerId/g, fx.trigger!)
    .replace(/:scheduleId/g, fx.schedule!)
    .replace(/:datasetKey/g, fx.dataset!)
    .replace(/:key/g, fx.dataset!)
    .replace(/:dashboardId/g, fx.dashboard!)
    .replace(/:userId/g, fx.user!)
    .replace(/:credentialId/g, fx.credential!)
    .replace(/:monitorId/g, fx.monitor!)
    .replace(/:recordId/g, fx.record!)
    .replace(/:version/g, '1')
    .replace(/:checkId/g, fx.check!)
    .replace(/:wid/g, fx.maintenance!)
    .replace(/:file/g, fx.monitorExample!)
    .replace(/:attId/g, 'att_none')
    .replace(/:linkId/g, url.startsWith('/api/services') ? fx.serviceLink! : fx.recordLink!)
    .replace(/:id/g, () => {
      const prefix = url.split('/')[2]!;
      const map: Record<string, string> = {
        platforms: 'platform',
        processes: 'process',
        runs: 'run',
        artifacts: 'artifact',
        tasks: 'task',
        schedules: 'schedule',
        dashboards: 'dashboard',
        monitors: 'monitor',
        'monitor-gateways': 'gateway',
        triggers: 'trigger',
        hooks: url.includes('/hooks/monitor/') ? 'monitor' : 'trigger',
        records: 'record',
        'record-types': 'recordType',
        credentials: 'credential',
        services: 'service',
        'report-schedules': 'reportSchedule',
        reports: 'report',
        users: 'user',
        teams: 'team',
        me: 'token',
        tokens: 'token',
        sso: 'sso',
        auth: 'sso',
        notifications: 'notification',
        'sync-sources': 'syncSource',
        'sync-updates': 'syncUpdate',
      };
      return seg(map[prefix] ?? '', `none_${prefix}`);
    });
}

/** Query strings some routes need. */
const QUERY: Record<string, string> = {
  'GET /api/link-targets': '?kind=record&q=',
  'GET /api/backlinks': '', // filled in beforeAll (needs the record id)
};

/** Valid bodies for changing routes, so a refusal is a permission decision and not a validation error. */
const bodies = (): Record<string, unknown> => ({
  'POST /api/runs': { processId: fx.process, dryRun: true },
  'POST /api/schedules': { name: 'x', processId: fx.process, cron: '0 3 * * *' },
  'PUT /api/schedules/:id': { name: 'x', processId: fx.process, cron: '0 3 * * *' },
  'POST /api/triggers': { ...TRIGGER, processId: fx.process },
  'PUT /api/triggers/:id': { ...TRIGGER, processId: fx.process },
  'PUT /api/processes/:id': { definition: { id: fx.process, name: 'x', nodes: [], edges: [] } },
  'PUT /api/processes/:id/access': { acl: [] },
  'PUT /api/platforms/:id': { name: 'renamed' },
  'PUT /api/platforms/:id/access': { acl: [] },
  'PUT /api/platforms/:id/secrets': { password: 'x' },
  'POST /api/platforms/:id/request': { method: 'GET', path: '/' },
  'POST /api/platforms/:id/docs': { title: 'x', kind: 'note', content: 'x' },
  'POST /api/platforms/:id/specs': { content: '{"openapi":"3.0.0","info":{"title":"x","version":"1"},"paths":{}}' },
  'PUT /api/monitors/:id/access': { acl: [] },
  'POST /api/monitors/:id/enabled': { enabled: false },
  'POST /api/monitors/:id/maintenance': { endsAt: new Date(Date.now() + 3600000).toISOString(), reason: 'x' },
  'POST /api/monitors/:id/acknowledge': { comment: 'x' },
  'POST /api/monitor-gateways': { name: 'gw x', allowedKeys: ['x.*'] },
  'PUT /api/monitor-gateways/:id': { name: 'gw x', allowedKeys: ['x.*'] },
  'POST /api/records': { type: 'CR', title: 'x', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } },
  'PUT /api/records/:id': { title: 'changed' },
  'POST /api/records/:id/transition': { action: 'submit' },
  'POST /api/records/:id/revise': { comment: 'x' },
  'POST /api/records/:id/comments': { text: 'x' },
  'POST /api/records/:id/links': { url: 'https://cmdb.example.com/9', label: 'x' },
  'POST /api/services': { name: 'svc x', owners: [] },
  'PUT /api/services/:id': { name: 'svc x', owners: [] },
  'POST /api/services/:id/archive': { archived: true },
  'POST /api/services/:id/links': { url: 'https://cmdb.example.com/8', label: 'x' },
  'POST /api/credentials': CREDENTIAL,
  'PUT /api/credentials/:id': CREDENTIAL,
  'POST /api/credentials/:id/rotated': { comment: 'x' },
  'POST /api/credentials/:id/reviewed': { comment: 'x' },
  'POST /api/report-schedules': REPORT_SCHEDULE,
  'PUT /api/report-schedules/:id': REPORT_SCHEDULE,
  'POST /api/dashboards': { text: 'name: Matrix\nwidgets: []\n' },
  'PUT /api/dashboards/:id': { text: 'name: x\nwidgets: []\n' },
  'PUT /api/users/:id': { roles: ['admin'] },
  'POST /api/users': { username: 'mallory', roles: ['admin'], password: 'Mallory-password-1' },
  'POST /api/teams': { name: 'team x', members: [] },
  'PUT /api/teams/:id': { name: 'team y', members: ['vera'] },
  'POST /api/me/tokens': { name: 'x', scope: 'full' },
  'PUT /api/settings': { outboundPolicy: 'open' },
  'PUT /api/audit/anchoring': { emailRecipients: [] },
  'PUT /api/credentials/settings': {},
  'POST /api/vault/passphrase': { current: 'correct horse battery', next: 'correct horse battery 2' },
  'POST /api/vault/unlock': { passphrase: 'correct horse battery' },
  'POST /api/platform-types': { fromPlatformId: fx.platform },
  'POST /api/record-types': { key: 'XX', name: 'x', workflow: 'decision' },
  'PUT /api/mcp-server': { enabled: true },
  'PUT /api/platforms/:id/mcp-gateway': { enabled: true },
  'POST /api/settings/notifications/test': { channel: 'email', to: 'it@example.com' },
  'POST /api/tasks/:id/complete': { approved: true },
  'POST /api/sync-sources': SYNC_SOURCE,
  'PUT /api/sync-sources/:id': SYNC_SOURCE,
});
const SYNC_SOURCE = { name: 'Matrix library', provider: 'forgejo', repoUrl: 'https://git.example.com/team/library', kinds: ['process'] };
const TRIGGER = {
  name: 'matrix',
  enabled: true,
  dryRun: true,
  inputMapping: {},
  bindings: {},
  authMode: 'token',
  allowedCidrs: [],
  allowedHeaders: [],
  rateLimitPerMinute: 60,
  dedupeSeconds: 0,
  skipIfRunning: false,
};
const CREDENTIAL = {
  name: 'Matrix credential',
  type: 'agentCertificate',
  platformText: 'x',
  environment: 'production',
  description: 'd',
  usedBy: { text: 'u', links: [] },
  owners: [{ email: 'it@example.com', role: 'IT' }],
  location: { text: 'KeePass' },
};
const REPORT_SCHEDULE = {
  name: 'Matrix',
  preset: 'custom',
  cron: '0 6 * * 1',
  timezone: 'Europe/Berlin',
  periodDays: 1,
  lang: 'en',
  sections: { runs: {} },
  recipients: { users: [], teams: [], emails: [] },
};

type Who = Role | 'anonymous' | { bearer: string };
async function call(who: Who, method: string, url: string, body?: unknown): Promise<number> {
  const headers: Record<string, string> = { 'x-sm-client': '1' };
  if (typeof who === 'object') headers.authorization = `Bearer ${who.bearer}`;
  else if (who !== 'anonymous') Object.assign(headers, authHeaders(cookies[who]));
  const send = method !== 'GET' && method !== 'DELETE';
  if (send) headers['content-type'] = 'application/json';
  const res = await fetch(s.base + url, { method, headers, redirect: 'manual', body: send ? JSON.stringify(body ?? {}) : undefined });
  await res.arrayBuffer();
  return res.status;
}

const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
const target = (r: { method: string; url: string }) => fill(r.url) + (QUERY[key(r)] ?? '');
const ok = (status: number) => status >= 200 && status < 300;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await allowEmailDomains(s, ['example.com']);
  const a = s.api;
  const procs = await a('GET', '/processes');
  const proc = procs.find((p: { id: string }) => p.id === 'ih-health-check') ?? procs[0];
  const run = await s.waitRun((await a('GET', `/runs?processId=${proc.id}`))[0].id, ['succeeded', 'failed']);
  const platforms = await a('GET', '/platforms');
  const plat = platforms.find((p: { kind: string }) => p.kind !== 'gatus') ?? platforms[0];
  const gatus = platforms.find((p: { kind: string }) => p.kind === 'gatus') ?? plat;
  cookies.admin = await loginCookie(s.base, 'admin', 'Admin-password-1');
  const doc = await (async () => {
    const form = new FormData();
    form.append('file', new Blob(['plain text'], { type: 'text/plain' }), 'notes.txt');
    const res = await fetch(`${s.base}/api/platforms/${plat.id}/docs`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', ...authHeaders(cookies.admin) },
      body: form,
    });
    return res.json();
  })();
  const mons = await a('GET', '/monitors');
  const mon = (mons.items ?? mons).find((m: { key: string }) => m.key === 'machine-17-powermeter') ?? (mons.items ?? mons)[0];
  const monD = await a('GET', `/monitors/${mon.id}`);
  const hook = await a('POST', '/triggers', { ...TRIGGER, processId: proc.id });
  const rec = await a('POST', '/records', { type: 'CR', title: 'Matrix record', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
  const recLink = await a('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/1', label: 'CMDB' });
  const svc = await a('POST', '/services', { name: 'Matrix service', owners: [] });
  const svcLink = await a('POST', `/services/${svc.id}/links`, { url: 'https://cmdb.example.com/2', label: 'x' });
  const gw = await a('POST', '/monitor-gateways', { name: 'Matrix gateway', allowedKeys: ['test.*'] });
  const team = await a('POST', '/teams', { name: 'Matrix team', members: [] });
  const report = await a('POST', `/runs/${run.id}/reports`, {});
  const users = await a('GET', '/users');
  const syncSource = (
    await a('POST', '/sync-sources', { ...SYNC_SOURCE, repoUrl: `${s.base}/mock/git/steward/library`, folder: 'steward', kinds: ['dashboard'] })
  ).source.id;
  await a('POST', `/sync-sources/${syncSource}/fetch`);
  const syncUpdate = (await a('GET', `/sync-updates?sourceId=${syncSource}`))[0].id;
  fx = {
    process: proc.id,
    run: run.id,
    step: String(run.steps[0].id),
    node: run.steps[0].stepId,
    platform: plat.id,
    platformKind: (await a('POST', '/platform-types', { fromPlatformId: gatus.id, kind: 'matrix-connector', label: 'Matrix connector' })).kind,
    gatusPlatform: gatus.id,
    doc: doc.id,
    spec: (await a('GET', `/platforms/${gatus.id}/specs`))[0].id,
    dashboard: (await a('GET', '/dashboards'))[0].id,
    dataset: (await a('GET', '/datasets'))[0].key,
    monitor: mon.id,
    check: monD.definition.checks[0].id,
    maintenance: (await a('POST', `/monitors/${mon.id}/maintenance`, { endsAt: new Date(Date.now() + 3600000).toISOString(), reason: 'x' })).id,
    monitorExample: (await a('GET', '/monitors/examples'))[0]?.file ?? 'none.yaml',
    gateway: gw.gateway.id,
    schedule: (await a('GET', '/schedules'))[0].id,
    trigger: hook.trigger.id,
    record: rec.id,
    recordLink: recLink.id,
    recordType: (await a('GET', '/record-types'))[0].id,
    credential: (await a('POST', '/credentials', CREDENTIAL)).id,
    service: svc.id,
    serviceLink: svcLink.id,
    reportSchedule: (await a('POST', '/report-schedules', REPORT_SCHEDULE)).id,
    report: report.id,
    user: users.find((u: { username: string }) => u.username === 'vera').id,
    team: team.id,
    token: (await a('POST', '/me/tokens', { name: 'matrix', scope: 'read' })).id,
    sso: (await a('GET', '/sso/providers'))[0].id,
    notification: 'ntf_none',
    artifact: 'art_none',
    task: 'tsk_none',
    syncSource,
    syncUpdate,
  };
  QUERY['GET /api/backlinks'] = `?kind=record&id=${rec.id}`;
  for (const role of ROLES) cookies[role] = await loginCookie(s.base, USERS[role], role === 'admin' ? 'Admin-password-1' : PW);
  for (const role of ROLES) {
    const res = await fetch(`${s.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json', ...authHeaders(cookies[role]) },
      body: JSON.stringify({ name: 'matrix read', scope: 'read' }),
    });
    readTokens[role] = (await res.json()).token;
  }
  const mk = async (scope: string) =>
    (
      await (
        await fetch(`${s.base}/api/me/tokens`, {
          method: 'POST',
          headers: { 'x-sm-client': '1', 'content-type': 'application/json', ...authHeaders(cookies.admin) },
          body: JSON.stringify({ name: `matrix ${scope}`, scope }),
        })
      ).json()
    ).token;
  fullAdminToken = await mk('full');
  mcpAdminToken = await mk('mcp');
  const { registeredRoutes } = await import('../src/app.js');
  routes = registeredRoutes(s.app).filter((r) => !r.url.startsWith('/mock/'));
}, 120_000);

afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

const OBSERVE = process.env.SM_ROUTE_MATRIX_OBSERVE;

describe('route permission matrix', () => {
  it('classifies every registered route (and lists no stale ones)', () => {
    const registered = new Set(routes.map(key));
    expect(
      [...registered].filter((k) => !(k in EXPECT)),
      'routes missing from EXPECT in route-matrix.test.ts',
    ).toEqual([]);
    // which of the two web UI routes exists depends on whether web/dist is built
    const WEB_UI = new Set(['GET /', 'GET /*']);
    expect(
      [...WEB_UI].some((k) => registered.has(k)),
      'one of the web UI routes',
    ).toBe(true);
    expect(
      Object.keys(EXPECT).filter((k) => !registered.has(k) && !WEB_UI.has(k)),
      'EXPECT entries without a route',
    ).toEqual([]);
  });

  it('refuses every role outside the table and serves the roles in it', async () => {
    const problems: string[] = [];
    const observed: string[] = [];
    const b = bodies();
    for (const r of routes) {
      const k = key(r);
      const access = EXPECT[k];
      if (!Array.isArray(access)) continue;
      const v1 = r.url.startsWith('/api/v1/');
      for (const role of ROLES) {
        const allowed = access.includes(role);
        // changing routes are only sent where they must be refused (keeps the fixtures intact)
        if (r.method !== 'GET' && allowed && !OBSERVE) continue;
        if (r.method !== 'GET' && role === 'admin') continue;
        if (k === 'POST /api/auth/logout') continue;
        const status = await call(v1 ? { bearer: readTokens[role] } : role, r.method, target(r), b[k] ?? {});
        observed.push(`${k} ${role} ${status}`);
        if (status >= 500) problems.push(`${k} as ${role}: ${status}`);
        else if (!allowed && ok(status)) problems.push(`${k} as ${role}: ${status} (must be refused)`);
        else if (allowed && r.method === 'GET' && !(status >= 200 && status < 400) && !NO_POSITIVE.has(k))
          problems.push(`${k} as ${role}: ${status} (must be served)`);
      }
    }
    if (OBSERVE) fs.writeFileSync(OBSERVE, observed.join('\n'));
    expect(problems).toEqual([]);
  }, 300_000);

  it('answers 401 without credentials on every non-public route', async () => {
    const problems: string[] = [];
    for (const r of routes) {
      const access = EXPECT[key(r)];
      if (!Array.isArray(access)) continue;
      const status = await call('anonymous', r.method, target(r), {});
      if (status !== 401) problems.push(`${key(r)}: ${status}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('refuses read-only tokens on changing routes and MCP tokens outside /api/mcp', async () => {
    const problems: string[] = [];
    const b = bodies();
    for (const r of routes) {
      const access = EXPECT[key(r)];
      if (!Array.isArray(access) || r.url.startsWith('/api/v1/')) continue;
      if (r.method !== 'GET') {
        const status = await call({ bearer: readTokens.admin }, r.method, target(r), b[key(r)] ?? {});
        if (status !== 403 && status !== 401) problems.push(`read token ${key(r)}: ${status}`);
      }
      const status = await call({ bearer: mcpAdminToken }, r.method, target(r), b[key(r)] ?? {});
      if (status !== 403 && status !== 401) problems.push(`MCP token ${key(r)}: ${status}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('keeps identity, vault and sign-in settings to signed-in sessions (no API tokens)', async () => {
    const b = bodies();
    const problems: string[] = [];
    const { SESSION_ONLY_ROUTES } = await import('../src/app.js');
    expect([...SESSION_ONLY_ROUTES].sort()).toEqual([...SESSION_ONLY].sort());
    for (const k of SESSION_ONLY) {
      expect(EXPECT[k], k).toBeDefined();
      const [method, url] = k.split(' ') as [string, string];
      const status = await call({ bearer: fullAdminToken }, method, fill(url), b[k] ?? {});
      if (status !== 403) problems.push(`${k}: ${status}`);
    }
    expect(problems).toEqual([]);
  });
});
