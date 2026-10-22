#!/usr/bin/env node
// Finds user-visible English text in the web UI that does not go through i18next:
// JSX text, text props (title, label, placeholder, aria-label …), notification and
// dialog texts. Uses the TypeScript compiler API (no type checking, just the syntax tree).
// See docs/I18N.md ("Checking for hard-coded texts").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HELP = `Usage: npm run i18n:literals -- [options] [files…]

Lists texts in web/src that a person sees but that are not translated:
  JSX text                          <Text>Save changes</Text>
  text props                        title="…", label="…", placeholder="…", aria-label="…"
  options                           data={['First option', …]}
  text properties in objects        notifications.show({ title: '…', message: '…' })
  notifyOk('…'), confirm('…')

Texts that are the same in every language (product names, units, acronyms,
symbols) are allowed by scripts/i18n-allow.json ("literals"). Anything else that
must stay as it is gets a comment on the line or the line above:
  // i18n-ignore: <reason>        or   {/* i18n-ignore: <reason> */}

Options:
  --json         Print the findings as JSON on stdout
  --root <dir>   Repository root (default: the folder above scripts/)
  -h, --help     Show this help

Exit codes: 0 no findings, 1 findings, 2 usage or I/O error.`;

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

/** JSX attributes whose value is shown to people (or read by screen readers). */
const TEXT_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'alt',
  'description',
  'error',
  'message',
  'tooltip',
  'emptyText',
  'nothingFoundMessage',
  'confirmLabel',
  'cancelLabel',
  'heading',
  'caption',
  'legend',
  'hint',
  'help',
  'text',
  'onLabel',
  'offLabel',
]);

/** Object properties whose value is shown to people (notifications, modals, select options, column definitions). */
const TEXT_PROPS = new Set([
  'title',
  'message',
  'label',
  'placeholder',
  'description',
  'confirm',
  'cancel',
  'tooltip',
  'ariaLabel',
  'help',
  'hint',
  'emptyText',
  'heading',
  'header',
  'caption',
  'text',
  'nothingFoundMessage',
  // props passed on to components (closeButtonProps: { 'aria-label': … })
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
]);

/** Functions whose string arguments are shown to people. */
const TEXT_CALLS = new Set(['notifyOk', 'notifyError', 'confirm', 'alert', 'prompt', 'window.confirm', 'window.alert', 'window.prompt']);

function parseArgs(argv) {
  const opts = { json: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--root') {
      if (!argv[i + 1]) throw new UsageError('--root needs a directory');
      opts.root = path.resolve(argv[++i]);
    } else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice(7));
    else if (a.startsWith('-')) throw new UsageError(`Unknown option: ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'locales' || e.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Loads scripts/i18n-allow.json: { literals: { exact: [], patterns: [] } }. */
export function loadAllow(root) {
  const file = path.join(root, 'scripts/i18n-allow.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const l = data.literals ?? {};
  return { exact: new Set(l.exact ?? []), patterns: (l.patterns ?? []).map((p) => new RegExp(p, 'u')) };
}

/**
 * True when a string reads like words a person would translate. Code-like values
 * (identifiers, URLs, paths, CSS, units, symbols) and allowed texts are not.
 */
export function isText(raw, allow) {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (allow.exact.has(s)) return false;
  if (allow.patterns.some((re) => re.test(s))) return false;
  // Remove placeholders, URLs, paths, e-mail addresses and code in backticks before looking for words
  const words = s
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/(^|\s)\/[\w./:-]*/g, ' ');
  const tokens = words.match(/[\p{L}][\p{L}'’-]*/gu) ?? [];
  // Words: at least two letters, not an ACRONYM, not in the allow-list of words
  const real = tokens.filter((w) => w.length >= 2 && !/^[\p{Lu}\d-]+s?$/u.test(w) && !allow.exact.has(w));
  if (real.length === 0) return false;
  // A single lower-case token without spaces is an identifier (variant, color, CSS value, key) – not prose
  if (!/\s/.test(s) && /^[\p{Ll}\d_.:#/$-]+$/u.test(s)) return false;
  // camelCase / kebab-case / snake_case identifiers and CSS
  if (!/\s/.test(s) && /^[\w.$-]+$/.test(s) && /[a-z][A-Z]|_|^[a-z$]/.test(s)) return false;
  if (/^[\d.,\s%]*(px|em|rem|vh|vw|ms|s|fr)?(\s+[\d.,]+(px|em|rem|%))*$/.test(s)) return false;
  return true;
}

/** Line and character of a node, 1-based. */
function pos(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

/**
 * `i18n-ignore` on the line of the text, the line above it, or the line above (or of) the enclosing
 * JSX element, attribute, object property or statement – e.g. above a table of English defaults
 * that are translated by key.
 */
function isIgnored(sf, node, lines) {
  const marked = (n) => {
    const l = pos(sf, n).line;
    return /i18n-ignore/.test(lines[l - 1] ?? '') || /i18n-ignore/.test(lines[l - 2] ?? '');
  };
  if (marked(node)) return true;
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxAttribute(p) || ts.isPropertyAssignment(p)) {
      if (marked(p)) return true;
    } else if (ts.isStatement(p) && !ts.isBlock(p)) return marked(p);
  }
  return false;
}

/** String parts of an expression that end up as the value: literals, template parts, both branches of ?: and ?? / || fallbacks. */
function stringParts(expr) {
  if (!expr) return [];
  if (ts.isParenthesizedExpression(expr)) return stringParts(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ node: expr, text: expr.text }];
  if (ts.isTemplateExpression(expr)) {
    const text = [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)].join(' {{x}} ');
    return [{ node: expr, text }];
  }
  if (ts.isConditionalExpression(expr)) return [...stringParts(expr.whenTrue), ...stringParts(expr.whenFalse)];
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken) return [...stringParts(expr.left), ...stringParts(expr.right)];
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return stringParts(expr.right);
    if (k === ts.SyntaxKind.PlusToken) return [...stringParts(expr.left), ...stringParts(expr.right)];
  }
  return [];
}

