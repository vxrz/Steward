import crypto from 'node:crypto';
import { EnvHttpProxyAgent } from 'undici';
import { BRAND, SYNC_LIMITS, type GitProvider } from '@sm/shared';
import { assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { HttpError } from '../util.js';

/**
 * Read-only clients for the Git hosts' HTTP APIs (Forgejo/Gitea, GitHub, GitLab).
 *
 * Why the hosts' APIs and not the Git protocol: no git binary and no new dependency (works in the
 * desktop executable), only the files of the configured folder are downloaded instead of a whole
 * pack, and every request is an ordinary HTTPS GET that the outbound policy can check. The price:
 * plain Git servers without one of these APIs are not supported.
 *
 * Security:
 *   - the API origin must pass the outbound policy (platform origins + admin allow-list);
 *   - the token goes to the configured API base only – URLs are always built from it, never taken
 *     from a response, and redirects are refused instead of followed;
 *   - every response is size-capped while it is read, and every blob is checked against its Git
 *     object id (SHA-1 or, in SHA-256 repositories, SHA-256 of "blob <size>\0<content>"), so the
 *     content is the one the tree names.
 */

export interface RepoRef {
  provider: GitProvider;
  /** https://host[/prefix]/owner/repo (no trailing slash, no .git) */
  repoUrl: string;
  apiBase: string;
  /** Forgejo/GitHub: owner/repo; GitLab: the full project path (groups/subgroups/project) */
  project: string;
}

export interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}

/**
 * A commit and whether the host verified its signature (null: unknown). `signers`: who the host
 * vouches for, lower case – Forgejo/Gitea name the signer; GitHub and GitLab only verify a
 * signature whose key belongs to the committer, so their committer login and e-mail are used.
 */
export interface CommitCheck {
  sha: string;
  verified: boolean | null;
  signers: string[];
}

export interface GitApi {
  /** Head commit of the branch. */
  head(branch: string): Promise<CommitCheck>;
  /** The commit a tag points to (annotated tags are followed to their commit). */
  tag(name: string): Promise<CommitCheck>;
  /**
   * The commits reachable from `head` but not from `base` (git log base..head), at most
   * SYNC_LIMITS.maxCheckedCommits – more fail with GIT_TOO_MANY_COMMITS; an unknown base fails
   * with GIT_HISTORY_UNKNOWN.
   */
  newCommits(base: string, head: string): Promise<CommitCheck[]>;
  /** All entries of the commit's tree (recursive) below `folder` ('' = everything). */
  tree(sha: string, folder: string): Promise<TreeEntry[]>;
  blob(sha: string, maxBytes: number): Promise<Buffer>;
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function parseHttpUrl(raw: string, field: 'repoUrl' | 'apiUrl'): URL {
  const what = field === 'apiUrl' ? 'API URL' : 'Repository URL';
  const ctx = { context: field };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, `${what}: not a valid URL`, 'GIT_URL_INVALID', ctx);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new HttpError(400, `${what}: only https:// URLs are allowed (http:// only for localhost)`, 'GIT_URL_HTTPS_ONLY', ctx);
  }
  if (u.username || u.password) throw new HttpError(400, `${what}: put the access token in the token field, not in the URL`, 'GIT_URL_CREDENTIALS', ctx);
  if (u.search || u.hash) throw new HttpError(400, `${what}: no query string or fragment`, 'GIT_URL_QUERY', ctx);
  return u;
}

/** Repository URL (+ optional API URL) → where the API lives and how the project is addressed. */
export function resolveRepo(provider: GitProvider, repoUrlRaw: string, apiUrlRaw?: string): RepoRef {
  const u = parseHttpUrl(repoUrlRaw, 'repoUrl');
  const segments = u.pathname
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.some((s) => !NAME.test(s) || s === '.' || s === '..'))
    throw new HttpError(400, 'Repository URL: unexpected characters in the path', 'GIT_REPO_PATH_INVALID');
  if (segments.length < 2) throw new HttpError(400, 'Repository URL: expected https://host/<owner>/<repository>', 'GIT_REPO_PATH_INVALID');
  const repoUrl = `${u.origin}/${segments.join('/')}`;
  const api = apiUrlRaw?.trim() ? parseHttpUrl(apiUrlRaw, 'apiUrl') : null;
  const apiOverride = api ? `${api.origin}${api.pathname.replace(/\/+$/, '')}` : null;
  if (provider === 'gitlab') {
    const apiBase = apiOverride ?? `${u.origin}/api/v4`;
    // GitLab under a relative URL root (https://host/gitlab/group/project): the API URL names the root
    const root = api
      ? api.pathname
          .replace(/\/api\/v4\/?$/, '')
          .split('/')
          .filter(Boolean)
      : [];
    const sameRoot = root.every((s, i) => segments[i] === s);
    const project = (sameRoot ? segments.slice(root.length) : segments).join('/');
    if (project.split('/').length < 2) throw new HttpError(400, 'Repository URL: expected https://host/<group>/<project>', 'GIT_REPO_PATH_INVALID');
    return { provider, repoUrl, apiBase, project };
  }
  const owner = segments.at(-2)!;
  const repo = segments.at(-1)!;
  const prefix = segments.slice(0, -2).join('/');
  const root = `${u.origin}${prefix ? `/${prefix}` : ''}`;
  const apiBase = apiOverride ?? (provider === 'github' ? (u.hostname === 'github.com' ? 'https://api.github.com' : `${root}/api/v3`) : `${root}/api/v1`);
  return { provider, repoUrl, apiBase, project: `${owner}/${repo}` };
}

