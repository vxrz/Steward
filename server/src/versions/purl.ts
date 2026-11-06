import { DEFAULT_REGISTRY_URLS, PACKAGE_ECOSYSTEMS, type PackageEcosystem } from '@sm/shared';

/**
 * Package URLs (purl, https://github.com/package-url/purl-spec) for the version watch (#241): parsed without regular
 * expressions, each segment checked, and the registry address built from encoded segments – a package URL from an
 * SBOM can name neither another host nor another path ("..", "/" inside a segment, control characters are refused).
 */

export interface Purl {
  type: string;
  namespace: string[];
  name: string;
}

const MAX = 300;

function segmentOk(s: string): boolean {
  if (!s || s.length > 214 || s === '.' || s === '..') return false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x21 || c === 0x7f || ch === '/' || ch === '\\' || ch === '?' || ch === '#' || ch === '%') return false;
  }
  return true;
}

/** pkg:type/namespace/name@version?qualifiers#subpath → type, namespace, name (the version, qualifiers, subpath dropped). */
export function parsePurl(text: string): Purl | null {
  let s = String(text ?? '').trim();
  if (s.length > 1000 || s.slice(0, 4).toLowerCase() !== 'pkg:') return null;
  s = s.slice(4);
  while (s.startsWith('/')) s = s.slice(1);
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const slash = s.indexOf('/');
  if (slash <= 0) return null;
  const type = s.slice(0, slash).toLowerCase();
  if (![...type].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '+' || c === '-')) return null;
  let rest = s.slice(slash + 1);
  const at = rest.lastIndexOf('@');
  if (at > rest.lastIndexOf('/')) rest = rest.slice(0, at);
  const parts: string[] = [];
  for (const raw of rest.split('/')) {
    if (!raw) continue;
    let d: string;
    try {
      d = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!segmentOk(d)) return null;
    parts.push(d);
  }
  const name = parts.pop();
  if (!name || parts.length > 10) return null;
  const p: Purl = { type, namespace: parts, name };
  // the spec's normalisations: npm and PyPI names are lower case, PyPI's "_" is "-"
  if (type === 'npm') ((p.name = p.name.toLowerCase()), (p.namespace = p.namespace.map((x) => x.toLowerCase())));
  if (type === 'pypi') p.name = pep503(p.name);
  if (type === 'nuget') p.name = p.name.toLowerCase();
  return p;
}

/** PEP 503 normalised project name: lower case, runs of "-", "_", "." as one "-". */
function pep503(name: string): string {
  let out = '';
  let sep = false;
  for (const ch of name.toLowerCase()) {
    if (ch === '-' || ch === '_' || ch === '.') sep = true;
    else {
      if (sep && out) out += '-';
      sep = false;
      out += ch;
    }
  }
  return out;
}

/** The package URL without version, its segments encoded (as Dependency-Track and SBOMs write it). */
export function purlText(p: Purl): string {
  return `pkg:${p.type}/${[...p.namespace, p.name].map(encodeURIComponent).join('/')}`.slice(0, MAX);
}

/** Readable: pkg:npm/@angular/core. */
export function purlLabel(p: Purl): string {
  return `pkg:${p.type}/${[...p.namespace, p.name].join('/')}`.slice(0, MAX);
}

export const isEcosystem = (t: string): t is PackageEcosystem => (PACKAGE_ECOSYSTEMS as readonly string[]).includes(t);

/** Go module proxy: upper-case letters become "!" and the lower-case letter (golang.org/ref/mod#goproxy-protocol). */
function goEscape(s: string): string {
  let out = '';
  for (const ch of s) out += ch >= 'A' && ch <= 'Z' ? `!${ch.toLowerCase()}` : ch;
  return out;
}

/** The address of a package's version list on its registry (base: the public registry or a mirror), or null when the purl does not fit. */
export function registryUrl(p: Purl, base: string = DEFAULT_REGISTRY_URLS[p.type as PackageEcosystem] ?? ''): string | null {
  const b = base.replace(/\/+$/, '');
  if (!b || !isEcosystem(p.type)) return null;
  const enc = encodeURIComponent;
  switch (p.type) {
    case 'npm': {
      if (p.namespace.length > 1) return null;
      const scope = p.namespace[0];
      const full = scope ? `${scope.startsWith('@') ? scope : `@${scope}`}/${p.name}` : p.name;
      // a scoped name keeps its "@", the slash is encoded: @angular%2Fcore
      return `${b}/${enc(full).replace(/^%40/, '@')}`;
    }
    case 'pypi':
      return p.namespace.length ? null : `${b}/pypi/${enc(p.name)}/json`;
    case 'maven': {
      if (p.namespace.length !== 1) return null;
      const group = p.namespace[0]!.split('.');
      if (!group.every((g) => g && segmentOk(g))) return null;
      return `${b}/${group.map(enc).join('/')}/${enc(p.name)}/maven-metadata.xml`;
    }
    case 'nuget':
      return p.namespace.length ? null : `${b}/${enc(p.name)}/index.json`;
    case 'golang':
      return `${b}/${[...p.namespace, p.name].map((x) => enc(goEscape(x))).join('/')}/@v/list`;
    case 'cargo':
      return p.namespace.length ? null : `${b}/api/v1/crates/${enc(p.name)}`;
  }
  return null;
}

/** The registry's name for people. */
export const ECOSYSTEM_LABELS: Record<PackageEcosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  maven: 'Maven Central',
  nuget: 'NuGet',
  golang: 'Go module proxy',
  cargo: 'crates.io',
};
