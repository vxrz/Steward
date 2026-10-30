import {
  ALERT_SEVERITIES,
  GIT_LIMITS,
  isGitPlatformKind,
  REPOSITORY_PATH_RE,
  STACK_FILES,
  stackHints,
  type AccessSubject,
  type AlertSeverity,
  type GitPlatformKind,
  type PipelineState,
  type Platform,
  type RepositoryKey,
  type RepositoryReadout,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { platformRequest } from '../platforms/http.js';
import { platformFor } from '../monitors/platforms.js';
import { isKnownProduct, matchSbom, stackSummary, type StackDiff } from './components.js';
import { mapImages, older, syncStack } from './kubernetes.js';
import { lifecycleSettings } from './lifecycle.js';

/**
 * Git platforms (#107): GitHub (also Enterprise Server), GitLab and Forgejo/Gitea as connectors. A component of type
 * repository names the platform and the repository path; Steward reads – read-only, with the platform's token – the
 * default branch and its pipeline, the latest release, open security alerts, packages and images, deploy keys and
 * tokens (offered for the credentials register, never their values), and the tech stack from the usual files
 * (Dockerfile, package.json, go.mod …; source "repository", entries entered by hand win).
 *
 * The platform's base URL is the API: https://api.github.com (GitHub Enterprise: https://host/api/v3),
 * https://host/api/v4 (GitLab), https://host/api/v1 (Forgejo, Gitea).
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_JSON = 4 * 1024 * 1024;
const enc = encodeURIComponent;
const encPath = (p: string) => p.split('/').map(enc).join('/');

class Answer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** GET on the platform; 404 (and, when `optional`, 401/403) answer null, other errors throw a readable message. */
async function get(
  platform: Platform,
  secrets: Record<string, string>,
  path: string,
  o: { optional?: boolean; raw?: boolean; accept?: string; max?: number } = {},
): Promise<unknown> {
  const r = await platformRequest(
    platform,
    secrets,
    {
      method: 'GET',
      url: path,
      headers: { accept: o.accept ?? 'application/json', ...(platform.kind === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}) },
      maxResponseBytes: o.max ?? MAX_JSON,
      rawText: o.raw,
      noRedirects: true,
    },
    AbortSignal.timeout(30000),
  );
  if (r.ok) return r.body;
  if (r.status === 404) return null;
  if (o.optional && (r.status === 401 || r.status === 403)) return new Answer(r.status, null);
  const msg = (r.body as { message?: string } | null)?.message;
  const detail = msg ? `: ${String(msg).slice(0, 200)}` : '';
  if (r.status === 401) throw new Error(`the Git host refused the token (401)${detail}`);
  if (r.status === 403) throw new Error(`no permission (403)${detail} – see the token rights in docs/GIT-PLATFORMS.md`);
  throw new Error(`the Git host answered HTTP ${r.status}${detail}`);
}

const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const denied = (v: unknown) => v instanceof Answer;
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const firstLine = (m: unknown) =>
  String(m ?? '')
    .split('\n')[0]!
    .slice(0, 200);

/** All pages of a list (access reviews must be complete), at most 20 pages. */
async function allPages(platform: Platform, secrets: Record<string, string>, path: string, perPage = 100): Promise<Obj[]> {
  const out: Obj[] = [];
  const sep = path.includes('?') ? '&' : '?';
  const size = platform.kind === 'forgejo' ? 'limit' : 'per_page';
  for (let page = 1; page <= 20; page++) {
    const r = await get(platform, secrets, `${path}${sep}${size}=${perPage}&page=${page}`);
    if (r === null) {
      if (page === 1) throw new Error(`not found: ${path.split('?')[0]}`);
      break;
    }
    const items = list(r);
    out.push(...items);
    if (items.length < perPage) return out;
  }
  throw new Error(`more than ${20 * perPage} entries – Steward reads at most that many`);
}

// ---------- the three hosts ----------

interface Host {
  repo(path: string): Promise<{ webUrl: string | null; defaultBranch: string | null; archived: boolean }>;
  head(path: string, branch: string): Promise<RepositoryReadout['head']>;
  pipeline(path: string, branch: string, sha: string | null): Promise<RepositoryReadout['pipeline']>;
  release(path: string): Promise<RepositoryReadout['release']>;
  alerts(path: string, webUrl: string | null): Promise<RepositoryReadout['alerts']>;
  packages(path: string): Promise<RepositoryReadout['packages']>;
  keys(path: string): Promise<RepositoryKey[] | null>;
  file(path: string, ref: string, name: string): Promise<string | null>;
  /** Who has which rights: a repository (owner/repo, GitLab project) or an organisation / group */
  access(scope: string): Promise<AccessSubject[]>;
}