/** Link to a file at a commit in the host's web UI. */
export function fileWebUrl(provider: GitProvider, repoUrl: string, sha: string, path: string): string {
  const p = path.split('/').map(encodeURIComponent).join('/');
  if (provider === 'github') return `${repoUrl}/blob/${sha}/${p}`;
  if (provider === 'gitlab') return `${repoUrl}/-/blob/${sha}/${p}`;
  return `${repoUrl}/src/commit/${sha}/${p}`;
}

/** Git object id of a blob: hash of the loose object header + content (SHA-1, or SHA-256 for repositories in the SHA-256 object format). */
export function gitBlobSha(content: Buffer, format: 'sha1' | 'sha256' = 'sha1'): string {
  return crypto.createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** The object format an object id belongs to (40 hex digits: SHA-1, 64: SHA-256). */
export const objectFormatOf = (id: string): 'sha1' | 'sha256' => (id.length === 64 ? 'sha256' : 'sha1');

const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);
const TIMEOUT_MS = 20_000;
/** JSON answers (branch, tree pages): trees of big repositories are a few MB. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(502, `The Git host sent ${declared} bytes – more than the limit of ${max}`, 'GIT_TOO_LARGE', { limit: max });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(502, `The Git host sent more than the limit of ${max} bytes`, 'GIT_TOO_LARGE', { limit: max });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function statusError(status: number, what: string): HttpError {
  if (status === 401 || status === 403)
    return new HttpError(502, `${what}: access denied (HTTP ${status}) – check the token and its read permission for the repository`, 'GIT_ACCESS_DENIED', {
      status,
    });
  if (status === 404)
    return new HttpError(502, `${what}: not found (HTTP 404) – check repository, branch and folder; private repositories need a token`, 'GIT_NOT_FOUND');
  if (status === 429) return new HttpError(502, `${what}: the Git host's rate limit was reached (HTTP 429) – try again later`, 'GIT_RATE_LIMITED');
  return new HttpError(502, `${what}: HTTP ${status} from the Git host`, 'GIT_HTTP_ERROR', { status });
}

class Client {
  private checked = false;
  constructor(
    private ref: RepoRef,
    private authHeaders: Record<string, string>,
  ) {}

  async get(
    path: string,
    what: string,
    opts: { max?: number; accept?: string; allow404?: boolean } = {},
  ): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const url = this.ref.apiBase + path;
    if (!this.checked) {
      // every request goes to the same API origin: one policy check per fetch, address safety on every connect
      await assertOutboundAllowed(url, outboundContext());
      this.checked = true;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: opts.accept ?? 'application/json', 'user-agent': BRAND.slug, ...this.authHeaders },
        redirect: 'manual',
        dispatcher,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      } as RequestInit);
    } catch (e) {
      const err = e as Error & { cause?: Error & { code?: string } };
      if (err.cause?.code === 'ESSRFBLOCKED') throw new HttpError(403, err.cause.message, 'GIT_BLOCKED', { detail: err.cause.message });
      throw new HttpError(502, `${what}: the Git host is not reachable (${err.cause?.message ?? err.message})`, 'GIT_UNREACHABLE', {
        detail: err.cause?.message ?? err.message,
      });
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(
        502,
        `${what}: the Git host answered with a redirect (HTTP ${res.status}). Redirects are not followed – check the repository and API URL.`,
        'GIT_REDIRECT',
        { status: res.status },
      );
    }
    if (res.status === 404 && opts.allow404) {
      await res.body?.cancel().catch(() => undefined);
      return { status: 404, body: Buffer.alloc(0), headers: res.headers };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw statusError(res.status, what);
    }
    return { status: res.status, body: await readCapped(res, opts.max ?? MAX_JSON_BYTES), headers: res.headers };
  }

  async json<T>(path: string, what: string): Promise<T> {
    const r = await this.get(path, what);
    try {
      return JSON.parse(r.body.toString('utf8')) as T;
    } catch {
      throw new HttpError(502, `${what}: the Git host did not answer with JSON`, 'GIT_BAD_RESPONSE');
    }
  }
}

const enc = encodeURIComponent;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function checkSha(sha: unknown, what: string): string {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new HttpError(502, `${what}: the Git host returned no valid commit id`, 'GIT_BAD_RESPONSE');
  return sha;
}

const signerList = (...ids: unknown[]): string[] => [
  ...new Set(ids.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().toLowerCase())),
];
const verifiedOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function historyUnknown(base: string): HttpError {
  return new HttpError(
    409,
    `The Git host cannot list the commits since the last fetched commit ${base.slice(0, 10)} (rewritten history, or a host without the compare API) – their signatures cannot be checked`,
    'GIT_HISTORY_UNKNOWN',
    { commit: base.slice(0, 10) },
  );
}

function tooManyCommits(count: number): HttpError {
  const limit = SYNC_LIMITS.maxCheckedCommits;
  return new HttpError(
    409,
    `${count} new commits since the last fetch – more than the ${limit} whose signatures Steward checks in one fetch`,
    'GIT_TOO_MANY_COMMITS',
    { count, limit },
  );
}

function decodeBlob(j: { content?: string; encoding?: string }, max: number): Buffer {
  if (typeof j.content !== 'string') throw new HttpError(502, 'Blob: no content in the answer', 'GIT_BAD_RESPONSE');
  const buf = j.encoding === 'base64' ? Buffer.from(j.content.replace(/\s/g, ''), 'base64') : Buffer.from(j.content, 'utf8');
  if (buf.length > max) throw new HttpError(502, `A file is larger than the limit of ${max} bytes`, 'GIT_TOO_LARGE', { limit: max });
  return buf;
}

/** Tag names in API paths: each segment encoded, the slashes kept (GitHub's ref API takes them as they are). */
const encPath = (name: string) => name.split('/').map(enc).join('/');

