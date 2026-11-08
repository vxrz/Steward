import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENTS, SSO_PRESET_INFO } from '@sm/shared';

/**
 * Every relative link in the repository's Markdown files points to a file that exists, and a link with an anchor
 * (`FILE.md#section`, `#section`) to a heading or an `<a id>` of that file – so moving or renaming a page or a
 * heading cannot leave a dead link behind. Links to other sites are not fetched.
 *
 * The same holds for links from the code to the docs: the web app's links to the docs on GitHub, and `docs/….md`
 * named in texts and comments.
 *
 * And the lists in the docs that mirror the code stay complete: the docs index (docs/README.md), the ADR index,
 * the module map in docs/ARCHITECTURE.md and the notification events in docs/NOTIFICATIONS.md.
 */

const ROOT = path.resolve(__dirname, '..', '..');
/** Folders that hold no documentation of ours (dependencies, build output, local data). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'data', 'test-results', 'playwright-report', '.tools', '.husky']);
/** Links that are placeholders on purpose: `file → target`. */
const PLACEHOLDERS = new Set([`${path.join('docs', 'adr', 'template.md')} → NNNN-title.md`]);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) markdownFiles(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** The text without fenced code blocks and HTML comments (line count kept, so line numbers stay right). */
function withoutCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, '');
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, blank)
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*$/gm, blank); // an unclosed fence runs to the end
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces as hyphens (github-slugger). */
export function slug(heading: string): string {
  const text = heading
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*?|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .trim();
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map<string, Set<string>>();
function anchors(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const text = withoutCode(fs.readFileSync(file, 'utf8'));
  const found = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) found.add(m[1]);
  anchorCache.set(file, found);
  return found;
}

interface Link {
  file: string;
  line: number;
  target: string;
}

export function links(file: string): Link[] {
  const text = withoutCode(fs.readFileSync(file, 'utf8')).replace(/`[^`\n]+`/g, (s) => ' '.repeat(s.length));
  const out: Link[] = [];
  const add = (index: number, target: string) => out.push({ file, line: text.slice(0, index).split('\n').length, target });
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(m.index, m[1]);
  for (const m of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) add(m.index, m[1]);
  for (const m of text.matchAll(/<(?:a|img)\s[^>]*?(?:href|src)="([^"]+)"/g)) add(m.index, m[1]);
  return out;
}

/** Why a link does not resolve, or null when it does. */
export function problem(link: Link): string | null {
  const { file, target } = link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // another site, mail
  const [rawPath, anchor] = target.split('#', 2) as [string, string | undefined];
  const filePart = decodeURIComponent(rawPath.split('?')[0]);
  if (filePart.startsWith('/')) return 'absolute path – write it relative to this file';
  const resolved = filePart ? path.resolve(path.dirname(file), filePart) : file;
  if (!fs.existsSync(resolved)) return 'no such file';
  if (anchor === undefined || !resolved.endsWith('.md') || fs.statSync(resolved).isDirectory()) return null;
  if (anchor === '' || /^L\d+(-L\d+)?$/.test(anchor)) return null;
  return anchors(resolved).has(decodeURIComponent(anchor)) ? null : `no heading or anchor "#${anchor}"`;
}

describe('documentation links', () => {
  const files = markdownFiles(ROOT);

  it('finds the Markdown files', () => {
    expect(files.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining(['README.md', path.join('docs', 'README.md'), 'CHANGELOG.md']));
  });

  it('computes anchors the way GitHub does', () => {
    expect(slug('6. Updating')).toBe('6-updating');
    expect(slug('Theming (Settings → Appearance)')).toBe('theming-settings--appearance');
    expect(slug('The step "Query a database"')).toBe('the-step-query-a-database');
    expect(slug('`SM_PORT` and [links](x.md)')).toBe('sm_port-and-links');
    expect(slug('Under a path: `https://apps.corp.example/steward`')).toBe('under-a-path-httpsappscorpexamplesteward');
  });

  it('finds broken files and anchors, and ignores code and other sites', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-doclinks-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'B.md'), '# B page\n\n## Same\n\n## Same\n\n<a id="kept"></a>\n');
    const a = path.join(dir, 'A.md');
    fs.writeFileSync(
      a,
      [
        '# A',
        '[ok](sub/B.md) [ok](sub/B.md#b-page) [ok](sub/B.md#same-1) [ok](sub/B.md#kept) [ok](#a) [ok](https://example.com/x.md)',
        '[gone](C.md) [bad anchor](sub/B.md#nope) [bad local](#nope)',
        '`[code](D.md)`',
        '```md',
        '[fenced](E.md)',
        '```',
        '[ref]: sub/missing.md',
        '<img src="sub/none.svg" alt="">',
      ].join('\n'),
    );
    const found = links(a).map((l) => `${l.line} ${l.target}: ${problem(l) ?? 'ok'}`);
    expect(found.filter((f) => !f.endsWith(': ok'))).toEqual([
      '3 C.md: no such file',
      '3 sub/B.md#nope: no heading or anchor "#nope"',
      '3 #nope: no heading or anchor "#nope"',
      '8 sub/missing.md: no such file',
      '9 sub/none.svg: no such file',
    ]);
    expect(found).toHaveLength(11);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every relative link points to an existing file and anchor', () => {
    const broken = files.flatMap((f) =>
      links(f).flatMap((l) => {
        if (PLACEHOLDERS.has(`${path.relative(ROOT, l.file)} → ${l.target}`)) return [];
        const why = problem(l);
        return why ? [`${path.relative(ROOT, l.file)}:${l.line}: ${l.target} – ${why}`] : [];
      }),
    );
    expect(broken).toEqual([]);
  });
});

