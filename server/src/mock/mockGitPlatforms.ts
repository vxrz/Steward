import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Simulated GitHub, GitLab and Forgejo APIs for the Git platforms (#107), for demo mode and tests – only the read
 * endpoints Steward uses, with the hosts' shapes. Separate from mockGit.ts (Git sync), so both can change on their own.
 *
 *   /mock/gitplat/github/…            like https://api.github.com
 *   /mock/gitplat/gitlab/api/v4/…     like https://gitlab.example.com/api/v4
 *   /mock/gitplat/forgejo/api/v1/…    like https://forgejo.example.com/api/v1
 *
 * All three serve the organisation "acme" with the repositories acme/shop-web (pipeline green, a release, Dependabot
 * alerts, a container package) and acme/shop-api (pipeline red); GitLab names them acme/shop/web and acme/shop/api.
 * Authentication: `Authorization: Bearer <DEMO_GIT_PLATFORMS.token>`; the repository acme/secret answers 403.
 */

export const DEMO_GIT_PLATFORMS = { token: 'demo-git-platform-token' };

type Host = 'github' | 'gitlab' | 'forgejo';

interface Repo {
  name: string;
  files: Record<string, string>;
  pipeline: 'success' | 'failure' | 'running';
  release: { tag: string; days: number } | null;
  alerts: { severity: string }[];
  packages: { name: string; type: string; version: string }[];
  keys: { id: number; title: string; readOnly: boolean; days: number }[];
  collaborators: { login: string; role: string; outside?: boolean }[];
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SHA = { 'shop-web': 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'shop-api': 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432' } as Record<string, string>;

function seed(): Record<string, Repo> {
  return {
    'shop-web': {
      name: 'shop-web',
      files: {
        Dockerfile:
          'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n\nFROM nginx:1.27.3-alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\n',
        'package.json': JSON.stringify({ name: 'shop-web', engines: { node: '>=22' }, dependencies: { react: '^18.3.1', express: '^4.21.2' } }, null, 2),
        '.nvmrc': '22\n',
      },
      pipeline: 'success',
      release: { tag: 'v2.4.1', days: 12 },
      alerts: [{ severity: 'high' }, { severity: 'medium' }, { severity: 'medium' }],
      packages: [{ name: 'shop-web', type: 'container', version: '2.4.1' }],
      keys: [
        { id: 11, title: 'argocd (read-only)', readOnly: true, days: 400 },
        { id: 12, title: 'release bot', readOnly: false, days: 30 },
      ],
      collaborators: [
        { login: 'alice', role: 'admin' },
        { login: 'bob', role: 'write' },
        { login: 'carol-ext', role: 'read', outside: true },
      ],
    },
    'shop-api': {
      name: 'shop-api',
      files: {
        Dockerfile: 'FROM golang:1.22 AS build\nCOPY . .\nRUN go build -o /api\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /api /api\n',
        'go.mod': 'module example.com/acme/shop-api\n\ngo 1.22\n',
      },
      pipeline: 'failure',
      release: null,
      alerts: [],
      packages: [],
      keys: [],
      collaborators: [
        { login: 'alice', role: 'admin' },
        { login: 'dave', role: 'maintain' },
      ],
    },
  };
}

let repos = seed();
const ORG = { admins: ['alice'], members: ['bob', 'dave'], outside: ['carol-ext'] };

/** For tests: the pipeline of a repository, or a file. */
export function setGitPipeline(repo: string, state: Repo['pipeline']): void {
  if (repos[repo]) repos[repo].pipeline = state;
}
export function setGitFile(repo: string, path: string, content: string | null): void {
  const r = repos[repo];
  if (!r) return;
  if (content === null) delete r.files[path];
  else r.files[path] = content;
}
export function resetGitPlatforms(): void {
  repos = seed();
}

function allowed(req: FastifyRequest, reply: FastifyReply, repo?: string): boolean {
  if (req.headers.authorization !== `Bearer ${DEMO_GIT_PLATFORMS.token}`) {
    void reply.code(401).send({ message: 'Bad credentials' });
    return false;
  }
  if (repo === 'secret') {
    void reply.code(403).send({ message: 'Resource not accessible by personal access token' });
    return false;
  }
  return true;
}

/** acme/shop-web, acme/shop/web (GitLab, URL-encoded or not) → shop-web */
function repoOf(host: Host, owner: string, name?: string): Repo | 'secret' | null {
  const path = decodeURIComponent(name ? `${owner}/${name}` : owner);
  const parts = path.split('/');
  if (parts[0] !== 'acme') return null;
  const key = host === 'gitlab' && parts.length === 3 && parts[1] === 'shop' ? `shop-${parts[2]}` : parts.slice(1).join('/');
  if (key === 'secret') return 'secret';
  return repos[key] ?? null;
}

const notFound = (reply: FastifyReply) => reply.code(404).send({ message: 'Not Found' });
const page = <T>(req: FastifyRequest, items: T[]) => {
  const q = req.query as { page?: string; per_page?: string; limit?: string };
  const size = Number(q.per_page ?? q.limit ?? 30);
  const p = Number(q.page ?? 1);
  return items.slice((p - 1) * size, p * size);
};

export async function mockGitPlatforms(app: FastifyInstance): Promise<void> {
  // ---------- GitHub ----------
  const G = '/gitplat/github';
  type GP = { owner: string; repo: string };
  const ghRepo = (req: FastifyRequest, reply: FastifyReply): Repo | null => {
    const { owner, repo } = req.params as GP;
    const r = repoOf('github', owner, repo);
    if (r === 'secret') {
      allowed(req, reply, 'secret');
      return null;
    }
    if (!allowed(req, reply)) return null;
    if (!r) void notFound(reply);
    return r;
  };
  const web = (r: Repo) => `https://github.example.com/acme/${r.name}`;
  app.get(`${G}/rate_limit`, async (req, reply) => (allowed(req, reply) ? { resources: { core: { limit: 5000, remaining: 4999 } } } : reply));
  app.get(`${G}/repos/:owner/:repo`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r ? { full_name: `acme/${r.name}`, html_url: web(r), default_branch: 'main', archived: false, private: true } : reply;
  });
  app.get(`${G}/repos/:owner/:repo/commits/:ref`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (r && !['main', SHA[r.name]].includes((req.params as { ref: string }).ref)) return notFound(reply);
    return r ? { sha: SHA[r.name], commit: { message: 'Merge pull request #42\n\nmore', committer: { date: ago(1) } } } : reply;
  });
  app.get(`${G}/repos/:owner/:repo/actions/runs`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const status = r.pipeline === 'running' ? 'in_progress' : 'completed';
    const conclusion = r.pipeline === 'running' ? null : r.pipeline;
    return {
      total_count: 4,
      workflow_runs: [
        { workflow_id: 1, name: 'CI', event: 'push', status, conclusion, html_url: `${web(r)}/actions/runs/103`, updated_at: ago(0.5) },
        { workflow_id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', html_url: `${web(r)}/actions/runs/101`, updated_at: ago(2) },
        {
          workflow_id: 2,
          name: 'CodeQL',
          event: 'schedule',
          status: 'completed',
          conclusion: 'cancelled',
          html_url: `${web(r)}/actions/runs/102`,
          updated_at: ago(1),
        },
        {
          workflow_id: 2,
          name: 'CodeQL',
          event: 'schedule',
          status: 'completed',
          conclusion: 'success',
          html_url: `${web(r)}/actions/runs/99`,
          updated_at: ago(3),
        },
      ],
    };
  });
  app.get(`${G}/repos/:owner/:repo/releases/latest`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    return r.release ? { tag_name: r.release.tag, published_at: ago(r.release.days), html_url: `${web(r)}/releases/tag/${r.release.tag}` } : notFound(reply);
  });
  app.get(`${G}/repos/:owner/:repo/dependabot/alerts`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r ? r.alerts.map((a, i) => ({ number: i + 1, state: 'open', security_advisory: { severity: a.severity } })) : reply;
  });
  app.get(`${G}/repos/:owner/:repo/keys`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r ? r.keys.map((k) => ({ id: k.id, title: k.title, read_only: k.readOnly, created_at: ago(k.days), key: 'ssh-ed25519 AAAA…' })) : reply;
  });
  app.get(`${G}/repos/:owner/:repo/contents/*`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const f = r.files[(req.params as { '*': string })['*']];
    return f === undefined ? notFound(reply) : reply.type('application/vnd.github.raw+json').send(f);
  });
  app.get(`${G}/repos/:owner/:repo/collaborators`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const aff = (req.query as { affiliation?: string }).affiliation ?? 'all';
    // like GitHub: direct collaborators include outside collaborators
    const list = r.collaborators.filter((c) => aff !== 'outside' || c.outside);
    return page(
      req,
      list.map((c) => ({ login: c.login, role_name: c.role, type: 'User' })),
    );
  });
  app.get(`${G}/orgs/:org/members`, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    if ((req.params as { org: string }).org !== 'acme') return notFound(reply);
    const role = (req.query as { role?: string }).role;
    return page(
      req,
      (role === 'admin' ? ORG.admins : role === 'member' ? ORG.members : [...ORG.admins, ...ORG.members]).map((login) => ({ login })),
    );
  });
  app.get(`${G}/orgs/:org/outside_collaborators`, async (req, reply) =>
    allowed(req, reply)
      ? page(
          req,
          ORG.outside.map((login) => ({ login })),
        )
      : reply,
  );
  app.get(`${G}/orgs/:org/packages`, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    return Object.values(repos).flatMap((r) =>
      r.packages.map((p) => ({
        name: p.name,
        package_type: p.type,
        html_url: `https://github.example.com/orgs/acme/packages/container/package/${p.name}`,
        repository: { full_name: `acme/${r.name}` },
      })),
    );
  });

  // ---------- GitLab ----------
  const L = '/gitplat/gitlab/api/v4';
  const glRepo = (req: FastifyRequest, reply: FastifyReply): Repo | null => {
    const r = repoOf('gitlab', (req.params as { id: string }).id);
    if (r === 'secret') {
      allowed(req, reply, 'secret');
      return null;
    }
    if (!allowed(req, reply)) return null;
    if (!r) void notFound(reply);
    return r;
  };
  const glWeb = (r: Repo) => `https://gitlab.example.com/acme/shop/${r.name.replace('shop-', '')}`;
  app.get(`${L}/version`, async (req, reply) => (allowed(req, reply) ? { version: '17.5.1', revision: 'abc' } : reply));
  app.get(`${L}/projects/:id`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r ? { path_with_namespace: `acme/shop/${r.name.replace('shop-', '')}`, web_url: glWeb(r), default_branch: 'main', archived: false } : reply;
  });
  app.get(`${L}/projects/:id/repository/branches/:branch`, async (req, reply) => {
    const r = glRepo(req, reply);
    if (r && (req.params as { branch: string }).branch !== 'main') return notFound(reply);
    return r ? { name: 'main', commit: { id: SHA[r.name], title: 'Merge branch feature', committed_date: ago(1) } } : reply;
  });
  app.get(`${L}/projects/:id/pipelines`, async (req, reply) => {
    const r = glRepo(req, reply);
    const status = r?.pipeline === 'failure' ? 'failed' : r?.pipeline;
    return r
      ? [
          { id: 9001, iid: 77, status: 'canceled', web_url: `${glWeb(r)}/-/pipelines/9001`, updated_at: ago(0.2) },
          { id: 9000, iid: 76, status, web_url: `${glWeb(r)}/-/pipelines/9000`, updated_at: ago(0.5) },
        ]
      : reply;
  });
  app.get(`${L}/projects/:id/releases`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r
      ? r.release
        ? [{ tag_name: r.release.tag, released_at: ago(r.release.days), _links: { self: `${glWeb(r)}/-/releases/${r.release.tag}` } }]
        : []
      : reply;
  });
  app.get(`${L}/projects/:id/registry/repositories`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r
      ? r.packages
          .filter((p) => p.type === 'container')
          .map((p, i) => ({ id: i + 1, name: '', path: `acme/shop/${p.name}`, location: `registry.gitlab.example.com/acme/shop/${p.name}` }))
      : reply;
  });
  app.get(`${L}/projects/:id/packages`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r ? [] : reply;
  });
  app.get(`${L}/projects/:id/deploy_keys`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r ? r.keys.map((k) => ({ id: k.id, title: k.title, can_push: !k.readOnly, created_at: ago(k.days), expires_at: null })) : reply;
  });
  app.get(`${L}/projects/:id/deploy_tokens`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r
      ? r.name === 'shop-web'
        ? [{ id: 5, name: 'registry pull', scopes: ['read_registry'], expires_at: ago(-60), revoked: false, expired: false }]
        : []
      : reply;
  });
  app.get(`${L}/projects/:id/access_tokens`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r
      ? r.name === 'shop-web'
        ? [
            {
              id: 8,
              name: 'renovate',
              scopes: ['api', 'write_repository'],
              created_at: ago(200),
              expires_at: ago(-20),
              last_used_at: ago(0.1),
              active: true,
              revoked: false,
            },
            { id: 9, name: 'old ci', scopes: ['read_api'], created_at: ago(500), expires_at: ago(10), active: false, revoked: false },
          ]
        : []
      : reply;
  });
  app.get(`${L}/projects/:id/repository/files/:file/raw`, async (req, reply) => {
    const r = glRepo(req, reply);
    if (!r) return reply;
    const f = r.files[decodeURIComponent((req.params as { file: string }).file)];
    return f === undefined ? notFound(reply) : reply.type('text/plain').send(f);
  });
  const LEVEL: Record<string, number> = { admin: 50, maintain: 40, write: 30, read: 20 };
  app.get(`${L}/projects/:id/members/all`, async (req, reply) => {
    const r = glRepo(req, reply);
    return r
      ? page(
          req,
          r.collaborators.map((c) => ({ username: c.login, access_level: LEVEL[c.role] ?? 10, state: 'active' })),
        )
      : reply;
  });
  app.get(`${L}/groups/:id/members/all`, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    if (decodeURIComponent((req.params as { id: string }).id) !== 'acme') return notFound(reply);
    return page(req, [
      ...ORG.admins.map((u) => ({ username: u, access_level: 50, state: 'active' })),
      ...ORG.members.map((u) => ({ username: u, access_level: 30, state: 'active' })),
    ]);
  });

  // ---------- Forgejo / Gitea ----------
  const F = '/gitplat/forgejo/api/v1';
  const fjWeb = (r: Repo) => `https://forgejo.example.com/acme/${r.name}`;
  app.get(`${F}/version`, async (req, reply) => (allowed(req, reply) ? { version: '9.0.1+gitea-1.22.0' } : reply));
  app.get(`${F}/repos/:owner/:repo`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r ? { full_name: `acme/${r.name}`, html_url: fjWeb(r), default_branch: 'main', archived: false } : reply;
  });
  app.get(`${F}/repos/:owner/:repo/branches/:branch`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (r && (req.params as { branch: string }).branch !== 'main') return notFound(reply);
    return r ? { name: 'main', commit: { id: SHA[r.name], message: 'Update dependencies\n', timestamp: ago(1) } } : reply;
  });
  app.get(`${F}/repos/:owner/:repo/commits/:ref/status`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const st = r.pipeline === 'running' ? 'pending' : r.pipeline;
    return {
      state: st,
      statuses: [
        { context: 'ci/woodpecker/push/build', status: st, target_url: `https://ci.example.com/repos/1/pipeline/55`, updated_at: ago(0.5) },
        { context: 'ci/woodpecker/push/lint', status: 'success', target_url: `https://ci.example.com/repos/1/pipeline/55/2`, updated_at: ago(0.5) },
      ],
    };
  });
  app.get(`${F}/repos/:owner/:repo/releases/latest`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    return r.release ? { tag_name: r.release.tag, published_at: ago(r.release.days), html_url: `${fjWeb(r)}/releases/tag/${r.release.tag}` } : notFound(reply);
  });
  app.get(`${F}/repos/:owner/:repo/keys`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r ? r.keys.map((k) => ({ id: k.id, title: k.title, read_only: k.readOnly, created_at: ago(k.days) })) : reply;
  });
  app.get(`${F}/repos/:owner/:repo/raw/*`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const f = r.files[(req.params as { '*': string })['*']];
    return f === undefined ? notFound(reply) : reply.type('text/plain').send(f);
  });
  app.get(`${F}/repos/:owner/:repo/collaborators`, async (req, reply) => {
    const r = ghRepo(req, reply);
    return r
      ? page(
          req,
          r.collaborators.map((c) => ({ login: c.login })),
        )
      : reply;
  });
  app.get(`${F}/repos/:owner/:repo/collaborators/:user/permission`, async (req, reply) => {
    const r = ghRepo(req, reply);
    if (!r) return reply;
    const c = r.collaborators.find((x) => x.login === (req.params as { user: string }).user);
    return c ? { permission: c.role === 'maintain' ? 'write' : c.role, role_name: c.role } : notFound(reply);
  });
  app.get(`${F}/orgs/:org/teams`, async (req, reply) =>
    allowed(req, reply)
      ? page(req, [
          { id: 1, name: 'Owners' },
          { id: 2, name: 'developers' },
        ])
      : reply,
  );
  app.get(`${F}/teams/:id/members`, async (req, reply) =>
    allowed(req, reply)
      ? page(
          req,
          ((req.params as { id: string }).id === '1' ? ORG.admins : ORG.members).map((login) => ({ login })),
        )
      : reply,
  );
  app.get(`${F}/packages/:owner`, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    return Object.values(repos).flatMap((r) =>
      r.packages.map((p) => ({
        name: p.name,
        type: p.type,
        version: p.version,
        html_url: `https://forgejo.example.com/acme/-/packages/${p.type}/${p.name}/${p.version}`,
        repository: { full_name: `acme/${r.name}` },
      })),
    );
  });
}
