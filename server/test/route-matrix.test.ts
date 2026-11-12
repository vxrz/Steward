import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowEmailDomains, authHeaders, loginCookie, setEnv, setup, startTestServer, type TestServer } from './helpers.js';
import { tinyPng } from './png.js';
import { NOTIFY_OWNER, signedRelease, testKey, uploadBody } from './library-helpers.js';
import { DEFAULT_VERSION_SETTINGS } from '@sm/shared';

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

/** Test keys of the library fixtures (#238): generated per run, trusted only inside this test server */
const MATRIX_KEY = testKey();
const MATRIX_KEY_2 = testKey();

type Role = 'admin' | 'designer' | 'operator' | 'approver' | 'auditor' | 'viewer' | 'status' | 'plant';
const ROLES: Role[] = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer', 'status', 'plant'];
const USERS: Record<Role, string> = {
  admin: 'admin',
  designer: 'dana',
  operator: 'olivia',
  approver: 'adam',
  auditor: 'audrey',
  viewer: 'vera',
  status: 'stella',
  plant: 'pia',
};
const PW = 'Demo-password-1';

/** Reachable without signing in. */
const PUBLIC = 'public' as const;
/** Machine-to-machine endpoints authenticated by their own secret (webhooks, heartbeats). */
const HOOK = 'hook' as const;
type Access = typeof PUBLIC | typeof HOOK | Role[];

/**
 * Every role that works in Steward; a status viewer (#26) only reaches the status pages (STATUS_PAGES), a plant
 * viewer (#218, role "plant" only) the plant registry and their own profile (PLANT)
 */