/** Every reference to a file of the repository in the code: `…/blob/HEAD/<path>`, `…/tree/HEAD/<dir>` and `docs/<page>`. */
function codeReferences(): Link[] {
  const out: Link[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && e.name !== 'fixtures') walk(full);
      } else if (/\.(ts|tsx|mjs|js|json|ya?ml|sh|toml)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const add = (index: number, target: string) =>
          out.push({ file: path.join(ROOT, 'README.md'), line: text.slice(0, index).split('\n').length, target: `${target}  (${path.relative(ROOT, full)})` });
        for (const m of text.matchAll(/\/(?:blob|tree)\/HEAD\/([\w./-]+[\w/](?:#[\w-]+)?)/g)) add(m.index, m[1]);
        for (const m of text.matchAll(/(?<![\w/.-])(docs\/[\w/-]+\.(?:md|json)(?:#[\w-]+)?)/g)) add(m.index, m[1]);
      }
    }
  };
  for (const d of ['web/src', 'server/src', 'shared/src', 'scripts', 'e2e', '.github', '.woodpecker']) {
    if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  }
  return out;
}

describe('links from the code to the docs', () => {
  it('every file and anchor the code names exists', () => {
    const refs = codeReferences();
    expect(refs.length).toBeGreaterThan(50);
    const broken = refs.flatMap((r) => {
      const [target, where] = r.target.split('  (');
      const why = problem({ ...r, target });
      return why ? [`${where.slice(0, -1)}:${r.line}: ${target} – ${why}`] : [];
    });
    expect(broken).toEqual([]);
  });

  it('the help links of the single sign-on presets point to their section of SSO.md', () => {
    const sso = anchors(path.join(ROOT, 'docs', 'SSO.md'));
    expect(Object.values(SSO_PRESET_INFO).filter((p) => !sso.has(p.docsAnchor))).toEqual([]);
  });
});

describe('documentation lists that mirror the code', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  const linkTargets = (file: string) => new Set(links(path.join(ROOT, file)).map((l) => l.target.split('#')[0]));

  it('the docs index lists every page in docs/ (ADRs are listed in docs/adr/README.md)', () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, 'docs', dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!['adr', 'images'].includes(rel)) walk(rel);
        } else if (/\.(md|json)$/.test(e.name) && rel !== 'README.md') {
          pages.push(rel);
        }
      }
    };
    walk('');
    const listed = linkTargets('docs/README.md');
    expect(pages.filter((p) => !listed.has(p))).toEqual([]);
  });

  it('the ADR index lists every decision record', () => {
    const records = fs.readdirSync(path.join(ROOT, 'docs', 'adr')).filter((f) => /^\d{4}-.+\.md$/.test(f));
    const listed = linkTargets('docs/adr/README.md');
    expect(records.filter((r) => !listed.has(r))).toEqual([]);
  });

  it('the module map in ARCHITECTURE.md names every folder and top-level file of server/src', () => {
    const doc = read('docs', 'ARCHITECTURE.md');
    const map = doc.slice(doc.indexOf('## Module map'), doc.indexOf('\n## ', doc.indexOf('## Module map') + 1));
    const entries = fs
      .readdirSync(path.join(ROOT, 'server', 'src'), { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .filter((n) => n.endsWith('/') || n.endsWith('.ts'));
    expect(entries.filter((n) => !map.includes(`\`${n}\``))).toEqual([]);
  });

  it('NOTIFICATIONS.md lists every notification event', () => {
    const doc = read('docs', 'NOTIFICATIONS.md');
    const table = doc.slice(doc.indexOf('## Events'), doc.indexOf('\n## ', doc.indexOf('## Events') + 1));
    expect(NOTIFICATION_EVENTS.filter((e) => !table.includes(`\`${e}\``))).toEqual([]);
  });
});
