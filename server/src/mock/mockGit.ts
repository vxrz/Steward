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
 *   POST /mock/git/_commit {repo, branch?, files: {path: content | null}, signed?, signer?, email?, message?, objectFormat?} → {sha}
 *        (signer/email: the account that signed – default steward-bot; objectFormat 'sha256' for a new SHA-256 repository)
 *   POST /mock/git/_tag {repo, tag, branch? | sha?, annotated?}   creates or moves a tag (annotated: a tag object in between) → {sha}
 *   POST /mock/git/_tamper {repo, path, content}   serves other content under the blob id of path at the head of main
 *   POST /mock/git/_reset
 *   GET  /mock/git/_calls?repo=…   requests seen per repository (whether a token was sent, never its value)
 */

export const DEMO_GIT = { token: 'mock-git-token-0123456789', repo: 'steward/library', privateRepo: 'steward/private' };

interface Commit {
  sha: string;
  parent: string | null;
  tree: Map<string, string>; // path → blob sha
  signed: boolean;
  /** The account (login, e-mail) that committed and signed */
  signer: { login: string; email: string };
  message: string;
}
interface Repo {
  isPrivate: boolean;
  /** Object format: SHA-1 (default) or SHA-256 object ids */
  format: 'sha1' | 'sha256';
  branches: Map<string, string>;
  /** tag name → the commit, and the tag object's id for annotated tags */
  tags: Map<string, { commit: string; object?: string }>;
  commits: Map<string, Commit>;
  blobs: Map<string, Buffer>;
  calls: { path: string; token: boolean; tokenOk: boolean }[];
}

const blobSha = (b: Buffer, format: Repo['format'] = 'sha1') => crypto.createHash(format).update(`blob ${b.length}\0`).update(b).digest('hex');

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
  'steward/record-types/rca.yaml': `kind: recordType
key: RCA
name: Root cause analysis
description: The cause of a problem and what we change (synced from Git).
workflow: decision
template: |
  ## What happened

  ## What we change
fields:
  - { key: incident, label: Incident number, kind: text, required: true }
`,
};

function newRepo(isPrivate: boolean, files: Record<string, string>): Repo {
  const repo: Repo = { isPrivate, format: 'sha1', branches: new Map(), tags: new Map(), commits: new Map(), blobs: new Map(), calls: [] };
  commit(repo, 'main', files, { signed: true, message: 'Initial library' });
  return repo;
}

function commit(
  repo: Repo,
  branch: string,
  files: Record<string, string | null>,
  o: { signed?: boolean; message?: string; signer?: string; email?: string },
): string {
  const parent = repo.branches.get(branch);
  const tree = new Map(parent ? repo.commits.get(parent)!.tree : []);
  for (const [p, content] of Object.entries(files)) {
    if (content === null) tree.delete(p);
    else {
      const b = Buffer.from(content, 'utf8');
      const s = blobSha(b, repo.format);
      repo.blobs.set(s, b);
      tree.set(p, s);
    }
  }
  const sha = crypto
    .createHash(repo.format)
    .update(`${parent ?? ''}|${[...tree].join(';')}|${o.message ?? ''}|${Date.now()}|${Math.random()}`)
    .digest('hex');
  const login = o.signer ?? 'steward-bot';
  repo.commits.set(sha, {
    sha,
    parent: parent ?? null,
    tree,
    signed: o.signed ?? false,
    signer: { login, email: o.email ?? `${login}@example.com` },
    message: o.message ?? 'Update',
  });
  repo.branches.set(branch, sha);
  return sha;
}

/** Commits reachable from head but not from base (git log base..head), oldest first; null when base is unknown. */
function between(repo: Repo, base: string, head: string): Commit[] | null {
  if (!repo.commits.has(base) || !repo.commits.has(head)) return null;
  const known = new Set<string>();
  for (let c: string | null = base; c; c = repo.commits.get(c)?.parent ?? null) known.add(c);
  const out: Commit[] = [];
  for (let c: string | null = head; c && !known.has(c); c = repo.commits.get(c)?.parent ?? null) out.push(repo.commits.get(c)!);
  return out.reverse();
}

