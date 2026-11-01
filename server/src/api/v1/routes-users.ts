/** /api/v1 routes for users and teams (administrators only). */
import { currentUser } from '../../auth/context.js';
import { requireCapability } from '../../auth/permissions.js';
import * as users from '../../auth/users.js';
import { pageArray } from './pagination.js';
import * as S from './schemas.js';
import { notFound, paged, params, query, type Get } from './helpers.js';

const mapUser = (u: ReturnType<typeof users.getUser>) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  firstName: u.firstName ?? null,
  lastName: u.lastName ?? null,
  email: u.email ?? null,
  profile: u.profile,
  roles: u.roles,
  teams: u.teams,
  active: u.active,
  authSource: u.authSource,
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt,
});

export function userRoutes(get: Get): void {
  get(
    '/users',
    {
      operationId: 'listUsers',
      tag: 'Users',
      summary: 'List users',
      description: 'Administrators only. Ordered by user name.',
      query: S.UserListQuery,
      paginated: true,
      response: S.pageOf('User', 'A page of users'),
    },
    async (req, reply) => {
      requireCapability(currentUser(), 'manageUsers', 'list users');
      const q = query<{ active?: boolean; cursor?: string; limit: number }>(req);
      const list = users
        .listUsers()
        .filter((u) => q.active === undefined || u.active === q.active)
        .map(mapUser);
      return paged(
        req,
        reply,
        pageArray(list, (u) => [u.username.toLowerCase(), u.id], q, q),
      );
    },
  );

  get(
    '/users/:userId',
    {
      operationId: 'getUser',
      tag: 'Users',
      summary: 'Get a user',
      description: 'Administrators only.',
      params: { userId: 'User id' },
      response: S.ref('User'),
    },
    async (req) => {
      requireCapability(currentUser(), 'manageUsers', 'view users');
      try {
        return mapUser(users.getUser(params(req).userId!));
      } catch {
        throw notFound(`User ${params(req).userId}`);
      }
    },
  );

  get(
    '/teams',
    {
      operationId: 'listTeams',
      tag: 'Users',
      summary: 'List teams',
      description: 'Administrators only. Ordered by name.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Team', 'A page of teams'),
    },
    async (req, reply) => {
      requireCapability(currentUser(), 'manageUsers', 'list teams');
      const q = query<{ cursor?: string; limit: number }>(req);
      return paged(
        req,
        reply,
        pageArray(users.listTeams(), (t) => [t.name.toLowerCase(), t.id], q, q),
      );
    },
  );
}