const overall = (states: PipelineState[]): PipelineState =>
  states.includes('failed') ? 'failed' : states.includes('running') ? 'running' : states.includes('success') ? 'success' : 'none';

const emptyAlerts = (): Record<AlertSeverity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });
const severity = (v: unknown): AlertSeverity => {
  const x = String(v ?? '').toLowerCase();
  return x === 'moderate' ? 'medium' : (ALERT_SEVERITIES as readonly string[]).includes(x) ? (x as AlertSeverity) : 'low';
};

const subject = (id: string, rights: string[], type = 'user'): AccessSubject => ({ id, name: id, type, rights: [...new Set(rights)].sort() });

function github(p: Platform, sec: Record<string, string>): Host {
  const r = (path: string) => `/repos/${encPath(path)}`;
  return {
    async repo(path) {
      const j = (await get(p, sec, r(path))) as Obj | null;
      if (!j) throw new Error(`no repository "${path}" (or the token may not read it)`);
      return { webUrl: s(j.html_url), defaultBranch: s(j.default_branch), archived: !!j.archived };
    },
    async head(path, branch) {
      const j = (await get(p, sec, `${r(path)}/commits/${enc(branch)}`)) as Obj | null;
      return j ? { sha: String(j.sha), at: s(j.commit?.committer?.date), message: firstLine(j.commit?.message) } : null;
    },
    async pipeline(path, branch) {
      const j = (await get(p, sec, `${r(path)}/actions/runs?branch=${enc(branch)}&per_page=${GIT_LIMITS.runs}&exclude_pull_requests=true`, {
        optional: true,
      })) as Obj | null;
      const seen = new Set<string>();
      const runs: RepositoryReadout['pipeline']['runs'] = [];
      for (const run of list(denied(j) ? null : j?.workflow_runs)) {
        if (run.event === 'pull_request' || ['cancelled', 'skipped'].includes(run.conclusion)) continue;
        const key = String(run.workflow_id ?? run.name);
        if (seen.has(key)) continue;
        seen.add(key);
        const state: PipelineState = run.status !== 'completed' ? 'running' : ['success', 'neutral'].includes(run.conclusion) ? 'success' : 'failed';
        runs.push({ name: String(run.name ?? key).slice(0, 200), state, url: s(run.html_url), at: s(run.updated_at) });
      }
      return { state: overall(runs.map((x) => x.state)), runs };
    },
    async release(path) {
      const j = (await get(p, sec, `${r(path)}/releases/latest`, { optional: true })) as Obj | null;
      return j && !denied(j) ? { tag: String(j.tag_name ?? ''), at: s(j.published_at), url: s(j.html_url) } : null;
    },
    async alerts(path, webUrl) {
      const j = await get(p, sec, `${r(path)}/dependabot/alerts?state=open&per_page=100`, { optional: true });
      if (j === null || denied(j)) return null;
      const out = emptyAlerts();
      for (const a of list(j)) out[severity(a.security_advisory?.severity ?? a.security_vulnerability?.severity)]++;
      return { ...out, url: webUrl ? `${webUrl}/security/dependabot` : null };
    },
    async packages(path) {
      const owner = path.split('/')[0]!;
      let j = await get(p, sec, `/orgs/${enc(owner)}/packages?package_type=container&per_page=100`, { optional: true });
      if (j === null) j = await get(p, sec, `/users/${enc(owner)}/packages?package_type=container&per_page=100`, { optional: true });
      if (j === null || denied(j)) return null;
      return list(j)
        .filter((x) => String(x.repository?.full_name ?? '').toLowerCase() === path.toLowerCase())
        .slice(0, GIT_LIMITS.listed)
        .map((x) => ({ name: String(x.name), type: String(x.package_type ?? 'container'), version: null, url: s(x.html_url) }));
    },
    async keys(path) {
      const j = await get(p, sec, `${r(path)}/keys?per_page=100`, { optional: true });
      if (j === null || denied(j)) return null;
      return list(j).map((k) => ({
        id: String(k.id),
        kind: 'deploy-key' as const,
        title: String(k.title ?? '').slice(0, 200),
        write: k.read_only === false,
        scopes: [],
        createdAt: s(k.created_at),
        expiresAt: null,
        lastUsedAt: s(k.last_used),
      }));
    },
    async file(path, ref, name) {
      const t = await get(p, sec, `${r(path)}/contents/${encPath(name)}?ref=${enc(ref)}`, {
        raw: true,
        accept: 'application/vnd.github.raw+json',
        max: GIT_LIMITS.stackFileBytes,
        optional: true,
      });
      return typeof t === 'string' ? t : null;
    },
    async access(scope) {
      if (scope.includes('/')) {
        const direct = await allPages(p, sec, `${r(scope)}/collaborators?affiliation=direct`);
        const outside = new Set((await allPages(p, sec, `${r(scope)}/collaborators?affiliation=outside`)).map((x) => String(x.login).toLowerCase()));
        const all = await allPages(p, sec, `${r(scope)}/collaborators?affiliation=all`);
        return all.map((x) =>
          subject(String(x.login), [
            String(x.role_name ?? 'read'),
            ...(outside.has(String(x.login).toLowerCase()) ? ['outside-collaborator'] : []),
            ...(direct.some((d) => d.login === x.login) ? [] : ['via-team-or-org']),
          ]),
        );
      }
      const o = `/orgs/${enc(scope)}`;
      const admins = await allPages(p, sec, `${o}/members?role=admin`);
      const members = await allPages(p, sec, `${o}/members?role=member`);
      const outside = await allPages(p, sec, `${o}/outside_collaborators`);
      return [
        ...admins.map((x) => subject(String(x.login), ['owner'])),
        ...members.map((x) => subject(String(x.login), ['member'])),
        ...outside.map((x) => subject(String(x.login), ['outside-collaborator'])),
      ];
    },
  };
}