const calleeName = (e) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${calleeName(e.expression)}.${e.name.text}` : '');
const propName = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : '');

/** Is this node inside a call of i18next (t('…', { defaultValue: '…' })) – such texts are fallbacks, not literals. */
function insideTranslationCall(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const n = calleeName(p.expression);
      if (n === 't' || n.endsWith('.t') || n === 'i18n.t') return true;
    }
    if (ts.isJsxElement(p) || ts.isFunctionLike(p)) return false;
  }
  return false;
}

export function scanSource(file, text, allow) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const findings = [];
  const add = (node, kind, value, context) => {
    if (!isText(value, allow) || isIgnored(sf, node, lines) || insideTranslationCall(node)) return;
    findings.push({ file, ...pos(sf, node), kind, context, text: value.replace(/\s+/g, ' ').trim() });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node, 'jsx-text', node.text, '');
    else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const p of stringParts(node.expression)) add(p.node, 'jsx-text', p.text, '');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      // Select/SegmentedControl options given as plain strings are shown as they are
      if (
        name === 'data' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isArrayLiteralExpression(node.initializer.expression)
      )
        for (const el of node.initializer.expression.elements) for (const p of stringParts(el)) add(p.node, 'attribute', p.text, 'data');
      if (TEXT_ATTRS.has(name) && node.initializer) {
        const parts = ts.isStringLiteral(node.initializer)
          ? [{ node: node.initializer, text: node.initializer.text }]
          : stringParts(node.initializer.expression);
        for (const p of parts) add(p.node, 'attribute', p.text, name);
      }
    } else if (ts.isPropertyAssignment(node) && TEXT_PROPS.has(propName(node.name))) {
      for (const p of stringParts(node.initializer)) add(p.node, 'property', p.text, propName(node.name));
    } else if (ts.isCallExpression(node) && TEXT_CALLS.has(calleeName(node.expression))) {
      for (const a of node.arguments) for (const p of stringParts(a)) add(p.node, 'call', p.text, calleeName(node.expression));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function scan(root, files = []) {
  const allow = loadAllow(root);
  const list = files.length ? files.map((f) => path.resolve(f)) : walk(path.join(root, 'web/src'));
  const findings = [];
  for (const f of list) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    findings.push(...scanSource(rel, fs.readFileSync(f, 'utf8'), allow));
  }
  return { ok: findings.length === 0, files: list.length, findings };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`i18n-literals: ${e.message}\nRun with --help for usage.\n`);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return EXIT_OK;
  }
  let result;
  try {
    result = scan(opts.root, opts.files);
  } catch (e) {
    process.stderr.write(`i18n-literals: ${e.message}\n`);
    return EXIT_USAGE;
  }
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    for (const f of result.findings)
      process.stderr.write(`${f.file}:${f.line}:${f.col}  ${f.kind}${f.context ? ` (${f.context})` : ''}  ${JSON.stringify(f.text)}\n`);
    if (result.ok) process.stdout.write(`✓ No untranslated texts in ${result.files} files.\n`);
    else
      process.stderr.write(
        `✗ ${result.findings.length} untranslated text(s). Move them to web/src/locales (t('…')), or allow them in scripts/i18n-allow.json / with // i18n-ignore: <reason>.\n`,
      );
  }
  return result.ok ? EXIT_OK : EXIT_FINDINGS;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