const ALL: Role[] = ROLES.filter((r) => r !== 'status' && r !== 'plant');
const EVERYONE: Role[] = ROLES;
const STATUS_PAGES: Role[] = [...ALL, 'status'];
const PLANT: Role[] = [...ALL, 'plant'];
const ADMIN: Role[] = ['admin'];
const ADMIN_AUDITOR: Role[] = ['admin', 'auditor'];
/** Roles that may create processes, dashboards, monitors, records and credentials. */
const DESIGN: Role[] = ['admin', 'designer'];
/** 0.13.0: who may keep drafts of plant changes and propose them (the right "propose": operators, approvers, plant viewers) */
const PROPOSE: Role[] = ['admin', 'designer', 'operator', 'approver', 'plant'];
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
  'GET /api/ready/traffic': PUBLIC,
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
  // their own sign-in, password and confirmations: every signed-in person, a status viewer too
  'POST /api/auth/logout': EVERYONE,
  'GET /api/auth/me': EVERYONE,
  'POST /api/auth/password': EVERYONE,
  // step-up re-authentication (auth/step-up.ts): every signed-in session confirms its own owner
  'GET /api/auth/step-up': EVERYONE,
  'POST /api/auth/step-up': EVERYONE,
  'DELETE /api/auth/step-up': EVERYONE,
  'POST /api/auth/step-up/sso': EVERYONE,
  'POST /api/auth/step-up/sso/complete': EVERYONE,
  'GET /api/about': PLANT,
  'GET /api/system/status': ADMIN_AUDITOR,
  'GET /api/system/update-notice': ADMIN,
  'GET /api/system/jobs': ADMIN,
  'POST /api/system/jobs/:name/run': ADMIN,
  'POST /api/system/update-notice/dismiss': ADMIN,
  'GET /api/metrics': ADMIN_AUDITOR,
  'GET /api/public-api': PLANT,

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
  // a person's data (GDPR, docs/PRIVACY.md): administrators for anyone, every person for themselves
  'GET /api/users/:id/data-export': ADMIN,
  'POST /api/users/:id/pseudonymise': ADMIN,
  'GET /api/me/data-export': PLANT,
  'GET /api/teams/:id/references': ADMIN,
  // members of the team see its settings too (team-settings.test.ts); the matrix team has none
  'GET /api/teams/:id/settings': ADMIN,
  'PUT /api/teams/:id/settings': ADMIN,
  'POST /api/teams/:id/settings/test': ADMIN,
  // the team's report logo (#136): the matrix team has no members, and no logo (NO_POSITIVE)
  'GET /api/teams/:id/settings/logo': ADMIN,
  'POST /api/teams/:id/settings/logo': ADMIN,
  'DELETE /api/teams/:id/settings/logo': ADMIN,
  'GET /api/subjects': ACTIVE,
  'PATCH /api/me': PLANT,
  'GET /api/me/tokens': PLANT,
  'POST /api/me/tokens': PLANT,
  'DELETE /api/me/tokens/:id': PLANT,
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
  'GET /api/settings/instance': ADMIN,
  'PUT /api/settings/instance': ADMIN,
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
  'GET /api/notifications': PLANT,
  'POST /api/notifications/read-all': PLANT,
  'POST /api/notifications/:id/read': PLANT,
  'GET /api/mcp-server': ALL,
  'PUT /api/mcp-server': ADMIN,
  // requests of MCP clients (#11): each reader sees the ones they may (the route decides per request)
  'GET /api/mcp-requests': ALL,
  // service status pages (#26): every signed-in user and the status viewers read them, designers and admins set them up
  'GET /api/status-pages': STATUS_PAGES,
  'POST /api/status-pages': DESIGN,
  'GET /api/status-pages/:pageId': ALL,
  'PUT /api/status-pages/:pageId': DESIGN,
  'DELETE /api/status-pages/:pageId': DESIGN,
  'GET /api/status-pages/:pageId/view': STATUS_PAGES,
  'POST /api/status-pages/:pageId/link': DESIGN,
  'DELETE /api/status-pages/:pageId/link': DESIGN,
  'GET /api/public/status-page': PUBLIC,
  'GET /api/mcp-requests/:requestId': ALL,
  'POST /api/mcp-requests/:requestId/decision': ALL,
  'POST /api/demo/setup': ADMIN,

  // ---- audit ----
  'GET /api/audit': ADMIN_AUDITOR,
  'GET /api/audit/facets': ADMIN_AUDITOR,
  'GET /api/audit/verify': ADMIN_AUDITOR,
  'POST /api/audit/verify': ADMIN_AUDITOR,
  'GET /api/audit/anchoring': ADMIN_AUDITOR,
  'PUT /api/audit/anchoring': ADMIN,
  'GET /api/audit/anchor.json': ADMIN_AUDITOR,
  'POST /api/audit/checkpoint': ADMIN_AUDITOR,
  'POST /api/audit/verify/full': ADMIN,
  'GET /api/audit/archive': ADMIN_AUDITOR,
  'PUT /api/audit/archive': ADMIN,
  'POST /api/audit/archive/run': ADMIN,
  'GET /api/audit/archives/:archiveId/file': ADMIN_AUDITOR,
  'GET /api/backups': ADMIN,
  'GET /api/backups/stored': ADMIN,
  'PUT /api/backups/settings': ADMIN,
  'PUT /api/backups/passphrase': ADMIN,
  'POST /api/backups/run': ADMIN,
  'POST /api/backups/restore-test': ADMIN,
  'POST /api/backups/confirm-target': ADMIN,
  'GET /api/backups/contents': ADMIN,
  // scheduled exports to S3 (0.16.0, ADR 0027)
  'GET /api/exports': ADMIN,
  'POST /api/exports': ADMIN,
  'GET /api/exports/:id': ADMIN,
  'PUT /api/exports/:id': ADMIN,
  'DELETE /api/exports/:id': ADMIN,
  'GET /api/exports/:id/runs': ADMIN,
  'POST /api/exports/:id/run': ADMIN,
  'POST /api/exports/:id/confirm-target': ADMIN,
  'GET /api/audit/public-key.pem': ADMIN_AUDITOR,
  'GET /api/audit/export': ADMIN_AUDITOR,
  // ---- assurance policy (#210): administrators and auditors read it, administrators change it (sessions only) ----
  'GET /api/assurance/policy': ADMIN_AUDITOR,
  'PUT /api/assurance/policy': ADMIN,
  'POST /api/assurance/policy/changes/:changeId/approve': ADMIN,
  'POST /api/assurance/policy/changes/:changeId/reject': ADMIN,
  'GET /api/assurance/policy/history': ADMIN_AUDITOR,
  'GET /api/assurance/policy/as-of': ADMIN_AUDITOR,
  'GET /api/assurance/report': ADMIN_AUDITOR,

  // ---- platforms (no access list: admins manage, designers and operators use) ----
  'GET /api/platform-presets': ALL,
  'POST /api/platform-types': ADMIN,
  'POST /api/platform-types/import': ADMIN,
  'DELETE /api/platform-types/:kind': ADMIN,
  'GET /api/platform-types/:kind/export': ALL, // connector types are shareable templates (see docs/reviews/REVIEW-2026-10.md)
  'GET /api/platforms': ALL,
  'POST /api/platforms': ADMIN,
  'GET /api/platforms/:id': USE,
  'PUT /api/platforms/:id': ADMIN,
  'DELETE /api/platforms/:id': ADMIN,
  'PUT /api/platforms/:id/access': ADMIN,
  'PUT /api/platforms/:id/mcp-gateway': ADMIN,
  // LLM gateways (#216): AI settings like the platform, its usage like the platform itself; budgets for administrators
  'PUT /api/platforms/:id/ai': ADMIN,
  'POST /api/platforms/:id/ai/discover': ADMIN,
  'GET /api/platforms/:id/ai/usage': USE,
  // database platforms (#203): the connection, with the platform's manage right
  'PUT /api/platforms/:id/database': ADMIN,
  // database schemas (#222), here of the demo database platform: whoever sees it sees its schema, "use" reads it,
  // "manage" imports and changes the settings
  'GET /api/db-schemas/:kind/:id': USE,
  'POST /api/db-schemas/:kind/:id/read': USE,
  'PUT /api/db-schemas/:kind/:id/settings': ADMIN,
  'POST /api/db-schemas/:kind/:id/import/preview': ADMIN,
  'POST /api/db-schemas/:kind/:id/import': ADMIN,
  'GET /api/db-schemas/:kind/:id/snapshots/:snapshotId': USE,
  'GET /api/db-schemas/:kind/:id/snapshots/:snapshotId/export': USE,
  'GET /api/db-schemas/:kind/:id/compare': USE,
  // push tokens of the tbls import from CI: who may manage the target; the push itself takes its push token only
  'GET /api/db-schemas/:kind/:id/push-tokens': ADMIN,
  'POST /api/db-schemas/:kind/:id/push-tokens': ADMIN,
  'POST /api/db-schemas/:kind/:id/push-tokens/:tokenId/rotate': ADMIN,
  'DELETE /api/db-schemas/:kind/:id/push-tokens/:tokenId': ADMIN,
  'POST /api/hooks/db-schema/:kind/:id': HOOK,
  // platform costs (#226), here of the demo platform: the overview for everyone (each sees the scopes they may see), a
  // platform's costs for who may see the platform and auditors; its source, imports and push tokens for its managers
  'GET /api/costs': ALL,
  'GET /api/costs/settings': ALL,
  'PUT /api/costs/settings': ADMIN,
  'GET /api/costs/settings/fiscal-year-change': ADMIN,
  'PUT /api/costs/budgets': DESIGN,
  'GET /api/costs/:scope/:id': RECON_READ,
  'GET /api/costs/platform/:id/source': RECON_READ,
  'PUT /api/costs/platform/:id/source': ADMIN,
  'POST /api/costs/platform/:id/read': ADMIN,
  'GET /api/costs/platform/:id/imports': RECON_READ,
  'POST /api/costs/platform/:id/imports/preview': ADMIN,
  'POST /api/costs/platform/:id/imports': ADMIN,
  'GET /api/costs/platform/:id/push-tokens': ADMIN,
  'POST /api/costs/platform/:id/push-tokens': ADMIN,
  'POST /api/costs/platform/:id/push-tokens/:tokenId/rotate': ADMIN,
  'DELETE /api/costs/platform/:id/push-tokens/:tokenId': ADMIN,
  'POST /api/hooks/costs/:platformId': HOOK,
  // service cost planning (0.16.0, ADR 0026), here the matrix service (no owning teams): everyone who sees the service
  // reads its plan, who may change the service (designers, administrators) changes it; a team's rollup for its members,
  // administrators and auditors
  'GET /api/costs/plans/:serviceId': ALL,
  'GET /api/costs/plans/:serviceId/export': ALL,
  'POST /api/costs/plans/:serviceId/lines': DESIGN,
  'PUT /api/costs/plans/:serviceId/lines/:lineId': DESIGN,
  'DELETE /api/costs/plans/:serviceId/lines/:lineId': DESIGN,
  'POST /api/costs/plans/:serviceId/copy': DESIGN,
  // 0.18.0 (ADR 0030): Book – who may change the service, in a session
  'POST /api/costs/plans/:serviceId/lines/:lineId/book': DESIGN,
  // payment schedules: who may change the contract (designers, administrators, the supplier's owners) or edit the paying service
  'GET /api/costs/schedules': ALL,
  'POST /api/costs/schedules': DESIGN,
  'PUT /api/costs/schedules/:costScheduleId': DESIGN,
  'DELETE /api/costs/schedules/:costScheduleId': DESIGN,
  'GET /api/costs/plans/:serviceId/proposals': ALL,
  'GET /api/costs/commitments': ALL,
  'POST /api/costs/plans/:serviceId/entries/import/preview': DESIGN,
  'POST /api/costs/plans/:serviceId/entries/import': DESIGN,
  'GET /api/costs/plans/:serviceId/imports': ALL,
  'DELETE /api/costs/plans/:serviceId/imports/:importId': DESIGN,
  'GET /api/costs/commitments/export': ALL,
  'POST /api/costs/plans/:serviceId/proposals': DESIGN,
  'POST /api/costs/plans/:serviceId/contract-updates': DESIGN,
  'POST /api/costs/plans/:serviceId/entries': DESIGN,
  'PUT /api/costs/plans/:serviceId/entries/:entryId': DESIGN,
  'DELETE /api/costs/plans/:serviceId/entries/:entryId': DESIGN,
  'GET /api/costs/team-plans/:teamId': ADMIN_AUDITOR,
  // a platform's own cost plan (0.19.0, ADR 0032): who may see the platform reads it; its managers and owning teams change it
  'GET /api/costs/platform-plans/:platformId': RECON_READ,
  'GET /api/costs/platform-plans/:platformId/export': RECON_READ,
  'POST /api/costs/platform-plans/:platformId/lines': DESIGN,
  'PUT /api/costs/platform-plans/:platformId/lines/:lineId': DESIGN,
  'DELETE /api/costs/platform-plans/:platformId/lines/:lineId': DESIGN,
  'POST /api/costs/platform-plans/:platformId/copy': DESIGN,
  'POST /api/costs/platform-plans/:platformId/lines/:lineId/book': DESIGN,
  'POST /api/costs/platform-plans/:platformId/entries': DESIGN,
  'PUT /api/costs/platform-plans/:platformId/entries/:entryId': DESIGN,
  'DELETE /api/costs/platform-plans/:platformId/entries/:entryId': DESIGN,
  'GET /api/costs/platform-plans/:platformId/proposals': RECON_READ,
  'POST /api/costs/platform-plans/:platformId/proposals': DESIGN,
  'POST /api/costs/platform-plans/:platformId/contract-updates': DESIGN,
  'POST /api/costs/platform-plans/:platformId/entries/import/preview': DESIGN,
  'POST /api/costs/platform-plans/:platformId/entries/import': DESIGN,
  'GET /api/costs/platform-plans/:platformId/imports': RECON_READ,
  'DELETE /api/costs/platform-plans/:platformId/imports/:importId': DESIGN,
  // an application's or system's "Costs and contracts" (0.19.0): who may see it
  'GET /api/costs/attribution/:kind/:id': ALL,
  // data contracts (#221), here the demo's "Shop orders" (no owning team): everyone who works in Steward sees and checks
  // them, operators test them, designers create and change them
  'GET /api/data-contracts': ALL,
  'POST /api/data-contracts': DESIGN,
  'POST /api/data-contracts/check': ALL,
  'POST /api/data-contracts/draft': ALL,
  'POST /api/data-contracts/import': DESIGN,
  'GET /api/data-contracts/:id': ALL,
  'DELETE /api/data-contracts/:id': DESIGN,
  'PUT /api/data-contracts/:id/settings': DESIGN,
  'POST /api/data-contracts/:id/check': ALL,
  'GET /api/data-contracts/:id/versions': ALL,
  'POST /api/data-contracts/:id/versions': DESIGN,
  'GET /api/data-contracts/:id/versions/:version': ALL,
  'GET /api/data-contracts/:id/compare': ALL,
  'GET /api/data-contracts/:id/export': ALL,
  'POST /api/data-contracts/:id/links': DESIGN,
  'DELETE /api/data-contracts/:id/links/:linkId': DESIGN,
  'POST /api/data-contracts/:id/test': RUN,
  'POST /api/data-contracts/:id/service-lint': ALL,
  'GET /api/data-contracts/:id/runs': ALL,
  'GET /api/data-contracts/:id/runs/:runId': ALL,
  'GET /api/ai/budgets': ADMIN_AUDITOR,
  'PUT /api/ai/budgets': ADMIN,
  'GET /api/ai/usage': ADMIN_AUDITOR,
  'GET /api/platforms/:id/confirm-config': ADMIN,
  'POST /api/platforms/:id/confirm-config': ADMIN,
  'POST /api/platforms/:id/contract-check': ADMIN,
  'PUT /api/platforms/:id/secrets': ADMIN,
  'POST /api/platforms/:id/test': USE,
  // what's next with a platform and its health (v0.4.0): like the platform itself; the periodic test by its managers
  'GET /api/platforms/:id/get-started': USE,
  'GET /api/platforms/:id/health': USE,
  'PUT /api/platforms/:id/health': ADMIN,
  'POST /api/platforms/:id/request': USE,
  // recorded responses (#105): read like the explorer, changed like the platform
  'GET /api/platforms/:id/recordings': USE,
  'POST /api/platforms/:id/recordings': ADMIN,
  'PUT /api/platforms/:id/recordings/:recId': ADMIN,
  'DELETE /api/platforms/:id/recordings/:recId': ADMIN,
  'POST /api/platforms/:id/token/renew': ADMIN,
  // platform identities (0.13.0, ADR 0009): listed for whoever sees the platform, managed with "manage"
  'GET /api/platforms/:id/identities': USE,
  'POST /api/platforms/:id/identities': ADMIN,
  'GET /api/platforms/:id/identities/:identityId/settings': ADMIN,
  'PUT /api/platforms/:id/identities/:identityId': ADMIN,
  'DELETE /api/platforms/:id/identities/:identityId': ADMIN,
  'PUT /api/platforms/:id/identities/:identityId/secrets': ADMIN,
  'PUT /api/platforms/:id/identities/:identityId/access': ADMIN,
  'PUT /api/platforms/:id/identities/:identityId/mcp': ADMIN,
  'POST /api/platforms/:id/identities/:identityId/default': ADMIN,
  'POST /api/platforms/:id/identities/:identityId/enable': ADMIN,
  'POST /api/platforms/:id/identities/:identityId/test': ADMIN,
  'POST /api/platforms/:id/identities/:identityId/token/renew': ADMIN,
  // Kafka peek (#112): platform managers only, and only where the platform allows it
  'POST /api/platforms/:id/kafka/peek': ADMIN,
  // Kafka Connect (#223): the readout for who sees the platform, "Read now" and a connector's configuration (audited) for who may use it
  'GET /api/platforms/:id/kafka-connect': USE,
  'POST /api/platforms/:id/kafka-connect/read': USE,
  'GET /api/platforms/:id/kafka-connect/connectors/:name/config': USE,
  // Confluent Cloud (#123): the readout for who sees the platform, "Read now" for who may use it
  'GET /api/platforms/:id/confluent': USE,
  'POST /api/platforms/:id/confluent/read': USE,
  'GET /api/platforms/:id/specs': USE,
  'POST /api/platforms/:id/specs': ADMIN,
  'DELETE /api/platforms/:id/specs/:specId': ADMIN,
  'PATCH /api/platforms/:id/specs/:specId': ADMIN,
  'POST /api/platforms/:id/specs/:specId/copy': ADMIN,
  'POST /api/platforms/:id/specs/built-in': ADMIN,
  'GET /api/platforms/:id/operations': USE,
  // Postman export (#204): who sees the platform (its page shows the same, no secret); audited
  'GET /api/platforms/:id/export/postman': USE,
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
  // changedetection.io (#242): watches as components of the platform
  'GET /api/changedetection/:platformId/watches': USE,
  'POST /api/changedetection/:platformId/watches/read': USE,
  'PUT /api/changedetection/:platformId/watches/:uuid/link': ADMIN,
  'GET /api/changedetection/:platformId/watches/:uuid/history': USE,

  // ---- processes, runs, tasks, schedules, triggers ----
  'GET /api/templates': ALL,
  // template bundles (v0.4.0): everyone sees the list, who may create processes sets them up
  'GET /api/template-bundles': ALL,
  'POST /api/template-bundles/:id/setup': DESIGN,
  'POST /api/template-bundles/:id/turn-on': DESIGN,
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
  // Postman export (#204): who may view the process; connections only with platforms the caller can see; audited
  'GET /api/processes/:id/export/postman': ALL,
  'GET /api/processes/:id/scope': ALL,
  'POST /api/processes/:id/evaluate': RUN,
  'POST /api/runs': RUN,
  'GET /api/runs': ALL,
  'GET /api/runs/:id': ALL,
  'GET /api/runs/:id/steps/:stepId': ALL,
  'GET /api/runs/:id/inspect/:nodeId': ALL,
  'POST /api/runs/:id/cancel': RUN,
  'POST /api/runs/:id/resume': RUN,
  // debugging (ADR 0010): comparing two runs needs view on both; debug runs need edit and run (an offline node edit only)
  'GET /api/runs/compare': ALL,
  'GET /api/runs/:id/last-good': ALL,
  'GET /api/runs/:id/debug': ALL,
  'POST /api/runs/:id/debug': DESIGN,
  'POST /api/processes/:id/debug/node': DESIGN,
  'POST /api/processes/:id/debug/runs': DESIGN,
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
  'GET /api/triggers/examples': ALL,
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
  // whether a dataset exists that the caller may not see (an empty widget says so); nothing else of it
  'GET /api/datasets/:key/visibility': ALL,
  'GET /api/datasets/:key/publishers': ALL,
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
  // evidence after the approval and the approved firewall rules of what a firewall change affects (#208)
  'POST /api/records/:id/evidence': RUN,
  'GET /api/records/:id/firewall': ALL,
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
  // corrective actions (ADR 0029): read by the roles of the register and the service's editors; changed in the app only
  'GET /api/compliance/corrective-actions': ALL, // each sees the findings they may read
  'POST /api/compliance/corrective-actions': DESIGN,
  'GET /api/compliance/corrective-actions/:findingId': ['admin', 'designer', 'approver', 'auditor'],
  'PUT /api/compliance/corrective-actions/:findingId': DESIGN,
  'POST /api/compliance/corrective-actions/:findingId/actions': DESIGN,
  'PUT /api/compliance/corrective-actions/:findingId/actions/:actionId': DESIGN,
  'DELETE /api/compliance/corrective-actions/:findingId/actions/:actionId': DESIGN,
  'POST /api/compliance/corrective-actions/:findingId/effectiveness': ['admin', 'designer', 'approver'],
  'POST /api/compliance/corrective-actions/:findingId/cancel': ADMIN,
  'GET /api/compliance/corrective-suggestions': ALL,
  'POST /api/compliance/corrective-suggestions/:suggestionId/confirm': DESIGN,
  'POST /api/compliance/corrective-suggestions/:suggestionId/dismiss': DESIGN,
  'GET /api/compliance/corrective-settings': ALL,
  'PUT /api/compliance/corrective-settings': ADMIN,
  // statement of applicability (ADR 0029 part 2): everyone reads it; designers and administrators change it (a row's
  // owner its status and review), approvers and administrators decide versions, who exports evidence exports it
  'GET /api/compliance/soa': ALL,
  'POST /api/compliance/soa': DESIGN,
  'GET /api/compliance/soa/:catalogueId': ALL,
  'PUT /api/compliance/soa/:catalogueId/settings': DESIGN,
  'PUT /api/compliance/soa/:catalogueId/entries/:controlId': DESIGN,
  'POST /api/compliance/soa/:catalogueId/versions': DESIGN,
  'GET /api/compliance/soa/:catalogueId/versions/:n': ALL,
  'POST /api/compliance/soa/:catalogueId/versions/:n/decision': ['admin', 'approver'],
  'GET /api/compliance/soa/:catalogueId/versions/:n/export': NOT_VIEWER,
  // the responsibility matrix of a service: whoever may edit the service changes it
  'GET /api/services/:id/responsibilities': ALL,
  'PUT /api/services/:id/responsibilities': DESIGN,

  'POST /api/record-types': ADMIN,
  'PUT /api/record-types/:id': ADMIN,
  'GET /api/link-targets': PLANT,
  'GET /api/backlinks': ALL,
  'GET /api/services': ALL,
  'POST /api/services': DESIGN,
  'GET /api/services/:id': ALL,
  'PUT /api/services/:id': DESIGN,
  'POST /api/services/:id/archive': DESIGN,
  'POST /api/services/:id/links': DESIGN,
  // types of external links: everyone reads them (the add-link dialog), administrators manage their own
  'GET /api/link-types': PLANT,
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
  // version watch (#241): the status for everyone, settings for administrators, an entry for whoever may change its application
  'GET /api/catalogue/versions': ALL,
  'PUT /api/catalogue/versions': ADMIN,
  'POST /api/catalogue/versions/refresh': DESIGN,
  'GET /api/catalogue/versions/entry': ALL,
  'PUT /api/catalogue/versions/entry': DESIGN,
  'POST /api/catalogue/versions/entry/read': DESIGN,
  'POST /api/applications/:id/components': DESIGN,
  'PUT /api/applications/:id/components/:componentId': DESIGN,
  'DELETE /api/applications/:id/components/:componentId': DESIGN,
  'POST /api/applications/:id/components/:componentId/sbom/preview': DESIGN,
  'POST /api/applications/:id/components/:componentId/sbom': DESIGN,
  'POST /api/applications/:id/components/:componentId/cluster': DESIGN,
  'POST /api/applications/:id/components/:componentId/repository': DESIGN,
  'POST /api/applications/:id/components/:componentId/topic': DESIGN,
  // Kafka topics by prefix (v0.4.0): who may change the application; the synced prefixes are read like the application
  'POST /api/applications/:id/kafka-topics/list': DESIGN,
  'POST /api/applications/:id/kafka-topics': DESIGN,
  'GET /api/applications/:id/topic-prefixes': ALL,
  'POST /api/applications/:id/topic-prefixes/:syncId/check': DESIGN,
  'POST /api/applications/:id/topic-prefixes/:syncId/dismiss': DESIGN,
  'DELETE /api/applications/:id/topic-prefixes/:syncId': DESIGN,
  'POST /api/applications/:id/components/:componentId/aws': DESIGN,
  'POST /api/applications/:id/components/:componentId/snowflake': DESIGN,
  'POST /api/applications/:id/components/:componentId/dependency-track': DESIGN,
  // suppliers (0.17.0, ADR 0029): like systems; the "To confirm" decisions need a session
  'GET /api/suppliers': ALL,
  'POST /api/suppliers': DESIGN,
  'GET /api/suppliers/options': ALL,
  'GET /api/suppliers/scope-notice': ALL,
  'GET /api/suppliers/scoped-contacts': ALL,
  'GET /api/suppliers/proposed-services': ALL,
  // shared suppliers (ADR 0031 part 8): widening merges and openings are for administrators
  'GET /api/suppliers/shared-suggestions': ADMIN,
  'POST /api/suppliers/shared-suggestions/:key/keep-separate': ADMIN,
  'POST /api/suppliers/merge/preview': DESIGN,
  'POST /api/suppliers/merge': DESIGN,
  'POST /api/suppliers/:id/open/preview': ADMIN,
  'POST /api/suppliers/:id/open': ADMIN,
  'DELETE /api/suppliers/scope-notice': ADMIN,
  'GET /api/suppliers/:id': ALL,
  'PUT /api/suppliers/:id': DESIGN,
  'POST /api/suppliers/:id/archive': DESIGN,
  'POST /api/suppliers/:id/confirm': DESIGN,
  'POST /api/suppliers/:id/merge': DESIGN,
  'POST /api/suppliers/:id/not-a-supplier': DESIGN,
  'POST /api/suppliers/:id/contacts': DESIGN,
  'PUT /api/suppliers/:id/contacts/:contactId': DESIGN,
  'DELETE /api/suppliers/:id/contacts/:contactId': DESIGN,
  'POST /api/suppliers/:id/contracts': DESIGN,
  'PUT /api/suppliers/:id/contracts/:contractId': DESIGN,
  'DELETE /api/suppliers/:id/contracts/:contractId': DESIGN,
  // contracts with their own scope (0.18.0, ADR 0031): the contract page, covered services, the service's contracts
  'GET /api/suppliers/:id/contracts/:contractId': ALL,
  'PUT /api/suppliers/:id/contracts/:contractId/services/:serviceId': DESIGN,
  'DELETE /api/suppliers/:id/contracts/:contractId/services/:serviceId': DESIGN,
  'GET /api/services/:id/contracts': ALL,
  // 0.19.0 (ADR 0032): platforms covered by a contract, a platform's contracts, a service's applications and systems
  'PUT /api/suppliers/:id/contracts/:contractId/platforms/:platformId': DESIGN,
  'DELETE /api/suppliers/:id/contracts/:contractId/platforms/:platformId': DESIGN,
  'GET /api/platforms/:id/contracts': RECON_READ,
  'GET /api/services/:id/contract-items': ALL,
  'POST /api/suppliers/:id/certificates': DESIGN,
  'PUT /api/suppliers/:id/certificates/:certificateId': DESIGN,
  'DELETE /api/suppliers/:id/certificates/:certificateId': DESIGN,
  'GET /api/systems': ALL,
  'POST /api/systems': DESIGN,
  'GET /api/systems/:id': ALL,
  'PUT /api/systems/:id': DESIGN,
  'DELETE /api/systems/:id': DESIGN,
  'POST /api/systems/:id/sbom/preview': DESIGN,
  'POST /api/systems/:id/sbom': DESIGN,
  // network context (#208): who may change the system
  'POST /api/systems/:id/segments': DESIGN,
  'PUT /api/systems/:id/segments/:segmentLinkId': DESIGN,
  'DELETE /api/systems/:id/segments/:segmentLinkId': DESIGN,
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
  // 0.14: impact before maintenance – before saving and of a window; planned downtime for its monitors, telling the owners
  'GET /api/maintenance-windows/impact': ALL,
  'GET /api/maintenance-windows/plant-targets': ALL,
  'GET /api/maintenance-windows/:id/impact': ALL,
  'POST /api/maintenance-windows/:id/impact/downtime': DESIGN,
  'POST /api/maintenance-windows/:id/impact/notify': DESIGN,
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
  // the vault link (#205): read now – its editors; find a secret – whoever may use the vault platform
  'POST /api/credentials/:id/vault/read': RUN,
  'GET /api/credentials/vault-secrets': USE,
  'POST /api/credentials/:id/restore': ADMIN,
  'POST /api/credentials/:id/archive': ADMIN,
  // app secrets and certificates of an Entra ID tenant as entries (v0.5.0): who may create entries and use the platform
  'POST /api/credentials/import/entra': RUN,

  // ---- MCP (bearer MCP tokens only; see mcp.test.ts) ----
  'POST /api/mcp': HOOK,
  'GET /api/mcp': HOOK,
  'PUT /api/mcp': HOOK,
  'PATCH /api/mcp': HOOK,
  'DELETE /api/mcp': HOOK,

  // ---- API documentation (Swagger UI; Settings → API documentation, default: signed-in users) ----
  'GET /api/docs': EVERYONE,
  'GET /api/docs/static/index.html': ALL,
  'GET /api/docs/static/swagger-initializer.js': EVERYONE,
  'GET /api/docs/*': ALL,
  'GET /api/docs/static/*': EVERYONE,
  'GET /api/docs/json': EVERYONE,
  'GET /api/docs/yaml': EVERYONE,

  // ---- public read API /api/v1 (API tokens; called with a read token of each role) ----
  'GET /api/v1/health': PUBLIC,
  'GET /api/v1/openapi.json': PUBLIC,
  'GET /api/v1/openapi.yaml': PUBLIC,
  'GET /api/v1/*': PUBLIC,
  'POST /api/v1/*': PUBLIC,
  'PUT /api/v1/*': PUBLIC,
  'PATCH /api/v1/*': PUBLIC,
  'DELETE /api/v1/*': PUBLIC,
  'GET /api/v1/me': PLANT,
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
  // cost attribution and a platform's cost plan (0.19.0, ADR 0032)
  'GET /api/v1/applications/:applicationId/cost-attribution': ALL,
  'GET /api/v1/systems/:systemId/cost-attribution': ALL,
  'GET /api/v1/platforms/:platformId/cost-plan': RECON_READ,
  'GET /api/v1/suppliers': ALL,
  'GET /api/v1/suppliers/:supplierId': ALL,
  'GET /api/v1/systems': ALL,
  'GET /api/v1/systems/:systemId': ALL,
  // the plant registry (#218): who may see the site (every role that works in Steward, without an access list)
  'GET /api/v1/plant/sites': PLANT,
  'GET /api/v1/plant/sites/:siteId': PLANT,
  'GET /api/v1/plant/assets': PLANT,
  'GET /api/v1/plant/assets/:assetId': PLANT,
  // part 2 (#219): the catalogues are the installation's (everyone who sees the registry), an assignment follows its site
  'GET /api/v1/plant/assets/:assetId/assignment': PLANT,
  'GET /api/v1/plant/profiles': PLANT,
  'GET /api/v1/plant/profiles/:profileId': PLANT,
  'GET /api/v1/plant/kpis': PLANT,
  'GET /api/v1/plant/kpis/:kpiId': PLANT,
  // the checks of the assets the token owner may see, the export of what they may see (#219)
  'GET /api/v1/plant/checks': PLANT,
  'GET /api/v1/plant/export': PLANT,
  // the OT network of a site and of an asset (#220): follows the site
  'GET /api/v1/plant/sites/:siteId/network': PLANT,
  'GET /api/v1/plant/assets/:assetId/network': PLANT,
  'GET /api/v1/plant/assets/:assetId/collections': PLANT,
  // 0.14: security advisories – published documents everyone in the registry reads; matches per visible site
  'GET /api/v1/plant/advisories': PLANT,
  'GET /api/v1/plant/advisories/:advisoryId': PLANT,
  'GET /api/v1/plant/assets/:assetId/advisories': PLANT,
  'GET /api/v1/plant/assets/:assetId/documentation': PLANT,
  'GET /api/v1/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub': PLANT,
  // 0.19.0: change sets (a proposed one is seen by who sees its site) and proposals from CI (a full-access token of who
  // may propose; read tokens are refused with token-scope)
  'GET /api/v1/plant/change-sets': PLANT,
  'GET /api/v1/plant/change-sets/:changeSetId': PLANT,
  'GET /api/v1/plant/change-sets/:changeSetId/operations': PLANT,
  'POST /api/v1/plant/proposals': PROPOSE,
  // database schemas (#222): of the demo database platform (who sees it) and of the matrix system (everyone);
  'GET /api/v1/platforms/:platformId/schema/snapshots': USE,
  // platform costs (#226): the overview for everyone (each sees what they may see); one scope as in the web app
  'GET /api/v1/costs': ALL,
  'GET /api/v1/costs/:scope/:id': RECON_READ,
  'GET /api/v1/platforms/:platformId/schema/snapshots/:snapshotId': USE,
  'GET /api/v1/platforms/:platformId/schema/snapshots/:snapshotId/export': USE,
  'GET /api/v1/platforms/:platformId/schema/changes': USE,
  'GET /api/v1/platforms/:platformId/schema/compare': USE,
  'GET /api/v1/systems/:systemId/schema/snapshots': ALL,
  'GET /api/v1/systems/:systemId/schema/snapshots/:snapshotId': ALL,
  'GET /api/v1/systems/:systemId/schema/snapshots/:snapshotId/export': ALL,
  'GET /api/v1/systems/:systemId/schema/changes': ALL,
  'GET /api/v1/systems/:systemId/schema/compare': ALL,
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
  'GET /api/v1/services/:serviceId/cost-plan': ALL,
  'GET /api/v1/cost-commitments': ALL,
  'GET /api/v1/objectives': ALL,
  'GET /api/v1/objectives/:objectiveId/samples': ALL,
  'GET /api/v1/access-changes': ALL,
  'GET /api/v1/access-findings': ALL,
  'GET /api/v1/control-catalogues': ALL,
  'GET /api/v1/controls': ALL,
  'GET /api/v1/control-coverage': ALL,
  'GET /api/v1/corrective-actions': ALL,
  'GET /api/v1/corrective-actions/:findingId': ['admin', 'designer', 'approver', 'auditor'],
  'GET /api/v1/statements-of-applicability': ALL,
  'GET /api/v1/statements-of-applicability/:catalogueKey': ALL,
  'GET /api/v1/services/:serviceId/responsibilities': ALL,
  'GET /api/v1/services/:serviceId/contracts': ALL,
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
  // shared procedure libraries (#238, ADR 0014): releases and installs for designers, Hold and trust for administrators
  'GET /api/libraries': DESIGN,
  'GET /api/libraries/:library': DESIGN,
  'POST /api/libraries/:library/rollback': DESIGN,
  'POST /api/libraries/:library/uninstall': DESIGN,
  'POST /api/libraries/:library/hold': ADMIN,
  'GET /api/library-releases/:id': DESIGN,
  'GET /api/library-releases/:id/review': DESIGN,
  'POST /api/library-releases/:id/install': DESIGN,
  'POST /api/library-releases/:id/approve': DESIGN,
  'POST /api/library-releases/:id/withdraw': DESIGN,
  'DELETE /api/library-releases/:id': DESIGN,
  'POST /api/library-releases/upload': DESIGN,
  'GET /api/library-origins': ALL,
  'GET /api/library-publishers': ADMIN,
  'POST /api/library-publishers': ADMIN,
  'PUT /api/library-publishers/:id': ADMIN,
  'DELETE /api/library-publishers/:id': ADMIN,
  'POST /api/library-publishers/:id/keys': ADMIN,
  'PUT /api/library-keys/:id': ADMIN,
  'POST /api/library-keys/:id/retire': ADMIN,
  'POST /api/library-keys/:id/revoke': ADMIN,
  'DELETE /api/library-keys/:id': ADMIN,
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

  // ---- team scopes (#131): owning teams of a resource and why someone has access ----
  // whoever may see the process (the demo process has no access list); administrators set owning teams
  'GET /api/owning-teams/:kind/:id': ALL,
  'PUT /api/owning-teams/:kind/:id': ADMIN,
  'POST /api/owning-teams/bulk': ADMIN,
  // own rights on what one can see; others' rights for administrators and auditors (checked in team-scopes.test.ts)
  'GET /api/access/explain': ALL,
  // which named users and teams are outside an item's owning teams (#195): the forms' hint; who may change the item
  'POST /api/access/named-outside': ALL,

  // ---- daily summary ----
  'GET /api/me/daily-summary': ALL,
  'PUT /api/me/daily-summary': ALL,
  'GET /api/me/daily-summary/preview': ALL,
  'DELETE /api/me/daily-summary': ALL,
  // the owning teams of one's own new resources (#136)
  'GET /api/me/new-resource-teams': ALL,
  'PUT /api/me/new-resource-teams': ALL,
  'GET /api/settings/daily-summary': ADMIN,
  // ---- quiet hours and digests (ADR 0012): one's own; administrators see who uses them and switch them off ----
  'GET /api/me/notification-prefs': ALL,
  'PUT /api/me/notification-prefs': ALL,
  'DELETE /api/me/notification-prefs': ALL,
  'GET /api/me/notification-opt-ins': ALL,
  'PUT /api/me/notification-opt-ins': ALL,
  'GET /api/me/teams-personal': ALL,
  'PUT /api/me/teams-personal': ALL,
  'GET /api/settings/quiet-hours': ADMIN,
  'PUT /api/settings/quiet-hours': ADMIN,
  // ---- the Teams bot (ADR 0013, preview): administrators; the bot endpoint itself is on its own listener (teams-bot.test.ts) ----
  'GET /api/settings/teams-bot': ADMIN,
  'PUT /api/settings/teams-bot': ADMIN,
  'GET /api/settings/teams-bot/conversations': ADMIN,
  'GET /api/settings/teams-bot/package': ADMIN,

  // ---- OAuth sign-in for MCP clients (#12): off in the fixtures (discovery and endpoints answer 404) ----
  'GET /.well-known/oauth-protected-resource': PUBLIC,
  'GET /.well-known/oauth-protected-resource/api/mcp': PUBLIC,
  'GET /.well-known/oauth-authorization-server': PUBLIC,
  'GET /.well-known/openid-configuration': PUBLIC,
  'POST /oauth/register': PUBLIC,
  'POST /oauth/token': PUBLIC,
  'POST /oauth/revoke': PUBLIC,
  // the consent page: every person who may use MCP (checked in mcp-oauth.test.ts)
  'GET /api/oauth/authorize': ALL,
  'POST /api/oauth/authorize': ALL,
  'GET /api/me/mcp-clients': ALL,
  'DELETE /api/me/mcp-clients/:grantId': ALL,
  'GET /api/settings/mcp-oauth': ADMIN,
  'PUT /api/settings/mcp-oauth': ADMIN,
  'POST /api/settings/mcp-oauth/clients': ADMIN,
  'DELETE /api/settings/mcp-oauth/clients/:clientId': ADMIN,
  'DELETE /api/settings/mcp-oauth/grants/:grantId': ADMIN,
  'PUT /api/settings/daily-summary': ADMIN,

  // ---- duplicating (0.4.0): who may see the original and create the kind (duplicate.test.ts checks the rules) ----
  'POST /api/monitors/:id/duplicate': DESIGN,
  'POST /api/processes/:id/duplicate': DESIGN,
  'POST /api/dashboards/:id/duplicate': DESIGN,
  'POST /api/credentials/:id/duplicate': RUN,
  'POST /api/applications/:id/duplicate': DESIGN,
  'POST /api/services/:id/duplicate': DESIGN,
  // the run right on the schedule's process
  'POST /api/schedules/:id/duplicate': RUN,
  // the fixture schedule is the administrator's: auditors see it, everyone but viewers creates report schedules
  'POST /api/report-schedules/:id/duplicate': ADMIN_AUDITOR,
  'POST /api/maintenance-windows/:id/duplicate': DESIGN,
  'POST /api/compliance/access-checks/:accessCheckId/duplicate': DESIGN,
  'POST /api/status-pages/:pageId/duplicate': DESIGN,
  'POST /api/systems/:id/duplicate': DESIGN,
  // the suggestion for the dialog (fixture: the demo process) and where a copy came from (everyone who sees it)
  'GET /api/duplicates/:kind/:id': DESIGN,
  'GET /api/duplicates/:kind/:id/source': ALL,
  // whoever manages the asset's site
  'POST /api/plant/assets/:assetId/duplicate': DESIGN,
  // device profiles and KPI definitions (#219): who may add sites manages the catalogues
  'POST /api/plant/profiles/:profileId/duplicate': DESIGN,
  'POST /api/plant/kpis/:kpiId/duplicate': DESIGN,

  // ---- the plant registry (#218, on in these fixtures): its switch is the administrators'; rights per site ----
  'GET /api/settings/plant': ADMIN,
  'PUT /api/settings/plant': ADMIN,
  // 0.15.0: the retention of the change-set history (ADR 0020)
  'GET /api/settings/plant/history': ADMIN,
  'PUT /api/settings/plant/history': ADMIN,
  // ---- the module registry (0.11.0, ADR 0016): the switches are the administrators' (a session, step-up) ----
  'GET /api/settings/modules': ADMIN,
  'PUT /api/settings/modules/:id': ADMIN,
  // what the signed-in person may see (the sidebar, honest empty states): two booleans per area, their own
  'GET /api/me/visibility': ALL,
  // the map of sites (#234): its source is the administrators' (a session); tiles for everyone who sees the registry
  'GET /api/settings/plant/map': ADMIN,
  'PUT /api/settings/plant/map': ADMIN,
  'POST /api/settings/plant/map/check': ADMIN,
  'GET /api/plant/map/sites': PLANT,
  'GET /api/plant/map/status': PLANT,
  'GET /api/plant/map/style.json': PLANT,
  'GET /api/plant/map/tiles/:layer/:z/:x/:y': PLANT,
  'GET /api/plant/map/glyphs/:fontstack/:range': PLANT,
  'GET /api/plant/map/sprites/:sprite': PLANT,
  'GET /api/plant/config': PLANT,
  'GET /api/plant/schema': PLANT,
  'GET /api/plant/hierarchy': PLANT,
  'GET /api/plant/sites': PLANT,
  'POST /api/plant/sites': DESIGN,
  'GET /api/plant/sites/:siteId': PLANT,
  'PUT /api/plant/sites/:siteId': DESIGN,
  'DELETE /api/plant/sites/:siteId': DESIGN,
  'PUT /api/plant/sites/:siteId/access': DESIGN,
  'POST /api/plant/sites/:siteId/nodes': DESIGN,
  'PUT /api/plant/sites/:siteId/nodes/:nodeId': DESIGN,
  'DELETE /api/plant/sites/:siteId/nodes/:nodeId': DESIGN,
  'POST /api/plant/sites/:siteId/buildings': DESIGN,
  'PUT /api/plant/sites/:siteId/buildings/:buildingId': DESIGN,
  'DELETE /api/plant/sites/:siteId/buildings/:buildingId': DESIGN,
  'POST /api/plant/sites/:siteId/links': DESIGN,
  'PATCH /api/plant/sites/:siteId/links/:linkId': DESIGN,
  'DELETE /api/plant/sites/:siteId/links/:linkId': DESIGN,
  'GET /api/plant/assets': PLANT,
  'POST /api/plant/assets': DESIGN,
  'GET /api/plant/assets/:assetId': PLANT,
  'PUT /api/plant/assets/:assetId': DESIGN,
  'DELETE /api/plant/assets/:assetId': DESIGN,
  'PUT /api/plant/assets/:assetId/image': DESIGN,
  'DELETE /api/plant/assets/:assetId/image': DESIGN,
  'GET /api/plant/assets/:assetId/image': PLANT,
  'POST /api/plant/assets/:assetId/links': DESIGN,
  'PATCH /api/plant/assets/:assetId/links/:linkId': DESIGN,
  'DELETE /api/plant/assets/:assetId/links/:linkId': DESIGN,
  // the import needs the right to add sites or manage one; its preview shows what it would change – 0.13.0: also to who
  // may only propose (with that right counted as manage, rolled back: for "Add to draft")
  'POST /api/plant/import/preview': PROPOSE,
  'POST /api/plant/import': DESIGN,
  'GET /api/plant/imports': PLANT,
  'GET /api/plant/export': PLANT,
  // changing ids (0.11.0): whoever may change the entry; the old ids (aliases) are the administrators'
  'POST /api/plant/ids/rename/preview': DESIGN,
  'POST /api/plant/ids/rename': DESIGN,
  'GET /api/plant/aliases': ADMIN,
  'DELETE /api/plant/aliases/:kind/:oldId': ADMIN,
  // many entries at once (0.11.0): whoever manages a site or the catalogues; entries they may not change are skipped;
  // 0.13.0: the preview for who may only propose too ("Add to draft")
  'POST /api/plant/bulk/preview': PROPOSE,
  'POST /api/plant/bulk': DESIGN,
  // 0.16: devices and data collections to another asset – who manages both sites; the preview also for who may only
  // propose ("Add to draft"); a duplicate of a device: who manages the target
  'POST /api/plant/move/preview': PROPOSE,
  'POST /api/plant/move': DESIGN,
  'POST /api/plant/assets/:assetId/devices/:deviceId/duplicate': DESIGN,
  // change sets (0.13.0, ADR 0020): whoever sees the registry reads what they may see; who may propose keeps drafts;
  // who manages what a change set touches applies, rejects or returns it (never its author under review)
  'GET /api/plant/change-sets': PLANT,
  'POST /api/plant/change-sets': PROPOSE,
  'GET /api/plant/change-sets/open': PLANT,
  'GET /api/plant/change-sets/settings': PLANT,
  'PUT /api/plant/change-sets/settings': DESIGN,
  'GET /api/plant/change-sets/:changeSetId': PLANT,
  'PATCH /api/plant/change-sets/:changeSetId': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/operations': PROPOSE,
  'PUT /api/plant/change-sets/:changeSetId/operations/:seq': PROPOSE,
  'DELETE /api/plant/change-sets/:changeSetId/operations/:seq': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/preview': PLANT,
  'POST /api/plant/change-sets/:changeSetId/propose': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/withdraw': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/return': DESIGN,
  'POST /api/plant/change-sets/:changeSetId/resolve': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/apply': DESIGN,
  'POST /api/plant/change-sets/:changeSetId/reject': DESIGN,
  'POST /api/plant/change-sets/:changeSetId/revert': PROPOSE,
  'POST /api/plant/change-sets/:changeSetId/copy': PROPOSE,
  'GET /api/plant/history': PLANT,
  'POST /api/plant/history/:historyId/revert': PROPOSE,
  // the site's switch "Changes need a second person": who manages the site, confirmed like an access grant
  'PUT /api/plant/sites/:siteId/review': DESIGN,
  // 0.14: documentation still current – confirming (who may propose on the site), the site's interval, the health view
  'POST /api/plant/documents/confirm': [...DESIGN, 'operator', 'approver', 'plant'],
  'PUT /api/plant/sites/:siteId/doc-review': DESIGN,
  'GET /api/plant/sites/:siteId/documentation': PLANT,
  // part 2 (#219): device profiles and KPI definitions (catalogues of the installation), an asset's assignment
  'GET /api/plant/profiles': PLANT,
  'POST /api/plant/profiles': DESIGN,
  // 0.12.0: extract a base profile (the candidates and the preview change nothing)
  'POST /api/plant/profiles/extract-base/candidates': DESIGN,
  'POST /api/plant/profiles/extract-base/preview': DESIGN,
  'POST /api/plant/profiles/extract-base': DESIGN,
  'GET /api/plant/profiles/:profileId': PLANT,
  'PUT /api/plant/profiles/:profileId': DESIGN,
  'DELETE /api/plant/profiles/:profileId': DESIGN,
  'GET /api/plant/profiles/:profileId/points/:pointId': PLANT,
  'GET /api/plant/kpis': PLANT,
  'POST /api/plant/kpis': DESIGN,
  'GET /api/plant/kpis/:kpiId': PLANT,
  'PUT /api/plant/kpis/:kpiId': DESIGN,
  'DELETE /api/plant/kpis/:kpiId': DESIGN,
  'GET /api/plant/assets/:assetId/assignment': PLANT,
  'PUT /api/plant/assets/:assetId/assignment': DESIGN,
  'DELETE /api/plant/assets/:assetId/assignment': DESIGN,
  'GET /api/plant/explore/points': PLANT,
  // visualizations (#230): read-only, the rights of the pages they picture (only what the caller may see)
  'GET /api/plant/views/overview': PLANT,
  'GET /api/plant/views/coverage': PLANT,
  'GET /api/plant/sites/:siteId/structure': PLANT,
  'GET /api/plant/sites/:siteId/network/placement': PLANT,
  'GET /api/plant/assets/:assetId/flow': PLANT,
  'GET /api/plant/profiles/:profileId/points/:pointId/lineage': PLANT,
  'GET /api/plant/checks': PLANT,
  // part 3 (#220): the OT network follows the site – who sees it sees the network, who manages it changes it
  'GET /api/plant/sites/:siteId/network': PLANT,
  'POST /api/plant/sites/:siteId/vlans': DESIGN,
  'PUT /api/plant/sites/:siteId/vlans/:vlanId': DESIGN,
  'DELETE /api/plant/sites/:siteId/vlans/:vlanId': DESIGN,
  'POST /api/plant/sites/:siteId/vlans/:vlanId/segment': DESIGN,
  'POST /api/plant/sites/:siteId/zones': DESIGN,
  'PUT /api/plant/sites/:siteId/zones/:zoneId': DESIGN,
  'DELETE /api/plant/sites/:siteId/zones/:zoneId': DESIGN,
  'POST /api/plant/sites/:siteId/conduits': DESIGN,
  'PUT /api/plant/sites/:siteId/conduits/:conduitId': DESIGN,
  'DELETE /api/plant/sites/:siteId/conduits/:conduitId': DESIGN,
  'GET /api/plant/assets/:assetId/network': PLANT,
  'PUT /api/plant/assets/:assetId/checks': DESIGN,
  'POST /api/plant/assets/:assetId/devices': DESIGN,
  'PUT /api/plant/assets/:assetId/devices/:deviceId': DESIGN,
  'DELETE /api/plant/assets/:assetId/devices/:deviceId': DESIGN,
  'POST /api/plant/assets/:assetId/paths': DESIGN,
  'PUT /api/plant/assets/:assetId/paths/:pathId': DESIGN,
  'DELETE /api/plant/assets/:assetId/paths/:pathId': DESIGN,
  // 0.11.0 (ADR 0019): data collections follow the asset's site like its data paths
  'GET /api/plant/assets/:assetId/collections': PLANT,
  'POST /api/plant/assets/:assetId/collections': DESIGN,
  'GET /api/plant/assets/:assetId/collections/:collectionId': PLANT,
  'PUT /api/plant/assets/:assetId/collections/:collectionId': DESIGN,
  'DELETE /api/plant/assets/:assetId/collections/:collectionId': DESIGN,
  'GET /api/plant/assets/:assetId/collections/:collectionId/mapping': PLANT,
  // 0.19.0: who may propose previews a collector's files to add them to their draft (importing stays with who manages)
  'POST /api/plant/assets/:assetId/collections/import/preview': PROPOSE,
  'POST /api/plant/assets/:assetId/collections/import': DESIGN,
  // 0.12: where the data goes, the kept files of imports (secrets removed) and the Documents panel: who sees the entry
  'GET /api/plant/assets/:assetId/collections/:collectionId/flow': PLANT,
  'GET /api/plant/assets/:assetId/collection-sources': PLANT,
  'GET /api/plant/assets/:assetId/collection-sources/diff': PLANT,
  'GET /api/plant/assets/:assetId/collection-sources/:sourceId/file': PLANT,
  'GET /api/plant/documents': PLANT,
  'GET /api/plant/collections': PLANT,
  'GET /api/plant/profiles/:profileId/points/:pointId/collections': PLANT,
  // 0.14: security advisories – read by everyone in the registry; upload and removal by who manages the catalogues;
  // decisions and remediation by who manages the asset's site (the fixture advisory matches no asset: refused roles
  // only); the sources (providers, aggregators, ROLIE feeds) are the administrators'
  'GET /api/plant/advisories': PLANT,
  'GET /api/plant/advisories/summary': PLANT,
  'POST /api/plant/advisories/upload': DESIGN,
  'GET /api/plant/advisories/:advisoryId': PLANT,
  'DELETE /api/plant/advisories/:advisoryId': DESIGN,
  'GET /api/plant/advisories/:advisoryId/document': PLANT,
  'PUT /api/plant/advisories/:advisoryId/assets/:assetId/decision': DESIGN,
  'PUT /api/plant/advisories/:advisoryId/assets/:assetId/remediation': DESIGN,
  'PUT /api/plant/advisories/:advisoryId/sites/:siteId': DESIGN,
  'GET /api/plant/assets/:assetId/advisories': PLANT,
  'GET /api/plant/advisory-sources': ADMIN,
  'POST /api/plant/advisory-sources': ADMIN,
  'PUT /api/plant/advisory-sources/:advisorySourceId': ADMIN,
  'DELETE /api/plant/advisory-sources/:advisorySourceId': ADMIN,
  'POST /api/plant/advisory-sources/:advisorySourceId/fetch': ADMIN,
  // 0.14: the Insights Hub mapping of a sink follows the collection; checking it also needs the platform's use right
  'GET /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub': PLANT,
  'GET /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/mapping.csv': PLANT,
  'PUT /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/mapping': DESIGN,
  'POST /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/bulk': DESIGN,
  'POST /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/csv': DESIGN,
  'POST /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/check': DESIGN,
  'POST /api/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub/monitor': DESIGN,
  'GET /api/plant/sites/:siteId/insights-hub': PLANT,
  // the monitor's page: who sees the monitor
  'GET /api/plant/monitors/:monitorId/insights-hub': ALL,
};

