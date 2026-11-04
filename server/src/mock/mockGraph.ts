import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * A simulated Microsoft Graph with the Entra ID sign-in for demo mode and tests (v0.5.0): the read endpoints Steward
 * uses, in Graph's shapes, at /mock/graph (like https://graph.microsoft.com) and the token endpoint at
 * /mock/graph/login/<tenant>/oauth2/v2.0/token (like https://login.microsoftonline.com).
 *
 *   POST /login/<tenant>/oauth2/v2.0/token   client credentials: client_id + client_secret, or a client assertion
 *                                            signed with a registered certificate (setGraphCertificate)
 *   GET  /v1.0/organization, /v1.0/users, /v1.0/groups[/<id>/members|transitiveMembers|owners]
 *   GET  /v1.0/roleManagement/directory/roleDefinitions|roleAssignments|roleEligibilityScheduleInstances
 *   GET  /v1.0/servicePrincipals[/<id>/appRoleAssignedTo], /v1.0/applications
 *   GET  /v1.0/reports/authenticationMethods/userRegistrationDetails, /v1.0/admin/serviceAnnouncement/healthOverviews
 *
 * Lists serve at most three items per page (@odata.nextLink with $skiptoken), so paging is exercised; the second page
 * of the users answers 429 with Retry-After once after each reset (throttling). The token carries the application
 * permissions with admin consent as its roles claim; an endpoint whose permission is missing answers 403
 * Authorization_RequestDenied, like Graph. The licence (setGraphLicence) decides whether sign-in activity and MFA
 * registration (P1) and PIM eligibility (P2) are readable. $filter knows the few expressions the templates use; other
 * filters answer 400. Nothing is ever changed – the endpoints are read-only.
 */

export const DEMO_GRAPH = {
  tenantId: '7d3c1a52-0b6e-4f39-9a1e-2c4f5e6d7a8b',
  clientId: '5f1e2d3c-4b5a-4968-8776-655443322110',
  clientSecret: 'demo-graph-client-secret',
  domain: 'example.com',
};

export const GRAPH_ROLES = [
  'User.Read.All',
  'Group.Read.All',
  'Directory.Read.All',
  'AuditLog.Read.All',
  'RoleManagement.Read.Directory',
  'Application.Read.All',
  'ServiceHealth.Read.All',
] as const;

type Licence = 'free' | 'P1' | 'P2';

interface MockUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  mail: string | null;
  otherMails: string[];
  userType: 'Member' | 'Guest';
  accountEnabled: boolean;
  createdDateTime: string;
  externalUserState: string | null;
  lastSignIn: number | null;
  mfa: boolean;
}
interface MockGroup {
  id: string;
  displayName: string;
  securityEnabled: boolean;
  groupTypes: string[];
  isAssignableToRole: boolean;
  members: string[];
  owners: string[];
}
interface MockSp {
  id: string;
  appId: string;
  displayName: string;
  tags: string[];
  appRoles: { id: string; value: string; displayName: string }[];
  assignedTo: { principalId: string; appRoleId: string }[];
}
interface MockApp {
  id: string;
  appId: string;
  displayName: string;
  passwordCredentials: { keyId: string; displayName: string; end: number; start: number }[];
  keyCredentials: { keyId: string; displayName: string; end: number; start: number; type: string; usage: string }[];
}

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const oid = (name: string) => {
  const h = crypto.createHash('sha256').update(`graph:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export const ROLE_IDS = {
  globalAdmin: '62e90394-69f5-4237-9190-012177145e10',
  userAdmin: 'fe930be7-5e62-47db-91af-98c3a49a38b1',
  appAdmin: '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3',
  securityReader: '5d6b6bb7-de71-4623-b4af-96380a352509',
};

function seed() {
  const u = (
    key: string,
    upn: string,
    displayName: string,
    o: Partial<Pick<MockUser, 'mail' | 'otherMails' | 'userType' | 'accountEnabled' | 'externalUserState' | 'mfa'>> & {
      signedIn: number | null;
      created: number;
    },
  ): MockUser => ({
    id: oid(key),
    userPrincipalName: upn,
    displayName,
    mail: o.mail === undefined ? upn : o.mail,
    otherMails: o.otherMails ?? [],
    userType: o.userType ?? 'Member',
    accountEnabled: o.accountEnabled ?? true,
    createdDateTime: at(-o.created),
    externalUserState: o.externalUserState ?? null,
    lastSignIn: o.signedIn === null ? null : Date.now() - o.signedIn * DAY,
    mfa: o.mfa ?? true,
  });
  const users = [
    u('alice', 'alice@example.com', 'Alice Admin', { signedIn: 2, created: 900 }),
    u('bob', 'bob@example.com', 'Bob Builder', { signedIn: 10, created: 700, mfa: false }),
    u('erika', 'erika.mustermann@example.com', 'Erika Mustermann', { mail: 'Erika.Mustermann@example.com', signedIn: 1, created: 500 }),
    u('max', 'max.stale@example.com', 'Max Stale', { signedIn: 200, created: 800 }),
    u('nora', 'nora.never@example.com', 'Nora Never', { signedIn: null, created: 120, mfa: false }),
    u('carl', 'carl.disabled@example.com', 'Carl Disabled', { signedIn: 60, created: 1000, accountEnabled: false }),
    u('paula', 'paula_fabrikam.example#EXT#@example.onmicrosoft.com', 'Paula Partner', {
      mail: 'paula@fabrikam.example',
      otherMails: ['paula@fabrikam.example'],
      userType: 'Guest',
      externalUserState: 'Accepted',
      signedIn: 20,
      created: 300,
    }),
    u('gary', 'gary_old-partner.example#EXT#@example.onmicrosoft.com', 'Gary Guest', {
      mail: 'gary@old-partner.example',
      userType: 'Guest',
      externalUserState: 'Accepted',
      signedIn: 400,
      created: 900,
      mfa: false,
    }),
    u('ingrid', 'ingrid_invited.example#EXT#@example.onmicrosoft.com', 'Ingrid Invited', {
      mail: 'ingrid@invited.example',
      userType: 'Guest',
      externalUserState: 'PendingAcceptance',
      signedIn: null,
      created: 45,
      mfa: false,
    }),
  ];
  const id = (key: string) => oid(key);
  const g = (key: string, displayName: string, members: string[], owners: string[], o: Partial<MockGroup> = {}): MockGroup => ({
    id: id(key),
    displayName,
    securityEnabled: true,
    groupTypes: [],
    isAssignableToRole: false,
    members: members.map(id),
    owners: owners.map(id),
    ...o,
  });
  const groups = [
    g('g-itadmins', 'IT Admins', ['alice'], ['alice'], { isAssignableToRole: true }),
    // a nested group: Contractors is a member of Developers
    g('g-dev', 'Developers', ['bob', 'max', 'carl', 'gary', 'g-contractors'], ['bob']),
    g('g-contractors', 'Contractors', ['paula'], ['bob']),
    g('g-finance', 'Finance', ['erika'], ['erika']),
    g('g-partner', 'Partner Portal Users', ['paula', 'ingrid'], []),
    g('g-all', 'All Staff', ['alice', 'bob', 'erika', 'max', 'nora'], ['alice'], { securityEnabled: false, groupTypes: ['Unified'] }),
  ];
  const sps: MockSp[] = [
    {
      id: id('sp-payroll'),
      appId: id('app-payroll'),
      displayName: 'Payroll',
      tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
      appRoles: [
        { id: id('role-approver'), value: 'Approver', displayName: 'Payroll approver' },
        { id: id('role-viewer'), value: 'Viewer', displayName: 'Payroll viewer' },
      ],
      assignedTo: [
        { principalId: id('erika'), appRoleId: id('role-approver') },
        { principalId: id('g-finance'), appRoleId: id('role-viewer') },
      ],
    },
    {
      id: id('sp-hrsync'),
      appId: id('app-hrsync'),
      displayName: 'HR Sync',
      tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
      appRoles: [],
      assignedTo: [{ principalId: id('alice'), appRoleId: '00000000-0000-0000-0000-000000000000' }],
    },
    { id: id('sp-steward'), appId: DEMO_GRAPH.clientId, displayName: 'Steward reader', tags: [], appRoles: [], assignedTo: [] },
  ];
  const cred = (key: string, displayName: string, endDays: number, startDays = -300) => ({
    keyId: id(key),
    displayName,
    end: Date.now() + endDays * DAY,
    start: Date.now() + startDays * DAY,
  });
  const apps: MockApp[] = [
    {
      id: id('appobj-payroll'),
      appId: id('app-payroll'),
      displayName: 'Payroll',
      passwordCredentials: [cred('pw-payroll', 'prod', 12)],
      keyCredentials: [{ ...cred('kc-payroll', 'CN=payroll.example.com', 200), type: 'AsymmetricX509Cert', usage: 'Verify' }],
    },
    {
      id: id('appobj-hrsync'),
      appId: id('app-hrsync'),
      displayName: 'HR Sync',
      passwordCredentials: [cred('pw-hrsync-old', 'old', -5, -370), cred('pw-hrsync-new', 'rotation 2026', 300, -60)],
      keyCredentials: [],
    },
    {
      id: id('appobj-steward'),
      appId: DEMO_GRAPH.clientId,
      displayName: 'Steward reader',
      passwordCredentials: [cred('pw-steward', 'steward', 80)],
      keyCredentials: [],
    },
    {
      id: id('appobj-legacy'),
      appId: id('app-legacy'),
      displayName: 'Legacy Reports',
      passwordCredentials: [],
      keyCredentials: [{ ...cred('kc-legacy', 'CN=legacy-reports', 3), type: 'AsymmetricX509Cert', usage: 'Verify' }],
    },
  ];
  const roleDefinitions = [
    { id: ROLE_IDS.globalAdmin, displayName: 'Global Administrator', isBuiltIn: true, isPrivileged: true },
    { id: ROLE_IDS.userAdmin, displayName: 'User Administrator', isBuiltIn: true, isPrivileged: true },
    { id: ROLE_IDS.appAdmin, displayName: 'Application Administrator', isBuiltIn: true, isPrivileged: true },
    { id: ROLE_IDS.securityReader, displayName: 'Security Reader', isBuiltIn: true, isPrivileged: false },
  ];
  const roleAssignments = [
    { id: 'ra-1', principalId: id('alice'), roleDefinitionId: ROLE_IDS.globalAdmin, directoryScopeId: '/' },
    { id: 'ra-2', principalId: id('g-itadmins'), roleDefinitionId: ROLE_IDS.userAdmin, directoryScopeId: '/' },
    { id: 'ra-3', principalId: id('sp-hrsync'), roleDefinitionId: ROLE_IDS.userAdmin, directoryScopeId: `/administrativeUnits/${id('au-hr')}` },
  ];
  const roleEligibilities = [
    { id: 're-1', principalId: id('bob'), roleDefinitionId: ROLE_IDS.appAdmin, directoryScopeId: '/' },
    { id: 're-2', principalId: id('erika'), roleDefinitionId: ROLE_IDS.securityReader, directoryScopeId: '/' },
  ];
  const health = [
    { id: 'Exchange', service: 'Exchange Online', status: 'serviceDegradation' },
    { id: 'microsoftteams', service: 'Microsoft Teams', status: 'serviceOperational' },
    { id: 'SharePoint', service: 'SharePoint Online', status: 'serviceOperational' },
  ];
  return { users, groups, sps, apps, roleDefinitions, roleAssignments, roleEligibilities, health };
}

let state = seed();
let licence: Licence = 'P2';
let consent: string[] | null = [...GRAPH_ROLES];
let throttleArmed = true;
let certificates: string[] = [];
const tokens = new Map<string, { roles: string[] | null; exp: number }>();
/** Requests seen (method path), for tests: paging and retries */
export const graphRequests: string[] = [];

/** Back to the seeded tenant: all permissions with admin consent, licence P2, the one 429 armed again, no certificates. */
export function resetGraph(): void {
  state = seed();
  licence = 'P2';
  consent = [...GRAPH_ROLES];
  throttleArmed = true;
  certificates = [];
  tokens.clear();
  graphRequests.length = 0;
}
/** The application permissions with admin consent (null: consent never granted – the token has no roles claim). */
export function setGraphConsent(roles: string[] | null): void {
  consent = roles ? [...roles] : null;
  tokens.clear();
}
export function setGraphLicence(l: Licence): void {
  licence = l;
}
/** Answer the next second page of the users with 429 once more. */
export function throttleGraphOnce(): void {
  throttleArmed = true;
}
/** A public certificate (PEM) of the app registration: client assertions signed with its key are accepted. */
export function setGraphCertificate(pem: string): void {
  certificates.push(pem);
}
/** For tests and the demo: a user added to a group (the next snapshot shows it). */
export function addGraphMember(groupName: string, upn: string): void {
  const g = state.groups.find((x) => x.displayName === groupName);
  const u = state.users.find((x) => x.userPrincipalName === upn);
  if (g && u && !g.members.includes(u.id)) g.members.push(u.id);
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function issue(reply: FastifyReply, roles: string[] | null) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = {
    aud: 'https://graph.microsoft.com',
    iss: `https://sts.windows.net/${DEMO_GRAPH.tenantId}/`,
    tid: DEMO_GRAPH.tenantId,
    appid: DEMO_GRAPH.clientId,
    exp,
    ...(roles ? { roles } : {}),
  };
  // shaped like a JWT so the client can read its claims; the mock never checks the signature of its own tokens
  const token = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.${crypto.randomBytes(16).toString('base64url')}`;
  tokens.set(token, { roles, exp });
  return reply.send({ token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: token });
}

const aadError = (reply: FastifyReply, status: number, error: string, code: string, text: string) =>
  reply.code(status).send({
    error,
    error_description: `${code}: ${text} Trace ID: 0000 Correlation ID: 0000 Timestamp: ${new Date().toISOString()}`,
    error_codes: [Number(code.slice(5))],
  });

/** The client assertion: a JWT signed with the key of a registered certificate, naming it by x5t#S256 or x5t, aud = the token endpoint. */
function assertionProblem(jwt: string, tokenUrl: string, clientId: string): [code: string, text: string] | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return ['AADSTS50027', 'JWT token is invalid or malformed.'];
  let header: Record<string, string>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return ['AADSTS50027', 'JWT token is invalid or malformed.'];
  }
  const cert = certificates
    .map((pem) => new crypto.X509Certificate(pem))
    .find(
      (c) =>
        header['x5t#S256'] === crypto.createHash('sha256').update(c.raw).digest('base64url') ||
        header.x5t === crypto.createHash('sha1').update(c.raw).digest('base64url'),
    );
  if (!cert) return ['AADSTS700027', `The certificate with identifier used to sign the client assertion is not registered on application.`];
  const alg = header.alg === 'PS256' ? { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {};
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: cert.publicKey, ...alg }, Buffer.from(parts[2]!, 'base64url'));
  if (!ok) return ['AADSTS700027', 'Client assertion failed signature validation.'];
  if (claims.aud !== tokenUrl) return ['AADSTS700016', `The audience of the client assertion is not the token endpoint.`];
  if (claims.iss !== clientId || claims.sub !== clientId) return ['AADSTS700023', 'The client assertion names another client.'];
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return ['AADSTS700024', 'Client assertion is not within its valid time range.'];
  return null;
}

const PAGE = 3;

/** The permission an endpoint needs (any of them is enough), like Graph's least-privileged permission lists. */
function needs(path: string, select: string): string[] {
  if (path.startsWith('/v1.0/users') && /signInActivity/i.test(select)) return ['AuditLog.Read.All'];
  if (path.startsWith('/v1.0/users')) return ['User.Read.All', 'Directory.Read.All'];
  if (path.startsWith('/v1.0/groups')) return ['Group.Read.All', 'Directory.Read.All'];
  if (path.startsWith('/v1.0/roleManagement')) return ['RoleManagement.Read.Directory', 'Directory.Read.All'];
  if (path.startsWith('/v1.0/servicePrincipals') || path.startsWith('/v1.0/applications')) return ['Application.Read.All', 'Directory.Read.All'];
  if (path.startsWith('/v1.0/reports')) return ['AuditLog.Read.All'];
  if (path.startsWith('/v1.0/admin/serviceAnnouncement')) return ['ServiceHealth.Read.All'];
  return ['Directory.Read.All', 'User.Read.All'];
}

const graphError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message, innerError: { date: new Date().toISOString(), 'request-id': crypto.randomUUID() } } });

type Q = Record<string, string | undefined>;

export async function mockGraph(app: FastifyInstance): Promise<void> {
  const R = '/graph';

  app.post(`${R}/login/:tenant/oauth2/v2.0/token`, async (req, reply) => {
    const { tenant } = req.params as { tenant: string };
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (tenant !== DEMO_GRAPH.tenantId && tenant !== DEMO_GRAPH.domain)
      return aadError(reply, 400, 'invalid_request', 'AADSTS90002', `Tenant '${tenant}' not found.`);
    if (b.grant_type !== 'client_credentials') return aadError(reply, 400, 'unsupported_grant_type', 'AADSTS70003', 'The grant type is not supported.');
    if (!b.scope?.endsWith('/.default')) return aadError(reply, 400, 'invalid_scope', 'AADSTS1002012', 'The provided value for scope is not valid.');
    if (b.client_id !== DEMO_GRAPH.clientId)
      return aadError(reply, 400, 'unauthorized_client', 'AADSTS700016', `Application with identifier '${b.client_id}' was not found in the directory.`);
    if (b.client_assertion) {
      const url = `${req.protocol}://${req.headers.host}${config.basePath}${req.url.split('?')[0]}`;
      const problem = assertionProblem(b.client_assertion, url, b.client_id);
      if (problem) return aadError(reply, 401, 'invalid_client', problem[0], problem[1]);
    } else if (b.client_secret !== DEMO_GRAPH.clientSecret) return aadError(reply, 401, 'invalid_client', 'AADSTS7000215', 'Invalid client secret provided.');
    return issue(reply, consent);
  });

  const auth = (req: FastifyRequest, reply: FastifyReply): { roles: string[] } | null => {
    const t = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const tok = tokens.get(t);
    if (!tok || tok.exp * 1000 < Date.now()) {
      void graphError(reply, 401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
      return null;
    }
    return { roles: tok.roles ?? [] };
  };

  /** Checks token and permission; then a page of the list with @odata.nextLink (absolute, like Graph). */
  const list = (req: FastifyRequest, reply: FastifyReply, path: string, all: () => Record<string, unknown>[], o: { premium?: Licence } = {}) => {
    const q = req.query as Q;
    graphRequests.push(`GET ${path}${q.$skiptoken ? `?$skiptoken=${q.$skiptoken}` : ''}`);
    const who = auth(req, reply);
    if (!who) return reply;
    const need = needs(path, q.$select ?? '');
    if (!need.some((r) => who.roles.includes(r)))
      return graphError(reply, 403, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.');
    if (o.premium === 'P1' && licence === 'free')
      return graphError(reply, 403, 'Authentication_RequestFromNonPremiumTenantOrB2CTenant', "Neither tenant is B2C or tenant doesn't have premium license");
    if (o.premium === 'P2' && licence !== 'P2')
      return graphError(reply, 403, 'AadPremiumLicenseRequired', 'The tenant needs to have Microsoft Entra ID P2 or Microsoft Entra ID Governance license.');
    const from = Math.max(0, Number(q.$skiptoken ?? 0) || 0);
    if (path === '/v1.0/users' && from > 0 && throttleArmed) {
      throttleArmed = false;
      return reply
        .code(429)
        .header('retry-after', '1')
        .send({ error: { code: 'TooManyRequests', message: 'Too many requests, retry after 1 second.' } });
    }
    let items: Record<string, unknown>[];
    try {
      items = all();
    } catch (e) {
      return graphError(reply, 400, 'Request_UnsupportedQuery', (e as Error).message);
    }
    const size = Math.min(PAGE, Math.max(1, Number(q.$top ?? PAGE) || PAGE));
    const value = items.slice(from, from + size);
    const body: Record<string, unknown> = { '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#${path.split('/').pop()}`, value };
    if (from + size < items.length) {
      const u = new URL(`${req.protocol}://${req.headers.host}${config.basePath}/mock/graph${path}`);
      for (const [k, v] of Object.entries(q)) if (k !== '$skiptoken' && v !== undefined) u.searchParams.set(k, v);
      u.searchParams.set('$skiptoken', String(from + size));
      body['@odata.nextLink'] = u.toString();
    }
    return reply.send(body);
  };

  const selectOf = (req: FastifyRequest) =>
    String((req.query as Q).$select ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  /** The fields asked for (all without $select), like Graph's $select. */
  const pick = (o: Record<string, unknown>, fields: string[]) => (fields.length ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o);

  const userJson = (u: MockUser): Record<string, unknown> => ({
    '@odata.type': '#microsoft.graph.user',
    id: u.id,
    userPrincipalName: u.userPrincipalName,
    displayName: u.displayName,
    mail: u.mail,
    otherMails: u.otherMails,
    userType: u.userType,
    accountEnabled: u.accountEnabled,
    createdDateTime: u.createdDateTime,
    externalUserState: u.externalUserState,
    signInActivity: {
      lastSignInDateTime: u.lastSignIn ? new Date(u.lastSignIn).toISOString() : null,
      lastNonInteractiveSignInDateTime: u.lastSignIn ? new Date(u.lastSignIn - 3600_000).toISOString() : null,
      lastSuccessfulSignInDateTime: u.lastSignIn ? new Date(u.lastSignIn).toISOString() : null,
    },
  });
  const groupJson = (g: MockGroup): Record<string, unknown> => ({
    '@odata.type': '#microsoft.graph.group',
    id: g.id,
    displayName: g.displayName,
    securityEnabled: g.securityEnabled,
    groupTypes: g.groupTypes,
    isAssignableToRole: g.isAssignableToRole,
    mailEnabled: !g.securityEnabled,
  });
  const spJson = (s: MockSp): Record<string, unknown> => ({
    '@odata.type': '#microsoft.graph.servicePrincipal',
    id: s.id,
    appId: s.appId,
    displayName: s.displayName,
    tags: s.tags,
    appRoles: s.appRoles.map((r) => ({ ...r, isEnabled: true, allowedMemberTypes: ['User'] })),
  });
  const objectJson = (id: string): Record<string, unknown> | null => {
    const u = state.users.find((x) => x.id === id);
    if (u) return userJson(u);
    const g = state.groups.find((x) => x.id === id);
    if (g) return groupJson(g);
    const s = state.sps.find((x) => x.id === id);
    return s ? spJson(s) : null;
  };

  app.get(`${R}/v1.0/organization`, async (req, reply) =>
    list(req, reply, '/v1.0/organization', () => [
      { id: DEMO_GRAPH.tenantId, displayName: 'Contoso (demo)', verifiedDomains: [{ name: DEMO_GRAPH.domain, isDefault: true }] },
    ]),
  );

  app.get(`${R}/v1.0/users`, async (req, reply) => {
    const fields = selectOf(req);
    const filter = String((req.query as Q).$filter ?? '').trim();
    return list(
      req,
      reply,
      '/v1.0/users',
      () => {
        const keep =
          filter === ''
            ? () => true
            : filter === "userType eq 'Guest'"
              ? (u: MockUser) => u.userType === 'Guest'
              : filter === "userType eq 'Member'"
                ? (u: MockUser) => u.userType === 'Member'
                : filter === 'accountEnabled eq false'
                  ? (u: MockUser) => !u.accountEnabled
                  : null;
        if (!keep) throw new Error(`Unsupported or invalid query filter clause specified for property of resource 'User': ${filter.slice(0, 80)}`);
        return state.users.filter(keep).map((u) => pick(userJson(u), fields));
      },
      fields.includes('signInActivity') ? { premium: 'P1' } : {},
    );
  });

  app.get(`${R}/v1.0/groups`, async (req, reply) => {
    const fields = selectOf(req);
    return list(req, reply, '/v1.0/groups', () => state.groups.map((g) => pick(groupJson(g), fields)));
  });

  const closure = (g: MockGroup, seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const m of g.members) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
      const nested = state.groups.find((x) => x.id === m);
      if (nested) out.push(...closure(nested, seen));
    }
    return out;
  };
  for (const rel of ['members', 'transitiveMembers', 'owners'] as const) {
    app.get(`${R}/v1.0/groups/:id/${rel}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const g = state.groups.find((x) => x.id === id);
      if (!g) {
        if (!auth(req, reply)) return reply;
        return graphError(
          reply,
          404,
          'Request_ResourceNotFound',
          `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`,
        );
      }
      const fields = selectOf(req);
      const ids = rel === 'members' ? g.members : rel === 'owners' ? g.owners : closure(g);
      return list(req, reply, `/v1.0/groups/${id}/${rel}`, () =>
        ids.map(objectJson).flatMap((o) => (o ? [{ '@odata.type': o['@odata.type'], ...pick(o, fields) }] : [])),
      );
    });
  }

  const expandRole = (req: FastifyRequest, a: { principalId: string; roleDefinitionId: string; directoryScopeId: string; id: string }) => {
    const expand = String((req.query as Q).$expand ?? '');
    return {
      ...a,
      ...(expand.includes('principal') ? { principal: objectJson(a.principalId) } : {}),
      ...(expand.includes('roleDefinition') ? { roleDefinition: state.roleDefinitions.find((r) => r.id === a.roleDefinitionId) ?? null } : {}),
    };
  };
  app.get(`${R}/v1.0/roleManagement/directory/roleDefinitions`, async (req, reply) =>
    list(req, reply, '/v1.0/roleManagement/directory/roleDefinitions', () => state.roleDefinitions),
  );
  app.get(`${R}/v1.0/roleManagement/directory/roleAssignments`, async (req, reply) =>
    list(req, reply, '/v1.0/roleManagement/directory/roleAssignments', () => state.roleAssignments.map((a) => expandRole(req, a))),
  );
  app.get(`${R}/v1.0/roleManagement/directory/roleEligibilityScheduleInstances`, async (req, reply) =>
    list(
      req,
      reply,
      '/v1.0/roleManagement/directory/roleEligibilityScheduleInstances',
      () => state.roleEligibilities.map((a) => ({ ...expandRole(req, a), memberType: 'Direct', startDateTime: at(-30), endDateTime: null })),
      { premium: 'P2' },
    ),
  );

  app.get(`${R}/v1.0/servicePrincipals`, async (req, reply) => {
    const fields = selectOf(req);
    const filter = String((req.query as Q).$filter ?? '').trim();
    return list(req, reply, '/v1.0/servicePrincipals', () => {
      if (filter && filter !== "tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')")
        throw new Error(`Unsupported query filter for servicePrincipals: ${filter.slice(0, 80)}`);
      return state.sps.filter((s) => !filter || s.tags.includes('WindowsAzureActiveDirectoryIntegratedApp')).map((s) => pick(spJson(s), fields));
    });
  });
  app.get(`${R}/v1.0/servicePrincipals/:id/appRoleAssignedTo`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const sp = state.sps.find((x) => x.id === id);
    if (!sp) {
      if (!auth(req, reply)) return reply;
      return graphError(reply, 404, 'Request_ResourceNotFound', `Resource '${id}' does not exist.`);
    }
    return list(req, reply, `/v1.0/servicePrincipals/${id}/appRoleAssignedTo`, () =>
      sp.assignedTo.map((a, i) => {
        const p = objectJson(a.principalId);
        return {
          id: `ara-${sp.id.slice(0, 4)}-${i}`,
          appRoleId: a.appRoleId,
          principalId: a.principalId,
          principalDisplayName: p?.displayName ?? null,
          principalType: p
            ? String(p['@odata.type'])
                .replace('#microsoft.graph.', '')
                .replace(/^./, (c) => c.toUpperCase())
            : 'User',
          resourceId: sp.id,
          resourceDisplayName: sp.displayName,
          createdDateTime: at(-100),
        };
      }),
    );
  });

  app.get(`${R}/v1.0/applications`, async (req, reply) => {
    const fields = selectOf(req);
    return list(req, reply, '/v1.0/applications', () =>
      state.apps.map((a) =>
        pick(
          {
            id: a.id,
            appId: a.appId,
            displayName: a.displayName,
            passwordCredentials: a.passwordCredentials.map((c) => ({
              keyId: c.keyId,
              displayName: c.displayName,
              // Graph shows the first characters of a secret as its hint; the mock's are made up
              hint: 'dmo',
              secretText: null,
              startDateTime: new Date(c.start).toISOString(),
              endDateTime: new Date(c.end).toISOString(),
            })),
            keyCredentials: a.keyCredentials.map((c) => ({
              keyId: c.keyId,
              displayName: c.displayName,
              type: c.type,
              usage: c.usage,
              key: null,
              startDateTime: new Date(c.start).toISOString(),
              endDateTime: new Date(c.end).toISOString(),
            })),
          },
          fields,
        ),
      ),
    );
  });

  app.get(`${R}/v1.0/reports/authenticationMethods/userRegistrationDetails`, async (req, reply) =>
    list(
      req,
      reply,
      '/v1.0/reports/authenticationMethods/userRegistrationDetails',
      () =>
        state.users.map((u) => ({
          id: u.id,
          userPrincipalName: u.userPrincipalName,
          userDisplayName: u.displayName,
          userType: u.userType.toLowerCase(),
          isAdmin: u.userPrincipalName === 'alice@example.com',
          isMfaRegistered: u.mfa,
          isMfaCapable: u.mfa,
          isPasswordlessCapable: false,
          methodsRegistered: u.mfa ? ['microsoftAuthenticatorPush'] : [],
          lastUpdatedDateTime: at(-1),
        })),
      { premium: 'P1' },
    ),
  );

  app.get(`${R}/v1.0/admin/serviceAnnouncement/healthOverviews`, async (req, reply) =>
    list(req, reply, '/v1.0/admin/serviceAnnouncement/healthOverviews', () => state.health),
  );

  // tests: a next page on another host (the client must not follow it)
  app.get(`${R}/v1.0/test/foreignNext`, async (req, reply) =>
    auth(req, reply) ? reply.send({ value: [{ id: 'x' }], '@odata.nextLink': 'https://graph.attacker.example/v1.0/users?$skiptoken=1' }) : reply,
  );

  // Graph is read here only: a changing call is refused (Steward never sends one)
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: `${R}/v1.0/*`,
    handler: async (_req, reply) => graphError(reply, 405, 'Request_BadRequest', 'The demo tenant is read-only.'),
  });
}
