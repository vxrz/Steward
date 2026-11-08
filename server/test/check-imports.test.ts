import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../scripts/check-imports.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A checkout with only these files (paths relative to its root). */
function checkout(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-imports-'));
  dirs.push(root);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

describe('npm run check:imports', () => {
  it('passes on this repository (the committed baseline is up to date)', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('finds a runtime cycle, but not one through type-only or lazy imports', () => {
    const root = checkout({
      'server/src/a.ts': "import { b } from './b.js';\nexport const a = () => b();\n",
      'server/src/b.ts': "import { a } from './a.js';\nexport const b = () => a();\n",
      // type-only in three spellings, and a value import only used as a type: erased by the compiler
      'server/src/c.ts': "import type { D } from './d.js';\nimport { type E } from './e.js';\nimport { F } from './f.js';\nexport type C = D | E | F;\n",
      'server/src/d.ts': "import { c } from './cc.js';\nexport type D = number;\nexport const d = c;\n",
      'server/src/cc.ts': "import type { C } from './c.js';\nexport const c: C | null = null;\n",
      'server/src/e.ts': "import { c } from './cc.js';\nexport type E = string;\nexport const e = c;\n",
      'server/src/f.ts': 'export interface F { x: number }\nexport const f = 1;\n',
      'server/src/lazy-a.ts': "export const la = () => import('./lazy-b.js');\n",
      'server/src/lazy-b.ts': "import { la } from './lazy-a.js';\nexport const lb = la;\n",
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 import(s) close a new runtime cycle');
    expect(r.stderr).toContain('server/src/a.ts → server/src/b.ts → server/src/a.ts');
    expect(r.stderr).not.toMatch(/c\.ts|d\.ts|e\.ts|lazy/);
    // the baseline accepts today's cycle; a cycle removed later makes the baseline outdated
    expect(run(root, '--update').status).toBe(0);
    expect(run(root).status).toBe(0);
    fs.writeFileSync(path.join(root, 'server/src/b.ts'), 'export const b = () => 1;\n');
    const after = run(root);
    expect(after.status).toBe(1);
    expect(after.stderr).toContain('no longer close a cycle or break a rule');
  });

  it('keeps the layer rules: shared/ imports neither the server nor the web app', () => {
    const root = checkout({
      'shared/src/index.ts': "import { x } from '../../server/src/x.js';\nexport const y = x;\n",
      'server/src/x.ts': 'export const x = 1;\n',
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('shared-is-shared: shared/src/index.ts -> server/src/x.ts');
  });
});
