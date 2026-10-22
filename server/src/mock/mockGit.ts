import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A tiny in-memory Git host for the demo and the tests, speaking the read-only API subsets that
 * Git sync uses – Forgejo/Gitea (/mock/git/api/v1), GitHub (/mock/github/api/v3) and GitLab
 * (/mock/gitlab/api/v4). All three serve the same repositories:
 *
 *   steward/library   public, a small Steward library under steward/ (process, dashboard, monitor, record type)
 *   steward/private   needs the token DEMO_GIT.token
 *
 * Repository URLs for a source: http://127.0.0.1:<port>/mock/git/steward/library (Forgejo),
 * …/mock/github/steward/library (GitHub), …/mock/gitlab/steward/library with the API URL
 * …/mock/gitlab/api/v4 (GitLab).
 *
 * Test helpers (demo mode only, like everything under /mock):
 *   POST /mock/git/_commit {repo, branch?, files: {path: content | null}, signed?, message?} → {sha}
 *   POST /mock/git/_reset
 *   GET  /mock/git/_calls?repo=…   requests seen per repository (whether a token was sent, never its value)
 */

export const DEMO_GIT = { token: 'mock-git-token-0123456789', repo: 'steward/library', privateRepo: 'steward/private' };

interface Commit {
  sha: string;
  tree: Map<string, string>; // path → blob sha
  signed: boolean;
  message: string;
}
interface Repo {
  isPrivate: boolean;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
  blobs: Map<string, Buffer>;
  calls: { path: string; token: boolean; tokenOk: boolean }[];
}

const blobSha = (b: Buffer) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

export const MOCK_LIBRARY: Record<string, string> = {
  'README.md': '# Steward library (demo)\n\nFiles below `steward/` are synced into Steward.\n',
  'steward/processes/git-user-count.yaml': `name: "Git demo – Insights Hub user count"
description: |
  Synced from Git (demo). Counts the users of the tenant and warns when there are none.
tags: [git, demo]
connections:
  - slot: hub
    kind: insights-hub
steps:
  - id: users
    type: http
    name: Count users
    connection: hub
    method: GET
    path: /api/identitymanagement/v3/Users
    query: { count: "1" }
    saveAs: users
  - id: check
    type: check
    name: The tenant has users
    severity: warning
    condition: "vars.users.body.totalResults > 0"
    message: "{{ vars.users.body.totalResults }} users"
`,
  'steward/dashboards/git-overview.yaml': `name: Git demo overview
description: A dashboard that lives in Git (demo).
widgets:
  - id: intro
    type: markdown
    width: 12
    text: This dashboard was synced from the demo Git repository.
`,
  'steward/monitors/git-ih-api.yaml': `kind: monitor
key: git-ih-api
name: Git demo – Insights Hub API
description: A monitor that lives in Git (demo).
intervalSeconds: 300
checks:
  - id: ih-api
    name: Identity API
    type: platform
    platform: Insights Hub (demo)
    path: /api/identitymanagement/v3/Users
    query: { count: "1" }
`,
  'steward/record-types/pir.yaml': `kind: recordType
key: PIR
name: Post-incident review
description: Lessons learned after an incident (synced from Git).
workflow: decision
template: |
  ## What happened

  ## What we change
fields:
  - { key: incident, label: Incident number, kind: text, required: true }
`,
};

function newRepo(isPrivate: boolean, files: Record<string, string>): Repo {
  const repo: Repo = { isPrivate, branches: new Map(), commits: new Map(), blobs: new Map(), calls: [] };
  commit(repo, 'main', files, { signed: true, message: 'Initial library' });
  return repo;
}

function commit(repo: Repo, branch: string, files: Record<string, string | null>, o: { signed?: boolean; message?: string }): string {
  const parent = repo.branches.get(branch);
  const tree = new Map(parent ? repo.commits.get(parent)!.tree : []);
  for (const [p, content] of Object.entries(files)) {
    if (content === null) tree.delete(p);
    else {
      const b = Buffer.from(content, 'utf8');
      const s = blobSha(b);
      repo.blobs.set(s, b);
      tree.set(p, s);
    }
  }
  const sha = crypto
    .createHash('sha1')
    .update(`${parent ?? ''}|${[...tree].join(';')}|${o.message ?? ''}|${Date.now()}|${Math.random()}`)
    .digest('hex');
  repo.commits.set(sha, { sha, tree, signed: o.signed ?? false, message: o.message ?? 'Update' });
  repo.branches.set(branch, sha);
  return sha;
}

