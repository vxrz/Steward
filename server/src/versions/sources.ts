import { EnvHttpProxyAgent, fetch } from 'undici';
import { BRAND, VERSION_LIMITS, type Platform } from '@sm/shared';
import { HttpError } from '../util.js';
import { assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { platformRequest, resolveBaseUrl, secretValues, type HttpResult } from '../platforms/http.js';
import { where } from '../platforms/answers.js';
import { purlText, registryUrl, trimSlashes, type Purl } from './purl.js';

/**
 * Reading versions for the version watch (#241) – read-only, every answer bounded in size and time:
 *
 *   registry  GET on the public registry (or a mirror) – no credentials, no cookies, redirects not followed, the
 *             outbound policy decides whether the host may be reached at all (blocked: the lookup records why)
 *   dtrack    GET /api/v1/repository/latest?purl=… on a Dependency-Track platform
 *   oci       GET /v2/<name>/tags/list on a container registry platform (OCI distribution spec), with the registry's
 *             token flow (WWW-Authenticate: Bearer realm=…): the platform's credentials only go to its own origins
 *   git       releases or tags of a repository on GitHub, GitLab or Forgejo/Gitea
 *
 * Each returns the versions as the source names them (a tag with its suffix, a release's tag), with the date when
 * the source has one and a pre-release flag when the source marks it (GitHub releases).
 */

export interface FoundVersion {
  v: string;
  at: string | null;
  pre?: boolean;
}

const TIMEOUT = 20_000;
const LIST_BYTES = 4 * 1024 * 1024;

const iso = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (v: unknown, max = 128): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** Keeps the newest-looking end of a long list (registries list oldest first) and drops empty names. */
function bounded(list: FoundVersion[]): FoundVersion[] {
  const clean = list.filter((x) => x.v);
  return clean.length > VERSION_LIMITS.versionsPerLookup ? clean.slice(-VERSION_LIMITS.versionsPerLookup) : clean;
}

// ---------- public registries ----------

const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);

