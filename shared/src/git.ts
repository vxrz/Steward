/**
 * Git platforms as connectors (#107): GitHub (also Enterprise Server), GitLab and Forgejo/Gitea. A platform of one of
 * these kinds holds the API base URL and a read-only token; application components of type "repository" name it and
 * the repository path, and Steward reads the default branch, its pipeline, the latest release, open security alerts,
 * packages and images, deploy keys and access tokens, and the tech stack from the repository's files.
 */

export const GIT_PLATFORM_KINDS = ['github', 'gitlab', 'forgejo'] as const;
export type GitPlatformKind = (typeof GIT_PLATFORM_KINDS)[number];
export const isGitPlatformKind = (k: string | null | undefined): k is GitPlatformKind => (GIT_PLATFORM_KINDS as readonly string[]).includes(k ?? '');

/** Pipeline state of the default branch: the latest finished run of each workflow (GitHub), the latest pipeline (GitLab) or the commit status (Forgejo). */
export const PIPELINE_STATES = ['success', 'failed', 'running', 'none'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** A deploy key, deploy token or access token of a repository – offered for the credentials register, never its value. */
export interface RepositoryKey {
  /** The host's id, e.g. "12" */
  id: string;
  kind: 'deploy-key' | 'deploy-token' | 'access-token';
  title: string;
  /** Can write to the repository (deploy key with write access, token with a write scope) */
  write: boolean;
  scopes: string[];
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** What Steward read from a repository (#107), kept on the component. */
export interface RepositoryReadout {
  readAt: string;
  /** null: read; else why not */
  error: string | null;
  webUrl: string | null;
  defaultBranch: string | null;
  archived: boolean;
  /** Head commit of the default branch */
  head: { sha: string; at: string | null; message: string } | null;
  pipeline: { state: PipelineState; runs: { name: string; state: PipelineState; url: string | null; at: string | null }[] };
  release: { tag: string; at: string | null; url: string | null } | null;
  /** Open security alerts by severity (GitHub Dependabot, GitLab vulnerabilities); null: the host has none or the token may not read them */
  alerts: (Record<AlertSeverity, number> & { url: string | null }) | null;
  /** Packages and container images of the repository; null: not readable */
  packages: { name: string; type: string; version: string | null; url: string | null }[] | null;
  /** Deploy keys and tokens; null: the token may not read them */
  keys: RepositoryKey[] | null;
  /** Files the tech stack was read from, e.g. "Dockerfile", "package.json" */
  stackFiles: string[];
  /** Images and versions Steward could not map to a product */
  unmapped: string[];
}

export const GIT_LIMITS = {
  /** A repository is read again after this many hours (the job), or on "Read now" */
  refreshHours: 6,
  /** Files read for the tech stack at most this large */
  stackFileBytes: 256 * 1024,
  /** Workflow runs looked at for the pipeline state (GitHub) */
  runs: 50,
  /** Packages, keys and access entries listed at most */
  listed: 100,
} as const;

/** Files the tech stack is read from, in this order. */
export const STACK_FILES = [
  'Dockerfile',
  'Containerfile',
  'package.json',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  'go.mod',
  'global.json',
  'composer.json',
  'pom.xml',
] as const;

/** A repository path: owner/repo (GitHub, Forgejo) or group/subgroup/project (GitLab). */
export const REPOSITORY_PATH_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,10}$/;

// ---------- tech stack from repository files ----------

/** What a file names: a product directly (a runtime version file), a package (mapped like an SBOM entry), or a container image. */
export type StackHint =
  | { kind: 'product'; product: string; version: string; file: string }
  | { kind: 'package'; purl: string; version: string; file: string }
  | { kind: 'image'; image: string; file: string };

/** The first version in a range or tag: "^18.2.0" → "18.2.0", ">=20" → "20", "22.x" → "22", "v1.23" → "1.23"; '' for "*", "latest", "lts/*". */
export function rangeVersion(s: string): string {
  const m = /(\d+(?:\.\d+){0,2})/.exec(String(s ?? ''));
  return m ? m[1]! : '';
}

/** Runtime names of .tool-versions (asdf, mise) and their products. */
const TOOL_PRODUCTS: Record<string, string> = {
  nodejs: 'nodejs',
  node: 'nodejs',
  python: 'python',
  ruby: 'ruby',
  golang: 'go',
  go: 'go',
  php: 'php',
  java: 'eclipse-temurin',
  dotnet: 'dotnet',
};

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim());

/** FROM lines of a Dockerfile, with ARG defaults before them filled in; stage names and "scratch" left out. */
export function dockerfileImages(text: string): string[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const out: string[] = [];
  // continuation lines joined, comments dropped
  const joined = text.replace(/\\\r?\n/g, ' ');
  for (const line of lines(joined)) {
    if (!line || line.startsWith('#')) continue;
    const [word, ...rest] = line.split(/\s+/);
    const kw = word!.toUpperCase();
    if (kw === 'ARG' && rest[0]) {
      const [k, ...v] = rest[0].split('=');
      if (k && v.length) args.set(k, v.join('=').replace(/^["']|["']$/g, ''));
    } else if (kw === 'FROM') {
      const parts = rest.filter((p) => !p.startsWith('--'));
      const raw = parts[0];
      if (!raw) continue;
      if (parts[1]?.toUpperCase() === 'AS' && parts[2]) stages.add(parts[2].toLowerCase());
      const image = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, dflt, b) => args.get(a ?? b) ?? dflt ?? m);
      if (image.toLowerCase() === 'scratch' || stages.has(image.toLowerCase()) || image.includes('$')) continue;
      out.push(image);
    }
  }
  return [...new Set(out)];
}

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The products, packages and images the usual files of a repository name (#107). Files that cannot be read are skipped. */
export function stackHints(files: Record<string, string>): StackHint[] {
  const out: StackHint[] = [];
  const product = (file: string, p: string, version: string) => out.push({ kind: 'product', product: p, version: rangeVersion(version), file });
  for (const [file, text] of Object.entries(files)) {
    const name = file.split('/').pop()!;
    try {
      if (name === 'Dockerfile' || name === 'Containerfile') for (const image of dockerfileImages(text)) out.push({ kind: 'image', image, file });
      else if (name === 'package.json') {
        const j = objOf(JSON.parse(text));
        const node = objOf(j.engines).node;
        if (typeof node === 'string' && rangeVersion(node)) product(file, 'nodejs', node);
        const deps = { ...objOf(j.devDependencies), ...objOf(j.dependencies) };
        for (const [dep, range] of Object.entries(deps))
          if (typeof range === 'string') out.push({ kind: 'package', purl: `pkg:npm/${dep}`, version: rangeVersion(range), file });
      } else if (name === '.nvmrc' || name === '.node-version') {
        const v = lines(text)[0] ?? '';
        if (rangeVersion(v)) product(file, 'nodejs', v);
      } else if (name === '.python-version' || name === '.ruby-version') {
        const v = (lines(text)[0] ?? '').replace(/^ruby-/, '');
        if (rangeVersion(v)) product(file, name === '.python-version' ? 'python' : 'ruby', v);
      } else if (name === '.tool-versions') {
        for (const l of lines(text)) {
          const [tool, v] = l.split(/\s+/);
          const p = tool ? TOOL_PRODUCTS[tool.toLowerCase()] : undefined;
          if (p && v && rangeVersion(v)) product(file, p, v);
        }
      } else if (name === 'go.mod') {
        const m = /^go\s+(\d+\.\d+)/m.exec(text);
        if (m) product(file, 'go', m[1]!);
      } else if (name === 'global.json') {
        const v = objOf(objOf(JSON.parse(text)).sdk).version;
        if (typeof v === 'string' && rangeVersion(v)) product(file, 'dotnet', v.split('.').slice(0, 2).join('.'));
      } else if (name === 'composer.json') {
        const req = objOf(objOf(JSON.parse(text)).require);
        for (const [dep, range] of Object.entries(req)) {
          if (typeof range !== 'string') continue;
          if (dep === 'php') product(file, 'php', range);
          else if (dep.includes('/')) out.push({ kind: 'package', purl: `pkg:composer/${dep}`, version: rangeVersion(range), file });
        }
      } else if (name === 'pom.xml') {
        // the Spring Boot parent, and the Java release
        const from = text.indexOf('<parent>');
        const to = from < 0 ? -1 : text.indexOf('</parent>', from);
        const parent = to < 0 ? '' : text.slice(from, to);
        const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(parent)?.[1];
        const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(parent)?.[1];
        const v = /<version>\s*([^<\s]+)\s*<\/version>/.exec(parent)?.[1];
        // spring-boot-starter-parent → spring-boot (the parent POM carries the framework's version)
        if (g && a && v) out.push({ kind: 'package', purl: `pkg:maven/${g}/${a.replace(/-starter-parent$|-parent$/, '')}`, version: rangeVersion(v), file });
        const java = /<(?:java\.version|maven\.compiler\.release)>\s*(\d+)\s*</.exec(text)?.[1];
        if (java) product(file, 'eclipse-temurin', java);
      }
    } catch {
      /* not valid JSON: skipped */
    }
  }
  return out;
}