/** Routes that only work with an interactive session: an API token must not manage identities, the vault or sign-in. */
const SESSION_ONLY = [
  // suppliers (ADR 0029 decision 9): every change is a decision of a person in the app
  'POST /api/suppliers',
  'PUT /api/suppliers/:id',
  'POST /api/suppliers/:id/archive',
  'POST /api/suppliers/:id/confirm',
  'POST /api/suppliers/:id/merge',
  'POST /api/suppliers/:id/not-a-supplier',
  'POST /api/suppliers/:id/contacts',
  'PUT /api/suppliers/:id/contacts/:contactId',
  'DELETE /api/suppliers/:id/contacts/:contactId',
  'POST /api/suppliers/:id/contracts',
  'PUT /api/suppliers/:id/contracts/:contractId',
  'DELETE /api/suppliers/:id/contracts/:contractId',
  'PUT /api/suppliers/:id/contracts/:contractId/services/:serviceId',
  'DELETE /api/suppliers/:id/contracts/:contractId/services/:serviceId',
  'PUT /api/suppliers/:id/contracts/:contractId/platforms/:platformId',
  'DELETE /api/suppliers/:id/contracts/:contractId/platforms/:platformId',
  'DELETE /api/suppliers/scope-notice',
  'POST /api/suppliers/shared-suggestions/:key/keep-separate',
  'POST /api/suppliers/merge/preview',
  'POST /api/suppliers/merge',
  'POST /api/suppliers/:id/open',
  'POST /api/suppliers/:id/certificates',
  'PUT /api/suppliers/:id/certificates/:certificateId',
  'DELETE /api/suppliers/:id/certificates/:certificateId',
  // contract payments and recorded costs (ADR 0030): new writes for people, in a session
  'POST /api/costs/plans/:serviceId/lines/:lineId/book',
  'POST /api/costs/schedules',
  'PUT /api/costs/schedules/:costScheduleId',
  'DELETE /api/costs/schedules/:costScheduleId',
  'POST /api/costs/plans/:serviceId/proposals',
  'POST /api/costs/plans/:serviceId/contract-updates',
  'POST /api/costs/plans/:serviceId/entries/import/preview',
  'POST /api/costs/plans/:serviceId/entries/import',
  'DELETE /api/costs/plans/:serviceId/imports/:importId',
  'POST /api/costs/platform-plans/:platformId/lines/:lineId/book',
  'POST /api/costs/platform-plans/:platformId/proposals',
  'POST /api/costs/platform-plans/:platformId/contract-updates',
  'POST /api/costs/platform-plans/:platformId/entries/import/preview',
  'POST /api/costs/platform-plans/:platformId/entries/import',
  'DELETE /api/costs/platform-plans/:platformId/imports/:importId',
  'PUT /api/settings/modules/:id',
  'GET /api/settings/plant/map',
  'PUT /api/settings/plant/map',
  'POST /api/settings/plant/map/check',
  'GET /api/plant/map/status',
  'GET /api/plant/map/style.json',
  'GET /api/plant/map/tiles/:layer/:z/:x/:y',
  'GET /api/plant/map/glyphs/:fontstack/:range',
  'GET /api/plant/map/sprites/:sprite',
  'POST /api/me/tokens',
  'POST /api/mcp-requests/:requestId/decision',
  'POST /api/users',
  'PUT /api/users/:id',
  'POST /api/users/:id/reset-password',
  'GET /api/users/:id/data-export',
  'POST /api/users/:id/pseudonymise',
  'GET /api/me/data-export',
  'POST /api/teams',
  'PUT /api/teams/:id',
  'DELETE /api/teams/:id',
  'PUT /api/teams/:id/settings',
  'POST /api/teams/:id/settings/test',
  'POST /api/teams/:id/settings/logo',
  'DELETE /api/teams/:id/settings/logo',
  'POST /api/oauth/authorize',
  'PUT /api/settings/mcp-oauth',
  'POST /api/settings/mcp-oauth/clients',
  'DELETE /api/settings/mcp-oauth/clients/:clientId',
  'DELETE /api/settings/mcp-oauth/grants/:grantId',
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
  'PUT /api/settings/instance',
  'PUT /api/assurance/policy',
  'POST /api/assurance/policy/changes/:changeId/approve',
  'POST /api/assurance/policy/changes/:changeId/reject',
  'POST /api/vault/passphrase',
  'POST /api/vault/lock',
  'POST /api/sync-sources',
  'PUT /api/sync-sources/:id',
  'DELETE /api/sync-sources/:id',
  'POST /api/sync-sources/:id/rotate-webhook-secret',
  // secrets that outlive an API token (0.10.1): webhook triggers, push tokens, heartbeat and gateway secrets, status page links
  'POST /api/triggers',
  'POST /api/triggers/:id/rotate',
  'POST /api/costs/platform/:id/push-tokens',
  'POST /api/costs/platform/:id/push-tokens/:tokenId/rotate',
  'POST /api/db-schemas/:kind/:id/push-tokens',
  'POST /api/db-schemas/:kind/:id/push-tokens/:tokenId/rotate',
  'POST /api/monitors/:id/checks/:checkId/rotate',
  'POST /api/monitor-gateways',
  'POST /api/monitor-gateways/:id/rotate',
  'POST /api/status-pages/:pageId/link',
  // switching the MCP server on (with AI run requests and control proposals), like its OAuth settings
  'PUT /api/mcp-server',
  'POST /api/libraries/:library/rollback',
  'POST /api/libraries/:library/uninstall',
  'POST /api/libraries/:library/hold',
  'POST /api/library-releases/:id/install',
  'POST /api/library-releases/:id/approve',
  'POST /api/library-releases/:id/withdraw',
  'DELETE /api/library-releases/:id',
  'POST /api/library-releases/upload',
  // corrective actions (ADR 0029 decision 9): decisions of people in the app
  'POST /api/compliance/corrective-actions',
  'PUT /api/compliance/corrective-actions/:findingId',
  'POST /api/compliance/corrective-actions/:findingId/actions',
  'PUT /api/compliance/corrective-actions/:findingId/actions/:actionId',
  'DELETE /api/compliance/corrective-actions/:findingId/actions/:actionId',
  'POST /api/compliance/corrective-actions/:findingId/effectiveness',
  'POST /api/compliance/corrective-actions/:findingId/cancel',
  'POST /api/compliance/corrective-suggestions/:suggestionId/confirm',
  'POST /api/compliance/corrective-suggestions/:suggestionId/dismiss',
  'PUT /api/compliance/corrective-settings',
  // statement of applicability and responsibility matrix (ADR 0029 decision 9): decisions of people in the app
  'POST /api/compliance/soa',
  'PUT /api/compliance/soa/:catalogueId/settings',
  'PUT /api/compliance/soa/:catalogueId/entries/:controlId',
  'POST /api/compliance/soa/:catalogueId/versions',
  'POST /api/compliance/soa/:catalogueId/versions/:n/decision',
  'PUT /api/services/:id/responsibilities',
  'POST /api/library-publishers',
  'PUT /api/library-publishers/:id',
  'DELETE /api/library-publishers/:id',
  'POST /api/library-publishers/:id/keys',
  'PUT /api/library-keys/:id',
  'POST /api/library-keys/:id/retire',
  'POST /api/library-keys/:id/revoke',
  'DELETE /api/library-keys/:id',
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
/** `query`: what is appended to the URL of the sensitive and the harmless request (a GET route whose query decides) */
/** `path`: the filled path to send to instead of the route's fixture path (a route whose path parameter decides) */
const STEP_UP: Record<string, 'always' | { sensitive: unknown; harmless: unknown; query?: { sensitive: string; harmless: string }; path?: () => string }> = {
  // copying the access settings of an original shares the copy with its access list and owning teams (0.4.0);
  // harmless: no access settings, refused for the key (nothing is created)
  ...Object.fromEntries(
    [
      'POST /api/monitors/:id/duplicate',
      'POST /api/processes/:id/duplicate',
      'POST /api/dashboards/:id/duplicate',
      'POST /api/credentials/:id/duplicate',
      'POST /api/applications/:id/duplicate',
      'POST /api/services/:id/duplicate',
      'POST /api/report-schedules/:id/duplicate',
      'POST /api/systems/:id/duplicate',
    ].map((k) => [k, { sensitive: { copyAccess: true }, harmless: { copyAccess: false, key: '!' } }]),
  ),
  // allowing an MCP client gives it lasting access as the person (#12); denying needs no confirmation
  'POST /api/oauth/authorize': {
    sensitive: { request: { response_type: 'code', client_id: 'mcpc_matrix', redirect_uri: 'http://127.0.0.1:1/cb' }, approve: true },
    harmless: { request: { response_type: 'code', client_id: 'mcpc_matrix', redirect_uri: 'http://127.0.0.1:1/cb' }, approve: false },
  },
  'POST /api/me/tokens': 'always',
  'POST /api/vault/passphrase': 'always',
  // the Teams bot (ADR 0013): its credential and where decisions can be taken
  'PUT /api/settings/teams-bot': 'always',
  // adding an owning team gives its members their roles on the resource (#131)
  'PUT /api/owning-teams/:kind/:id': {
    get sensitive() {
      return { teamIds: [fx.team] };
    },
    harmless: { teamIds: [] as string[] },
  },
  'POST /api/owning-teams/bulk': {
    get sensitive() {
      return { teamIds: [fx.team], resources: [{ kind: 'process', id: fx.process }] };
    },
    // a preview changes nothing
    get harmless() {
      return { teamIds: [fx.team], resources: [{ kind: 'process', id: fx.process }], preview: true };
    },
  },
  // shared suppliers (ADR 0031 part 8, security review 0.18.0 M5): adding an owning team and a merge that widens who
  // sees a supplier grant access like the owning-teams panel
  'POST /api/suppliers/:id/open': {
    get sensitive() {
      return { teamIds: [fx.team] };
    },
    harmless: { teamIds: [] as string[] },
  },
  'POST /api/suppliers/merge': {
    get sensitive() {
      return { intoId: fx.supplier, ids: [fx.supplierTeam] };
    },
    // nothing to merge (refused as a merge into itself)
    get harmless() {
      return { intoId: fx.supplier, ids: [fx.supplier] };
    },
  },
  'POST /api/suppliers/:id/merge': {
    get sensitive() {
      return { into: fx.supplier };
    },
    get harmless() {
      return { into: fx.supplierTeam };
    },
    path: () => `/api/suppliers/${fx.supplierTeam}/merge`,
  },
  // #195: naming an owner or responsible from outside the owning teams (vera; the administrator is a member of
  // "Matrix owners", which owns the *Team fixtures and is chosen for the administrator's new resources in this test)
  // grants access like an access list; a covered subject or an invalid body is harmless
  ...namedGrantRoutes(),
  'POST /api/users': { sensitive: { username: 'matrix-new', roles: ['viewer'] }, harmless: { username: '!' } },
  'PUT /api/users/:id': { sensitive: { roles: ['admin'] }, harmless: {} },
  'POST /api/users/:id/reset-password': 'always',
  'GET /api/users/:id/data-export': 'always',
  'POST /api/users/:id/pseudonymise': 'always',
  'POST /api/sso/providers': 'always',
  'PUT /api/sso/providers/:id': 'always',
  'DELETE /api/sso/providers/:id': 'always',
  'PUT /api/settings': { sensitive: { outboundAllowList: ['matrix.example'] }, harmless: {} },
  'PUT /api/settings/instance': { sensitive: { outboundAllowList: ['matrix.example'] }, harmless: {} },
  'PUT /api/settings/notifications': { sensitive: { allowedEmailDomains: ['matrix.example'] }, harmless: { allowedEmailDomains: ['example.com'] } },
  'POST /api/teams': { sensitive: { name: 'Matrix step-up', members: ['vera'] }, harmless: { name: '!' } },
  'PUT /api/teams/:id': { sensitive: { name: 'Matrix team', members: ['vera'] }, harmless: { name: 'Matrix team', members: [] } },
  // a team's own channel sends messages about its resources elsewhere (#136)
  'PUT /api/teams/:id/settings': {
    sensitive: { channel: { enabled: true, format: 'teams', mode: 'also', url: 'https://matrix.example/hook' } },
    harmless: { newResources: 'auto' },
  },
  // (harmless: no list, so nobody gains a right – refused by the route's validation, the fixture stays)
  // an access list of a plant registry site gives rights to others (#218)
  'PUT /api/plant/sites/:siteId/access': 'always',
  // 0.14: where Steward reads security advisories from (plant.advisorySources)
  'POST /api/plant/advisory-sources': 'always',
  'PUT /api/plant/advisory-sources/:advisorySourceId': 'always',
  'DELETE /api/plant/advisory-sources/:advisorySourceId': 'always',
  // Git sync sources (security review 0.19.0 L1, control point sync.sources): a new source, another repository, signing
  // loosened or auto-accept on; harmless: an invalid body (refused by the route) and the fixture's own settings
  'POST /api/sync-sources': {
    get sensitive() {
      return SYNC_SOURCE;
    },
    harmless: { name: '!' },
  },
  'PUT /api/sync-sources/:id': {
    get sensitive() {
      return SYNC_SOURCE;
    },
    get harmless() {
      return { ...SYNC_SOURCE, repoUrl: `${s.base}/mock/git/steward/library`, folder: 'steward', kinds: ['dashboard'] };
    },
  },
  // a new address of a platform's stored credentials (security review 0.19.0 H1, control point platform.destination)
  'PUT /api/platforms/:id': { sensitive: { baseUrl: 'https://matrix.example' }, harmless: {} },
  'PUT /api/platforms/:id/database': {
    sensitive: { dialect: 'postgresql', host: 'db.example.com', database: 'shop' },
    // (not a valid connection: refused by the route's validation, the fixture stays)
    harmless: { dialect: 'postgresql' },
    path: () => `/api/platforms/${fx.dbPlatform}/database`,
  },
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
  // approving or returning a version of the statement of applicability (soa.approve, ADR 0029)
  'POST /api/compliance/soa/:catalogueId/versions/:n/decision': 'always',
  // switching the second person of a statement of applicability off (soa.approve, security review 0.17.0)
  'PUT /api/compliance/soa/:catalogueId/settings': { sensitive: { fourEyes: false }, harmless: { scopeName: 'Matrix' } },
  'POST /api/compliance/soa': { sensitive: { catalogueId: 'none', fourEyes: false }, harmless: { catalogueId: 'none' } },
  // the signed export of a statement of applicability (the evidence-pack key, like creating a pack); PDF and CSV are not
  'GET /api/compliance/soa/:catalogueId/versions/:n/export': { sensitive: {}, harmless: {}, query: { sensitive: '?format=zip', harmless: '?format=csv' } },
  'GET /api/audit/export': 'always',
  'PUT /api/assurance/policy': 'always',
  'POST /api/assurance/policy/changes/:changeId/approve': 'always',
  'GET /api/assurance/report': 'always',
  'PUT /api/audit/anchoring': 'always',
  'PUT /api/audit/archive': 'always',
  'GET /api/audit/archives/:archiveId/file': 'always',
  'GET /api/credentials/export.csv': 'always',
  'POST /api/migration/export': 'always',
  'POST /api/migration/imports/staged/:id/apply': 'always',
  'PUT /api/catalogue/cia-scale': 'always',
  'PUT /api/backups/settings': 'always',
  // the platform of the backups changed: confirming its target again (0.17.1, like an export's)
  'POST /api/backups/confirm-target': 'always',
  // a scheduled export sends data out of Steward (0.16.0, control point export.settings)
  'POST /api/exports': 'always',
  'PUT /api/exports/:id': 'always',
  'DELETE /api/exports/:id': 'always',
  'POST /api/exports/:id/confirm-target': 'always',
  'PUT /api/platforms/:id/mcp-gateway': { sensitive: { enabled: true, writes: 'confirm' }, harmless: { enabled: true } },
  // identities (0.13.0, ADR 0009): loosening (read-only off), adding someone to the list, MCP writes on, a new default
  'PUT /api/platforms/:id/identities/:identityId': { sensitive: { readOnly: false }, harmless: { description: 'Matrix' } },
  'PUT /api/platforms/:id/identities/:identityId/access': {
    sensitive: { acl: [{ subject: 'user:vera', permissions: ['use'] }] },
    harmless: { acl: 'not a list' },
  },
  'PUT /api/platforms/:id/identities/:identityId/mcp': { sensitive: { mode: 'writes', writes: 'confirm' }, harmless: { mode: 'read' } },
  'POST /api/platforms/:id/identities/:identityId/default': 'always',
  // privileged identities (0.14.0, ADR 0009 step 4): naming one asks for a step-up (platform.privilegedIdentity); the
  // routes where it depends on a stored object (approving a start approval or an MCP request, "Run now") ask in the handler
  'POST /api/runs': {
    get sensitive() {
      return { processId: fx.process, bindings: { api: fx.platform }, identities: { api: fx.privIdentity } };
    },
    get harmless() {
      return { processId: fx.process, dryRun: true, bindings: { api: fx.platform }, identities: { api: fx.identity } };
    },
  },
  ...Object.fromEntries(
    ['POST /api/schedules', 'PUT /api/schedules/:id'].map((k) => [
      k,
      {
        get sensitive() {
          return { name: 'x', processId: fx.process, cron: '0 3 * * *', bindings: { api: fx.platform }, identities: { api: fx.privIdentity } };
        },
        get harmless() {
          return { name: '!', processId: fx.process, cron: 'not a cron' };
        },
      },
    ]),
  ),
  ...Object.fromEntries(
    ['POST /api/triggers', 'PUT /api/triggers/:id'].map((k) => [
      k,
      {
        get sensitive() {
          return { ...TRIGGER, processId: fx.process, bindings: { api: fx.platform }, identities: { api: fx.privIdentity } };
        },
        get harmless() {
          return { name: 1 };
        },
      },
    ]),
  ),
  'POST /api/platforms/:id/request': {
    get sensitive() {
      return { method: 'GET', path: '/x', identityId: fx.privIdentity };
    },
    harmless: { method: 'GET', path: '/x', identityId: 'pi_none' },
  },
  'POST /api/platforms/:id/identities/:identityId/enable': 'always',
  // raising an AI budget (the fixtures set 1,000 tokens a day for the installation); lowering it needs no confirmation
  'PUT /api/ai/budgets': {
    sensitive: { scope: 'installation', scopeId: '', tokensPerDay: 2000, tokensPerMonth: null },
    harmless: { scope: 'installation', scopeId: '', tokensPerDay: 500, tokensPerMonth: null },
  },
  'PUT /api/backups/passphrase': 'always',
  // where the map of sites fetches its tiles from (#234; the fixtures use OpenStreetMap, the demo's mock of it)
  'PUT /api/settings/plant/map': { sensitive: { source: 'openfreemap' }, harmless: { source: 'osm' } },
  // switching a module (0.11.0, ADR 0016); repeating its state is harmless – the plant registry's own switch, too
  'PUT /api/settings/modules/:id': { sensitive: { enabled: false }, harmless: { enabled: true } },
  'PUT /api/settings/plant': {
    sensitive: { enabled: false, enterprise: '', labels: {}, fields: {} },
    harmless: { enabled: true, enterprise: '', labels: {}, fields: {} },
  },
  // trusting a library publisher or key (#238, control point library.publishers); retiring and revoking need none
  'POST /api/library-publishers': 'always',
  'DELETE /api/library-publishers/:id': 'always',
  'POST /api/library-publishers/:id/keys': 'always',
  'DELETE /api/library-keys/:id': 'always',
  // widening the library list (the fixture's publisher may publish matrix-library only); the same list is harmless
  'PUT /api/library-publishers/:id': {
    sensitive: { name: 'Matrix publisher', libraries: [] },
    harmless: { name: 'Matrix publisher', libraries: ['matrix-library'] },
  },
  // lifting an expiry (the fixture's key is valid until 2099); an earlier date is harmless
  'PUT /api/library-keys/:id': { sensitive: { expiresAt: null }, harmless: { expiresAt: '2098-01-01' } },
  // checking a new address of an own source is the first step of a new source (the stored own source checks freely)
  'POST /api/settings/plant/map/check': {
    sensitive: { kind: 'raster', url: 'https://other-tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' },
    harmless: { kind: 'raster', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' },
  },
  // raising a cost budget (#226; the fixtures set 1,000 USD a month for a service); lowering it needs no confirmation
  'PUT /api/costs/budgets': {
    get sensitive() {
      return { scope: 'service', scopeId: fx.service, amount: '2000', currency: 'USD' };
    },
    get harmless() {
      return { scope: 'service', scopeId: fx.service, amount: '500', currency: 'USD' };
    },
  },
  // 0.13.0: the site's switch "Changes need a second person" and the catalogue's, confirmed like access grants
  'PUT /api/plant/sites/:siteId/review': 'always',
  'PUT /api/plant/change-sets/settings': 'always',
  // applying a change set that removes or renames more than one entry (the fixture's removes two); without a valid body
  // nothing is asked (the route answers 400)
  'POST /api/plant/change-sets/:changeSetId/apply': { sensitive: { fingerprint: 'matrix' }, harmless: {} },
  // many plant entries at once (0.11.0): removing more than one; one is harmless (here: one that does not exist)
  'POST /api/plant/bulk': {
    sensitive: { kind: 'asset', action: 'remove', items: [{ id: 'nothing-a' }, { id: 'nothing-b' }] },
    harmless: { kind: 'asset', action: 'remove', items: [{ id: 'nothing-a' }] },
  },
  // 0.16: a move of more than 25 entries (none of them exists); one is harmless
  'POST /api/plant/move': {
    sensitive: { kind: 'device', items: Array.from({ length: 26 }, (_, i) => ({ asset: 'nothing', id: `d-${i}` })), toAsset: 'nothing' },
    harmless: { kind: 'device', items: [{ asset: 'nothing', id: 'd-0' }], toAsset: 'nothing' },
  },
  // an import that removes (or renames) more than one entry; a file that removes nothing is harmless
  'POST /api/plant/import': {
    sensitive: {
      files: [{ name: 'r.yaml', content: 'version: 1\nremove:\n  - { kind: site, id: hillcrest }\n  - { kind: site, id: riverside }\n' }],
      mode: 'update',
      cascade: true,
    },
    harmless: { files: [{ name: 'r.yaml', content: 'version: 1\nremove: []\n' }], mode: 'update' },
  },
};

/** The step-up table of named owners and responsibles from outside the owning teams (#195). */
function namedGrantRoutes(): typeof STEP_UP {
  type Rule = Exclude<(typeof STEP_UP)[string], 'always'>;
  const rule = (sensitive: () => unknown, harmless: () => unknown, path?: () => string): Rule => ({
    get sensitive() {
      return sensitive();
    },
    get harmless() {
      return harmless();
    },
    ...(path ? { path } : {}),
  });
  // (read when the test runs: the bodies are defined further down)
  const credential = () => ({ ...CREDENTIAL, name: 'Matrix team credential' });
  const ticket = () => ({ ...TICKET, externalNumber: 'INC-MATRIX-T', title: 'Matrix team ticket' });
  const duty = () => ({ name: 'Matrix team duty', processId: fx.process, interval: 'monthly', level: 'mandatory' });
  return {
    'POST /api/credentials': rule(
      () => ({ ...CREDENTIAL, name: 'Matrix new credential', ownerSubjects: ['user:vera'] }),
      () => ({ name: '' }),
    ),
    'PUT /api/credentials/:id': rule(
      () => ({ ...credential(), ownerSubjects: ['user:vera'] }),
      () => ({ ...credential(), ownerSubjects: ['team:matrix owners'] }),
      () => `/api/credentials/${fx.credentialTeam}`,
    ),
    'POST /api/ticket-references': rule(
      () => ({ ...TICKET, externalNumber: 'INC-MATRIX-N', responsible: ['user:vera'] }),
      () => ({ source: '' }),
    ),
    'PUT /api/ticket-references/:id': rule(
      () => ({ ...ticket(), responsible: ['user:vera'] }),
      () => ({ ...ticket(), responsible: ['user:admin'] }),
      () => `/api/ticket-references/${fx.ticketTeam}`,
    ),
    ...Object.fromEntries(
      (['services', 'applications', 'systems'] as const).flatMap((kind) => {
        const extra = kind === 'systems' ? { kind: 'server' } : {};
        const name = `Matrix team ${kind.slice(0, -1)}`;
        return [
          [
            `POST /api/${kind}`,
            rule(
              () => ({ name: `Matrix new ${kind}`, ...extra, owners: ['user:vera'] }),
              () => ({ name: '' }),
            ),
          ],
          [
            `PUT /api/${kind}/:id`,
            rule(
              () => ({ name, ...extra, owners: ['user:vera'] }),
              () => ({ name, ...extra, owners: ['team:matrix owners'] }),
              () => `/api/${kind}/${fx[`${kind.slice(0, -1)}Team`]}`,
            ),
          ],
        ];
      }),
    ),
    'PUT /api/suppliers/:id': rule(
      () => ({ name: 'Matrix team supplier', type: 'saas', owners: ['user:vera'] }),
      () => ({ name: '' }),
      () => `/api/suppliers/${fx.supplierTeam}`,
    ),
    'POST /api/suppliers/:id/contracts': rule(
      () => ({ title: 'Matrix new contract', owners: ['user:vera'] }),
      () => ({ title: '' }),
      () => `/api/suppliers/${fx.supplierTeam}/contracts`,
    ),
    'PUT /api/suppliers/:id/contracts/:contractId': rule(
      () => ({ title: 'Matrix team contract', owners: ['team:matrix owners', 'user:vera'] }),
      () => ({ title: 'Matrix team contract', owners: ['team:matrix owners', 'user:admin'] }),
      () => `/api/suppliers/${fx.supplierTeam}/contracts/${fx.contractTeam}`,
    ),
    'PUT /api/suppliers/:id/contracts/:contractId/platforms/:platformId': rule(
      () => ({ purpose: 'Matrix' }),
      () => ({ purpose: 5 }),
      () => `/api/suppliers/${fx.supplierTeam}/contracts/${fx.contractTeam}/platforms/${fx.platformOutside}`,
    ),
    'PUT /api/records/:id': rule(
      () => ({ owner: 'vera' }),
      () => ({ owner: 'admin' }),
      () => `/api/records/${fx.reviewTeam}`,
    ),
    'POST /api/records/:id/measures': rule(
      () => ({ title: 'Matrix new measure', owners: ['user:vera'], dueDate: '2030-01-01' }),
      () => ({ title: '' }),
      () => `/api/records/${fx.reviewTeam}/measures`,
    ),
    'PUT /api/records/:id/measures/:measureId': rule(
      () => ({ owners: ['user:vera'] }),
      () => ({ owners: ['user:admin'] }),
      () => `/api/records/${fx.reviewTeam}/measures/${fx.measureTeam}`,
    ),
    'POST /api/duties': rule(
      () => ({ serviceId: fx.serviceTeam, ...duty(), name: 'Matrix new duty', owners: ['user:vera'] }),
      () => ({ serviceId: fx.serviceTeam, name: '' }),
    ),
    'PUT /api/duties/:id': rule(
      () => ({ ...duty(), owners: ['user:vera'] }),
      () => ({ ...duty(), owners: [] }),
      () => `/api/duties/${fx.dutyTeam}`,
    ),
    'POST /api/compliance/corrective-actions': rule(
      () => ({ title: 'Matrix new finding', source: 'internalAudit', serviceId: fx.serviceTeam, owner: 'vera' }),
      () => ({ title: '' }),
    ),
    'PUT /api/compliance/corrective-actions/:findingId': rule(
      () => ({ owner: 'vera' }),
      () => ({ title: 'Matrix team finding' }),
      () => `/api/compliance/corrective-actions/${fx.findingTeam}`,
    ),
    'POST /api/compliance/corrective-actions/:findingId/actions': rule(
      () => ({ title: 'Matrix new action', owners: ['user:vera'], dueDate: '2030-01-01' }),
      () => ({ title: '' }),
      () => `/api/compliance/corrective-actions/${fx.findingTeam}/actions`,
    ),
    'PUT /api/compliance/corrective-actions/:findingId/actions/:actionId': rule(
      () => ({ owners: ['user:vera'] }),
      () => ({ owners: ['user:admin'] }),
      () => `/api/compliance/corrective-actions/${fx.findingTeam}/actions/${fx.actionTeam}`,
    ),
  };
}

/**
 * Control points whose step-up the assurance policy turns on (#210, auth/assurance.ts) – off by default, so they never
 * ask with the default policy (server/test/assurance.test.ts turns them on).
 */
const STEP_UP_BY_POLICY = [
  'POST /api/records/:id/transition',
  // changing one plant entry's id (0.11.0): off until the policy turns it on
  'POST /api/plant/ids/rename',
  'POST /api/tasks/:id/verify',
  'POST /api/compliance/findings/:findingId/document',
  'POST /api/compliance/findings/:findingId/dismiss',
  'POST /api/compliance/person-reviews/:reviewId/submit',
  'POST /api/compliance/person-reviews/:reviewId/approval',
];

/** GET routes whose fixtures cannot give a 2xx (nothing to find); refusals are still checked. */
const NO_POSITIVE = new Set([
  // the Teams app package needs the bot's app id (none in the fixtures: 409)
  'GET /api/settings/teams-bot/package',
  // OAuth sign-in for MCP clients is off in the fixtures (#12)
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/api/mcp',
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/openid-configuration',
  'GET /api/oauth/authorize',
  'GET /api/teams/:id/settings/logo', // the matrix team has no logo of its own
  // no S3 storage set up in the fixtures
  'GET /api/backups/stored',
  // the SoA version of the fixtures was never approved through the app: no archived PDF (404)
  'GET /api/compliance/soa/:catalogueId/versions/:n/export',
  // no scheduled export in the fixtures
  'GET /api/exports/:id',
  'GET /api/exports/:id/runs',
  'GET /api/artifacts/:id', // the demo runs write no artifacts
  'GET /api/mcp-requests/:requestId', // no MCP client asked for anything
  'GET /api/tasks/:id', // no open approval
  'GET /api/tasks/:id/evidence/:evidenceId/download', // no manual step
  'GET /api/v1/tasks/:taskId',
  'GET /api/records/:id/attachments/:attId/download',
  'GET /api/records/:id/editions/:edition', // the fixture record is a change request: no editions
  'GET /api/v1/records/:recordId/editions/:edition',
  'GET /api/auth/oidc/callback', // redirects
  'GET /api/auth/oidc/:id/start',
  'GET /api/audit/anchor.json', // no checkpoint file yet
  'GET /api/audit/archives/:archiveId/file', // no audit archive (archiving is off)
  'GET /api/reports/branding/logo', // no logo uploaded
  'GET /api/settings/notifications/look/logo',
  'GET /api/theme/logo',
  'GET /api/docs/*', // no such asset
  'GET /api/docs/static/*',
  'GET /api/migration/exports/:id/download', // no package exported
  'GET /api/migration/imports/staged/:id', // no package uploaded
  'GET /api/migration/imports/:id', // nothing imported
  'GET /api/migration/imports/:id/history',
  // the map's raster source (#234) has no glyphs and no sprite
  'GET /api/plant/map/glyphs/:fontstack/:range',
  'GET /api/plant/map/sprites/:sprite',
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
  return (
    url
      .replace(/\*/g, 'nothing-here')
      .replace(/\/api\/platform-types\/:kind/, `/api/platform-types/${fx.platformKind}`)
      // the module registry (ADR 0016): a module the fixtures do not depend on
      .replace(/\/api\/settings\/modules\/:id/, '/api/settings/modules/statusPages')
      .replace(/\/api\/owning-teams\/:kind\/:id/, `/api/owning-teams/process/${fx.process}`)
      .replace(/\/api\/duplicates\/:kind\/:id/, `/api/duplicates/process/${fx.process}`)
      .replace(/\/api\/costs\/attribution\/:kind\/:id/, `/api/costs/attribution/application/${fx.application}`)
      // database schemas (#222): the demo database platform, the newest snapshot
      .replace(/\/api\/db-schemas\/:kind\/:id/, `/api/db-schemas/platform/${fx.dbPlatform}`)
      .replace(/\/schema\/snapshots\/:snapshotId/, '/schema/snapshots/latest')
      .replace(/\/api\/db-schemas\/([^/]+)\/([^/]+)\/snapshots\/:snapshotId/, '/api/db-schemas/$1/$2/snapshots/latest')
      .replace(/:platformId\/schema/, `${fx.dbPlatform}/schema`)
      // Kafka Connect (#223): the demo cluster and its Debezium connector
      .replace(/\/api\/platforms\/:id\/kafka-connect/, `/api/platforms/${fx.connectPlatform}/kafka-connect`)
      .replace(/:name\/config/, 'shop-cdc/config')
      // Confluent Cloud (#123): the demo organisation
      .replace(/\/api\/platforms\/:id\/confluent/, `/api/platforms/${fx.confluentPlatform}/confluent`)
      // platform costs (#226): the demo platform
      .replace(/\/api\/(v1\/)?costs\/:scope\/:id/, `/api/$1costs/platform/${fx.platform}`)
      .replace(/\/api\/costs\/platform\/:id/, `/api/costs/platform/${fx.platform}`)
      .replace(/:platformId/g, url.startsWith('/api/gatus') ? fx.gatusPlatform! : url.startsWith('/api/changedetection') ? fx.cdPlatform! : fx.platform!)
      .replace(/:uuid/g, '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e01')
      .replace(/:specId/g, fx.spec!)
      .replace(/:identityId/g, fx.identity!)
      .replace(/:docId/g, fx.doc!)
      .replace(/:processId/g, fx.process!)
      // a test run of the demo's data contract (#221)
      .replace(/^\/api\/data-contracts\/:id\/runs\/:runId/, `/api/data-contracts/${fx.contract}/runs/${fx.contractRun}`)
      .replace(/:runId/g, fx.run!)
      .replace(/:stepId/g, fx.step!)
      .replace(/:nodeId/g, fx.node!)
      .replace(/:taskId/g, 'tsk_none')
      // plant change sets (0.13.0): a proposed one that removes two entries; one operation; no history row
      .replace(/:changeSetId/g, fx.changeSet!)
      // 0.14: an uploaded advisory (matching no asset) and an advisory source (never read)
      .replace(/:advisoryId/g, fx.advisory!)
      .replace(/:advisorySourceId/g, fx.advisorySource!)
      .replace(/:seq/g, '1')
      .replace(/:historyId/g, 'peh_none')
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
      .replace(/:lineId/g, fx.planLine!)
      .replace(/:entryId/g, fx.planEntry!)
      .replace(/:teamId/g, fx.team!)
      .replace(/:applicationId/g, fx.application!)
      .replace(/:componentId/g, fx.component!)
      .replace(/:systemLinkId/g, fx.systemLink!)
      .replace(/:segmentLinkId/g, 'ssg_none')
      .replace(/:systemId/g, fx.system!)
      .replace(/:dutyId/g, fx.duty!)
      .replace(/:skipId/g, fx.dutySkip!)
      .replace(/:objectiveId/g, fx.objective!)
      .replace(/:accessChangeId/g, fx.accessChange!)
      .replace(/:accessCheckId/g, fx.accessCheck!)
      .replace(/:reviewId/g, fx.personReview!)
      .replace(/:requestId/g, 'mrq_none')
      .replace(/:pageId/g, fx.statusPage!)
      .replace(/:snapshotId/g, fx.snapshot!)
      // corrective actions (ADR 0029): a finding with one action, a pending suggestion
      .replace(/corrective-actions\/:findingId/g, `corrective-actions/${fx.correctiveFinding}`)
      .replace(/:actionId/g, fx.correctiveAction!)
      .replace(/:suggestionId/g, fx.correctiveSuggestion!)
      .replace(/:findingId/g, fx.finding!)
      // the statement of applicability of the fixtures' catalogue and its one version
      .replace(/versions\/:n(?=\/|$)/, 'versions/1')
      .replace(/:catalogueKey/g, 'ISO27001')
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
      .replace(/:siteId/g, fx.site!)
      // the map of sites (#234): the one tile of zoom 0
      .replace('/:layer/:z/:x/:y', '/base/0/0/0')
      .replace('/:fontstack/:range', '/Noto%20Sans%20Regular/0-255.pbf')
      .replace(/:sprite$/, 'default.json')
      .replace(/:assetId/g, fx.asset!)
      .replace(/:nodeId/g, fx.plantNode!)
      .replace(/:buildingId/g, fx.building!)
      .replace(/:profileId/g, 'matrix-profile')
      .replace(/:pointId/g, 'matrix_point')
      .replace(/:collectionId/g, 'matrix-collection')
      .replace(/:sinkId/g, 'matrix-sink')
      .replace(/:sourceId/g, 'pcs_matrix')
      .replace(/:kpiId/g, 'matrix-kpi')
      .replace(
        /:linkId/g,
        url.startsWith('/api/services')
          ? fx.serviceLink!
          : url.startsWith('/api/applications')
            ? fx.applicationLink!
            : url.startsWith('/api/plant/sites')
              ? fx.siteLink!
              : url.startsWith('/api/plant/assets')
                ? fx.assetLink!
                : fx.recordLink!,
      )
      .replace(/:library/g, fx.library!)
      .replace(/:measureId/g, fx.measure!)
      .replace(/:supplierId/g, fx.supplier!)
      .replace(/:contactId/g, fx.supplierContact!)
      .replace(/:contractId/g, fx.supplierContract!)
      .replace(/:certificateId/g, fx.supplierCertificate!)
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
          suppliers: 'supplier',
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
          'library-releases': 'libraryRelease',
          'library-publishers': 'libraryPublisher',
          'library-keys': 'libraryKey',
          'data-contracts': 'contract',
        };
        return seg(map[prefix] ?? '', `none_${prefix}`);
      })
  );
}

