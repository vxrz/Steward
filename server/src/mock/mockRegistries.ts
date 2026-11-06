import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Simulated package and container registries for the version watch (#241), for the demo and the tests. The answers
 * have the shape of the real APIs (recorded from them, trimmed to a few versions); dates are relative to today.
 *
 *   /mock/registries/npm/<name>                                   npm registry (packument: versions, time)
 *   /mock/registries/pypi/pypi/<name>/json                        PyPI JSON API (releases with files)
 *   /mock/registries/maven/<group path>/<artifact>/maven-metadata.xml   Maven Central
 *   /mock/registries/nuget/<id>/index.json                        NuGet flat container
 *   /mock/registries/golang/<module>/@v/list                      Go module proxy
 *   /mock/registries/cargo/api/v1/crates/<name>                   crates.io
 *   /mock/registry/v2/<name>/tags/list                            an OCI registry with the token flow of Docker Hub and
 *   /mock/registry/token?service=&scope=                          GHCR: 401 + WWW-Authenticate, then a bearer token
 *
 * Unknown packages answer 404. Mounted under the base path too: links and the token realm are built from
 * req.originalUrl (req.url has the base path stripped).
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Versions with their age in days (newest last), per package. */
const NPM: Record<string, [string, number][]> = {
  react: [
    ['17.0.2', 1500],
    ['18.2.0', 1300],
    ['18.3.1', 900],
    ['19.0.0', 700],
    ['19.1.0', 500],
    ['19.2.0', 120],
    ['19.3.0-canary-20261101', 5],
  ],
  express: [
    ['4.21.2', 600],
    ['4.22.0', 300],
    ['5.0.0', 550],
    ['5.1.0', 200],
    ['5.2.0', 40],
  ],
  '@angular/core': [
    ['20.0.0', 520],
    ['21.0.0', 340],
    ['21.2.1', 150],
    ['22.0.0', 30],
    ['22.1.0-rc.0', 3],
  ],
};
const PYPI: Record<string, [string, number][]> = {
  django: [
    ['5.1.4', 700],
    ['5.2', 560],
    ['5.2.1', 520],
    ['6.0', 330],
    ['6.0.1', 300],
    ['6.1a1', 10],
  ],
};
const MAVEN: Record<string, string[]> = {
  'org/springframework/boot/spring-boot': ['3.4.0', '3.5.0', '3.5.3', '4.0.0-M1', '4.0.0-RC1', '4.0.0', '4.0.1', '4.1.0-M2'],
  'org/apache/logging/log4j/log4j-core': ['2.14.1', '2.17.1', '2.24.3', '2.25.0'],
};
const NUGET: Record<string, string[]> = {
  'microsoft.netcore.app': ['8.0.11', '9.0.0', '9.0.4', '10.0.0-rc.2.25502.107', '10.0.0', '10.0.1'],
};
const GO: Record<string, string[]> = {
  'k8s.io/kubernetes': ['v1.32.4', 'v1.33.0', 'v1.33.2', 'v1.34.0-alpha.1', 'v1.34.0'],
  'github.com/!burnt!sushi/toml': ['v1.4.0', 'v1.5.0'],
};
const CARGO: Record<string, [string, number, boolean?][]> = {
  deno: [
    ['1.40.0', 650],
    ['1.46.3', 420],
    ['2.0.0', 390],
    ['2.5.0', 90, true],
    ['2.4.5', 100],
  ],
  tokio: [
    ['1.40.0', 400],
    ['1.44.0', 200],
    ['1.45.0', 120, true],
    ['1.45.1', 100],
  ],
};
/** Image tags per repository on the simulated registry. */
const OCI: Record<string, string[]> = {
  'library/nginx': [
    '1.25.5',
    '1.26.3',
    '1.27.3',
    '1.27.3-alpine',
    '1.27.4',
    '1.27.4-alpine',
    '1.28.0',
    '1.28.0-alpine',
    '1.29.0-alpine-slim',
    'mainline-alpine',
    'latest',
  ],
  'library/postgres': ['15.8', '15.8-alpine', '16.4', '16.6', '16.6-alpine', '17.2', '17.2-alpine', '18.0', '18.1', '18.1-alpine', '19beta1', 'latest'],
  'library/node': ['22-alpine', '22.11.0-alpine', '24-alpine', '24.11.1-alpine', '25-alpine', '26-alpine', '26.1.0-alpine', 'lts-alpine', 'latest'],
  'library/alpine': ['3.20', '3.20.3', '3.21', '3.21.2', '3.22', '3.22.1', 'edge', 'latest'],
  'acme/shop-web': ['2.3.0', '2.4.0', '2.4.1', '2.5.0-rc1', 'main'],
};
export const DEMO_REGISTRY = { token: 'demo-registry-token', username: 'robot$steward', password: 'demo-registry-password' };

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found' });
/** An error answer of the OCI distribution spec: { errors: [{ code, message }] } */
const ociError = (code: string, message: string) => ({ errors: [{ code, message }] });
/** The path after the mount point, from the original URL (the base path is stripped from req.url only). */
function tail(req: FastifyRequest, mount: string): string {
  const path = req.originalUrl.split('?')[0]!;
  const i = path.indexOf(mount);
  return i < 0 ? '' : path.slice(i + mount.length);
}
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

export async function mockRegistries(app: FastifyInstance): Promise<void> {
  // ---------- npm ----------
  app.get('/registries/npm/*', async (req, reply) => {
    const name = dec(tail(req, '/registries/npm/'));
    const list = NPM[name];
    if (!list) return notFound(reply);
    const latest = [...list].reverse().find(([v]) => !v.includes('-'))![0];
    return {
      _id: name,
      name,
      'dist-tags': { latest },
      versions: Object.fromEntries(list.map(([v]) => [v, { name, version: v, dist: { tarball: `https://registry.example.com/${name}/-/${v}.tgz` } }])),
      time: { created: ago(2000), modified: ago(list.at(-1)![1]), ...Object.fromEntries(list.map(([v, d]) => [v, ago(d)])) },
    };
  });
  // ---------- PyPI ----------
  app.get('/registries/pypi/pypi/:name/json', async (req, reply) => {
    const name = (req.params as { name: string }).name.toLowerCase();
    const list = PYPI[name];
    if (!list) return notFound(reply);
    return {
      info: { name, version: '6.0.1' },
      releases: {
        ...Object.fromEntries(list.map(([v, d]) => [v, [{ filename: `${name}-${v}.tar.gz`, upload_time_iso_8601: ago(d), yanked: false }]])),
        // yanked and empty releases are not installable
        '6.0.2': [{ filename: `${name}-6.0.2.tar.gz`, upload_time_iso_8601: ago(2), yanked: true }],
        '7.0': [],
      },
    };
  });
  // ---------- Maven Central ----------
  app.get('/registries/maven/*', async (req, reply) => {
    const path = tail(req, '/registries/maven/');
    if (!path.endsWith('/maven-metadata.xml')) return notFound(reply);
    const key = path.slice(0, -'/maven-metadata.xml'.length);
    const list = MAVEN[key];
    if (!list) return notFound(reply);
    const parts = key.split('/');
    const artifact = parts.pop()!;
    return reply
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>${parts.join('.')}</groupId>\n  <artifactId>${artifact}</artifactId>\n  <versioning>\n    <latest>${list.at(-1)}</latest>\n    <release>${list.at(-1)}</release>\n    <versions>\n${list.map((v) => `      <version>${v}</version>`).join('\n')}\n    </versions>\n    <lastUpdated>20261101120000</lastUpdated>\n  </versioning>\n</metadata>\n`,
      );
  });
  // ---------- NuGet ----------
  app.get('/registries/nuget/:id/index.json', async (req, reply) => {
    const list = NUGET[(req.params as { id: string }).id];
    return list ? { versions: list } : notFound(reply);
  });
  // ---------- Go module proxy ----------
  app.get('/registries/golang/*', async (req, reply) => {
    const path = dec(tail(req, '/registries/golang/'));
    if (!path.endsWith('/@v/list')) return notFound(reply);
    const list = GO[path.slice(0, -'/@v/list'.length)];
    return list ? reply.type('text/plain').send(`${list.join('\n')}\n`) : reply.code(404).type('text/plain').send('not found');
  });
  // ---------- crates.io ----------
  app.get('/registries/cargo/api/v1/crates/:name', async (req, reply) => {
    if (!req.headers['user-agent']) return reply.code(403).send({ errors: [{ detail: 'We require that all requests include a User-Agent header.' }] });
    const name = (req.params as { name: string }).name;
    const list = CARGO[name];
    if (!list) return reply.code(404).send({ errors: [{ detail: 'Not Found' }] });
    return {
      crate: { id: name, name, max_version: list.at(-1)![0] },
      versions: [...list].reverse().map(([num, d, yanked], i) => ({ id: 1000 - i, crate: name, num, created_at: ago(d), yanked: !!yanked })),
    };
  });

  // ---------- an OCI registry (distribution API) with a token service ----------
  const realmOf = (req: FastifyRequest) => {
    const path = req.originalUrl.split('?')[0]!;
    const prefix = path.slice(0, path.indexOf('/registry/') + '/registry'.length);
    return `${req.protocol}://${req.headers.host}${prefix}/token`;
  };
  app.get('/registry/token', async (req, reply) => {
    const q = req.query as { service?: string; scope?: string };
    const auth = req.headers.authorization;
    // anonymous, or the demo robot account; other credentials are refused
    if (auth && auth !== `Basic ${Buffer.from(`${DEMO_REGISTRY.username}:${DEMO_REGISTRY.password}`).toString('base64')}`)
      return reply.code(401).send(ociError('UNAUTHORIZED', 'authentication required'));
    if (q.service !== 'registry.demo' || !q.scope?.startsWith('repository:') || !q.scope.endsWith(':pull'))
      return reply.code(400).send(ociError('DENIED', 'invalid scope'));
    return { token: `${DEMO_REGISTRY.token}:${q.scope.slice('repository:'.length, -':pull'.length)}`, expires_in: 300, issued_at: new Date().toISOString() };
  });
  app.get('/registry/v2/', async (req, reply) =>
    reply
      .code(401)
      .header('www-authenticate', `Bearer realm="${realmOf(req)}",service="registry.demo"`)
      .send(ociError('UNAUTHORIZED', 'authentication required')),
  );
  app.get('/registry/v2/*', async (req, reply) => {
    const path = tail(req, '/registry/v2/');
    if (!path.endsWith('/tags/list')) return notFound(reply);
    const name = path.slice(0, -'/tags/list'.length);
    if (req.headers.authorization !== `Bearer ${DEMO_REGISTRY.token}:${name}`)
      return reply
        .code(401)
        .header('www-authenticate', `Bearer realm="${realmOf(req)}",service="registry.demo",scope="repository:${name}:pull"`)
        .send(ociError('UNAUTHORIZED', 'authentication required'));
    const tags = OCI[name];
    if (!tags) return reply.code(404).send(ociError('NAME_UNKNOWN', 'repository name not known to registry'));
    // paged like the spec: n tags after "last", a Link header to the next page
    const q = req.query as { n?: string; last?: string };
    const n = Math.max(1, Math.min(Number(q.n ?? 1000) || 1000, 1000));
    const sorted = [...tags].sort();
    const from = q.last ? sorted.findIndex((t) => t > q.last!) : 0;
    const page = from < 0 ? [] : sorted.slice(from, from + n);
    const base = req.originalUrl.split('?')[0]!;
    if (from >= 0 && from + n < sorted.length) reply.header('link', `<${base}?n=${n}&last=${encodeURIComponent(page.at(-1)!)}>; rel="next"`);
    return { name, tags: page };
  });
}
