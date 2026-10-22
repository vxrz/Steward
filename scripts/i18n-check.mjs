#!/usr/bin/env node
// Checks that every translation matches the English source: same keys, same
// {{placeholders}}, same <tags>, plural forms for the language. See docs/I18N.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: npm run i18n:check -- [options]

Compares every language with English (the source of truth):
  web/src/locales/<lang>/<namespace>.json   (web UI)
  server/src/i18n/locales/<lang>.json       (notifications, e-mails)
and reports missing keys, extra keys, empty texts, and {{placeholders}} or
<tags> that differ from English. Plural keys (_one, _other, …) are checked
against the plural forms the language needs.

Options:
  --json         Print the result as JSON on stdout
  --root <dir>   Repository root (default: the folder above scripts/)
  -h, --help     Show this help

Exit codes: 0 all languages in sync, 1 problems found, 2 usage or I/O error.`;

const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const opts = { json: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--root') {
      if (!argv[i + 1]) throw new UsageError('--root needs a directory');
      opts.root = path.resolve(argv[++i]);
    } else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice(7));
    else throw new UsageError(`Unknown option: ${a}`);
  }
  return opts;
}

class UsageError extends Error {}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** { "a.b": "text" } from nested JSON. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const placeholders = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([a-zA-Z][\w-]*)\s*\/?>/g)].map((m) => m[0].replace(/\s+/g, '')).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Group plural keys: base -> { form -> key } ; other keys map to themselves. */
function pluralGroups(flat) {
  const groups = new Map();
  for (const key of Object.keys(flat)) {
    const m = PLURAL_SUFFIX.exec(key);
    if (!m) continue;
    const base = key.slice(0, -m[0].length);
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[m[1]] = key;
  }
  return groups;
}

function pluralForms(lang) {
  try {
    return new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  } catch {
    return ['one', 'other'];
  }
}

/** Compare one file (flat) with its English counterpart (flat). */
function compare(lang, file, en, tr, problems) {
  const add = (type, key, detail) => problems.push({ lang, file, type, key, ...(detail ? { detail } : {}) });
  const enPlural = pluralGroups(en);
  const trPlural = pluralGroups(tr);
  const forms = pluralForms(lang);
  const isPluralKey = (flat, groups, key) => {
    const m = PLURAL_SUFFIX.exec(key);
    return !!m && groups.has(key.slice(0, -m[0].length));
  };

  // plain keys
  for (const key of Object.keys(en)) {
    if (isPluralKey(en, enPlural, key)) continue;
    if (!(key in tr)) add('missing', key);
  }
  for (const key of Object.keys(tr)) {
    if (isPluralKey(tr, trPlural, key)) {
      const base = key.slice(0, -PLURAL_SUFFIX.exec(key)[0].length);
      if (!enPlural.has(base)) add('extra', key);
      continue;
    }
    if (!(key in en)) add('extra', key);
  }
  // plural groups: the language's own forms
  for (const [base, enForms] of enPlural) {
    const trForms = trPlural.get(base) ?? {};
    for (const f of forms) if (!trForms[f] && !(base in tr)) add('missing', `${base}_${f}`, `plural form "${f}" needed for ${lang}`);
    for (const f of Object.keys(trForms)) if (!forms.includes(f)) add('extra', `${base}_${f}`, `${lang} has no plural form "${f}" (${forms.join(', ')})`);
    void enForms;
  }
  // texts
  for (const [key, value] of Object.entries(tr)) {
    if (typeof value !== 'string') {
      add('type', key, 'must be a string');
      continue;
    }
    if (!value.trim()) add('empty', key);
    const m = PLURAL_SUFFIX.exec(key);
    const base = m ? key.slice(0, -m[0].length) : null;
    const source =
      key in en ? en[key] : base && enPlural.has(base) ? (en[`${base}_other`] ?? Object.values(enPlural.get(base)).map((k) => en[k])[0]) : undefined;
    if (source === undefined) continue;
    let want = placeholders(source);
    let got = placeholders(value);
    if (base) {
      // "one" forms may say "a minute" instead of "{{count}} minutes"
      want = want.filter((p) => p !== 'count');
      got = got.filter((p) => p !== 'count');
    }
    if (!same(want, got)) add('placeholders', key, `English has ${fmtList(want)}, ${lang} has ${fmtList(got)}`);
    const wantTags = tags(source);
    const gotTags = tags(value);
    if (!same(wantTags, gotTags)) add('tags', key, `English has ${fmtList(wantTags)}, ${lang} has ${fmtList(gotTags)}`);
  }
}

const fmtList = (l) => (l.length ? l.map((x) => (x.startsWith('<') ? x : `{{${x}}}`)).join(' ') : 'none');

function readJson(file, problems, lang, rel) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('top level must be an object');
    return data;
  } catch (e) {
    problems.push({ lang, file: rel, type: 'invalid', key: '', detail: e.message });
    return null;
  }
}

/** Language codes declared in shared/src/locales.ts */
function declaredLanguages(root) {
  const file = path.join(root, 'shared/src/locales.ts');
  if (!fs.existsSync(file)) return null;
  return [...fs.readFileSync(file, 'utf8').matchAll(/code:\s*'([\w-]+)'/g)].map((m) => m[1]);
}

export function check(root) {
  const problems = [];
  const stats = {};
  const webDir = path.join(root, 'web/src/locales');
  const serverDir = path.join(root, 'server/src/i18n/locales');
  if (!fs.existsSync(path.join(webDir, 'en')))
    throw new UsageError(`No English locale folder at ${path.relative(process.cwd(), path.join(webDir, 'en')) || webDir}`);
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  const langs = fs
    .readdirSync(webDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const declared = declaredLanguages(root);
  if (declared) {
    for (const l of declared)
      if (!langs.includes(l))
        problems.push({
          lang: l,
          file: rel(webDir),
          type: 'missing',
          key: '',
          detail: `language "${l}" is declared in shared/src/locales.ts but has no folder`,
        });
    for (const l of langs)
      if (!declared.includes(l))
        problems.push({ lang: l, file: rel(path.join(webDir, l)), type: 'extra', key: '', detail: `folder "${l}" is not declared in shared/src/locales.ts` });
  }

  const enFiles = fs
    .readdirSync(path.join(webDir, 'en'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const enFlat = {};
  for (const f of enFiles) {
    const data = readJson(path.join(webDir, 'en', f), problems, 'en', rel(path.join(webDir, 'en', f)));
    if (data) enFlat[f] = flatten(data);
  }
  stats.en = { files: enFiles.length, keys: Object.values(enFlat).reduce((n, o) => n + Object.keys(o).length, 0) };

  for (const lang of langs.filter((l) => l !== 'en')) {
    let keys = 0;
    const files = fs.readdirSync(path.join(webDir, lang)).filter((f) => f.endsWith('.json'));
    for (const f of enFiles) {
      const p = path.join(webDir, lang, f);
      if (!fs.existsSync(p)) {
        problems.push({ lang, file: rel(p), type: 'missing', key: '', detail: 'namespace file missing' });
        continue;
      }
      const data = readJson(p, problems, lang, rel(p));
      if (!data || !enFlat[f]) continue;
      const flat = flatten(data);
      keys += Object.keys(flat).length;
      compare(lang, rel(p), enFlat[f], flat, problems);
    }
    for (const f of files)
      if (!enFiles.includes(f)) problems.push({ lang, file: rel(path.join(webDir, lang, f)), type: 'extra', key: '', detail: 'namespace has no English file' });
    stats[lang] = { files: files.length, keys };
  }

  // server catalog (optional per language: missing languages fall back to English)
  const enServer = path.join(serverDir, 'en.json');
  if (fs.existsSync(enServer)) {
    const en = readJson(enServer, problems, 'en', rel(enServer));
    for (const f of fs.readdirSync(serverDir).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
      const lang = f.slice(0, -5);
      const p = path.join(serverDir, f);
      const data = readJson(p, problems, lang, rel(p));
      if (en && data) compare(lang, rel(p), flatten(en), flatten(data), problems);
      if (declared && !declared.includes(lang))
        problems.push({ lang, file: rel(p), type: 'extra', key: '', detail: `language "${lang}" is not declared in shared/src/locales.ts` });
    }
  }
  return { ok: problems.length === 0, languages: langs, stats, problems };
}

function report(result, useColor) {
  const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const byFile = new Map();
  for (const p of result.problems) {
    const k = `${p.file}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(p);
  }
  for (const [file, list] of byFile) {
    process.stderr.write(`${c('1', file)}\n`);
    for (const p of list) {
      process.stderr.write(`  ${c('31', p.type.padEnd(12))} ${p.key}${p.detail ? c('2', `  ${p.detail}`) : ''}\n`);
    }
  }
  const langs = result.languages.filter((l) => l !== 'en');
  const summary = langs.map((l) => `${l}: ${result.stats[l]?.keys ?? 0}/${result.stats.en.keys} keys`).join(', ');
  if (result.ok)
    process.stdout.write(
      `${c('32', '✓')} All languages match English (${result.stats.en.keys} keys in ${result.stats.en.files} namespaces${summary ? `; ${summary}` : ''}).\n`,
    );
  else
    process.stderr.write(
      `${c('31', '✗')} ${result.problems.length} problem(s) found${summary ? ` (${summary})` : ''}. English is the source of truth: add or fix the keys above.\n`,
    );
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`i18n-check: ${e.message}\nRun with --help for usage.\n`);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return EXIT_OK;
  }
  let result;
  try {
    result = check(opts.root);
  } catch (e) {
    process.stderr.write(`i18n-check: ${e.message}\n`);
    return EXIT_USAGE;
  }
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else report(result, !process.env.NO_COLOR && process.stderr.isTTY && process.env.TERM !== 'dumb');
  return result.ok ? EXIT_OK : EXIT_PROBLEMS;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