/** Query strings some routes need. */
const QUERY: Record<string, string> = {
  'GET /api/plant/collections': '?collectorKind=job&collectorRef=matrix-job',
  'GET /api/plant/assets/:assetId/collection-sources/diff': '?from=pcs_matrix&to=pcs_matrix',
  'GET /api/plant/documents': '?kind=device-profile&id=matrix-profile',
  'GET /api/plant/history': '?kind=site&id=matrix-site&children=1',
  'GET /api/plant/change-sets/open': '?site=matrix-site',
  'GET /api/records/:id/timeline': '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
  'GET /api/link-targets': '?kind=record&q=',
  'GET /api/backlinks': '', // filled in beforeAll (needs the record id)
  'GET /api/runs/compare': '', // filled in beforeAll (needs the run id)
  'GET /api/ticket-references/open-counts': '?kind=service',
  'GET /api/costs/settings/fiscal-year-change': '?startMonth=4',
  'GET /api/compliance/coverage': `?from=2026-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`,
  'GET /api/assurance/policy/as-of': '?at=2026-01-01T00:00:00Z',
  'GET /api/assurance/report': `?from=2026-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`,
  'GET /api/v1/control-coverage': `?from=2026-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`,
  'GET /api/compliance/tag-targets': '?kind=process&q=',
  'GET /api/compliance/tagged': '?kind=recordType&targetId=rty_ac',
  'GET /api/compliance/person-reviews/suggest': '?user=vera',
};