const GITLAB_LEVELS: Record<number, string> = { 5: 'minimal', 10: 'guest', 15: 'planner', 20: 'reporter', 30: 'developer', 40: 'maintainer', 50: 'owner' };

function gitlab(p: Platform, sec: Record<string, string>): Host {
  const r = (path: string) => `/projects/${enc(path)}`;
  return {
    async repo(path) {
      const j = (await get(p, sec, r(path))) as Obj | null;
      if (!j) throw new Error(`no project "${path}" (or the token may not read it)`);
      return { webUrl: s(j.web_url), defaultBranch: s(j.default_branch), archived: !!j.archived };
    },
    async head(path, branch) {
      const j = (await get(p, sec, `${r(path)}/repository/branches/${enc(branch)}`)) as Obj | null;
      return j?.commit ? { sha: String(j.commit.id), at: s(j.commit.committed_date), message: firstLine(j.commit.title) } : null;
    },
    async pipeline(path, branch) {
      const j = await get(p, sec, `${r(path)}/pipelines?ref=${enc(branch)}&per_page=20`, { optional: true });
      const run = list(denied(j) ? null : j).find((x) => ['success', 'failed', 'running', 'pending', 'preparing', 'waiting_for_resource'].includes(x.status));
      if (!run) return { state: 'none', runs: [] };
      const state: PipelineState = run.status === 'success' ? 'success' : run.status === 'failed' ? 'failed' : 'running';
      return { state, runs: [{ name: `Pipeline #${run.iid ?? run.id}`, state, url: s(run.web_url), at: s(run.updated_at) }] };
    },
    async release(path) {
      const j = await get(p, sec, `${r(path)}/releases?per_page=1`, { optional: true });
      const x = list(denied(j) ? null : j)[0];
      return x ? { tag: String(x.tag_name ?? ''), at: s(x.released_at), url: s(x._links?.self) } : null;
    },
    // vulnerabilities are only in GitLab Ultimate's GraphQL API
    async alerts() {
      return null;
    },
    async packages(path) {
      const images = await get(p, sec, `${r(path)}/registry/repositories?per_page=100`, { optional: true });
      const pkgs = await get(p, sec, `${r(path)}/packages?per_page=100`, { optional: true });
      if ((images === null || denied(images)) && (pkgs === null || denied(pkgs))) return null;
      return [
        ...list(denied(images) ? null : images).map((x) => ({ name: String(x.path ?? x.name), type: 'container', version: null, url: s(x.location) })),
        ...list(denied(pkgs) ? null : pkgs).map((x) => ({
          name: String(x.name),
          type: String(x.package_type ?? ''),
          version: s(x.version),
          url: s(x._links?.web_path),
        })),
      ].slice(0, GIT_LIMITS.listed);
    },
    async keys(path) {
      const keys = await get(p, sec, `${r(path)}/deploy_keys?per_page=100`, { optional: true });
      const deployTokens = await get(p, sec, `${r(path)}/deploy_tokens?active=true&per_page=100`, { optional: true });
      const tokens = await get(p, sec, `${r(path)}/access_tokens?state=active&per_page=100`, { optional: true });
      if ([keys, deployTokens, tokens].every((x) => x === null || denied(x))) return null;
      const writeScope = (scopes: string[]) => scopes.some((x) => /write|^api$/.test(x));
      return [
        ...list(denied(keys) ? null : keys).map((k) => ({
          id: String(k.id),
          kind: 'deploy-key' as const,
          title: String(k.title ?? '').slice(0, 200),
          write: !!k.can_push,
          scopes: [],
          createdAt: s(k.created_at),
          expiresAt: s(k.expires_at),
          lastUsedAt: null,
        })),
        ...list(denied(deployTokens) ? null : deployTokens)
          .filter((t) => !t.revoked && !t.expired)
          .map((t) => ({
            id: String(t.id),
            kind: 'deploy-token' as const,
            title: String(t.name ?? '').slice(0, 200),
            write: writeScope(list(t.scopes) as unknown as string[]),
            scopes: (list(t.scopes) as unknown as string[]).map(String),
            createdAt: null,
            expiresAt: s(t.expires_at),
            lastUsedAt: null,
          })),
        ...list(denied(tokens) ? null : tokens)
          .filter((t) => t.active !== false && !t.revoked)
          .map((t) => ({
            id: String(t.id),
            kind: 'access-token' as const,
            title: String(t.name ?? '').slice(0, 200),
            write: writeScope(list(t.scopes) as unknown as string[]),
            scopes: (list(t.scopes) as unknown as string[]).map(String),
            createdAt: s(t.created_at),
            expiresAt: s(t.expires_at),
            lastUsedAt: s(t.last_used_at),
          })),
      ];
    },
    async file(path, ref, name) {
      const t = await get(p, sec, `${r(path)}/repository/files/${enc(name)}/raw?ref=${enc(ref)}`, {
        raw: true,
        max: GIT_LIMITS.stackFileBytes,
        optional: true,
      });
      return typeof t === 'string' ? t : null;
    },
    async access(scope) {
      const level = (x: Obj) => GITLAB_LEVELS[Number(x.access_level)] ?? `level-${x.access_level}`;
      // a project, else a group
      const project = await get(p, sec, r(scope), { optional: true });
      const base = project && !denied(project) ? r(scope) : `/groups/${enc(scope)}`;
      const members = await allPages(p, sec, `${base}/members/all`);
      return members.map((x) => subject(String(x.username), [level(x), ...(x.state && x.state !== 'active' ? [String(x.state)] : [])], x.bot ? 'bot' : 'user'));
    },
  };
}

