import crypto from 'node:crypto';
import { EnvHttpProxyAgent } from 'undici';
import { BRAND, type GitProvider } from '@sm/shared';
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
 *     object id (SHA-1 of "blob <size>\0<content>"), so the content is the one the tree names.
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

export interface GitApi {
  /** Head commit of the branch and whether the host verified its signature (null: unknown). */
  head(branch: string): Promise<{ sha: string; verified: boolean | null }>;
  /** All entries of the commit's tree (recursive) below `folder` ('' = everything). */
  tree(sha: string, folder: string): Promise<TreeEntry[]>;
  blob(sha: string, maxBytes: number): Promise<Buffer>;
}

export class SyncError extends HttpError {
  constructor(message: string, status = 502) {
    super(status, message, 'SYNC_FAILED');
  }
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function parseHttpUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, `${what}: not a valid URL`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new HttpError(400, `${what}: only https:// URLs are allowed (http:// only for localhost)`);
  }
  if (u.username || u.password) throw new HttpError(400, `${what}: put the access token in the token field, not in the URL`);
  if (u.search || u.hash) throw new HttpError(400, `${what}: no query string or fragment`);
  return u;
}

/** Repository URL (+ optional API URL) → where the API lives and how the project is addressed. */
export function resolveRepo(provider: GitProvider, repoUrlRaw: string, apiUrlRaw?: string): RepoRef {
  const u = parseHttpUrl(repoUrlRaw, 'Repository URL');
  const segments = u.pathname
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.some((s) => !NAME.test(s) || s === '.' || s === '..')) throw new HttpError(400, 'Repository URL: unexpected characters in the path');
  if (segments.length < 2) throw new HttpError(400, 'Repository URL: expected https://host/<owner>/<repository>');
  const repoUrl = `${u.origin}/${segments.join('/')}`;
  const api = apiUrlRaw?.trim() ? parseHttpUrl(apiUrlRaw, 'API URL') : null;
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
    if (project.split('/').length < 2) throw new HttpError(400, 'Repository URL: expected https://host/<group>/<project>');
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

/** Git object id of a blob (SHA-1 of the loose object header + content). */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);
const TIMEOUT_MS = 20_000;
/** JSON answers (branch, tree pages): trees of big repositories are a few MB. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new SyncError(`The Git host sent ${declared} bytes – more than the limit of ${max}`);
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
      throw new SyncError(`The Git host sent more than the limit of ${max} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function statusError(status: number, what: string): SyncError {
  if (status === 401 || status === 403)
    return new SyncError(`${what}: access denied (HTTP ${status}) – check the token and its read permission for the repository`);
  if (status === 404) return new SyncError(`${what}: not found (HTTP 404) – check repository, branch and folder; private repositories need a token`);
  if (status === 429) return new SyncError(`${what}: the Git host's rate limit was reached (HTTP 429) – try again later`);
  return new SyncError(`${what}: HTTP ${status} from the Git host`);
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
      if (err.cause?.code === 'ESSRFBLOCKED') throw new SyncError(err.cause.message, 403);
      throw new SyncError(`${what}: the Git host is not reachable (${err.cause?.message ?? err.message})`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new SyncError(
        `${what}: the Git host answered with a redirect (HTTP ${res.status}). Redirects are not followed – check the repository and API URL.`,
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
      throw new SyncError(`${what}: the Git host did not answer with JSON`);
    }
  }
}

const enc = encodeURIComponent;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function checkSha(sha: unknown, what: string): string {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new SyncError(`${what}: the Git host returned no valid commit id`);
  return sha;
}

function decodeBlob(j: { content?: string; encoding?: string }, max: number): Buffer {
  if (typeof j.content !== 'string') throw new SyncError('Blob: no content in the answer');
  const buf = j.encoding === 'base64' ? Buffer.from(j.content.replace(/\s/g, ''), 'base64') : Buffer.from(j.content, 'utf8');
  if (buf.length > max) throw new SyncError(`A file is larger than the limit of ${max} bytes`);
  return buf;
}

const inFolder = (path: string, folder: string) => !folder || path.startsWith(`${folder}/`);

/** Forgejo and Gitea (/api/v1). */
function forgejo(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, token ? { authorization: `token ${token}` } : {});
  const repo = `/repos/${ref.project.split('/').map(enc).join('/')}`;
  return {
    async head(branch) {
      const j = await c.json<{ commit?: { id?: string; verification?: { verified?: boolean } } }>(`${repo}/branches/${enc(branch)}`, 'Branch');
      const sha = checkSha(j.commit?.id, 'Branch');
      const v = j.commit?.verification?.verified;
      return { sha, verified: typeof v === 'boolean' ? v : null };
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
        if (page === 50) throw new SyncError('The repository has too many files – point the source at a smaller repository or folder');
      }
      return out.filter((e) => inFolder(e.path, folder));
    },
    async blob(sha, max) {
      const j = await c.json<{ content?: string; encoding?: string }>(`${repo}/git/blobs/${sha}`, 'File');
      return decodeBlob(j, max);
    },
  };
}