/** Entries of a commit's tree, with the directories a real host lists too. */
function entries(c: Commit, repo: Repo) {
  const dirs = new Set<string>();
  for (const p of c.tree.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [
    ...[...dirs].map((d) => ({ path: d, mode: '040000', type: 'tree', sha: crypto.createHash('sha1').update(`tree:${d}`).digest('hex') })),
    ...[...c.tree].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: repo.blobs.get(sha)!.length })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

export async function mockGit(app: FastifyInstance): Promise<void> {
  let repos = new Map<string, Repo>();
  const reset = () => {
    repos = new Map([
      [DEMO_GIT.repo, newRepo(false, MOCK_LIBRARY)],
      [DEMO_GIT.privateRepo, newRepo(true, { 'steward/processes/private.yaml': MOCK_LIBRARY['steward/processes/git-user-count.yaml']! })],
    ]);
  };
  reset();

  /** Resolves the repository and checks the provider's token header. */
  const access = (req: FastifyRequest, reply: FastifyReply, name: string, tokenOf: (req: FastifyRequest) => string | undefined): Repo | null => {
    const repo = repos.get(name);
    const token = tokenOf(req);
    const tokenOk = token === DEMO_GIT.token;
    repo?.calls.push({ path: req.url.split('?')[0]!, token: token !== undefined, tokenOk });
    if (repo && repo.calls.length > 500) repo.calls.shift();
    if (!repo || (repo.isPrivate && !tokenOk)) {
      void reply.code(404).send({ message: 'Not Found' });
      return null;
    }
    if (token !== undefined && !tokenOk) {
      void reply.code(401).send({ message: 'Bad credentials' });
      return null;
    }
    return repo;
  };
  const commitOf = (repo: Repo, sha: string, reply: FastifyReply) => {
    const c = repo.commits.get(sha);
    if (!c) void reply.code(404).send({ message: 'Not Found' });
    return c;
  };
  const blobOf = (repo: Repo, sha: string, reply: FastifyReply) => {
    const b = repo.blobs.get(sha);
    if (!b) void reply.code(404).send({ message: 'Not Found' });
    return b;
  };
  const p = (req: FastifyRequest) => req.params as Record<string, string>;

  // ---------- test helpers ----------
  app.post('/git/_reset', async () => {
    reset();
    return { ok: true };
  });
  app.post('/git/_commit', async (req, reply) => {
    const b = (req.body ?? {}) as {
      repo?: string;
      branch?: string;
      files?: Record<string, string | null>;
      signed?: boolean;
      message?: string;
      private?: boolean;
    };
    if (!b.repo || !/^[\w.-]+\/[\w.-]+$/.test(b.repo) || !b.files) return reply.code(400).send({ error: 'repo and files are required' });
    let repo = repos.get(b.repo);
    if (!repo) {
      repo = { isPrivate: !!b.private, branches: new Map(), commits: new Map(), blobs: new Map(), calls: [] };
      repos.set(b.repo, repo);
    }
    return { sha: commit(repo, b.branch ?? 'main', b.files, { signed: b.signed, message: b.message }) };
  });
  app.get('/git/_calls', async (req) => repos.get(String((req.query as { repo?: string }).repo))?.calls ?? []);

  // ---------- Forgejo / Gitea ----------
  const giteaToken = (req: FastifyRequest) => /^token\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const G = '/git/api/v1/repos/:owner/:repo';
  app.get(`${G}/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: 'branch not found' });
    const c = repo.commits.get(sha)!;
    return {
      name: p(req).branch,
      commit: { id: sha, message: c.message, verification: { verified: c.signed, reason: c.signed ? '' : 'gpg.error.not_signed_commit' } },
    };
  });
  app.get(`${G}/git/trees/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    const q = req.query as { page?: string; per_page?: string };
    const all = entries(c, repo);
    const per = Math.min(Number(q.per_page ?? 1000), 1000);
    const page = Math.max(1, Number(q.page ?? 1));
    const slice = all.slice((page - 1) * per, page * per);
    return { sha: c.sha, tree: slice, truncated: page * per < all.length, page, total_count: all.length };
  });
  app.get(`${G}/git/blobs/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const b = blobOf(repo, p(req).sha!, reply);
    if (!b) return reply;
    return { sha: p(req).sha, size: b.length, encoding: 'base64', content: b.toString('base64') };
  });

  // ---------- GitHub (Enterprise-style API path /api/v3) ----------
  const githubToken = (req: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const H = '/github/api/v3/repos/:owner/:repo';
  app.get(`${H}/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: 'Branch not found' });
    const c = repo.commits.get(sha)!;
    return {
      name: p(req).branch,
      commit: { sha, commit: { message: c.message, verification: { verified: c.signed, reason: c.signed ? 'valid' : 'unsigned' } } },
    };
  });
  app.get(`${H}/git/trees/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    return { sha: c.sha, tree: entries(c, repo), truncated: false };
  });
  app.get(`${H}/git/blobs/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const b = blobOf(repo, p(req).sha!, reply);
    if (!b) return reply;
    // GitHub wraps base64 at 60 characters
    return { sha: p(req).sha, size: b.length, encoding: 'base64', content: b.toString('base64').replace(/.{60}/g, '$&\n') };
  });

  // ---------- GitLab ----------
  const gitlabToken = (req: FastifyRequest) => {
    const t = req.headers['private-token'];
    return typeof t === 'string' ? t : undefined;
  };
  const L = '/gitlab/api/v4/projects/:project';
  app.get(`${L}/repository/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: '404 Branch Not Found' });
    return { name: p(req).branch, commit: { id: sha, message: repo.commits.get(sha)!.message } };
  });
  app.get(`${L}/repository/commits/:sha/signature`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    if (!c.signed) return reply.code(404).send({ message: '404 Signature Not Found' });
    return { signature_type: 'SSH', verification_status: 'verified', commit_sha: c.sha };
  });
  app.get(`${L}/repository/tree`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const q = req.query as { ref?: string; path?: string; page?: string; per_page?: string };
    const c = commitOf(repo, String(q.ref), reply);
    if (!c) return reply;
    const all = entries(c, repo)
      .filter((e) => !q.path || e.path.startsWith(`${q.path}/`))
      .map((e) => ({ id: e.sha, name: e.path.split('/').pop(), type: e.type, path: e.path, mode: e.mode }));
    const per = Math.min(Number(q.per_page ?? 20), 100);
    const page = Math.max(1, Number(q.page ?? 1));
    if (page * per < all.length) reply.header('x-next-page', String(page + 1));
    return all.slice((page - 1) * per, page * per);
  });
  app.get(`${L}/repository/blobs/:sha/raw`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const b = blobOf(repo, p(req).sha!, reply);
    if (!b) return reply;
    return reply.type('text/plain').send(b);
  });
}