const notATag = (name: string) => new HttpError(502, `Tag ${name}: the tag does not point to a commit`, 'GIT_BAD_RESPONSE', { context: 'tag' });

const inFolder = (path: string, folder: string) => !folder || path.startsWith(`${folder}/`);

interface GiteaVerification {
  verified?: boolean;
  signer?: { username?: string; email?: string } | null;
}
const giteaCheck = (sha: string, v: GiteaVerification | undefined): CommitCheck => ({
  sha,
  verified: verifiedOf(v?.verified),
  signers: signerList(v?.signer?.username, v?.signer?.email),
});

function parseJsonBody<T>(body: Buffer, what: string): T {
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new HttpError(502, `${what}: the Git host did not answer with JSON`, 'GIT_BAD_RESPONSE');
  }
}

/** Forgejo and Gitea (/api/v1). */
function forgejo(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, token ? { authorization: `token ${token}` } : {});
  const repo = `/repos/${ref.project.split('/').map(enc).join('/')}`;
  return {
    async head(branch) {
      const j = await c.json<{ commit?: { id?: string; verification?: GiteaVerification } }>(`${repo}/branches/${enc(branch)}`, 'Branch');
      return giteaCheck(checkSha(j.commit?.id, 'Branch'), j.commit?.verification);
    },
    async tag(name) {
      // the tag's commit is already peeled (annotated tags too); its signature comes from the commit
      const t = await c.json<{ commit?: { sha?: string } }>(`${repo}/tags/${enc(name)}`, 'Tag');
      const sha = checkSha(t.commit?.sha, 'Tag');
      const j = await c.json<{ sha?: string; commit?: { verification?: GiteaVerification } }>(
        `${repo}/git/commits/${sha}?stat=false&verification=true&files=false`,
        'Tag commit',
      );
      if (j.sha !== sha) throw new HttpError(502, 'Tag commit: the Git host answered for another commit', 'GIT_BAD_RESPONSE');
      return giteaCheck(sha, j.commit?.verification);
    },
    async newCommits(base, head) {
      // Gitea ≥ 1.22 / Forgejo ≥ 7; without file lists, with the signature verification
      const r = await c.get(`${repo}/compare/${base}...${head}?verification=true&files=false`, 'Commits', { allow404: true });
      if (r.status === 404) throw historyUnknown(base);
      const j = parseJsonBody<{ total_commits?: number; commits?: { sha?: string; commit?: { verification?: GiteaVerification } }[] }>(r.body, 'Commits');
      const list = j.commits ?? [];
      const total = Math.max(j.total_commits ?? 0, list.length);
      if (total > SYNC_LIMITS.maxCheckedCommits) throw tooManyCommits(total);
      if (total > list.length) throw new HttpError(502, `Commits: the Git host listed only ${list.length} of ${total} new commits`, 'GIT_BAD_RESPONSE');
      return list.map((x) => giteaCheck(checkSha(x.sha, 'Commits'), x.commit?.verification));
    },
    async tree(sha, folder) {
      const out: TreeEntry[] = [];
      for (let page = 1; page <= 50; page++) {
        const j = await c.json<{ tree?: TreeEntry[]; truncated?: boolean; total_count?: number }>(
          `${repo}/git/trees/${sha}?recursive=true&per_page=1000&page=${page}`,
          'Tree',
        );
        const items = j.tree ?? [];
        out.push(...items);
        if (!j.truncated || !items.length || (j.total_count !== undefined && out.length >= j.total_count)) break;
        if (page === 50)
          throw new HttpError(413, 'The repository has too many files – point the source at a smaller repository or folder', 'GIT_TOO_MANY_FILES');
      }
      return out.filter((e) => inFolder(e.path, folder));
    },
    async blob(sha, max) {
      const j = await c.json<{ content?: string; encoding?: string }>(`${repo}/git/blobs/${sha}`, 'File');
      return decodeBlob(j, max);
    },
  };
}

