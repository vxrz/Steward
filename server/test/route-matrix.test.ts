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

/** Access reconciliation: administrators, auditors and whoever may use the platform (the demo check's owner is the admin). */
const RECON_READ: Role[] = ['admin', 'designer', 'operator', 'auditor'];

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
  // emergency access: the one-time code (auth/emergency.ts), and the signed grant of the command line (loopback only)
  'POST /api/auth/emergency': PUBLIC,
  'POST /api/auth/emergency/grant': PUBLIC,
  // moving an instance (server/src/migration): administrators, sessions only
  'POST /api/migration/export': ADMIN,
  'GET /api/migration/exports/:id/download': ADMIN,
  'POST /api/migration/imports/upload': ADMIN,
  'GET /api/migration/imports/staged/:id': ADMIN,
  'DELETE /api/migration/imports/staged/:id': ADMIN,
  'POST /api/migration/imports/staged/:id/apply': ADMIN,
  'GET /api/migration/imports': ADMIN,
  'GET /api/migration/imports/:id': ADMIN,
  'GET /api/migration/imports/:id/history': ADMIN,
  'GET /api/auth/oidc/:id/start': PUBLIC,
  'GET /api/auth/oidc/callback': PUBLIC,
  'POST /api/auth/logout': ALL,
  'GET /api/auth/me': ALL,
  'POST /api/auth/password': ALL,
  // step-up re-authentication (auth/step-up.ts): every signed-in session confirms its own owner
  'GET /api/auth/step-up': ALL,
  'POST /api/auth/step-up': ALL,
  'DELETE /api/auth/step-up': ALL,
  'POST /api/auth/step-up/sso': ALL,
  'POST /api/auth/step-up/sso/complete': ALL,
  'GET /api/about': ALL,
  'GET /api/system/status': ADMIN_AUDITOR,
  'GET /api/system/update-notice': ADMIN,
  'POST /api/system/update-notice/dismiss': ADMIN,
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
  'GET /api/users/:id/references': ADMIN,
  'GET /api/teams/:id/references': ADMIN,
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
  'POST /api/sso/providers/:id/test-sign-in': ADMIN,
  'POST /api/sso/test-sign-ins/:id': ADMIN,
  'GET /api/sso/redirect-uri': ALL,

  // ---- settings, theme, notifications, maintenance ----
  'GET /api/settings': ADMIN,
  'PUT /api/settings': ADMIN,
  'GET /api/settings/notifications': ADMIN,
  'PUT /api/settings/notifications': ADMIN,
  'POST /api/settings/notifications/test': ADMIN,
  'GET /api/settings/notifications/look': ADMIN,
  'PUT /api/settings/notifications/look': ADMIN,
  'POST /api/settings/notifications/look/preview': ADMIN,
  'GET /api/settings/notifications/look/logo': ADMIN,
  'POST /api/settings/notifications/look/logo': ADMIN,
  'DELETE /api/settings/notifications/look/logo': ADMIN,
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
  'GET /api/backups': ADMIN,
  'GET /api/backups/stored': ADMIN,
  'PUT /api/backups/settings': ADMIN,
  'PUT /api/backups/passphrase': ADMIN,
  'POST /api/backups/run': ADMIN,
  'POST /api/backups/restore-test': ADMIN,
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
  // recorded responses (#105): read like the explorer, changed like the platform
  'GET /api/platforms/:id/recordings': USE,
  'POST /api/platforms/:id/recordings': ADMIN,
  'PUT /api/platforms/:id/recordings/:recId': ADMIN,
  'DELETE /api/platforms/:id/recordings/:recId': ADMIN,
  'POST /api/platforms/:id/token/renew': ADMIN,
  // Kafka peek (#112): platform managers only, and only where the platform allows it
  'POST /api/platforms/:id/kafka/peek': ADMIN,
  'GET /api/platforms/:id/specs': USE,
  'POST /api/platforms/:id/specs': ADMIN,
  'DELETE /api/platforms/:id/specs/:specId': ADMIN,
  'PATCH /api/platforms/:id/specs/:specId': ADMIN,
  'POST /api/platforms/:id/specs/:specId/copy': ADMIN,
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
  // manual steps: verify, evidence files (only whoever may work on the step adds or removes them; whoever sees the run reads them)
  'POST /api/tasks/:id/verify': ACTIVE,
  'POST /api/tasks/:id/evidence': ACTIVE,
  'DELETE /api/tasks/:id/evidence/:evidenceId': ACTIVE,
  'GET /api/tasks/:id/evidence/:evidenceId/download': ALL,
  'GET /api/schedules': ALL,
  'POST /api/schedules': RUN,
  'PUT /api/schedules/:id': ADMIN,
  'DELETE /api/schedules/:id': ADMIN,
  'POST /api/schedules/:id/pause': ADMIN,
  'POST /api/schedules/:id/resume': ADMIN,
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
  'POST /api/triggers/:id/pause': ADMIN,
  'POST /api/triggers/:id/resume': ADMIN,
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
  'GET /api/datasets/:key/sources': ALL,
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
  'POST /api/monitors/import/preview': DESIGN,
  'POST /api/monitors/examples/:file/preview': DESIGN,
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
  'POST /api/monitors/:id/test-run': RUN,
  'POST /api/monitors/check-preview': DESIGN,
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
  // incident reviews (#109): measures are kept by the review's author/owner, designers and administrators
  'GET /api/measures': ALL,
  'GET /api/records/:id/measures': ALL,
  'POST /api/records/:id/measures': DESIGN,
  'PUT /api/records/:id/measures/:measureId': DESIGN,
  'DELETE /api/records/:id/measures/:measureId': DESIGN,
  'GET /api/records/:id/timeline': ALL,
  'POST /api/records/:id/timeline': RUN,
  'POST /api/incident-reviews': RUN,
  // editing a link (label, type, note): the same people who add and remove links
  'PATCH /api/records/:id/links/:linkId': RUN,
  'DELETE /api/records/:id/links/:linkId': RUN,
  'POST /api/records/:id/attachments': RUN,
  'DELETE /api/records/:id/attachments/:attId': RUN,
  'GET /api/records/:id/attachments/:attId/download': ALL,
  'POST /api/records/:id/pdf': ACTIVE,
  'POST /api/records/:id/signed': ACTIVE,
  // living documents: editions and reviews are read by everyone; reviewing: approvers, administrators and the document's (review) owner
  'GET /api/records/:id/editions': ALL,
  'GET /api/records/:id/editions/:edition': ALL,
  'POST /api/records/:id/editions/:edition/pdf': ACTIVE,
  'GET /api/records/:id/changelog': ALL,
  'GET /api/records/:id/reviews': ALL,
  'POST /api/records/:id/review': ['admin', 'approver'],
  // the interval needs an approver (an earlier date: editors and the owner too)
  'PUT /api/records/:id/review-settings': ['admin', 'approver'],
  'GET /api/record-types': ALL,
  // ---- compliance: access changes, reconciliation, controls, evidence packs ----
  'GET /api/compliance/access-changes': ALL,
  // access change entries name people and their rights: not for viewers (who have no right on the platform)
  'GET /api/compliance/access-changes/:accessChangeId': NOT_VIEWER,
  'POST /api/compliance/access-changes': RUN,
  'GET /api/compliance/reconciliation/meta': ALL,
  'GET /api/compliance/person-reviews': ALL, // each sees the reviews they may read
  'GET /api/compliance/person-reviews/suggest': DESIGN,
  'POST /api/compliance/person-reviews': DESIGN,
  // the fixture review is the administrator's: they decide; approvers and auditors read it
  'GET /api/compliance/person-reviews/:reviewId': ['admin', 'approver', 'auditor'],
  'PUT /api/compliance/person-reviews/:reviewId/decisions': ADMIN,
  'POST /api/compliance/person-reviews/:reviewId/submit': ADMIN,
  'POST /api/compliance/person-reviews/:reviewId/approval': ['admin', 'approver'],
  'POST /api/compliance/person-reviews/:reviewId/recheck': ['admin', 'approver'],
  'GET /api/compliance/person-reviews/:reviewId/seal': ['admin', 'approver', 'auditor'],
  'GET /api/compliance/access-checks': ALL,
  'POST /api/compliance/access-checks': DESIGN,
  'GET /api/compliance/access-checks/:accessCheckId': RECON_READ,
  'PUT /api/compliance/access-checks/:accessCheckId': ADMIN,
  'DELETE /api/compliance/access-checks/:accessCheckId': ADMIN,
  'POST /api/compliance/access-checks/:accessCheckId/run': ADMIN,
  'GET /api/compliance/access-checks/:accessCheckId/snapshots': RECON_READ,
  'GET /api/compliance/access-checks/:accessCheckId/snapshots/:snapshotId': RECON_READ,
  'GET /api/compliance/access-checks/:accessCheckId/verify': RECON_READ,
  'GET /api/compliance/findings': ALL,
  'POST /api/compliance/findings/:findingId/document': RUN,
  'POST /api/compliance/findings/:findingId/dismiss': ADMIN,
  'POST /api/compliance/demo/simulate-change': DESIGN,
  'GET /api/compliance/meta': ALL,
  'GET /api/compliance/catalogues': ALL,
  'POST /api/compliance/catalogues': ADMIN,
  'PUT /api/compliance/catalogues/:catalogueId': ADMIN,
  'DELETE /api/compliance/catalogues/:catalogueId': ADMIN,
  'POST /api/compliance/catalogues/import': ADMIN,
  'POST /api/compliance/catalogues/:catalogueId/controls': ADMIN,
  'GET /api/compliance/controls': ALL,
  'GET /api/compliance/controls/:controlId': ALL,
  'PUT /api/compliance/controls/:controlId': ADMIN,
  'POST /api/compliance/controls/:controlId/tags': DESIGN,
  'POST /api/compliance/controls/:controlId/tags/remove': DESIGN,
  'GET /api/compliance/coverage': ALL,
  'GET /api/compliance/tagged': ALL,
  'GET /api/compliance/tag-targets': ALL,
  'GET /api/compliance/evidence-packs/meta': ALL,
  'GET /api/compliance/evidence-packs': ALL,
  'POST /api/compliance/evidence-packs': NOT_VIEWER,
  'GET /api/compliance/evidence-packs/:packId': ADMIN_AUDITOR,
  'DELETE /api/compliance/evidence-packs/:packId': ADMIN,
  'GET /api/compliance/evidence-packs/:packId/download': ADMIN_AUDITOR,

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
  // types of external links: everyone reads them (the add-link dialog), administrators manage their own
  'GET /api/link-types': ALL,
  'POST /api/link-types': ADMIN,
  'PUT /api/link-types/:key': ADMIN,
  'PATCH /api/services/:id/links/:linkId': DESIGN,
  'DELETE /api/services/:id/links/:linkId': DESIGN,
  // applications of the service catalogue: everyone reads them; designers, administrators (and the owners) change them
  'GET /api/applications': ALL,
  'POST /api/applications': DESIGN,
  'GET /api/applications/:id': ALL,
  'PUT /api/applications/:id': DESIGN,
  'POST /api/applications/:id/archive': DESIGN,
  'PUT /api/applications/:id/rating': DESIGN,
  'POST /api/applications/:id/platforms': DESIGN,
  'DELETE /api/applications/:id/platforms/:platformId': DESIGN,
  'POST /api/applications/:id/links': DESIGN,
  'PATCH /api/applications/:id/links/:linkId': DESIGN,
  'DELETE /api/applications/:id/links/:linkId': DESIGN,
  // components and tech stack (#103): like the application
  'GET /api/catalogue/stack-products': ALL,
  // end of life (#104): everyone reads the status; administrators change the settings; designers and administrators refresh
  'GET /api/catalogue/lifecycle': ALL,
  'PUT /api/catalogue/lifecycle': ADMIN,
  'POST /api/catalogue/lifecycle/refresh': DESIGN,
  'POST /api/applications/:id/components': DESIGN,
  'PUT /api/applications/:id/components/:componentId': DESIGN,
  'DELETE /api/applications/:id/components/:componentId': DESIGN,
  'POST /api/applications/:id/components/:componentId/sbom/preview': DESIGN,
  'POST /api/applications/:id/components/:componentId/sbom': DESIGN,
  'POST /api/applications/:id/components/:componentId/cluster': DESIGN,
  'POST /api/applications/:id/components/:componentId/repository': DESIGN,
  'POST /api/applications/:id/components/:componentId/topic': DESIGN,
  'POST /api/applications/:id/components/:componentId/aws': DESIGN,
  'POST /api/applications/:id/components/:componentId/snowflake': DESIGN,
  'POST /api/applications/:id/components/:componentId/dependency-track': DESIGN,
  'GET /api/systems': ALL,
  'POST /api/systems': DESIGN,
  'GET /api/systems/:id': ALL,
  'PUT /api/systems/:id': DESIGN,
  'DELETE /api/systems/:id': DESIGN,
  'POST /api/systems/:id/sbom/preview': DESIGN,
  'POST /api/systems/:id/sbom': DESIGN,
  'POST /api/applications/:id/systems': DESIGN,
  'PUT /api/applications/:id/systems/:systemLinkId': DESIGN,
  'DELETE /api/applications/:id/systems/:systemLinkId': DESIGN,
  'GET /api/catalogue/environments': ALL,
  'PUT /api/catalogue/environments': ADMIN,
  'GET /api/maintenance-windows': ALL,
  'POST /api/maintenance-windows': DESIGN,
  'GET /api/maintenance-windows/:id': ALL,
  'PUT /api/maintenance-windows/:id': DESIGN,
  'POST /api/maintenance-windows/:id/cancel': DESIGN,
  'GET /api/maintenance-windows/:id/ics': ALL,
  'GET /api/platforms/:id/application': USE,
  'PUT /api/services/:id/applications/:applicationId': DESIGN,
  'DELETE /api/services/:id/applications/:applicationId': DESIGN,
  'PUT /api/services/:id/protection-need': DESIGN,
  'GET /api/catalogue/cia-scale': ALL,
  'PUT /api/catalogue/cia-scale': ADMIN,
  // the scope of a living document: whoever may edit records (the fixture record is a change request: 400 for them)
  'PUT /api/records/:id/applications': RUN,
  // service duties (#85): everyone reads them like services; service editors (and owners) define them and ask for
  // exceptions; a second person – administrator, designer, or an owner as of the request – decides (the fixture's exception was asked
  // by the administrator, who may only withdraw it)
  'GET /api/duties': ALL,
  'POST /api/duties': DESIGN,
  'GET /api/duties/:id': ALL,
  'PUT /api/duties/:id': DESIGN,
  'POST /api/duties/:id/archive': DESIGN,
  'POST /api/duties/:id/skips': DESIGN,
  'POST /api/duties/:id/skips/:skipId/decision': DESIGN,
  'POST /api/duties/:id/skips/:skipId/withdraw': ADMIN,
  // availability objectives and the service scorecard (#86): everyone reads them like services; service editors (and
  // owners) define objectives; administrators keep the expected-document rules
  'GET /api/objectives': ALL,
  'POST /api/objectives': DESIGN,
  'GET /api/objectives/:id': ALL,
  'PUT /api/objectives/:id': DESIGN,
  'POST /api/objectives/:id/archive': DESIGN,
  'GET /api/scorecard': ALL,
  'GET /api/scorecard/trend': ALL,
  'GET /api/scorecard/services/:id': ALL,
  'GET /api/scorecard/rules': ALL,
  'POST /api/scorecard/rules': ADMIN,
  'PUT /api/scorecard/rules/:id': ADMIN,
  'DELETE /api/scorecard/rules/:id': ADMIN,

  // ---- credentials register ----
  'GET /api/credentials': ALL,
  'POST /api/credentials': RUN,
  'GET /api/credentials/export.csv': ALL,
  'GET /api/credentials/summary': ALL,
  'GET /api/credentials/belongs-targets': ALL,
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
  'GET /api/v1/records/:recordId/editions': ALL,
  'GET /api/v1/records/:recordId/editions/:edition': ALL,
  'GET /api/v1/records/:recordId/reviews': ALL,
  'GET /api/v1/services': ALL,
  'GET /api/v1/services/:serviceId': ALL,
  'GET /api/v1/services/:serviceId/documents': ALL,
  'GET /api/v1/applications': ALL,
  'GET /api/v1/applications/:applicationId': ALL,
  'GET /api/v1/systems': ALL,
  'GET /api/v1/systems/:systemId': ALL,
  'GET /api/v1/environments': ALL,
  'GET /api/v1/maintenance-windows': ALL,
  'GET /api/v1/measures': ALL,
  'GET /api/v1/applications/:applicationId/documents': ALL,
  'GET /api/v1/cia-scale': ALL,
  'GET /api/v1/duties': ALL,
  'GET /api/v1/duties/:dutyId': ALL,
  'GET /api/v1/duties/:dutyId/periods': ALL,
  'GET /api/v1/scorecard': ALL,
  'GET /api/v1/scorecard/trend': ALL,
  'GET /api/v1/services/:serviceId/scorecard': ALL,
  'GET /api/v1/objectives': ALL,
  'GET /api/v1/objectives/:objectiveId/samples': ALL,
  'GET /api/v1/access-changes': ALL,
  'GET /api/v1/access-findings': ALL,
  'GET /api/v1/control-catalogues': ALL,
  'GET /api/v1/controls': ALL,
  'GET /api/v1/control-coverage': ALL,
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
  'GET /api/v1/ticket-references': ALL,
  'GET /api/v1/ticket-references/:ticketId': ALL,

  // ---- ticket references (edit: editor roles plus the responsible people; none in the fixture) ----
  'GET /api/ticket-references': ALL,
  'POST /api/ticket-references': RUN,
  'GET /api/ticket-references/settings': ALL,
  'PUT /api/ticket-references/settings': ADMIN,
  'GET /api/ticket-references/vendors': ALL,
  'GET /api/ticket-references/open-counts': ALL,
  'GET /api/ticket-references/:id': ALL,
  'PUT /api/ticket-references/:id': RUN,
  'POST /api/ticket-references/:id/status': RUN,
  'POST /api/ticket-references/:id/checked': RUN,
  'DELETE /api/ticket-references/:id': ADMIN,

  // ---- daily summary ----
  'GET /api/me/daily-summary': ALL,
  'PUT /api/me/daily-summary': ALL,
  'GET /api/me/daily-summary/preview': ALL,
  'GET /api/settings/daily-summary': ADMIN,
  'PUT /api/settings/daily-summary': ADMIN,
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
  'POST /api/sso/providers/:id/test-sign-in',
  'POST /api/sso/test-sign-ins/:id',
  'GET /api/auth/step-up',
  'POST /api/auth/step-up',
  'DELETE /api/auth/step-up',
  'POST /api/auth/step-up/sso',
  'POST /api/auth/step-up/sso/complete',
  'PUT /api/settings',
  'POST /api/vault/passphrase',
  'POST /api/vault/lock',
  'POST /api/sync-sources',
  'PUT /api/sync-sources/:id',
  'DELETE /api/sync-sources/:id',
  'POST /api/sync-sources/:id/rotate-webhook-secret',
  'POST /api/migration/export',
  'GET /api/migration/exports/:id/download',
  'POST /api/migration/imports/upload',
  'GET /api/migration/imports/staged/:id',
  'DELETE /api/migration/imports/staged/:id',
  'POST /api/migration/imports/staged/:id/apply',
  'GET /api/migration/imports',
  'GET /api/migration/imports/:id',
  'GET /api/migration/imports/:id/history',
];