/** Valid bodies for changing routes, so a refusal is a permission decision and not a validation error. */
const bodies = (): Record<string, unknown> => ({
  'POST /api/runs': { processId: fx.process, dryRun: true },
  'POST /api/processes/:id/debug/node': { nodeId: fx.node, vars: { from: 'sample', vars: {} } },
  'POST /api/processes/:id/debug/runs': { mode: 'test' },
  'POST /api/runs/:id/debug': { type: 'debug.continue' },
  'PUT /api/owning-teams/:kind/:id': { teamIds: [] },
  'POST /api/owning-teams/bulk': { teamIds: [], resources: [] },
  'POST /api/access/named-outside': { kind: 'service', subjects: ['user:vera'] },
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
  'PUT /api/catalogue/versions': DEFAULT_VERSION_SETTINGS,
  'PUT /api/catalogue/versions/entry': { holder: 'component', id: fx.component, product: 'nodejs', config: { source: 'endoflife' } },
  'POST /api/catalogue/versions/entry/read': { holder: 'component', id: fx.component, product: 'nodejs' },
  'PUT /api/applications/:id/components/:componentId': { type: 'other', name: 'matrix component' },
  'POST /api/applications/:id/components/:componentId/sbom/preview': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/applications/:id/components/:componentId/sbom': { sbom: { bomFormat: 'CycloneDX', components: [] } },
  'POST /api/systems': { name: 'Matrix system x', kind: 'server' },
  'POST /api/suppliers': { name: 'Matrix supplier x', type: 'saas' },
  'PUT /api/suppliers/:id': { name: 'Matrix supplier', type: 'saas' },
  'POST /api/suppliers/:id/archive': { archived: true },
  'POST /api/suppliers/:id/merge': { into: fx.supplierUnconfirmed },
  'POST /api/suppliers/:id/contacts': { name: 'Matrix contact' },
  'PUT /api/suppliers/:id/contacts/:contactId': { name: 'Matrix contact', role: 'support' },
  'POST /api/suppliers/:id/contracts': { title: 'Matrix contract' },
  'PUT /api/suppliers/:id/contracts/:contractId': { title: 'Matrix contract', noticeDays: 30 },
  'PUT /api/suppliers/:id/contracts/:contractId/services/:serviceId': { purpose: 'Matrix purpose' },
  'POST /api/suppliers/:id/certificates': { kind: 'iso27001' },
  'PUT /api/suppliers/:id/certificates/:certificateId': { kind: 'iso27001', validUntil: '2030-01-01' },
  'PUT /api/settings/plant': { enabled: true, enterprise: '', labels: {}, fields: {} },
  'PUT /api/settings/modules/:id': { enabled: true },
  'PUT /api/settings/plant/map': { source: 'osm' },
  'POST /api/settings/plant/map/check': { kind: 'raster', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' },
  'POST /api/plant/sites': { id: 'matrix-new', name: 'Matrix new site' },
  'PUT /api/plant/sites/:siteId': { name: 'Matrix site' },
  'PUT /api/plant/sites/:siteId/access': { acl: [] },
  'POST /api/plant/sites/:siteId/nodes': { id: 'matrix-new-node', level: 'area', name: 'New area' },
  'PUT /api/plant/sites/:siteId/nodes/:nodeId': { name: 'Matrix area' },
  'POST /api/plant/sites/:siteId/buildings': { id: 'matrix-new-building', name: 'New building' },
  'PUT /api/plant/sites/:siteId/buildings/:buildingId': { name: 'Matrix building' },
  'POST /api/plant/sites/:siteId/links': { url: 'https://cmdb.example.com/9', label: 'x' },
  'PATCH /api/plant/sites/:siteId/links/:linkId': { note: 'x' },
  'POST /api/plant/assets': { id: 'matrix-new-asset', siteId: 'matrix-site', name: 'New asset' },
  'PUT /api/plant/assets/:assetId': { siteId: 'matrix-site', name: 'Matrix asset', areaId: 'matrix-area' },
  'POST /api/plant/assets/:assetId/links': { url: 'https://cmdb.example.com/9', label: 'x' },
  'PATCH /api/plant/assets/:assetId/links/:linkId': { note: 'x' },
  'POST /api/plant/import/preview': { files: [{ name: 'm.yaml', content: 'version: 1\nsites: []\n' }], mode: 'add' },
  'POST /api/plant/assets/:assetId/collections': { id: 'matrix-new-collection', name: 'New collection', collector: { kind: 'job', ref: 'matrix-job' } },
  'PUT /api/plant/assets/:assetId/collections/:collectionId': { name: 'Matrix collection', collector: { kind: 'job', ref: 'matrix-job' } },
  'POST /api/plant/assets/:assetId/collections/import/preview': {
    collector: { kind: 'job', ref: 'matrix-job' },
    files: [{ name: 'm.csv', content: 'collection,source_address,output_name\nc,ns=2;s=X,x\n' }],
  },
  'POST /api/plant/assets/:assetId/collections/import': {
    collector: { kind: 'job', ref: 'matrix-job' },
    files: [{ name: 'm.csv', content: 'collection,source_address,output_name\nc,ns=2;s=X,x\n' }],
  },
  'POST /api/plant/profiles': { id: 'matrix-new-profile', name: 'New profile' },
  'PUT /api/plant/profiles/:profileId': { name: 'Matrix profile' },
  'POST /api/plant/kpis': { id: 'matrix-new-kpi', name: 'New KPI' },
  'PUT /api/plant/kpis/:kpiId': { name: 'Matrix KPI' },
  'PUT /api/plant/assets/:assetId/assignment': { profileId: 'matrix-profile' },
  'POST /api/plant/profiles/:profileId/duplicate': { name: 'Matrix profile copy', key: 'matrix-profile-copy' },
  'POST /api/plant/kpis/:kpiId/duplicate': { name: 'Matrix KPI copy', key: 'matrix-kpi-copy' },
  'POST /api/plant/import': { files: [{ name: 'm.yaml', content: 'version: 1\nsite:\n  id: matrix-site\n  name: Matrix site\n' }], mode: 'update' },
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
  'POST /api/costs/plans/:serviceId/lines': { fiscalYear: 2030, title: 'Matrix line x', category: 'other', amount: '1', currency: 'EUR', cadence: 'monthly' },
  'PUT /api/costs/plans/:serviceId/lines/:lineId': { title: 'Matrix line', category: 'other', amount: '100', currency: 'EUR', cadence: 'monthly' },
  'POST /api/costs/plans/:serviceId/copy': { fiscalYear: 2030 },
  'POST /api/costs/plans/:serviceId/entries': { date: '2030-05-01', amount: '1', currency: 'EUR' },
  'PUT /api/costs/plans/:serviceId/entries/:entryId': { date: new Date().toISOString().slice(0, 10), amount: '10', currency: 'EUR' },
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
  'PUT /api/me/notification-prefs': {
    quietHours: { enabled: false, timeZone: 'UTC', windows: [], allDay: [], urgentBreaksThrough: true },
    digests: { timeZone: 'UTC', groups: {} },
  },
  'PUT /api/settings/quiet-hours': { allowed: true },
  'PUT /api/me/teams-personal': { events: [] },
  'PUT /api/me/notification-opt-ins': { events: [] },
  'PUT /api/settings/teams-bot': { enabled: false, appId: '', tenantIds: [], providerId: null, credential: 'secret' },
  'POST /api/report-schedules': REPORT_SCHEDULE,
  'PUT /api/report-schedules/:id': REPORT_SCHEDULE,
  'POST /api/dashboards': { text: 'name: Matrix\nwidgets: []\n' },
  'PUT /api/dashboards/:id': { text: 'name: x\nwidgets: []\n' },
  'PUT /api/users/:id': { roles: ['admin'] },
  'POST /api/users': { username: 'mallory', roles: ['admin'], password: 'Mallory-password-1' },
  'POST /api/teams': { name: 'team x', members: [] },
  'PUT /api/teams/:id': { name: 'team y', members: ['vera'] },
  'PUT /api/teams/:id/settings': { channel: null },
  'POST /api/teams/:id/settings/logo': { contentBase64: 'bm90IGFuIGltYWdl' },
  'PUT /api/me/new-resource-teams': { teamId: null },
  'POST /api/oauth/authorize': { request: { response_type: 'code', client_id: 'mcpc_matrix', redirect_uri: 'http://127.0.0.1:1/cb' }, approve: false },
  'PUT /api/settings/mcp-oauth': { dynamicRegistration: true },
  'POST /api/settings/mcp-oauth/clients': { name: 'Matrix', redirectUris: ['http://127.0.0.1:1/cb'] },
  'POST /api/me/tokens': { name: 'x', scope: 'full' },
  'PUT /api/settings': { outboundPolicy: 'open' },
  'PUT /api/settings/instance': { outboundPolicy: 'open' },
  'PUT /api/audit/anchoring': { emailRecipients: [] },
  'PUT /api/audit/archive': { archive: false, upload: false, retentionDays: 0 },
  'PUT /api/credentials/settings': {},
  'POST /api/vault/passphrase': { current: 'correct horse battery', next: 'correct horse battery 2' },
  'POST /api/vault/unlock': { passphrase: 'correct horse battery' },
  'POST /api/platform-types': { fromPlatformId: fx.platform },
  'POST /api/record-types': { key: 'XX', name: 'x', workflow: 'decision' },
  'PUT /api/mcp-server': { enabled: true },
  'PUT /api/platforms/:id/mcp-gateway': { enabled: true },
  'PUT /api/platforms/:id/ai': { models: [] },
  'PUT /api/platforms/:id/database': { dialect: 'postgresql', host: 'db.example.com', database: 'shop' },
  'PUT /api/ai/budgets': { scope: 'installation', scopeId: '', tokensPerDay: 100, tokensPerMonth: null },
  'POST /api/settings/notifications/test': { channel: 'email', to: 'it@example.com' },
  'PUT /api/settings/notifications/look': { name: 'Matrix' },
  'POST /api/settings/notifications/look/preview': { name: 'Matrix' },
  'POST /api/tasks/:id/complete': { approved: true },
  'POST /api/tasks/:id/verify': { approved: true },
  'POST /api/sync-sources': SYNC_SOURCE,
  'PUT /api/sync-sources/:id': SYNC_SOURCE,
  'POST /api/library-publishers': { id: 'matrix-publisher-2', name: 'Matrix publisher 2' },
  'PUT /api/library-publishers/:id': { name: 'Matrix publisher', libraries: ['matrix-library'] },
  'POST /api/library-publishers/:id/keys': { key: MATRIX_KEY_2.line },
  'PUT /api/library-keys/:id': { expiresAt: '2098-01-01' },
  'POST /api/library-keys/:id/revoke': { reason: 'matrix' },
  'POST /api/libraries/:library/hold': { held: true },
  'POST /api/library-releases/upload': { fileName: 'x.zip', content: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' },
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
  'POST /api/mcp-requests/:requestId/decision': { approve: false },
  'POST /api/status-pages': { title: 'Matrix page', serviceIds: [fx.service] },
  'PUT /api/status-pages/:pageId': { title: 'Matrix page', serviceIds: [fx.service] },
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
  // the matrix calls every route without credentials within a minute; each refusal counts against the address,
  // and there are more routes than the default limit (600 a minute) allows
  s = await startTestServer();
  await setEnv({ SM_RATE_LIMIT_PER_MINUTE: '10000' });
  await setup(s);
  // the plant registry module on (#218): in demo mode it loads its example enterprise with the demo data
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: '', labels: {}, fields: {} });
  // the map of sites on (#234): OpenStreetMap, in demo mode the mock tile source of this server
  await s.api('PUT', '/settings/plant/map', {
    source: 'osm',
    own: { kind: 'raster', url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: 'Example tiles' },
  });
  await s.api('POST', '/demo/setup', {});
  await allowEmailDomains(s, ['example.com']);
  // a plant viewer (#218): the demo has none
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: USERS.plant, roles: ['plant'], password: PW });
  const a = s.api;
  // an AI budget, so raising it is a sensitive change (STEP_UP)
  await a('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: 1000, tokensPerMonth: null });
  await a('POST', '/plant/sites', { id: 'matrix-site', name: 'Matrix site' });
  await a('POST', '/plant/sites/matrix-site/buildings', { id: 'matrix-building', name: 'Matrix building' });
  await a('POST', '/plant/sites/matrix-site/nodes', { id: 'matrix-area', level: 'area', name: 'Matrix area' });
  await a('POST', '/plant/assets', { id: 'matrix-asset', siteId: 'matrix-site', name: 'Matrix asset', areaId: 'matrix-area' });
  // part 2 (#219): a device profile with one data point, a KPI definition, the asset's assignment
  await a('POST', '/plant/profiles', {
    id: 'matrix-profile',
    name: 'Matrix profile',
    interfaces: [{ id: 'opc', protocol: 'opc_ua', groups: [{ name: 'State', dataPoints: [{ id: 'matrix_point', name: 'Point', address: 'ns=2;s=X' }] }] }],
  });
  await a('POST', '/plant/kpis', { id: 'matrix-kpi', name: 'Matrix KPI', inputs: [{ profile: 'matrix-profile', dataPoints: ['matrix_point'] }] });
  await a('PUT', '/plant/assets/matrix-asset/assignment', { profileId: 'matrix-profile', interfaces: [{ interface: 'opc' }] });
  // 0.11.0: a data collection of the asset
  await a('POST', '/plant/assets/matrix-asset/collections', {
    id: 'matrix-collection',
    name: 'Matrix collection',
    collector: { kind: 'job', ref: 'matrix-job' },
    items: [{ address: 'ns=2;s=X', outputName: 'x', dataPoint: 'matrix_point' }],
    // 0.14: a sink (not Insights Hub: its mapping reads, a change is refused)
    sinks: [{ id: 'matrix-sink', name: 'Matrix sink', kind: 'other', ref: 'matrix-broker' }],
  });
  // 0.12: a kept file of a collection import (secrets removed), as an import writes it
  (await import('../src/db.js')).db().run(
    `INSERT INTO plant_collection_sources (id, asset_id, collector_key, collector, version, file_name, format, sha256, size, content, redacted_sha256,
         redacted_paths, collections, imported_by, imported_at) VALUES ('pcs_matrix', 'matrix-asset', 'job:matrix-job', '{"kind":"job","ref":"matrix-job","host":null}',
         1, 'matrix.csv', 'table', 'x', 1, 'a,b', 'y', '[]', '["matrix-collection"]', 'admin', '2026-01-01T00:00:00.000Z')`,
  );
  await a('PUT', '/plant/assets/matrix-asset/image', { contentBase64: tinyPng().toString('base64') });
  // 0.13.0: a proposed change set that removes two entries (applying it asks for a step-up)
  const changeSet = (await a('POST', '/plant/change-sets', { title: 'Matrix changes', current: false })).id;
  await a('POST', `/plant/change-sets/${changeSet}/operations`, { op: 'remove', kind: 'building', scope: 'matrix-site', id: 'matrix-building', value: {} });
  await a('POST', `/plant/change-sets/${changeSet}/operations`, { op: 'remove', kind: 'node', scope: 'matrix-site', id: 'matrix-area', value: {} });
  await a('POST', `/plant/change-sets/${changeSet}/propose`, {});
  // 0.14: a security advisory (uploaded; it matches no asset) and an advisory source that is never read
  const advisory = (
    await a('POST', '/plant/advisories/upload', {
      content: JSON.stringify({
        document: {
          category: 'csaf_security_advisory',
          csaf_version: '2.0',
          publisher: { category: 'vendor', name: 'Matrix Vendor', namespace: 'https://psirt.matrix.example' },
          title: 'Matrix advisory',
          tracking: {
            id: 'MATRIX-1',
            version: '1',
            status: 'final',
            initial_release_date: '2026-01-01T00:00:00Z',
            current_release_date: '2026-01-01T00:00:00Z',
            revision_history: [{ date: '2026-01-01T00:00:00Z', number: '1', summary: 'x' }],
          },
        },
      }),
    })
  ).advisory.id;
  const advisorySource = (await a('POST', '/plant/advisory-sources', { name: 'Matrix source', url: 'https://csaf.matrix.example/provider-metadata.json' })).id;
  const siteLink = (await a('POST', '/plant/sites/matrix-site/links', { url: 'https://cmdb.example.com/4', label: 'x' })).id;
  const assetLink = (await a('POST', '/plant/assets/matrix-asset/links', { url: 'https://cmdb.example.com/5', label: 'x' })).id;
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
  const component = (
    await a('POST', `/applications/${application.id}/components`, {
      type: 'repository',
      name: 'matrix component',
      stack: [{ product: 'nodejs', version: '24' }],
    })
  ).components[0];
  QUERY['GET /api/catalogue/versions/entry'] = `?holder=component&id=${component.id}&product=nodejs`;
  QUERY['GET /api/suppliers/scoped-contacts'] = `?kind=application&id=${application.id}`;
  await a('PUT', `/services/${svc.id}/applications/${application.id}`, { role: 'primary' });
  const system = await a('POST', '/systems', { name: 'Matrix system', kind: 'server' });
  // a supplier with a contact, a contract and a certificate, and one waiting for confirmation (0.17.0)
  const supplier = await a('POST', '/suppliers', { name: 'Matrix supplier', type: 'saas' });
  const supplierContact = (await a('POST', `/suppliers/${supplier.id}/contacts`, { name: 'Matrix contact' })).contacts[0].id;
  const supplierContract = (await a('POST', `/suppliers/${supplier.id}/contracts`, { title: 'Matrix contract' })).contracts[0].id;
  const supplierCertificate = (await a('POST', `/suppliers/${supplier.id}/certificates`, { kind: 'iso27001' })).certificates[0].id;
  const systemLink = (await a('POST', `/applications/${application.id}/systems`, { systemId: system.id, environment: 'dev' })).systems[0];
  const catalogueMaintenance = await a('POST', '/maintenance-windows', {
    title: 'Matrix maintenance',
    startsAt: '2030-01-01T02:00:00Z',
    endsAt: '2030-01-01T04:00:00Z',
    targets: [{ kind: 'service', id: svc.id }],
  });
  const gw = await a('POST', '/monitor-gateways', { name: 'Matrix gateway', allowedKeys: ['test.*'] });
  const team = await a('POST', '/teams', { name: 'Matrix team', members: [] });
  // a supplier of that team (ADR 0031): merging it into one of the whole instance widens who sees it
  const supplierTeam = (await a('POST', '/suppliers', { name: 'Matrix team supplier', type: 'saas' })).id as string;
  await a('PUT', `/owning-teams/supplier/${supplierTeam}`, { teamIds: [team.id] });
  // #195: a team of the administrator that owns a service, application, system, credential, ticket reference and
  // incident review (with a measure), a duty and a finding of its service, and a contract of the team's supplier
  const owners = await a('POST', '/teams', { name: 'Matrix owners', members: ['admin'] });
  const owned = async (kind: string, path: string, body: unknown) => {
    const made = await a('POST', path, body);
    await a('PUT', `/owning-teams/${kind}/${made.id}`, { teamIds: [owners.id] });
    return made.id as string;
  };
  const reviewTeam = await owned('record', '/records', { type: 'PIR', title: 'Matrix team review' });
  const findingTeamService = await owned('service', '/services', { name: 'Matrix team service', owners: [] });
  const findingTeam = (
    await a('POST', '/compliance/corrective-actions', { title: 'Matrix team finding', source: 'internalAudit', serviceId: findingTeamService })
  ).id as string;
  const teamFixtures = {
    ownersTeam: owners.id as string,
    serviceTeam: findingTeamService,
    applicationTeam: await owned('application', '/applications', { name: 'Matrix team application', owners: [] }),
    systemTeam: await owned('system', '/systems', { name: 'Matrix team system', kind: 'server' }),
    credentialTeam: await owned('credential', '/credentials', { ...CREDENTIAL, name: 'Matrix team credential' }),
    ticketTeam: await owned('ticket', '/ticket-references', { ...TICKET, externalNumber: 'INC-MATRIX-T', title: 'Matrix team ticket' }),
    reviewTeam,
    measureTeam: (await a('POST', `/records/${reviewTeam}/measures`, { title: 'Matrix team measure', owners: ['user:admin'], dueDate: '2030-01-01' })).items[0]
      .id as string,
    dutyTeam: (
      await a('POST', '/duties', { serviceId: findingTeamService, name: 'Matrix team duty', processId: proc.id, interval: 'monthly', level: 'mandatory' })
    ).id as string,
    findingTeam,
    actionTeam: (
      await a('POST', `/compliance/corrective-actions/${findingTeam}/actions`, { title: 'Matrix team action', owners: ['user:admin'], dueDate: '2030-01-01' })
    ).actions[0].id as string,
    contractTeam: (await a('POST', `/suppliers/${supplierTeam}/contracts`, { title: 'Matrix team contract', owners: ['team:matrix owners'] })).contracts.find(
      (c: { title: string }) => c.title === 'Matrix team contract',
    ).id as string,
    // a platform of another team (security review 0.19.0 M1): covering it gives that team the contract
    platformOutside: await (async () => {
      const id = (await a('POST', '/platforms', { name: 'Matrix outside platform', kind: 'rest', baseUrl: 'https://matrix-outside.example' })).id as string;
      await a('PUT', `/owning-teams/platform/${id}`, { teamIds: [team.id] });
      return id;
    })(),
  };
  const report = await a('POST', `/runs/${run.id}/reports`, {});
  const users = await a('GET', '/users');
  const syncSource = (
    await a('POST', '/sync-sources', { ...SYNC_SOURCE, repoUrl: `${s.base}/mock/git/steward/library`, folder: 'steward', kinds: ['dashboard'] })
  ).source.id;
  await a('POST', `/sync-sources/${syncSource}/fetch`);
  const syncUpdate = (await a('GET', `/sync-updates?sourceId=${syncSource}`))[0].id;
  // a library (#238): a trusted publisher limited to matrix-library, its key valid until 2099, release 1.0.0 installed and 1.1.0 staged
  await a('POST', '/library-publishers', { id: 'matrix-publisher', name: 'Matrix publisher', libraries: ['matrix-library'] });
  const libraryKey = (await a('POST', '/library-publishers/matrix-publisher/keys', { key: MATRIX_KEY.line, expiresAt: '2099-01-01' })).id;
  const libSpec = {
    library: 'matrix-library',
    publisher: 'matrix-publisher',
    items: { 'processes/n.yaml': NOTIFY_OWNER.replace('notify-owner', 'matrix-lib-proc') },
    references: { platforms: [] },
  };
  const lib1 = await a('POST', '/library-releases/upload', await uploadBody(await signedRelease(MATRIX_KEY, libSpec)));
  await a('POST', `/library-releases/${lib1.id}/install`, {});
  const libraryRelease = (await a('POST', '/library-releases/upload', await uploadBody(await signedRelease(MATRIX_KEY, { ...libSpec, release: '1.1.0' })))).id;
  fx = {
    process: proc.id,
    run: run.id,
    step: String(run.steps[0].id),
    node: run.steps[0].stepId,
    platform: plat.id,
    // a read-only identity of the platform (0.13.0, ADR 0009)
    identity: (await a('POST', `/platforms/${plat.id}/identities`, { name: 'Matrix read only', readOnly: true })).id,
    // a privileged identity of the platform (0.14.0, ADR 0009 step 4): naming it asks for a step-up
    privIdentity: (await a('POST', `/platforms/${plat.id}/identities`, { name: 'Matrix privileged', privileged: true })).id,
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
    supplier: supplier.id,
    supplierContact,
    supplierContract,
    supplierCertificate,
    supplierUnconfirmed: supplier.id,
    supplierTeam,
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
    library: 'matrix-library',
    libraryRelease,
    libraryPublisher: 'matrix-publisher',
    libraryKey,
    site: 'matrix-site',
    asset: 'matrix-asset',
    plantNode: 'matrix-area',
    building: 'matrix-building',
    changeSet,
    advisory,
    advisorySource,
    siteLink,
    assetLink,
    ...teamFixtures,
  };
  QUERY['GET /api/backlinks'] = `?kind=record&id=${rec.id}`;
  QUERY['GET /api/runs/compare'] = `?a=${run.id}&b=${run.id}`;
  // database schemas (#222): a read of the demo database platform, a tbls import for the matrix system
  fx.dbPlatform = platforms.find((p: { kind: string }) => p.kind === 'database').id;
  fx.connectPlatform = platforms.find((p: { kind: string }) => p.kind === 'kafka-connect').id;
  fx.confluentPlatform = platforms.find((p: { kind: string }) => p.kind === 'confluent-cloud').id;
  // changedetection.io (#242): the demo platform, read by the demo setup
  fx.cdPlatform = platforms.find((p: { kind: string }) => p.kind === 'changedetection').id;
  // a cost budget (#226), so raising it is a sensitive change (STEP_UP)
  await a('PUT', '/costs/budgets', { scope: 'service', scopeId: fx.service, amount: '1000', currency: 'USD' });
  // a cost plan line and an entry of the matrix service (ADR 0026)
  const planYear = (await a('GET', `/costs/plans/${fx.service}`)).fiscalYear as number;
  fx.planLine = (
    await a('POST', `/costs/plans/${fx.service}/lines`, {
      fiscalYear: planYear,
      title: 'Matrix line',
      category: 'other',
      amount: '100',
      currency: 'EUR',
      cadence: 'monthly',
    })
  ).lines[0].id;
  fx.planEntry = (
    await a('POST', `/costs/plans/${fx.service}/entries`, { date: new Date().toISOString().slice(0, 10), amount: '10', currency: 'EUR' })
  ).entries[0].id;
  const dbSnap = (await a('POST', `/db-schemas/platform/${fx.dbPlatform}/read`)).snapshot.id;
  const tbls = JSON.stringify({
    name: 'matrix',
    tables: [{ name: 'public.t', type: 'BASE TABLE', columns: [{ name: 'id', type: 'integer', nullable: false }] }],
  });
  const sysSnap = (await a('POST', `/db-schemas/system/${system.id}/import`, { schema: tbls })).snapshot.id;
  QUERY['GET /api/db-schemas/:kind/:id/compare'] = `?from=${dbSnap}&to=${dbSnap}`;
  // data contracts (#221): the demo's orders contract and its first test run
  const contract = (await a('GET', '/data-contracts')).find((c: { key: string }) => c.key === 'shop-orders');
  fx.contract = contract.id;
  fx.contractRun = contract.lastRun.id;
  QUERY['GET /api/data-contracts/:id/compare'] = '?from=1&to=1';
  QUERY['GET /api/v1/platforms/:platformId/schema/compare'] = `?from=${dbSnap}&to=${dbSnap}`;
  QUERY['GET /api/v1/systems/:systemId/schema/compare'] = `?from=${sysSnap}&to=${sysSnap}`;
  QUERY['GET /api/access/explain'] = `?kind=process&id=${fx.process}`;
  QUERY['GET /api/costs/schedules'] = `?serviceId=${fx.service}`;
  const vaultPlatform = (await a('GET', '/platforms')).find((p: { kind: string }) => p.kind === 'privilege-vault').id;
  QUERY['GET /api/credentials/vault-secrets'] = `?platformId=${vaultPlatform}&q=`;
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
    statusPage: (await a('POST', '/status-pages', { title: 'Matrix status', serviceIds: [svc.id] })).id,
  });
  // corrective actions (ADR 0029): a finding of the matrix service with an action of the administrator, a suggestion
  const caFinding = await a('POST', '/compliance/corrective-actions', { title: 'Matrix finding', source: 'internalAudit', serviceId: svc.id });
  const caWithAction = await a('POST', `/compliance/corrective-actions/${caFinding.id}/actions`, {
    title: 'Matrix action',
    owners: ['user:admin'],
    dueDate: '2030-01-01',
  });
  {
    const { db } = await import('../src/db.js');
    db().run(
      `INSERT INTO ca_suggestions (id, source, source_key, title, severity, occurred_at, status, created_at)
       VALUES ('cas_matrix', 'duty', 'matrix:duty', 'Matrix suggestion', 'minor', ?, 'pending', ?)`,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
  Object.assign(fx, { correctiveFinding: caFinding.id, correctiveAction: caWithAction.actions[0].id, correctiveSuggestion: 'cas_matrix' });
  // statement of applicability (ADR 0029 part 2): the SoA of the control's catalogue with one approved version
  {
    const soa = await a('POST', '/compliance/soa', { catalogueId: fx.catalogue, scopeServiceIds: [svc.id] });
    const { db } = await import('../src/db.js');
    db().run(
      `INSERT INTO soa_versions (id, soa_id, number, status, content, content_sha256, submitted_at, submitted_by, decided_at, decided_by)
       VALUES ('soav_matrix', ?, 1, 'approved', '{"entries":[]}', ?, ?, 'admin', ?, 'adam')`,
      soa.id,
      // the SHA-256 of the content: it is checked before an export (security review 0.17.0)
      (await import('../src/util.js')).sha256('{"entries":[]}'),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
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
  await setEnv({ SM_RATE_LIMIT_PER_MINUTE: undefined });
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
      Object.fromEntries([...Object.entries(STEP_UP).map(([k, v]) => [k, v === 'always' ? 'always' : 'rule']), ...STEP_UP_BY_POLICY.map((k) => [k, 'policy'])]),
    );
    // a session of its own that is not confirmed (a sign-in counts as a confirmation: ended here)
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const ended = await fetch(`${s.base}/api/auth/step-up`, { method: 'DELETE', headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
    expect(ended.status).toBe(200);
    // the administrator's new resources go to "Matrix owners" (#195: naming vera on a new item grants across teams)
    const choose = async (teamId: string | null) =>
      fetch(`${s.base}/api/me/new-resource-teams`, {
        method: 'PUT',
        headers: { 'x-sm-client': '1', 'content-type': 'application/json', ...authHeaders(cookie) },
        body: JSON.stringify({ teamId }),
      });
    expect((await choose(fx.ownersTeam!)).status).toBe(200);
    const send = async (headers: Record<string, string>, k: string, body: unknown, query = '') => {
      const [method, url] = k.split(' ') as [string, string];
      const send = method !== 'DELETE' && method !== 'GET';
      const rule = STEP_UP[k];
      const res = await fetch(s.base + (rule !== 'always' && rule?.path ? rule.path() : fill(url)) + query, {
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
      const query = rule === 'always' ? '' : (rule.query?.sensitive ?? '');
      const asSession = await send(authHeaders(cookie), k, body, query);
      if (asSession.status !== 403 || asSession.code !== 'STEP_UP_REQUIRED') problems.push(`${k} unconfirmed session: ${asSession.status} ${asSession.code}`);
      const asToken = await send({ authorization: `Bearer ${fullAdminToken}` }, k, body, query);
      if (asToken.status !== 403) problems.push(`${k} full API token: ${asToken.status} ${asToken.code}`);
      if (rule !== 'always') {
        const harmless = await send(authHeaders(cookie), k, rule.harmless, rule.query?.harmless ?? '');
        if (harmless.code === 'STEP_UP_REQUIRED') problems.push(`${k} harmless change: asks for a step-up`);
      }
    }
    expect((await choose(null)).status).toBe(200);
    expect(problems).toEqual([]);
  });

  it('keeps identity, vault and sign-in settings to signed-in sessions (no API tokens)', async () => {
    const b = bodies();
    const problems: string[] = [];
    const { routeAccess } = await import('../src/app.js');
    const declared = Object.entries(routeAccess(s.app)).filter(([, a]) => a.auth === 'session');
    expect(declared.map(([k]) => k).sort(), 'routes declaring config.access.auth "session"').toEqual([...SESSION_ONLY].sort());
    for (const k of SESSION_ONLY) {
      expect(EXPECT[k], k).toBeDefined();
      const [method, url] = k.split(' ') as [string, string];
      const status = await call({ bearer: fullAdminToken }, method, fill(url), b[k] ?? {});
      if (status !== 403) problems.push(`${k}: ${status}`);
    }
    expect(problems).toEqual([]);
  });
  it('declares on each route the access this table expects (#16)', async () => {
    const { routeAccess } = await import('../src/app.js');
    const declared = routeAccess(s.app);
    const problems: string[] = [];
    for (const r of routes) {
      const k = key(r);
      const want = EXPECT[k];
      const a = declared[k];
      if (!a || want === undefined) continue;
      // the public API (/api/v1) authenticates itself; its open parts (health, OpenAPI) count as public above
      if (a.auth !== 'api' && (want === PUBLIC) !== (a.auth === 'public')) problems.push(`${k}: declared ${a.auth}, expected ${String(want)}`);
      if (want === HOOK && a.auth !== 'hook' && a.auth !== 'api') problems.push(`${k}: declared ${a.auth}, expected hook`);
      if (!Array.isArray(want) || a.auth === 'api') continue;
      // a status viewer reaches exactly the routes that say so
      if (want.includes('status') !== a.statusViewer) problems.push(`${k}: statusViewer ${a.statusViewer}, expected ${want.includes('status')}`);
      // declared roles may not shut out a role the table lets in
      if (a.roles) for (const role of want) if (!a.roles.includes(role)) problems.push(`${k}: declares roles ${a.roles.join(',')} but ${role} is allowed`);
    }
    expect(problems).toEqual([]);
  });

  it('refuses callers by the declared access before reading the body (#16)', async () => {
    const { routeAccess } = await import('../src/app.js');
    const declared = routeAccess(s.app);
    // a body that cannot be parsed: answered 400 if it were read first
    const send = async (headers: Record<string, string>, method: string, url: string) => {
      const res = await fetch(s.base + fill(url), {
        method,
        headers: { 'x-sm-client': '1', 'content-type': 'application/json', ...headers },
        body: '{"broken":',
      });
      await res.arrayBuffer();
      return res.status;
    };
    const problems: string[] = [];
    let checked = 0;
    for (const r of routes) {
      const a = declared[key(r)];
      if (!a || r.method === 'GET' || r.method === 'DELETE' || a.auth === 'api' || a.auth === 'public' || a.auth === 'hook') continue;
      const anonymous = await send({}, r.method, r.url);
      // 429: the address has used up its refusals (rateLimits.ts) – refused before the body as well
      if (anonymous !== 401 && anonymous !== 429) problems.push(`${key(r)} anonymous: ${anonymous}`);
      if (a.roles && !a.roles.includes('designer')) {
        const status = await send(authHeaders(cookies.designer), r.method, r.url);
        if (status !== 403) problems.push(`${key(r)} as designer: ${status}`);
        checked++;
      }
      if (a.auth === 'session') {
        const status = await send({ authorization: `Bearer ${fullAdminToken}` }, r.method, r.url);
        if (status !== 403) problems.push(`${key(r)} API token: ${status}`);
      }
      const asStatus = await send(authHeaders(cookies.status), r.method, r.url);
      if (!a.statusViewer && asStatus !== 403) problems.push(`${key(r)} as status viewer: ${asStatus}`);
    }
    expect(checked, 'routes with declared roles were tried').toBeGreaterThan(20);
    expect(problems).toEqual([]);
  }, 120_000);
});