interface GithubCommit {
  sha?: string;
  commit?: { committer?: { email?: string }; verification?: { verified?: boolean } };
  committer?: { login?: string } | null;
}
const githubCheck = (x: GithubCommit | undefined, what: string): CommitCheck => ({
  sha: checkSha(x?.sha, what),
  verified: verifiedOf(x?.commit?.verification?.verified),
  // GitHub verifies a signature only for a key of the committer's account
  signers: signerList(x?.committer?.login, x?.commit?.committer?.email),
});

function github(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, { 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const repo = `/repos/${ref.project.split('/').map(enc).join('/')}`;
  return {
    async head(branch) {
      // the branch endpoint carries the commit without its file list (small, unlike /commits/{ref})
      const j = await c.json<{ commit?: GithubCommit }>(`${repo}/branches/${enc(branch)}`, 'Branch');
      return githubCheck(j.commit, 'Branch');
    },
    async tag(name) {
      // refs/tags/<name> points to the commit (lightweight tag) or to a tag object (annotated, possibly nested)
      let obj = (await c.json<{ object?: { type?: string; sha?: string } }>(`${repo}/git/ref/tags/${encPath(name)}`, 'Tag')).object;
      for (let depth = 0; obj?.type === 'tag' && depth < 5; depth++) {
        obj = (await c.json<{ object?: { type?: string; sha?: string } }>(`${repo}/git/tags/${checkSha(obj.sha, 'Tag')}`, 'Tag')).object;
      }
      if (obj?.type !== 'commit') throw notATag(name);
      const sha = checkSha(obj.sha, 'Tag');
      // the commit with its signature; per_page=1 keeps the file list short
      const j = await c.json<GithubCommit>(`${repo}/commits/${sha}?per_page=1`, 'Tag commit');
      const check = githubCheck(j, 'Tag commit');
      if (check.sha !== sha) throw new HttpError(502, 'Tag commit: the Git host answered for another commit', 'GIT_BAD_RESPONSE');
      return check;
    },
    async newCommits(base, head) {
      const out: CommitCheck[] = [];
      const per = 100;
      for (let page = 1; ; page++) {
        const r = await c.get(`${repo}/compare/${base}...${head}?per_page=${per}&page=${page}`, 'Commits', { allow404: true });
        if (r.status === 404) throw historyUnknown(base);
        const j = parseJsonBody<{ total_commits?: number; commits?: GithubCommit[] }>(r.body, 'Commits');
        const total = j.total_commits ?? 0;
        if (total > SYNC_LIMITS.maxCheckedCommits) throw tooManyCommits(total);
        const list = j.commits ?? [];
        out.push(...list.map((x) => githubCheck(x, 'Commits')));
        if (out.length >= total || !list.length) break;
      }
      return out;
    },
    async tree(sha, folder) {
      const j = await c.json<{ tree?: TreeEntry[]; truncated?: boolean }>(`${repo}/git/trees/${sha}?recursive=1`, 'Tree');
      if (j.truncated) throw new HttpError(413, 'The repository tree is too large for the GitHub API – use a smaller repository', 'GIT_TOO_MANY_FILES');
      return (j.tree ?? []).filter((e) => inFolder(e.path, folder));
    },
    async blob(sha, max) {
      const j = await c.json<{ content?: string; encoding?: string }>(`${repo}/git/blobs/${sha}`, 'File');
      return decodeBlob(j, max);
    },
  };
}

interface GitlabCommit {
  id?: string;
  committer_email?: string;
}

function gitlab(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, token ? { 'private-token': token } : {});
  const project = `/projects/${enc(ref.project)}`;
  /** GitLab verifies a signature only when its key belongs to a user with the committer's e-mail address. */
  const check = async (sha: string, x: GitlabCommit | undefined): Promise<CommitCheck> => {
    // 404 = the commit is not signed
    const sig = await c.get(`${project}/repository/commits/${sha}/signature`, 'Commit signature', { allow404: true });
    if (sig.status === 404) return { sha, verified: false, signers: [] };
    let s: { verification_status?: string; gpg_key_user_email?: string; x509_certificate?: { email?: string } };
    try {
      s = JSON.parse(sig.body.toString('utf8'));
    } catch {
      return { sha, verified: null, signers: [] };
    }
    return { sha, verified: s.verification_status === 'verified', signers: signerList(x?.committer_email, s.gpg_key_user_email, s.x509_certificate?.email) };
  };
  return {
    async head(branch) {
      const j = await c.json<{ commit?: GitlabCommit }>(`${project}/repository/branches/${enc(branch)}`, 'Branch');
      return check(checkSha(j.commit?.id, 'Branch'), j.commit);
    },
    async tag(name) {
      // "commit" is the commit the tag points to (annotated tags are peeled by GitLab)
      const j = await c.json<{ commit?: GitlabCommit }>(`${project}/repository/tags/${enc(name)}`, 'Tag');
      return check(checkSha(j.commit?.id, 'Tag'), j.commit);
    },
    async newCommits(base, head) {
      const known = await c.get(`${project}/repository/commits/${base}?stats=false`, 'Commit', { allow404: true });
      if (known.status === 404) throw historyUnknown(base);
      const list: GitlabCommit[] = [];
      for (let page = 1; ; page++) {
        const r = await c.get(`${project}/repository/commits?ref_name=${enc(`${base}..${head}`)}&per_page=100&page=${page}`, 'Commits');
        const items = parseJsonBody<GitlabCommit[]>(r.body, 'Commits');
        if (!Array.isArray(items)) throw new HttpError(502, 'Commits: unexpected answer of the Git host', 'GIT_BAD_RESPONSE');
        list.push(...items);
        if (list.length > SYNC_LIMITS.maxCheckedCommits) throw tooManyCommits(list.length);
        if (!r.headers.get('x-next-page') || !items.length) break;
      }
      // GitLab lists commits without their signatures: one request per commit
      const out: CommitCheck[] = [];
      for (const x of list) out.push(await check(checkSha(x.id, 'Commits'), x));
      return out;
    },
    async tree(sha, folder) {
      const out: TreeEntry[] = [];
      for (let page = 1; page <= 100; page++) {
        const r = await c.get(`${project}/repository/tree?ref=${sha}&recursive=true&per_page=100&page=${page}${folder ? `&path=${enc(folder)}` : ''}`, 'Tree');
        let items: { id: string; path: string; type: string; mode: string }[];
        try {
          items = JSON.parse(r.body.toString('utf8'));
        } catch {
          throw new HttpError(502, 'Tree: the Git host did not answer with JSON', 'GIT_BAD_RESPONSE');
        }
        out.push(...items.map((i) => ({ path: i.path, type: i.type, mode: i.mode, sha: i.id })));
        const next = r.headers.get('x-next-page');
        if (!next || !items.length) break;
        if (page === 100) throw new HttpError(413, 'The repository has too many files – point the source at a smaller folder', 'GIT_TOO_MANY_FILES');
      }
      return out.filter((e) => inFolder(e.path, folder));
    },
    async blob(sha, max) {
      return (await c.get(`${project}/repository/blobs/${sha}/raw`, 'File', { max, accept: '*/*' })).body;
    },
  };
}

export function gitApi(ref: RepoRef, token?: string): GitApi {
  if (ref.provider === 'github') return github(ref, token);
  if (ref.provider === 'gitlab') return gitlab(ref, token);
  return forgejo(ref, token);
}