function forgejo(p: Platform, sec: Record<string, string>): Host {
  const r = (path: string) => `/repos/${encPath(path)}`;
  return {
    async repo(path) {
      const j = (await get(p, sec, r(path))) as Obj | null;
      if (!j) throw new Error(`no repository "${path}" (or the token may not read it)`);
      return { webUrl: s(j.html_url), defaultBranch: s(j.default_branch), archived: !!j.archived };
    },
    async head(path, branch) {
      const j = (await get(p, sec, `${r(path)}/branches/${enc(branch)}`)) as Obj | null;
      return j?.commit ? { sha: String(j.commit.id), at: s(j.commit.timestamp), message: firstLine(j.commit.message) } : null;
    },
    async pipeline(path, _branch, sha) {
      if (!sha) return { state: 'none', runs: [] };
      const j = (await get(p, sec, `${r(path)}/commits/${enc(sha)}/status`, { optional: true })) as Obj | null;
      const toState = (v: unknown): PipelineState =>
        v === 'success' || v === 'warning' ? 'success' : v === 'failure' || v === 'error' ? 'failed' : v === 'pending' ? 'running' : 'none';
      const runs = list(denied(j) ? null : j?.statuses).map((x) => ({
        name: String(x.context ?? '').slice(0, 200),
        state: toState(x.status ?? x.state),
        url: s(x.target_url),
        at: s(x.updated_at),
      }));
      return { state: runs.length ? overall(runs.map((x) => x.state)) : 'none', runs };
    },
    async release(path) {
      const j = (await get(p, sec, `${r(path)}/releases/latest`, { optional: true })) as Obj | null;
      return j && !denied(j) ? { tag: String(j.tag_name ?? ''), at: s(j.published_at), url: s(j.html_url) } : null;
    },
    async alerts() {
      return null;
    },
    async packages(path) {
      const owner = path.split('/')[0]!;
      const j = await get(p, sec, `/packages/${enc(owner)}?limit=50`, { optional: true });
      if (j === null || denied(j)) return null;
      return list(j)
        .filter((x) => String(x.repository?.full_name ?? '').toLowerCase() === path.toLowerCase())
        .slice(0, GIT_LIMITS.listed)
        .map((x) => ({ name: String(x.name), type: String(x.type ?? ''), version: s(x.version), url: s(x.html_url) }));
    },
    async keys(path) {
      const j = await get(p, sec, `${r(path)}/keys?limit=50`, { optional: true });
      if (j === null || denied(j)) return null;
      return list(j).map((k) => ({
        id: String(k.id),
        kind: 'deploy-key' as const,
        title: String(k.title ?? '').slice(0, 200),
        write: k.read_only === false,
        scopes: [],
        createdAt: s(k.created_at),
        expiresAt: null,
        lastUsedAt: null,
      }));
    },
    async file(path, ref, name) {
      const t = await get(p, sec, `${r(path)}/raw/${encPath(name)}?ref=${enc(ref)}`, { raw: true, max: GIT_LIMITS.stackFileBytes, optional: true });
      return typeof t === 'string' ? t : null;
    },
    async access(scope) {
      if (scope.includes('/')) {
        const users = await allPages(p, sec, `${r(scope)}/collaborators`, 50);
        const out: AccessSubject[] = [];
        for (const u of users) {
          const perm = (await get(p, sec, `${r(scope)}/collaborators/${enc(String(u.login))}/permission`)) as Obj | null;
          out.push(subject(String(u.login), [String(perm?.role_name ?? perm?.permission ?? 'read')]));
        }
        return out;
      }
      const teams = await allPages(p, sec, `/orgs/${enc(scope)}/teams`, 50);
      const rights = new Map<string, string[]>();
      for (const t of teams)
        for (const m of await allPages(p, sec, `/teams/${enc(String(t.id))}/members`, 50)) {
          const login = String(m.login);
          rights.set(login, [...(rights.get(login) ?? []), String(t.name).toLowerCase() === 'owners' ? 'owner' : `team:${t.name}`]);
        }
      return [...rights].map(([login, r]) => subject(login, r));
    },
  };
}