/**
 * Sensitive routes that need a recent confirmation of the session's owner (step-up, auth/step-up.ts): always, or – for
 * routes where only some changes are sensitive – with a body that makes the request a sensitive one (`sensitive`) and
 * one that does not (`harmless`, never STEP_UP_REQUIRED). A route that loses its step-up fails this test.
 */
const STEP_UP: Record<string, 'always' | { sensitive: unknown; harmless: unknown }> = {
  'POST /api/me/tokens': 'always',
  'POST /api/vault/passphrase': 'always',
  'POST /api/users': { sensitive: { username: 'matrix-new', roles: ['viewer'] }, harmless: { username: '!' } },
  'PUT /api/users/:id': { sensitive: { roles: ['admin'] }, harmless: {} },
  'POST /api/users/:id/reset-password': 'always',
  'POST /api/sso/providers': 'always',
  'PUT /api/sso/providers/:id': 'always',
  'DELETE /api/sso/providers/:id': 'always',
  'PUT /api/settings': { sensitive: { outboundAllowList: ['matrix.example'] }, harmless: {} },
  'PUT /api/settings/notifications': { sensitive: { allowedEmailDomains: ['matrix.example'] }, harmless: { allowedEmailDomains: ['example.com'] } },
  'POST /api/teams': { sensitive: { name: 'Matrix step-up', members: ['vera'] }, harmless: { name: '!' } },
  'PUT /api/teams/:id': { sensitive: { name: 'Matrix team', members: ['vera'] }, harmless: { name: 'Matrix team', members: [] } },
  // (harmless: no list, so nobody gains a right – refused by the route's validation, the fixture stays)
  'PUT /api/platforms/:id/access': {
    sensitive: { acl: [{ subject: 'user:vera', permissions: ['manage'] }] },
    harmless: { acl: 'not a list' },
  },
  'PUT /api/processes/:id/access': {
    sensitive: { acl: [{ subject: 'user:vera', permissions: ['manage'] }] },
    harmless: { acl: 'not a list' },
  },
  'PUT /api/monitors/:id/access': {
    sensitive: { acl: [{ subject: 'team:matrix team', permissions: ['manage'] }] },
    harmless: { acl: 'not a list' },
  },
  'POST /api/compliance/evidence-packs': 'always',
  'GET /api/audit/export': 'always',
  'PUT /api/audit/anchoring': 'always',
  'GET /api/credentials/export.csv': 'always',
  'POST /api/migration/export': 'always',
  'POST /api/migration/imports/staged/:id/apply': 'always',
  'PUT /api/catalogue/cia-scale': 'always',
  'PUT /api/backups/settings': 'always',
  'PUT /api/backups/passphrase': 'always',
};