/** Entries of a commit's tree, with the directories a real host lists too. */
function entries(c: Commit, repo: Repo) {
  const dirs = new Set<string>();
  for (const p of c.tree.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [
    ...[...dirs].map((d) => ({ path: d, mode: '040000', type: 'tree', sha: crypto.createHash(repo.format).update(`tree:${d}`).digest('hex') })),
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
      signer?: string;
      email?: string;
      message?: string;
      private?: boolean;
      objectFormat?: 'sha1' | 'sha256';
    };
    if (!b.repo || !/^[\w.-]+\/[\w.-]+$/.test(b.repo) || !b.files) return reply.code(400).send({ error: 'repo and files are required' });
    let repo = repos.get(b.repo);
    if (!repo) {
      const format = b.objectFormat === 'sha256' ? 'sha256' : 'sha1';
      repo = { isPrivate: !!b.private, format, branches: new Map(), tags: new Map(), commits: new Map(), blobs: new Map(), calls: [] };
      repos.set(b.repo, repo);
    }
    return { sha: commit(repo, b.branch ?? 'main', b.files, { signed: b.signed, signer: b.signer, email: b.email, message: b.message }) };
  });
  app.post('/git/_tag', async (req, reply) => {
    const b = (req.body ?? {}) as { repo?: string; tag?: string; branch?: string; sha?: string; annotated?: boolean };
    const repo = repos.get(String(b.repo));
    const sha = b.sha ?? repo?.branches.get(b.branch ?? 'main');
    if (!repo || !b.tag || !/^[\w.-]+$/.test(b.tag) || !sha || !repo.commits.has(sha))
      return reply.code(400).send({ error: 'repo, tag and a known commit are required' });
    const object = b.annotated ? crypto.createHash(repo.format).update(`tag:${b.tag}:${sha}:${Math.random()}`).digest('hex') : undefined;
    repo.tags.set(b.tag, { commit: sha, ...(object ? { object } : {}) });
    return { sha };
  });
  app.post('/git/_tamper', async (req, reply) => {
    const b = (req.body ?? {}) as { repo?: string; path?: string; content?: string };
    const repo = repos.get(String(b.repo));
    const head = repo?.branches.get('main');
    const sha = head ? repo!.commits.get(head)!.tree.get(String(b.path)) : undefined;
    if (!repo || !sha || typeof b.content !== 'string') return reply.code(400).send({ error: 'repo, path and content are required' });
    repo.blobs.set(sha, Buffer.from(b.content, 'utf8'));
    return { ok: true };
  });
  app.get('/git/_calls', async (req) => repos.get(String((req.query as { repo?: string }).repo))?.calls ?? []);

  // ---------- Forgejo / Gitea ----------
  const giteaVerification = (c: Commit) => ({
    verified: c.signed,
    reason: c.signed ? `${c.signer.login} / ABCDEF0123456789` : 'gpg.error.not_signed_commit',
    signer: c.signed ? { name: c.signer.login, email: c.signer.email, username: c.signer.login } : null,
  });
  const giteaToken = (req: FastifyRequest) => /^token\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const G = '/git/api/v1/repos/:owner/:repo';
  app.get(`${G}/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: 'branch not found' });
    const c = repo.commits.get(sha)!;
    return { name: p(req).branch, commit: { id: sha, message: c.message, verification: giteaVerification(c) } };
  });
  // the tag with its (peeled) commit, and a single commit with its signature
  app.get(`${G}/tags/:tag`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const t = repo.tags.get(p(req).tag!);
    if (!t) return reply.code(404).send({ message: 'tag not found' });
    return { name: p(req).tag, id: t.object ?? t.commit, message: '', commit: { sha: t.commit, url: '' } };
  });
  app.get(`${G}/git/commits/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    return { sha: c.sha, commit: { message: c.message, verification: giteaVerification(c) } };
  });
  // Gitea/Forgejo ≥ 1.22 / 7: commits between two revisions (newest first, like git log)
  app.get(`${G}/compare/:basehead`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, giteaToken);
    if (!repo) return reply;
    const [base, head] = p(req).basehead!.split('...');
    const list = between(repo, String(base), String(head));
    if (!list) return reply.code(404).send({ message: 'Not Found' });
    return {
      total_commits: list.length,
      commits: list.reverse().map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { email: c.signer.email }, committer: { email: c.signer.email }, verification: giteaVerification(c) },
      })),
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
  const githubCommit = (c: Commit) => ({
    sha: c.sha,
    commit: {
      message: c.message,
      author: { email: c.signer.email },
      committer: { email: c.signer.email },
      verification: { verified: c.signed, reason: c.signed ? 'valid' : 'unsigned' },
    },
    author: { login: c.signer.login },
    committer: { login: c.signer.login },
  });
  app.get(`${H}/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: 'Branch not found' });
    const c = repo.commits.get(sha)!;
    return { name: p(req).branch, commit: githubCommit(c) };
  });
  // refs/tags/<tag> → a commit (lightweight) or a tag object (annotated) that points to it
  app.get(`${H}/git/ref/tags/:tag`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const t = repo.tags.get(p(req).tag!);
    if (!t) return reply.code(404).send({ message: 'Not Found' });
    return { ref: `refs/tags/${p(req).tag}`, object: t.object ? { type: 'tag', sha: t.object } : { type: 'commit', sha: t.commit } };
  });
  app.get(`${H}/git/tags/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const t = [...repo.tags.values()].find((x) => x.object === p(req).sha);
    if (!t) return reply.code(404).send({ message: 'Not Found' });
    return { sha: t.object, object: { type: 'commit', sha: t.commit } };
  });
  app.get(`${H}/commits/:sha`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    return { ...githubCommit(c), files: [] };
  });
  app.get(`${H}/compare/:basehead`, async (req, reply) => {
    const repo = access(req, reply, `${p(req).owner}/${p(req).repo}`, githubToken);
    if (!repo) return reply;
    const [base, head] = p(req).basehead!.split('...');
    const list = between(repo, String(base), String(head));
    if (!list) return reply.code(404).send({ message: 'Not Found' });
    const q = req.query as { page?: string; per_page?: string };
    const per = Math.min(Number(q.per_page ?? 250), 250);
    const page = Math.max(1, Number(q.page ?? 1));
    return {
      status: list.length ? 'ahead' : 'identical',
      ahead_by: list.length,
      behind_by: 0,
      total_commits: list.length,
      commits: list.slice((page - 1) * per, page * per).map(githubCommit),
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
  const gitlabCommit = (c: Commit) => ({
    id: c.sha,
    message: c.message,
    parent_ids: c.parent ? [c.parent] : [],
    author_email: c.signer.email,
    committer_email: c.signer.email,
  });
  app.get(`${L}/repository/branches/:branch`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const sha = repo.branches.get(p(req).branch!);
    if (!sha) return reply.code(404).send({ message: '404 Branch Not Found' });
    return { name: p(req).branch, commit: gitlabCommit(repo.commits.get(sha)!) };
  });
  app.get(`${L}/repository/tags/:tag`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const t = repo.tags.get(p(req).tag!);
    if (!t) return reply.code(404).send({ message: '404 Tag Not Found' });
    return { name: p(req).tag, target: t.object ?? t.commit, commit: gitlabCommit(repo.commits.get(t.commit)!) };
  });
  app.get(`${L}/repository/commits`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const q = req.query as { ref_name?: string; page?: string; per_page?: string };
    const [base, head] = String(q.ref_name).split('..');
    const list = between(repo, String(base), String(head));
    if (!list) return reply.code(404).send({ message: '404 Commit Not Found' });
    const per = Math.min(Number(q.per_page ?? 20), 100);
    const page = Math.max(1, Number(q.page ?? 1));
    if (page * per < list.length) reply.header('x-next-page', String(page + 1));
    return list
      .reverse()
      .slice((page - 1) * per, page * per)
      .map(gitlabCommit);
  });
  app.get(`${L}/repository/commits/:sha`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    return gitlabCommit(c);
  });
  app.get(`${L}/repository/commits/:sha/signature`, async (req, reply) => {
    const repo = access(req, reply, p(req).project!, gitlabToken);
    if (!repo) return reply;
    const c = commitOf(repo, p(req).sha!, reply);
    if (!c) return reply;
    if (!c.signed) return reply.code(404).send({ message: '404 Signature Not Found' });
    return {
      signature_type: 'PGP',
      verification_status: 'verified',
      commit_sha: c.sha,
      gpg_key_user_name: c.signer.login,
      gpg_key_user_email: c.signer.email,
    };
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
