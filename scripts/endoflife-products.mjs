#!/usr/bin/env node
// Writes server/assets/endoflife/products.json: the products endoflife.date knows (id, name, category, other
// names, package URLs, CPEs and release cycles). Steward offers them when a tech stack is entered by hand and
// matches SBOM components against them, without asking endoflife.date at run time.
//
//   node scripts/endoflife-products.mjs                 # from https://endoflife.date/api/v1/products/full
//   node scripts/endoflife-products.mjs --repo <dir>    # from a checkout of github.com/endoflife-date/endoflife.date
//
// With --repo it also copies the API description (api_v1/openapi.yml) to server/assets/endoflife/openapi.yml: the
// preset "endoflife.date" brings it along as the platform's spec.
//
// The data is MIT licensed (Copyright endoflife.date contributors); the licence travels in the file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'server', 'assets', 'endoflife', 'products.json');
const args = process.argv.slice(2);
const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;

const LICENSE = 'MIT, Copyright 2020 endoflife.date contributors (https://github.com/endoflife-date/endoflife.date/blob/master/LICENSE)';
const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

function fromRepo(dir) {
  const products = [];
  for (const f of fs.readdirSync(path.join(dir, 'products')).sort()) {
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, 'products', f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) continue;
    const fm = YAML.parse(m[1]);
    const id = f.slice(0, -3);
    const ids = fm.identifiers ?? [];
    products.push({
      id,
      label: String(fm.title ?? id),
      category: String(fm.category ?? 'app').trim(),
      aliases: uniq([...(fm.alternate_urls ?? []).map((u) => String(u).replace(/^\//, '')), ...ids.map((i) => i.repology).filter(Boolean)]).filter(
        (a) => a !== id,
      ),
      purls: uniq(ids.map((i) => i.purl)),
      cpes: uniq(ids.map((i) => i.cpe)),
      cycles: uniq((fm.releases ?? []).map((r) => String(r.releaseCycle))).slice(0, 60),
    });
  }
  let commit = '';
  try {
    // a short commit id: a full 40-digit hash looks like an access token to secret scanners
    commit = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h %cs', '--abbrev=12'], { encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  return { source: `github.com/endoflife-date/endoflife.date${commit ? ` @ ${commit}` : ''}`, products };
}

async function fromApi() {
  const res = await fetch('https://endoflife.date/api/v1/products/full');
  if (!res.ok) throw new Error(`endoflife.date answered HTTP ${res.status}`);
  const body = await res.json();
  const products = body.result.map((p) => ({
    id: p.name,
    label: p.label ?? p.name,
    category: p.category ?? 'app',
    aliases: uniq([...(p.aliases ?? []), ...(p.identifiers ?? []).filter((i) => i.type === 'repology').map((i) => i.id)]).filter((a) => a !== p.name),
    purls: uniq((p.identifiers ?? []).filter((i) => i.type === 'purl').map((i) => i.id)),
    cpes: uniq((p.identifiers ?? []).filter((i) => i.type === 'cpe').map((i) => i.id)),
    cycles: uniq((p.releases ?? []).map((r) => String(r.name))).slice(0, 60),
  }));
  return { source: `https://endoflife.date/api/v1/products/full @ ${new Date().toISOString().slice(0, 10)}`, products };
}

const data = repo ? fromRepo(repo) : await fromApi();
data.products.sort((a, b) => a.id.localeCompare(b.id));
fs.mkdirSync(path.dirname(out), { recursive: true });
// one product per line: small diffs when the list is refreshed
const lines = data.products.map((p) => JSON.stringify(p));
fs.writeFileSync(out, `{"source":${JSON.stringify(data.source)},"license":${JSON.stringify(LICENSE)},"products":[\n${lines.join(',\n')}\n]}\n`);
console.log(`${data.products.length} products → ${path.relative(root, out)}`);

if (repo) {
  const specIn = path.join(repo, 'api_v1', 'openapi.yml');
  const specOut = path.join(path.dirname(out), 'openapi.yml');
  if (fs.existsSync(specIn)) {
    const HEADER = [
      '# OpenAPI description of the endoflife.date API v1, copied from github.com/endoflife-date/endoflife.date (api_v1/openapi.yml,',
      '# MIT License, Copyright 2020 endoflife.date contributors). Only the Jekyll front matter was removed and the site address',
      '# filled in. Refresh it together with products.json (scripts/endoflife-products.mjs).',
    ].join('\n');
    const spec = fs
      .readFileSync(specIn, 'utf8')
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .replaceAll('{{ site.url }}', 'https://endoflife.date');
    YAML.parse(spec); // refuse to write what does not parse
    fs.writeFileSync(specOut, `${HEADER}\n${spec.trimStart()}`);
    console.log(`API description → ${path.relative(root, specOut)}`);
  } else console.warn(`${path.relative(process.cwd(), specIn)} not found: API description left as it is`);
}