export function gitHost(platform: Platform, secrets: Record<string, string>): Host {
  if (platform.kind === 'github') return github(platform, secrets);
  if (platform.kind === 'gitlab') return gitlab(platform, secrets);
  if (platform.kind === 'forgejo') return forgejo(platform, secrets);
  throw new HttpError(400, 'Choose a GitHub, GitLab or Forgejo/Gitea platform', 'COMPONENT_REPOSITORY_PLATFORM');
}

export function assertRepositoryPath(path: string): void {
  if (!REPOSITORY_PATH_RE.test(path) || path.split('/').some((x) => x === '.' || x === '..'))
    throw new HttpError(400, 'The repository path is owner/repository (GitLab: group/project)', 'COMPONENT_REPOSITORY_PATH', { path });
}

// ---------- reading a repository ----------

/** The products a repository's files name: images and runtime files the oldest version, packages like an SBOM. */
export function stackOfFiles(files: Record<string, string>): { found: Map<string, { version: string; ref: string }>; unmapped: string[] } {
  const hints = stackHints(files);
  const images = mapImages(
    hints.flatMap((h) => (h.kind === 'image' ? [h.image] : [])),
    lifecycleSettings().imageMap ?? [],
  );
  const found = images.found;
  const put = (product: string, version: string, ref: string) => {
    const prev = found.get(product);
    if (!prev || (version && (!prev.version || older(version, prev.version)))) found.set(product, { version, ref });
  };
  for (const h of hints) if (h.kind === 'product' && isKnownProduct(h.product)) put(h.product, h.version, h.file);
  const pkgs = matchSbom(hints.flatMap((h) => (h.kind === 'package' ? [{ name: '', version: h.version, purl: h.purl, cpes: [], os: false }] : [])));
  for (const [product, f] of pkgs) put(product, f.version, f.ref);
  return { found, unmapped: images.unmapped };
}

