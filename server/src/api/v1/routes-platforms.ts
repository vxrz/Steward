/** /api/v1 routes for platform metadata. */
import * as platforms from '../../platforms/service.js';
import { HttpError } from '../../util.js';
import { pageArray } from './pagination.js';
import * as S from './schemas.js';
import { notFound, paged, params, query, type Get } from './helpers.js';

/** Base URL without user info, query or fragment (they could carry credentials). */
export function safeBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, raw.endsWith('/') ? '/' : '');
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//').replace(/[?#].*$/, '');
  }
}

const mapPlatform = (p: ReturnType<typeof platforms.getPlatform>) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  description: p.description ?? '',
  environment: p.environment ?? '',
  baseUrl: safeBaseUrl(p.baseUrl ?? ''),
  authType: p.config?.auth?.type ?? 'none',
  permissions: p.permissions,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export function platformRoutes(get: Get): void {
  get(
    '/platforms',
    {
      operationId: 'listPlatforms',
      tag: 'Platforms',
      summary: 'List platforms (metadata only)',
      description: 'Only platforms the token owner has some permission on. Credentials, variables and authentication settings are never returned.',
      query: S.PlatformListQuery,
      paginated: true,
      response: S.pageOf('Platform', 'A page of platforms'),
    },
    async (req, reply) => {
      const q = query<{ kind?: string; environment?: string; cursor?: string; limit: number }>(req);
      // Like the web UI: only platforms the token owner has some permission on.
      const list = platforms
        .listPlatforms()
        .filter((p) => p.permissions.length > 0)
        .filter((p) => !q.kind || p.kind === q.kind)
        .filter((p) => !q.environment || p.environment === q.environment)
        .map(mapPlatform);
      return paged(
        req,
        reply,
        pageArray(list, (p) => [p.name.toLowerCase(), p.id], q, q),
      );
    },
  );

  get(
    '/platforms/:platformId',
    {
      operationId: 'getPlatform',
      tag: 'Platforms',
      summary: 'Get a platform (metadata only)',
      params: { platformId: 'Platform id' },
      response: S.ref('Platform'),
    },
    async (req) => {
      try {
        const p = platforms.getPlatform(params(req).platformId!);
        // 404 (not 403) without any permission, so platform ids can't be probed.
        if (!p.permissions.length) throw notFound(`Platform ${params(req).platformId}`);
        return mapPlatform(p);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Platform ${params(req).platformId}`);
        throw e;
      }
    },
  );
}