/** GET routes whose fixtures cannot give a 2xx (nothing to find); refusals are still checked. */
const NO_POSITIVE = new Set([
  // no S3 storage set up in the fixtures
  'GET /api/backups/stored',
  'GET /api/artifacts/:id', // the demo runs write no artifacts
  'GET /api/tasks/:id', // no open approval
  'GET /api/tasks/:id/evidence/:evidenceId/download', // no manual step
  'GET /api/v1/tasks/:taskId',
  'GET /api/records/:id/attachments/:attId/download',
  'GET /api/records/:id/editions/:edition', // the fixture record is a change request: no editions
  'GET /api/v1/records/:recordId/editions/:edition',
  'GET /api/auth/oidc/callback', // redirects
  'GET /api/auth/oidc/:id/start',
  'GET /api/audit/anchor.json', // no checkpoint file yet
  'GET /api/reports/branding/logo', // no logo uploaded
  'GET /api/settings/notifications/look/logo',
  'GET /api/theme/logo',
  'GET /api/docs/*', // no such asset
  'GET /api/docs/static/*',
  'GET /api/migration/exports/:id/download', // no package exported
  'GET /api/migration/imports/staged/:id', // no package uploaded
  'GET /api/migration/imports/:id', // nothing imported
  'GET /api/migration/imports/:id/history',
]);

