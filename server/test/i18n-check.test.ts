import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../scripts/i18n-check.mjs';

const script = path.resolve(__dirname, '../../scripts/i18n-check.mjs');
const repo = path.resolve(__dirname, '../..');

function fixture(files: Record<string, unknown>, languages = ['en', 'de']): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-i18n-'));
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  write('shared/src/locales.ts', `export const LOCALES = [${languages.map((l) => `{ code: '${l}' }`).join(', ')}];`);
  for (const [rel, data] of Object.entries(files)) write(rel, typeof data === 'string' ? data : JSON.stringify(data));
  return root;
}

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('npm run i18n:check', () => {
  it('passes for the repository', () => {
    const r = check(repo);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports missing and extra keys, placeholders, tags and empty texts', () => {
    const root = fixture({
      'web/src/locales/en/a.json': {
        hello: 'Hello {{name}}',
        nested: { x: 'X', bold: 'a <b>b</b>' },
        items_one: '{{count}} item',
        items_other: '{{count}} items',
        gone: 'Gone',
      },
      'web/src/locales/de/a.json': {
        hello: 'Hallo {{nom}}',
        nested: { x: '', bold: 'a b' },
        items_one: 'ein Eintrag',
        items_other: '{{count}} Einträge',
        extra: 'Extra',
      },
      'server/src/i18n/locales/en.json': { a: 'A {{x}}' },
      'server/src/i18n/locales/de.json': { a: 'A' },
    });
    const r = check(root);
    const types = r.problems.map((p: { type: string; key: string }) => `${p.type}:${p.key}`).sort();
    expect(types).toEqual(['empty:nested.x', 'extra:extra', 'missing:gone', 'placeholders:a', 'placeholders:hello', 'tags:nested.bold']);
    expect(r.ok).toBe(false);
  });

  it('checks plural forms per language', () => {
    const root = fixture(
      {
        'web/src/locales/en/a.json': { n_one: '{{count}} file', n_other: '{{count}} files' },
        'web/src/locales/de/a.json': { n_other: '{{count}} Dateien', n_few: 'x' },
        'web/src/locales/pl/a.json': { n_one: '1 plik', n_few: '{{count}} pliki', n_many: '{{count}} plików', n_other: '{{count}} pliku' },
      },
      ['en', 'de', 'pl'],
    );
    const problems = check(root).problems.map((p: { lang: string; type: string; key: string }) => `${p.lang}:${p.type}:${p.key}`);
    expect(problems).toEqual(expect.arrayContaining(['de:missing:n_one', 'de:extra:n_few']));
    expect(problems.filter((p: string) => p.startsWith('pl:'))).toEqual([]);
  });

  it('reports texts that are still English unless they are allowed to be the same', () => {
    const root = fixture({
      'web/src/locales/en/a.json': { save: 'Save changes', name: 'Name', count: '{{count}} PDF', url: 'URL', ok: 'Done' },
      'web/src/locales/de/a.json': { save: 'Save changes', name: 'Name', count: '{{count}} PDF', url: 'URL', ok: 'Fertig' },
      'scripts/i18n-allow.json': { sameAsEnglish: { de: ['Name'] } },
    });
    const problems = check(root).problems.map((p: { type: string; key: string }) => `${p.type}:${p.key}`);
    // placeholders and ACRONYMS are no words to translate; "Name" is German too (allowed)
    expect(problems).toEqual(['untranslated:save']);
  });

  it('reports undeclared and missing language folders and missing namespaces', () => {
    const root = fixture({ 'web/src/locales/en/a.json': { a: 'A' }, 'web/src/locales/en/b.json': { b: 'B' }, 'web/src/locales/fr/a.json': { a: 'A' } });
    const problems = check(root).problems.map((p: { lang: string; type: string; detail?: string; file: string }) => `${p.lang}:${p.type}:${p.file}`);
    expect(problems).toEqual(expect.arrayContaining(['de:missing:web/src/locales', 'fr:extra:web/src/locales/fr', 'fr:missing:web/src/locales/fr/b.json']));
  });

  it('follows CLI conventions: help, JSON output, exit codes, errors on stderr', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: npm run i18n:check');

    const ok = run('--root', repo);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('All languages match English');

    const bad = fixture({ 'web/src/locales/en/a.json': { a: 'A' }, 'web/src/locales/de/a.json': {} });
    const fail = run('--root', bad);
    expect(fail.status).toBe(1);
    expect(fail.stderr).toContain('missing');
    expect(fail.stdout).toBe('');

    const json = run('--root', bad, '--json');
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, problems: [{ lang: 'de', type: 'missing', key: 'a' }] });

    const usage = run('--nope');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Unknown option');
    expect(run('--root', path.join(os.tmpdir(), 'does-not-exist-sm')).status).toBe(2);
  });
});