/** A registry request: outbound policy, no credentials, no redirects, at most VERSION_LIMITS.answerBytes, 20 seconds. */
export async function registryGet(url: string, accept = 'application/json'): Promise<{ status: number; text: string }> {
  try {
    await assertOutboundAllowed(url, outboundContext());
  } catch (e) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url.slice(0, 80);
      }
    })();
    if (e instanceof HttpError && e.statusCode === 403) throw new Error(`blocked by the outbound policy – allow ${host} under Settings → Outbound access`);
    throw e;
  }
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: { accept, 'user-agent': `${BRAND.slug} version watch` },
      redirect: 'manual',
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    if (err.cause?.code === 'ESSRFBLOCKED') throw new Error(err.cause.message);
    throw new Error(`${where(url)} is not reachable${err.name === 'TimeoutError' ? ' (timeout)' : ''}`);
  }
  const max = VERSION_LIMITS.answerBytes;
  const tooLarge = () => new Error(`the answer of ${where(url)} is larger than ${max / 1024 / 1024} MB`);
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined); // the body is not read: a failed cancel changes nothing
    if (res.ok) throw tooLarge();
    return { status: res.status, text: '' };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined); // the rest is not read: a failed cancel changes nothing
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} did not answer with JSON`);
  }
}

/** The values of every <version> element inside <versions> of a maven-metadata.xml (string search, no XML entities needed). */
export function mavenVersions(xml: string): string[] {
  const from = xml.indexOf('<versions>');
  const to = from < 0 ? -1 : xml.indexOf('</versions>', from);
  if (to < 0) return [];
  const part = xml.slice(from, to);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = part.indexOf('<version>', i);
    if (a < 0) break;
    const b = part.indexOf('</version>', a);
    if (b < 0) break;
    out.push(
      part
        .slice(a + 9, b)
        .trim()
        .slice(0, 128),
    );
    i = b + 10;
  }
  return out;
}

/** The versions of a package on its registry (base: the public registry or the mirror of the settings). */
export async function readRegistry(p: Purl, base: string): Promise<FoundVersion[]> {
  const url = registryUrl(p, base);
  if (!url) throw new Error(`no registry address for ${p.type} packages like this one`);
  const r = await registryGet(url, p.type === 'maven' ? 'application/xml, text/xml' : p.type === 'golang' ? 'text/plain' : 'application/json');
  if (r.status === 404 || r.status === 410) throw new Error(`the registry does not know this package (HTTP ${r.status})`);
  if (r.status < 200 || r.status >= 300)
    throw new Error(`the registry answered HTTP ${r.status}${r.status >= 300 && r.status < 400 ? ' (redirects are not followed)' : ''}`);
  switch (p.type) {
    case 'npm': {
      const d = obj(json(r.text, 'npm'));
      const time = obj(d.time);
      const versions = Object.keys(obj(d.versions));
      return bounded(versions.map((v) => ({ v: v.slice(0, 128), at: iso(time[v]) })));
    }
    case 'pypi': {
      const releases = obj(obj(json(r.text, 'PyPI')).releases);
      const out: FoundVersion[] = [];
      for (const [v, files] of Object.entries(releases)) {
        const list = Array.isArray(files) ? files.map(obj) : [];
        // a release without files, or only yanked ones, is not installable
        const live = list.filter((f) => f.yanked !== true);
        if (!live.length) continue;
        const times = live.map((f) => iso(f.upload_time_iso_8601) ?? iso(f.upload_time)).filter((x): x is string => !!x);
        out.push({ v: v.slice(0, 128), at: times.sort()[0] ?? null });
      }
      return bounded(out);
    }
    case 'maven':
      return bounded(mavenVersions(r.text).map((v) => ({ v, at: null })));
    case 'nuget': {
      const list = obj(json(r.text, 'NuGet')).versions;
      return bounded((Array.isArray(list) ? list : []).map((v) => ({ v: str(v), at: null })));
    }
    case 'golang':
      return bounded(
        r.text
          .split('\n')
          .map((l) => l.trim().slice(0, 128))
          .filter(Boolean)
          .map((v) => ({ v, at: null })),
      );
    case 'cargo': {
      const list = obj(json(r.text, 'crates.io')).versions;
      return bounded(
        (Array.isArray(list) ? list.map(obj) : [])
          .filter((x) => x.yanked !== true)
          .map((x) => ({ v: str(x.num), at: iso(x.created_at) }))
          .reverse(),
      );
    }
  }
  return [];
}

// ---------- platforms ----------

/** A platform request of the version watch: the base URL through the outbound policy first, bounded answers, no redirects. */
async function platformGet(
  p: Platform,
  secrets: Record<string, string>,
  url: string,
  o: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  await assertOutboundAllowed(await resolveBaseUrl(p, secrets), outboundContext());
  return platformRequest(
    p,
    secrets,
    { method: 'GET', url, query: o.query, headers: { accept: 'application/json', ...(o.headers ?? {}) }, maxResponseBytes: LIST_BYTES, noRedirects: true },
    AbortSignal.timeout(TIMEOUT),
  );
}

const redact = (text: string, secrets: Record<string, string>) =>
  secretValues(secrets).reduce((t, v) => (v && t.includes(v) ? t.split(v).join('***') : t), text);

/** The latest version Dependency-Track's repository metadata analyzer knows for a package URL. */
export async function readDtrackLatest(p: Platform, secrets: Record<string, string>, purl: Purl): Promise<FoundVersion[]> {
  const r = await platformGet(p, secrets, '/api/v1/repository/latest', { query: { purl: purlText(purl) } });
  if (r.status === 404 || r.status === 204) throw new Error('Dependency-Track does not know the latest version of this package');
  if (r.status === 401 || r.status === 403) throw new Error(`Dependency-Track refused the API key (HTTP ${r.status}) – the team needs VIEW_PORTFOLIO`);
  if (!r.ok) throw new Error(`Dependency-Track answered HTTP ${r.status}`);
  const b = obj(r.body);
  const v = str(b.latestVersion);
  if (!v) throw new Error('Dependency-Track does not know the latest version of this package');
  return [{ v, at: iso(b.published) }];
}

/** Bearer challenge of a registry: realm, service, scope (RFC 6750 auth-params, quoted strings). */
export function parseChallenge(header: string): Record<string, string> | null {
  const h = header.trim();
  if (h.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  const out: Record<string, string> = {};
  let i = 7;
  while (i < h.length && Object.keys(out).length < 10) {
    while (h[i] === ' ' || h[i] === ',') i++;
    const eq = h.indexOf('=', i);
    if (eq < 0) break;
    const key = h.slice(i, eq).trim().toLowerCase();
    let value: string;
    i = eq + 1;
    if (h[i] === '"') {
      const end = h.indexOf('"', i + 1);
      if (end < 0) break;
      value = h.slice(i + 1, end);
      i = end + 1;
    } else {
      const end = h.indexOf(',', i);
      value = h.slice(i, end < 0 ? h.length : end).trim();
      i = end < 0 ? h.length : end;
    }
    if (key === 'realm' || key === 'service' || key === 'scope') out[key] = value.slice(0, 500);
  }
  return out.realm ? out : null;
}

/** Image repository on a registry: lower case path segments of [a-z0-9._-] (OCI distribution spec, "name"). */
export function ociNameOk(name: string): boolean {
  if (!name || name.length > 255) return false;
  return name
    .split('/')
    .every(
      (seg) =>
        seg.length > 0 &&
        seg !== '.' &&
        seg !== '..' &&
        [...seg].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '-'),
    );
}

/** The tags of an image on a container registry platform, with the registry's token flow when it asks for one. */
export async function readOciTags(p: Platform, secrets: Record<string, string>, name: string): Promise<FoundVersion[]> {
  if (!ociNameOk(name)) throw new Error(`"${name.slice(0, 100)}" is not an image repository name`);
  const path = `/v2/${name}/tags/list`;
  const base = await resolveBaseUrl(p, secrets);
  let token: string | null = null;
  const tags: string[] = [];
  let next: string | null = `${path}?n=1000`;
  for (let page = 0; next && page < VERSION_LIMITS.pages; page++) {
    let r = await platformGet(p, secrets, next, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    if (r.status === 401 && !token) {
      const ch = parseChallenge(r.headers['www-authenticate'] ?? '');
      if (!ch) throw new Error('the registry refused the request (401) – check the credentials');
      token = await registryToken(p, secrets, ch, name);
      r = await platformGet(p, secrets, next, { headers: { authorization: `Bearer ${token}` } });
    }
    if (r.status === 404) throw new Error(`the registry does not know the image ${name}`);
    if (r.status === 401 || r.status === 403) throw new Error(`the registry refused the request (HTTP ${r.status}) – check the credentials`);
    if (!r.ok) throw new Error(redact(`the registry answered HTTP ${r.status}`, secrets));
    const list = obj(r.body).tags;
    for (const t of Array.isArray(list) ? list : []) if (typeof t === 'string' && t.length <= 128) tags.push(t);
    next = nextPage(r.headers.link ?? '', base, path);
  }
  return bounded(tags.map((v) => ({ v, at: null })));
}

/** The next page of a tag list (Link: <…>; rel="next"), only on the same origin and path – nothing else is followed. */
export function nextPage(link: string, base: string, path: string): string | null {
  const lt = link.indexOf('<');
  const gt = lt < 0 ? -1 : link.indexOf('>', lt);
  if (gt < 0 || !link.slice(gt).toLowerCase().includes('rel="next"')) return null;
  let u: URL;
  let b: URL;
  try {
    b = new URL(base.endsWith('/') ? base : `${base}/`);
    u = new URL(link.slice(lt + 1, gt), b);
  } catch {
    return null;
  }
  const prefix = trimSlashes(b.pathname);
  if (u.origin !== b.origin || u.pathname !== `${prefix}${path}`) return null;
  return `${path}${u.search}`;
}

/** The registry's token for pulling the image: anonymous, or with the platform's credentials when the realm is one of its own origins. */
async function registryToken(p: Platform, secrets: Record<string, string>, ch: Record<string, string>, name: string): Promise<string> {
  let realm: URL;
  try {
    realm = new URL(ch.realm!);
  } catch {
    throw new Error('the registry named no usable token address');
  }
  if (realm.protocol !== 'https:' && realm.protocol !== 'http:') throw new Error('the registry named no usable token address');
  // only the pull right of this one repository is asked for
  const r = await platformRequest(
    p,
    secrets,
    {
      method: 'GET',
      url: `${realm.origin}${realm.pathname}`,
      query: { ...(ch.service ? { service: ch.service } : {}), scope: `repository:${name}:pull` },
      maxResponseBytes: 256 * 1024,
      noRedirects: true,
    },
    AbortSignal.timeout(TIMEOUT),
  );
  const b = obj(r.body);
  const t = str(b.token, 8192) || str(b.access_token, 8192);
  if (!r.ok || !t) throw new Error(`the registry's token service answered HTTP ${r.status}`);
  return t;
}