type Fx = Record<string, string>;
let s: TestServer;
const cookies = {} as Record<Role, string>;
const readTokens = {} as Record<Role, string>;
let fullAdminToken = '';
let mcpAdminToken = '';
let fx: Fx = {};
let routes: { method: string; url: string; bodyLimit?: number }[] = [];

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
    .replace(/:ticketId/g, fx.ticket!)
    .replace(/:monitorId/g, fx.monitor!)
    .replace(/:recordId/g, fx.record!)
    .replace(/:serviceId/g, fx.service!)
    .replace(/:applicationId/g, fx.application!)
    .replace(/:componentId/g, fx.component!)
    .replace(/:systemLinkId/g, fx.systemLink!)
    .replace(/:systemId/g, fx.system!)
    .replace(/:dutyId/g, fx.duty!)
    .replace(/:skipId/g, fx.dutySkip!)
    .replace(/:objectiveId/g, fx.objective!)
    .replace(/:accessChangeId/g, fx.accessChange!)
    .replace(/:accessCheckId/g, fx.accessCheck!)
    .replace(/:reviewId/g, fx.personReview!)
    .replace(/:snapshotId/g, fx.snapshot!)
    .replace(/:findingId/g, fx.finding!)
    .replace(/:catalogueId/g, fx.catalogue!)
    .replace(/:controlId/g, fx.control!)
    .replace(/:packId/g, fx.pack!)
    .replace(/:version/g, '1')
    .replace(/:edition/g, '1.0')
    .replace(/:checkId/g, fx.check!)
    .replace(/:wid/g, fx.maintenance!)
    .replace(/:file/g, fx.monitorExample!)
    .replace(/:attId/g, 'att_none')
    .replace(/:evidenceId/g, 'tev_none')
    .replace(/:linkId/g, url.startsWith('/api/services') ? fx.serviceLink! : url.startsWith('/api/applications') ? fx.applicationLink! : fx.recordLink!)
    .replace(/:measureId/g, fx.measure!)
    .replace(/^\/api\/records\/:id\/(measures|timeline)/, (_m, rest: string) => `/api/records/${fx.review}/${rest}`)
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
        'ticket-references': 'ticket',
        services: 'service',
        applications: 'application',
        systems: 'system',
        'maintenance-windows': 'catalogueMaintenance',
        duties: 'duty',
        objectives: 'objective',
        scorecard: url.includes('/rules/') ? 'scorecardRule' : 'service',
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
  'GET /api/records/:id/timeline': '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
  'GET /api/link-targets': '?kind=record&q=',
  'GET /api/backlinks': '', // filled in beforeAll (needs the record id)
  'GET /api/ticket-references/open-counts': '?kind=service',
  'GET /api/compliance/coverage': `?from=2026-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`,
  'GET /api/v1/control-coverage': `?from=2026-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`,
  'GET /api/compliance/tag-targets': '?kind=process&q=',
  'GET /api/compliance/tagged': '?kind=recordType&targetId=rty_ac',
  'GET /api/compliance/person-reviews/suggest': '?user=vera',
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
  'POST /api/platforms/:id/recordings': { method: 'GET', path: `/matrix/${Math.random()}`, status: 200 },
  'PUT /api/platforms/:id/recordings/:recId': { method: 'GET', path: '/matrix', status: 200 },
  'POST /api/platforms/:id/docs': { title: 'x', kind: 'note', content: 'x' },
  'POST /api/platforms/:id/specs': { content: '{"openapi":"3.0.0","info":{"title":"x","version":"1"},"paths":{}}' },
  'PATCH /api/platforms/:id/specs/:specId': { pathPrefix: '' },
  // the source itself is skipped: nothing is copied
  'POST /api/platforms/:id/specs/:specId/copy': { targets: [fx.platform] },
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
  'POST /api/records/:id/review': { outcome: 'no_change', comment: 'x' },
  'PUT /api/records/:id/review-settings': { intervalMonths: 6 },
  'POST /api/records/:id/links': { url: 'https://cmdb.example.com/9', label: 'x' },
  'POST /api/records/:id/measures': { title: 'Matrix measure x', owners: ['user:admin'], dueDate: '2030-01-01' },
  'PUT /api/records/:id/measures/:measureId': { title: 'Matrix measure' },
  'POST /api/records/:id/timeline': { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', keys: ['monitor:0'] },
  'POST /api/incident-reviews': { source: 'ticket', ticketId: fx.ticket },
  'POST /api/services': { name: 'svc x', owners: [] },
  'PUT /api/services/:id': { name: 'svc x', owners: [] },
  'POST /api/services/:id/archive': { archived: true },
  'POST /api/services/:id/links': { url: 'https://cmdb.example.com/8', label: 'x', linkType: 'runbook' },
  'PATCH /api/records/:id/links/:linkId': { label: 'changed', note: 'n', linkType: 'repository' },
  'PATCH /api/services/:id/links/:linkId': { label: 'changed', note: 'n', linkType: 'repository' },
  'POST /api/applications': { name: 'app x', owners: [] },
  'PUT /api/applications/:id': { name: 'app x', owners: [] },
  'POST /api/applications/:id/archive': { archived: true },
  'PUT /api/applications/:id/rating': { confidentiality: { level: 'high', justification: 'x' } },
  'POST /api/applications/:id/platforms': { platformId: fx.platform },
  'POST /api/applications/:id/links': { url: 'https://cmdb.example.com/7', label: 'x' },
  'PATCH /api/applications/:id/links/:linkId': { label: 'changed', note: 'n' },
  'POST /api/applications/:id/components': { type: 'other', name: `matrix ${Math.random()}` },
  'PUT /api/catalogue/lifecycle': { platformId: null, warnDays: 90, notify: true, scorecard: false },
  'PUT /api/applications/:id/components/:componentId': { type: 'other', name: 'matrix component' },
  'POST /api/applications/:id/components/:componentId/sbom/preview': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/applications/:id/components/:componentId/sbom': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/systems': { name: 'Matrix system x', kind: 'server' },
  'PUT /api/systems/:id': { name: 'Matrix system', kind: 'server' },
  'POST /api/systems/:id/sbom/preview': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/systems/:id/sbom': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/applications/:id/systems': { systemId: fx.system, environment: 'test' },
  'PUT /api/applications/:id/systems/:systemLinkId': { environment: 'prod' },
  'PUT /api/catalogue/environments': { environments: [{ name: 'prod', production: true }] },
  'POST /api/maintenance-windows': {
    title: 'Matrix maintenance',
    startsAt: '2030-01-01T02:00:00Z',
    endsAt: '2030-01-01T04:00:00Z',
    targets: [{ kind: 'service', id: fx.service }],
  },
  'PUT /api/maintenance-windows/:id': {
    title: 'Matrix maintenance',
    startsAt: '2030-01-01T02:00:00Z',
    endsAt: '2030-01-01T04:00:00Z',
    targets: [{ kind: 'service', id: fx.service }],
  },
  'PUT /api/services/:id/applications/:applicationId': { role: 'primary' },
  'PUT /api/services/:id/protection-need': { availability: { level: 'high', reason: 'x' } },
  'PUT /api/catalogue/cia-scale': { mode: 'default' },
  'PUT /api/records/:id/applications': { applicationIds: [] },
  'POST /api/duties': { serviceId: fx.service, name: 'Matrix duty x', processId: fx.process, interval: 'monthly', level: 'mandatory' },
  'PUT /api/duties/:id': { name: 'Matrix duty', processId: fx.process, interval: 'monthly', level: 'recommended' },
  'POST /api/duties/:id/archive': { archived: true },
  'POST /api/duties/:id/skips': { periodKey: fx.dutyPeriod, reason: 'x' },
  'POST /api/duties/:id/skips/:skipId/decision': { decision: 'reject', comment: 'x' },
  'POST /api/objectives': {
    serviceId: fx.service,
    name: 'Matrix objective x',
    platformId: fx.gatusPlatform,
    endpointKey: 'matrix_endpoint',
    targets: { h24: 99 },
  },
  'PUT /api/objectives/:id': { name: 'Matrix objective', platformId: fx.gatusPlatform, endpointKey: 'matrix_endpoint', targets: { h24: 99.5 } },
  'POST /api/objectives/:id/archive': { archived: true },
  'POST /api/scorecard/rules': { typeKey: 'DOC', dimension: 'integrity', minLevel: 'high' },
  'PUT /api/scorecard/rules/:id': { typeKey: 'DOC', dimension: 'confidentiality', minLevel: 'very_high' },
  'POST /api/link-types': { name: 'Matrix link type', icon: 'book' },
  'PUT /api/link-types/:key': { name: 'Matrix link type 2', icon: 'git' },
  'POST /api/credentials': CREDENTIAL,
  'PUT /api/credentials/:id': CREDENTIAL,
  'POST /api/credentials/:id/rotated': { comment: 'x' },
  'POST /api/credentials/:id/reviewed': { comment: 'x' },
  'POST /api/ticket-references': { ...TICKET, externalNumber: 'INC-MATRIX-2' },
  'PUT /api/ticket-references/:id': TICKET,
  'POST /api/ticket-references/:id/status': { status: 'waitingVendor' },
  'POST /api/ticket-references/:id/checked': {},
  'PUT /api/ticket-references/settings': { sources: [{ key: 'vendor', label: 'Vendor ticket', vendor: true }], reminderDays: null },
  'PUT /api/me/daily-summary': { enabled: false, time: '07:30', timeZone: 'UTC', days: 'weekdays', channel: 'inApp', sections: ['runs'], skipEmpty: true },
  'PUT /api/settings/daily-summary': { allowed: true },
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
  'PUT /api/settings/notifications/look': { name: 'Matrix' },
  'POST /api/settings/notifications/look/preview': { name: 'Matrix' },
  'POST /api/tasks/:id/complete': { approved: true },
  'POST /api/tasks/:id/verify': { approved: true },
  'POST /api/sync-sources': SYNC_SOURCE,
  'PUT /api/sync-sources/:id': SYNC_SOURCE,
  'POST /api/compliance/access-changes': {
    platformId: fx.platform,
    subjectId: 'x',
    kind: 'grant',
    rightsAfter: ['r'],
    reason: 'r',
    performedBy: 'x',
    performedAt: new Date().toISOString(),
  },
  'POST /api/compliance/access-checks': { name: 'x', platformId: fx.accessPlatform, source: 'insights-hub', cron: '0 3 * * *' },
  'PUT /api/compliance/access-checks/:accessCheckId': { name: 'x', platformId: fx.accessPlatform, source: 'insights-hub', cron: '0 3 * * *' },
  'POST /api/compliance/findings/:findingId/document': { reason: 'x' },
  'POST /api/compliance/findings/:findingId/dismiss': { comment: 'x' },
  'POST /api/compliance/demo/simulate-change': { accessCheckId: fx.accessCheck },
  'POST /api/compliance/person-reviews': { title: 'x', personName: 'x', identifiers: ['x'], checkIds: [fx.accessCheck] },
  'PUT /api/compliance/person-reviews/:reviewId/decisions': { decisions: [{ itemId: 'pri_none', decision: 'keep' }] },
  'POST /api/compliance/person-reviews/:reviewId/approval': { approve: true },
  'POST /api/compliance/catalogues': { key: 'MATRIX', name: 'x' },
  'PUT /api/compliance/catalogues/:catalogueId': { name: 'x' },
  'POST /api/compliance/catalogues/import': { key: 'MATRIX2', filename: 'x.csv', content: 'ref,title\n1,x\n' },
  'POST /api/compliance/catalogues/:catalogueId/controls': { ref: 'X.1', title: 'x' },
  'PUT /api/compliance/controls/:controlId': { title: 'x' },
  'POST /api/compliance/controls/:controlId/tags': { kind: 'recordType', targetId: 'rty_cr' },
  'POST /api/compliance/controls/:controlId/tags/remove': { kind: 'recordType', targetId: 'rty_ac' },
  'POST /api/compliance/evidence-packs': { scope: { controlIds: [fx.control] }, from: '2026-01-01T00:00:00Z', to: new Date().toISOString() },
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
const TICKET = { source: 'vendor', externalNumber: 'INC-MATRIX-1', title: 'Matrix ticket', vendor: 'Vendor A' };
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
  const review = await a('POST', '/records', { type: 'PIR', title: 'Matrix review' });
  const measure = (await a('POST', `/records/${review.id}/measures`, { title: 'Matrix measure', owners: ['user:admin'], dueDate: '2030-01-01' })).items[0];
  const recLink = await a('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/1', label: 'CMDB' });
  const svc = await a('POST', '/services', { name: 'Matrix service', owners: [] });
  const svcLink = await a('POST', `/services/${svc.id}/links`, { url: 'https://cmdb.example.com/2', label: 'x' });
  const application = await a('POST', '/applications', { name: 'Matrix application', owners: [] });
  const appLink = await a('POST', `/applications/${application.id}/links`, { url: 'https://cmdb.example.com/3', label: 'x' });
  const component = (await a('POST', `/applications/${application.id}/components`, { type: 'repository', name: 'matrix component' })).components[0];
  await a('PUT', `/services/${svc.id}/applications/${application.id}`, { role: 'primary' });
  const system = await a('POST', '/systems', { name: 'Matrix system', kind: 'server' });
  const systemLink = (await a('POST', `/applications/${application.id}/systems`, { systemId: system.id, environment: 'dev' })).systems[0];
  const catalogueMaintenance = await a('POST', '/maintenance-windows', {
    title: 'Matrix maintenance',
    startsAt: '2030-01-01T02:00:00Z',
    endsAt: '2030-01-01T04:00:00Z',
    targets: [{ kind: 'service', id: svc.id }],
  });
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
    review: review.id,
    measure: measure.id,
    recordLink: recLink.id,
    recordType: (await a('GET', '/record-types'))[0].id,
    credential: (await a('POST', '/credentials', CREDENTIAL)).id,
    ticket: (await a('POST', '/ticket-references', TICKET)).id,
    service: svc.id,
    serviceLink: svcLink.id,
    application: application.id,
    applicationLink: appLink.id,
    component: component.id,
    system: system.id,
    systemLink: systemLink.id,
    catalogueMaintenance: catalogueMaintenance.id,
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
  // compliance: the demo access check with a finding, a control, an access change entry, an evidence pack
  const accessCheck = (await a('GET', '/compliance/access-checks'))[0];
  const sim = await a('POST', '/compliance/demo/simulate-change', { accessCheckId: accessCheck.id });
  const iso = await a('GET', '/compliance/controls?catalogue=ISO27001');
  const control = iso.find((c: { ref: string }) => c.ref === '5.18');
  const accessChange = await a('POST', '/compliance/access-changes', {
    platformId: accessCheck.platformId,
    subjectId: 'matrix',
    kind: 'grant',
    rightsAfter: ['x'],
    reason: 'matrix',
    performedBy: 'admin',
    performedAt: new Date().toISOString(),
  });
  let pack = await a('POST', '/compliance/evidence-packs', { scope: { controlIds: [control.id] }, from: '2026-01-01T00:00:00Z', to: new Date().toISOString() });
  for (let i = 0; i < 300 && pack.status === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pack = await a('GET', `/compliance/evidence-packs/${pack.id}`);
  }
  // a duty of the service with an exception for the next month, asked by the administrator
  const duty = await a('POST', '/duties', { serviceId: svc.id, name: 'Matrix duty', processId: proc.id, interval: 'monthly', level: 'mandatory' });
  const [y, m] = duty.current.key.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const skip = (await a('POST', `/duties/${duty.id}/skips`, { periodKey: nextMonth, reason: 'Matrix' })).skips[0];
  Object.assign(fx, { duty: duty.id, dutySkip: skip.id, dutyPeriod: nextMonth });
  // an availability objective of the service on an endpoint the Gatus platform reports, and an expected-document rule
  const { db } = await import('../src/db.js');
  db().run(
    "INSERT INTO gatus_endpoints (platform_id, key, group_name, name, first_seen_at, last_seen_at) VALUES (?, 'matrix_endpoint', 'matrix', 'endpoint', ?, ?) ON CONFLICT DO NOTHING",
    gatus.id,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const objective = await a('POST', '/objectives', {
    serviceId: svc.id,
    name: 'Matrix objective',
    platformId: gatus.id,
    endpointKey: 'matrix_endpoint',
    targets: { h24: 99 },
  });
  const rule = (await a('POST', '/scorecard/rules', { typeKey: 'DOC', dimension: 'confidentiality', minLevel: 'high' }))[0];
  Object.assign(fx, { objective: objective.id, scorecardRule: rule.id });
  Object.assign(fx, {
    accessCheck: accessCheck.id,
    accessPlatform: accessCheck.platformId,
    snapshot: sim.result.snapshot.id,
    finding: sim.result.findings[0].id,
    catalogue: control.catalogueId,
    control: control.id,
    accessChange: accessChange.recordId,
    pack: pack.id,
    personReview: (
      await a('POST', '/compliance/person-reviews', { title: 'Matrix', personName: 'Matrix', identifiers: ['matrix'], checkIds: [accessCheck.id] })
    ).id,
  });
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

  it('keeps request bodies to 1 MB except on the routes named in bodyLimits.ts', async () => {
    const { DEFAULT_BODY_LIMIT, LARGE_BODIES } = await import('../src/bodyLimits.js');
    expect(s.app.initialConfig.bodyLimit).toBe(DEFAULT_BODY_LIMIT);
    const named = new Map<string, number>(Object.values(LARGE_BODIES).flatMap((l) => l.routes.map((r) => [r, l.bytes] as [string, number])));
    expect(
      routes.filter((r) => (named.has(key(r)) ? r.bodyLimit !== named.get(key(r)) : (r.bodyLimit ?? DEFAULT_BODY_LIMIT) > DEFAULT_BODY_LIMIT)).map(key),
      'routes with a body limit above 1 MB that is not their LARGE_BODIES entry (server/src/bodyLimits.ts)',
    ).toEqual([]);
    expect(
      [...named.keys()].filter((k) => !routes.some((r) => key(r) === k)),
      'LARGE_BODIES routes that are not registered',
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

  it('asks for a step-up on every sensitive route (sessions) and refuses API tokens there', async () => {
    const { stepUpRoutes } = await import('../src/app.js');
    expect(stepUpRoutes(s.app), 'routes with a step-up rule (config.stepUp) – see STEP_UP').toEqual(
      Object.fromEntries(Object.entries(STEP_UP).map(([k, v]) => [k, v === 'always' ? 'always' : 'rule'])),
    );
    // a session of its own that is not confirmed (a sign-in counts as a confirmation: ended here)
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const ended = await fetch(`${s.base}/api/auth/step-up`, { method: 'DELETE', headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
    expect(ended.status).toBe(200);
    const send = async (headers: Record<string, string>, k: string, body: unknown) => {
      const [method, url] = k.split(' ') as [string, string];
      const send = method !== 'DELETE' && method !== 'GET';
      const res = await fetch(s.base + fill(url), {
        method,
        headers: { 'x-sm-client': '1', ...headers, ...(send ? { 'content-type': 'application/json' } : {}) },
        body: send ? JSON.stringify(body ?? {}) : undefined,
      });
      const text = await res.text();
      return { status: res.status, code: (text.startsWith('{') ? (JSON.parse(text) as { code?: string }).code : undefined) ?? '' };
    };
    const problems: string[] = [];
    for (const [k, rule] of Object.entries(STEP_UP)) {
      const body = rule === 'always' ? (bodies()[k] ?? {}) : rule.sensitive;
      const asSession = await send(authHeaders(cookie), k, body);
      if (asSession.status !== 403 || asSession.code !== 'STEP_UP_REQUIRED') problems.push(`${k} unconfirmed session: ${asSession.status} ${asSession.code}`);
      const asToken = await send({ authorization: `Bearer ${fullAdminToken}` }, k, body);
      if (asToken.status !== 403) problems.push(`${k} full API token: ${asToken.status} ${asToken.code}`);
      if (rule !== 'always') {
        const harmless = await send(authHeaders(cookie), k, rule.harmless);
        if (harmless.code === 'STEP_UP_REQUIRED') problems.push(`${k} harmless change: asks for a step-up`);
      }
    }
    expect(problems).toEqual([]);
  });

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
