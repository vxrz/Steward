import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROLES, TEAM_ROLES, type Subject, type UserInfo, boundedRecord } from '@sm/shared';
import { audit } from '../audit.js';
import { passwordLoginMode } from '../settings.js';
import { HttpError } from '../util.js';
import { db } from '../db.js';
import * as teamSettings from '../teams/settings.js';
import { chooseNewResourceTeam, newResourceTeams } from '../auth/policy.js';
import { subjectReferences } from '../auth/subjects.js';
import * as users from '../auth/users.js';
import * as sso from '../auth/sso.js';
import { changesAccess, changesTeamMembers, grantsRoles } from '../auth/step-up-rules.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ACCESS, me } from '../auth/access.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** Users, teams and team settings (mounted under /api). */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  // ---------- users & teams ----------
  app.get('/users', { config: { access: ACCESS.admin } }, async () => {
    requireCapability(me(), 'manageUsers', 'manage users');
    return users.listUsers();
  });
  app.post('/users', { config: { access: ACCESS.adminSession, stepUp: { action: 'createUser', who: 'manageUsers', when: grantsRoles } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    const b = z
      .object({
        username: z.string().max(64),
        displayName: z.string().max(100).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        email: z.string().max(254).optional(),
        roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
        password: z.string().max(1024).optional(),
        /** A single sign-on account: no password, claimed at the first sign-in through this provider only */
        provider: z.string().max(100).optional(),
      })
      .parse(req.body);
    const { provider, ...input } = b;
    // single sign-on only: new accounts get no password and are linked by their user name at the first sign-in
    if (provider || passwordLoginMode() === 'none') {
      if (b.password) users.requirePasswordLogin('setting a password');
      return users.createUser({ ...input, password: undefined, noPassword: true, provider: claimingProvider(provider).id });
    }
    return users.createUser({ ...input, mustChangePassword: true });
  });
  /**
   * The provider that may claim a new account without a password: the one chosen, or the only enabled one. With several
   * enabled providers the choice is required – otherwise any of them could hand the account (and its roles) to whoever
   * has that user name there.
   */
  function claimingProvider(id: string | undefined): { id: string; displayName: string } {
    const enabled = sso.publicProviders();
    if (id) {
      const p = enabled.find((x) => x.id === id);
      if (!p) throw new HttpError(400, 'Choose an enabled single sign-on provider', 'SSO_PROVIDER_UNKNOWN');
      return p;
    }
    if (enabled.length === 1) return enabled[0]!;
    if (!enabled.length) throw new HttpError(400, 'Enable a single sign-on provider first', 'SSO_PROVIDER_REQUIRED');
    throw new HttpError(400, 'Choose the single sign-on provider the account signs in with', 'SSO_PROVIDER_CHOICE_REQUIRED');
  }
  app.put(
    '/users/:id',
    { config: { access: ACCESS.adminSession, stepUp: { action: 'changeAccount', who: 'manageUsers', when: changesAccess } } },
    async (req) => {
      requireCapability(me(), 'manageUsers', 'manage users');
      const b = z
        .object({
          displayName: z.string().max(100).optional(),
          firstName: z.string().max(100).optional(),
          lastName: z.string().max(100).optional(),
          email: z.string().max(254).optional(),
          roles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
          active: z.boolean().optional(),
          /** Bind a local account to a single sign-on provider (removes its password) */
          provider: z.string().max(100).optional(),
        })
        .parse(req.body);
      const { provider, ...patch } = b;
      const id = params(req).id!;
      // one transaction: a binding is not kept when the rest of the change is refused
      return db().tx(() => {
        if (provider) {
          const p = claimingProvider(provider);
          users.bindToProvider(id, p.id, p.displayName);
        }
        return Object.keys(patch).length || !provider ? users.updateUser(id, patch) : users.getUser(id);
      });
    },
  );
  // a temporary password lets the administrator sign in as that person
  app.post(
    '/users/:id/reset-password',
    { config: { access: ACCESS.adminSession, rateLimit: ROUTE_LIMITS.credential, stepUp: { action: 'resetPassword', who: 'manageUsers' } } },
    async (req) => {
      requireCapability(me(), 'manageUsers', 'manage users');
      return { temporaryPassword: users.resetPassword(params(req).id!) };
    },
  );
  app.get('/teams', { config: { access: ACCESS.admin } }, async () => {
    requireCapability(me(), 'manageUsers', 'view teams');
    return users.listTeams();
  });
  const teamBody = z.object({
    name: z.string().max(64),
    description: z.string().max(2000).optional(),
    members: z.array(z.string().max(64)).max(5000).optional(),
    /** roles in the team by member (#131) */
    memberRoles: boundedRecord(z.array(z.enum(TEAM_ROLES)).max(TEAM_ROLES.length), 5000).optional(),
  });
  // teams are subjects of access lists: a new member gets the team's rights (auth/step-up-rules.ts)
  const teamStepUp = { stepUp: { action: 'changeTeamMembers' as const, who: 'manageUsers' as const, when: changesTeamMembers } };
  app.post('/teams', { config: { ...teamStepUp, access: ACCESS.adminSession } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body));
  });
  app.put('/teams/:id', { config: { ...teamStepUp, access: ACCESS.adminSession } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body), params(req).id);
  });
  app.delete('/teams/:id', { config: { access: ACCESS.adminSession } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    users.deleteTeam(params(req).id!);
    return { ok: true };
  });
  // team settings (#136): members and administrators read them, administrators change them
  app.get('/teams/:id/settings', async (req) => teamSettings.getTeamSettings(params(req).id!, me()));
  app.put('/teams/:id/settings', { config: { access: ACCESS.adminSession } }, async (req) =>
    teamSettings.saveTeamSettings(params(req).id!, teamSettings.teamSettingsInput.parse(req.body), me()),
  );
  // the team's report logo: shown to members and administrators, changed by administrators
  app.get('/teams/:id/settings/logo', async (req, reply) => {
    teamSettings.getTeamSettings(params(req).id!, me());
    const l = teamSettings.teamLogo(params(req).id!);
    if (!l) throw new HttpError(404, 'The team has no logo of its own', 'TEAM_LOGO_MISSING');
    reply.header('cache-control', 'no-store');
    return reply.type(l.mime).send(l.data);
  });
  app.post('/teams/:id/settings/logo', { config: { access: ACCESS.adminSession }, bodyLimit: LARGE_BODIES.reportLogo.bytes }, async (req) => {
    const b = z
      .object({ contentBase64: z.string().max(LARGE_BODIES.reportLogo.bytes) })
      .strict()
      .safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, 'Upload a PNG or JPEG file', 'LOGO_TYPE');
    return teamSettings.setTeamLogo(params(req).id!, Buffer.from(b.data.contentBase64, 'base64'), me());
  });
  app.delete('/teams/:id/settings/logo', { config: { access: ACCESS.adminSession } }, async (req) => teamSettings.removeTeamLogo(params(req).id!, me()));
  // the owning teams of the resources the signed-in user creates, and their own choice (#136)
  app.get('/me/new-resource-teams', async () => newResourceTeams(me()));
  app.put('/me/new-resource-teams', async (req) => {
    const b = z
      .object({ teamId: z.string().max(100).nullable() })
      .strict()
      .parse(req.body ?? {});
    const before = newResourceTeams(me());
    const after = chooseNewResourceTeam(me(), b.teamId);
    if (before.chosen !== after.chosen)
      audit({
        action: 'user.new_resource_team_changed',
        entityType: 'user',
        entityId: me().id,
        summary: after.chosen
          ? `${me().username}'s new resources get team "${after.teams[0]?.name}"`
          : `${me().username}'s new resources get the teams' defaults again`,
        details: { from: before.chosen, to: after.chosen },
      });
    return after;
  });
  app.post('/teams/:id/settings/test', { config: { access: ACCESS.adminSession } }, async (req) => {
    teamSettings.getTeamSettings(params(req).id!, me());
    const { sendTeamTest } = await import('../notifications/service.js');
    return sendTeamTest(params(req).id!);
  });
  // where a user or team is still named, before it is deactivated or deleted (#143)
  app.get('/users/:id/references', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    return subjectReferences('user', users.getUser(params(req).id!).username);
  });
  app.get('/teams/:id/references', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    const team = users.listTeams().find((t) => t.id === params(req).id);
    if (!team) throw new HttpError(404, 'Team not found');
    return subjectReferences('team', team.name);
  });
  app.get('/subjects', async (): Promise<Subject[]> => {
    // Used by access editors and assignee pickers – not needed by read-only accounts.
    if (!me().roles.some((r) => r !== 'viewer' && r !== 'auditor')) throw new HttpError(403, 'You are not allowed to list users and teams');
    return subjectList();
  });
  const subjectList = (): Subject[] => [
    ...users
      .listUsers()
      .filter((u: UserInfo) => u.active)
      .map((u) => ({ value: `user:${u.username.toLowerCase()}`, label: `${u.displayName} (${u.username})`, kind: 'user' as const })),
    ...users.listTeams().map((t) => ({ value: `team:${t.name.toLowerCase()}`, label: `Team ${t.name}`, kind: 'team' as const, name: t.name })),
    ...ROLES.map((r) => ({ value: `role:${r}`, label: `Everyone with role ${r}`, kind: 'role' as const, name: r })),
  ];
}