/** Reads a repository (everything but its access list). */
export async function readRepository(
  platform: Platform,
  secrets: Record<string, string>,
  path: string,
): Promise<Omit<RepositoryReadout, 'readAt' | 'error'> & { files: Record<string, string> }> {
  assertRepositoryPath(path);
  const host = gitHost(platform, secrets);
  const info = await host.repo(path);
  const branch = info.defaultBranch ?? 'main';
  const head = await host.head(path, branch);
  const [pipeline, release, alerts, packages, keys] = await Promise.all([
    host.pipeline(path, branch, head?.sha ?? null),
    host.release(path),
    host.alerts(path, info.webUrl),
    host.packages(path),
    host.keys(path),
  ]);
  const files: Record<string, string> = {};
  if (head)
    for (const name of STACK_FILES) {
      const text = await host.file(path, head.sha, name);
      if (text !== null) files[name] = text;
    }
  return { ...info, defaultBranch: branch, head, pipeline, release, alerts, packages, keys, stackFiles: Object.keys(files), unmapped: [], files };
}

interface Row {
  id: string;
  application_id: string;
  name: string;
  environment: string;
  platform_id: string | null;
  updated_by: string;
}

/**
 * Reads the repository of a component now, with the rights of `actor` on the Git platform, and stores what it found.
 * A read that fails keeps the stack and records the error.
 */
export async function refreshRepository(componentId: string, actor: string, now = Date.now()): Promise<RepositoryReadout> {
  const c = db().get<Row>("SELECT * FROM application_components WHERE id = ? AND type = 'repository'", componentId);
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.platform_id) throw new HttpError(400, 'Choose the Git platform of the repository first', 'COMPONENT_REPOSITORY_REQUIRED');
  const at = new Date(now).toISOString();
  let readout: RepositoryReadout;
  let diff: StackDiff = { added: [], changed: [], removed: [] };
  try {
    const { platform, secrets } = platformFor(actor, c.platform_id);
    if (!isGitPlatformKind(platform.kind)) throw new Error('the platform is not a GitHub, GitLab or Forgejo/Gitea platform');
    const { files, ...r } = await readRepository(platform, secrets, c.name);
    const { found, unmapped } = stackOfFiles(files);
    readout = { readAt: at, error: null, ...r, unmapped };
    db().tx(() => {
      diff = syncStack(componentId, found, actor, nowIso(), 'repository');
    });
  } catch (e) {
    const prev = parseJson<RepositoryReadout | null>(
      db().get<{ repo_state: string | null }>('SELECT repo_state FROM application_components WHERE id = ?', componentId)?.repo_state ?? null,
      null,
    );
    readout = {
      ...(prev ?? {
        webUrl: null,
        defaultBranch: null,
        archived: false,
        head: null,
        pipeline: { state: 'none', runs: [] },
        release: null,
        alerts: null,
        packages: null,
        keys: null,
        stackFiles: [],
        unmapped: [],
      }),
      readAt: at,
      error: (e as Error).message.slice(0, 500),
    };
  }
  db().run('UPDATE application_components SET repo_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  if (diff.added.length || diff.changed.length || diff.removed.length)
    audit({
      action: 'application.component_repository_read',
      entityType: 'application',
      entityId: c.application_id,
      actor,
      summary: `Tech stack of the repository "${c.name}" read from its files: ${stackSummary(diff)}`,
      details: { componentId, ...diff },
    });
  return readout;
}

/** The job: every repository with a Git platform, read again after GIT_LIMITS.refreshHours, as whoever last changed the component. */
export async function runRepositoryJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<Row & { repo_state: string | null }>(
    `SELECT c.* FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE c.type = 'repository' AND c.platform_id IS NOT NULL AND a.archived = 0`,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<RepositoryReadout | null>(r.repo_state, null);
    if (last && now - Date.parse(last.readAt) < GIT_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshRepository(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading a repository failed');
    }
  }
  return n;
}

export type { GitPlatformKind };