function github(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, { 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const repo = `/repos/${ref.project.split('/').map(enc).join('/')}`;
  return {
    async head(branch) {
      // the branch endpoint carries the commit without its file list (small, unlike /commits/{ref})
      const j = await c.json<{ commit?: { sha?: string; commit?: { verification?: { verified?: boolean } } } }>(`${repo}/branches/${enc(branch)}`, 'Branch');
      const sha = checkSha(j.commit?.sha, 'Branch');
      const v = j.commit?.commit?.verification?.verified;
      return { sha, verified: typeof v === 'boolean' ? v : null };
    },
    async tree(sha, folder) {
      const j = await c.json<{ tree?: TreeEntry[]; truncated?: boolean }>(`${repo}/git/trees/${sha}?recursive=1`, 'Tree');
      if (j.truncated) throw new SyncError('The repository tree is too large for the GitHub API – use a smaller repository');
      return (j.tree ?? []).filter((e) => inFolder(e.path, folder));
    },
    async blob(sha, max) {
      const j = await c.json<{ content?: string; encoding?: string }>(`${repo}/git/blobs/${sha}`, 'File');
      return decodeBlob(j, max);
    },
  };
}

function gitlab(ref: RepoRef, token?: string): GitApi {
  const c = new Client(ref, token ? { 'private-token': token } : {});
  const project = `/projects/${enc(ref.project)}`;
  return {
    async head(branch) {
      const j = await c.json<{ commit?: { id?: string } }>(`${project}/repository/branches/${enc(branch)}`, 'Branch');
      const sha = checkSha(j.commit?.id, 'Branch');
      // 404 = the commit is not signed
      const sig = await c.get(`${project}/repository/commits/${sha}/signature`, 'Commit signature', { allow404: true });
      if (sig.status === 404) return { sha, verified: false };
      try {
        const s = JSON.parse(sig.body.toString('utf8')) as { verification_status?: string };
        return { sha, verified: s.verification_status === 'verified' };
      } catch {
        return { sha, verified: null };
      }
    },
    async tree(sha, folder) {
      const out: TreeEntry[] = [];
      for (let page = 1; page <= 100; page++) {
        const r = await c.get(`${project}/repository/tree?ref=${sha}&recursive=true&per_page=100&page=${page}${folder ? `&path=${enc(folder)}` : ''}`, 'Tree');
        let items: { id: string; path: string; type: string; mode: string }[];
        try {
          items = JSON.parse(r.body.toString('utf8'));
        } catch {
          throw new SyncError('Tree: the Git host did not answer with JSON');
        }
        out.push(...items.map((i) => ({ path: i.path, type: i.type, mode: i.mode, sha: i.id })));
        const next = r.headers.get('x-next-page');
        if (!next || !items.length) break;
        if (page === 100) throw new SyncError('The repository has too many files – point the source at a smaller folder');
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
