import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isText, scan, scanSource } from '../../scripts/i18n-literals.mjs';

const script = path.resolve(__dirname, '../../scripts/i18n-literals.mjs');
const repo = path.resolve(__dirname, '../..');
const allow = { exact: new Set(['Steward', 'ms']), patterns: [/^Bearer /u] };
const texts = (src: string) => scanSource('x.tsx', src, allow).map((f: { text: string }) => f.text);

describe('npm run i18n:literals', () => {
  it('finds no untranslated texts in the web UI', () => {
    const r = scan(repo);
    expect(r.findings).toEqual([]);
    expect(r.files).toBeGreaterThan(100);
  });

  it('finds JSX text, text props, notifications and dialog texts', () => {
    const src = `
      export function A() {
        const n = 2;
        notifications.show({ title: 'Saved', message: \`Saved \${n} items\` });
        if (!window.confirm('Delete this record?')) return null;
        return (
          <Stack>
            <Text>Nothing here yet</Text>
            <Button title="Open the file" aria-label={n ? 'Close dialog' : 'Open dialog'}>{'Click me'}</Button>
            <Select data={['First option']} />
          </Stack>
        );
      }`;
    expect(texts(src)).toEqual([
      'Saved',
      'Saved {{x}} items',
      'Delete this record?',
      'Nothing here yet',
      'Open the file',
      'Close dialog',
      'Open dialog',
      'Click me',
      'First option',
    ]);
  });

  it('leaves translated texts, code, allowed words and marked lines alone', () => {
    const src = `
      export function B() {
        const { t } = useTranslation();
        return (
          <Stack className="table-scroll" gap="xs">
            <Text>{t('records:title')}</Text>
            <Text title={t('x', { defaultValue: 'English fallback' })}>Steward</Text>
            <Code>{'{{ vars.x }}'}</Code>
            <TextInput placeholder="https://example.com/api" label="ID" />
            <Text>12 ms · 3 %</Text>
            <TextInput placeholder="Bearer <token>" />
            {/* i18n-ignore: a product name */}
            <Text>Siemens Insights Hub</Text>
            <Select data={['GET', 'POST', 'json']} />
          </Stack>
        );
      }
      // i18n-ignore: English defaults, translated by key
      const DEFAULTS = { a: { label: 'Host reachable' } };`;
    expect(texts(src)).toEqual([]);
  });

  it('tells words from code', () => {
    expect(isText('Save changes', allow)).toBe(true);
    expect(isText('Name', allow)).toBe(true);
    for (const code of ['primary', 'pre-wrap', 'dataSource', 'snake_case', 'PDF', 'HTTP 200', '{{count}}', '$vars', 'https://a.example', '–', '12px'])
      expect(isText(code, allow), code).toBe(false);
  });

  it('follows CLI conventions: help, JSON output, exit codes', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: npm run i18n:literals');
    const ok = run('--root', repo, '--json');
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, findings: [] });
    expect(run('--nope').status).toBe(2);
  });
});