/** Releases (tag, date, pre-release flag) or tags of a repository on a Git platform. */
export async function readGitRefs(p: Platform, secrets: Record<string, string>, repo: string, refs: 'releases' | 'tags'): Promise<FoundVersion[]> {
  const parts = repo.split('/');
  if (parts.length < 2 || !parts.every((x) => x && x !== '.' && x !== '..' && x.length <= 100)) throw new Error('the repository is owner/repository');
  const enc = encodeURIComponent;
  const pages = 3;
  const out: FoundVersion[] = [];
  const headers = p.kind === 'github' ? { 'x-github-api-version': '2022-11-28' } : undefined;
  for (let page = 1; page <= pages; page++) {
    let url: string;
    let size: number;
    if (p.kind === 'gitlab') {
      size = 100;
      const id = enc(repo);
      url = refs === 'releases' ? `/projects/${id}/releases?per_page=${size}&page=${page}` : `/projects/${id}/repository/tags?per_page=${size}&page=${page}`;
    } else if (p.kind === 'forgejo') {
      size = 50;
      const r = `/repos/${parts.map(enc).join('/')}`;
      url = `${r}/${refs}?limit=${size}&page=${page}`;
    } else if (p.kind === 'github') {
      size = 100;
      const r = `/repos/${parts.map(enc).join('/')}`;
      url = `${r}/${refs}?per_page=${size}&page=${page}`;
    } else throw new Error(`"${p.name}" is not a GitHub, GitLab or Forgejo platform`);
    const r = await platformGet(p, secrets, url, { headers });
    if (r.status === 404) throw new Error(`the Git platform does not know the repository ${repo} (or the token may not read it)`);
    if (r.status === 401 || r.status === 403) throw new Error(`the Git platform refused the token (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`the Git platform answered HTTP ${r.status}`);
    const list = Array.isArray(r.body) ? r.body.map(obj) : [];
    for (const x of list) {
      if (refs === 'tags') {
        out.push({ v: str(x.name), at: iso(obj(x.commit).created_at) });
        continue;
      }
      if (x.draft === true) continue;
      out.push({ v: str(x.tag_name), at: iso(x.published_at) ?? iso(x.released_at), pre: x.prerelease === true || x.upcoming_release === true });
    }
    if (list.length < size) break;
  }
  return bounded(out);
}

/**
 * "Test connection" of a container registry platform: the tags of its test image (variable testImage), else whether
 * /v2/ answers like a registry (200, or 401 with a token challenge).
 */
export async function testRegistry(p: Platform, secrets: Record<string, string>): Promise<string> {
  const image = String(p.config.variables?.testImage ?? '')
    .trim()
    .toLowerCase();
  if (image) {
    const tags = await readOciTags(p, secrets, image);
    return `The registry lists ${tags.length} tag(s) of ${image}`;
  }
  const r = await platformGet(p, secrets, '/v2/');
  if (r.ok) return 'The registry answers (OCI distribution API) – name a test image under the variable testImage to test reading tags';
  if (r.status === 401 && parseChallenge(r.headers['www-authenticate'] ?? ''))
    return 'The registry answers and asks for a token (OCI distribution API) – name a test image under the variable testImage to test reading tags';
  throw new Error(`GET /v2/ answered HTTP ${r.status} – the base URL must be the registry itself (https://ghcr.io, https://registry-1.docker.io)`);
}
