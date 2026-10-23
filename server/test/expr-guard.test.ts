import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { evalExpr, render, expressionLimits, isFixedLengthPattern, setExpressionLimits } from '../src/engine/expr.js';

// F1: the expression engine must bound CPU, stack, sequence size and regular
// expressions by default – a caller that passes no options is already safe.
describe('F1 – guarded expression evaluation (defaults)', () => {
  it('has safe default limits', () => {
    const l = expressionLimits();
    expect(l.timeoutMs).toBeGreaterThan(0);
    expect(l.maxDepth).toBeGreaterThan(0);
    expect(l.maxSequence).toBeGreaterThan(0);
  });

  it('stops the PoC expression within the timeout (not tens of seconds)', async () => {
    setExpressionLimits({ timeoutMs: 1000 });
    const t0 = Date.now();
    await expect(evalExpr('$count($map([1..30000], function($i){ $sum([1..30000]) }))', {})).rejects.toThrow(/stopped|timeout/i);
    expect(Date.now() - t0).toBeLessThan(4000);
    setExpressionLimits({ timeoutMs: 5000 });
  });

  it('caps the sequence length (ranges / $map blow-up)', async () => {
    await expect(evalExpr('$sum([1..5000000])', {}, {}, { maxSequence: 100000 })).rejects.toThrow(/sequence/i);
  });

  it('caps recursion depth', async () => {
    await expect(evalExpr('( $x := function($n){ $n<=0 ? 0 : $x($n-1)+1 }; $x(100000) )', {}, {}, { maxDepth: 500 })).rejects.toThrow(/deep|stopped/i);
  });

  it('does not block the event loop while a heavy expression runs', async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    await evalExpr('$count($map([1..20000], function($i){ $sum([1..20000]) }))', {}, {}, { timeoutMs: 800 }).catch(() => undefined);
    clearInterval(iv);
    // If the event loop were blocked the timer would never fire.
    expect(ticks).toBeGreaterThan(5);
  });

  it('can be cancelled via an AbortSignal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await expect(evalExpr('$count($map([1..30000], function($i){ $sum([1..30000]) }))', {}, {}, { timeoutMs: 10000, signal: ac.signal })).rejects.toThrow(
      /cancel/i,
    );
  });
});

// A classic catastrophic-backtracking regex must not freeze the server.
describe('F1 – regular expressions cannot block the server', () => {
  it('time-limits catastrophic backtracking (no V8 flag fallback any more)', async () => {
    const t0 = Date.now();
    await expect(evalExpr("$contains('" + 'a'.repeat(44) + "!', /(a+)+$/)", {})).rejects.toThrow(/longer than|simplify/i);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('time-limits polynomial backtracking on a long subject', async () => {
    const t0 = Date.now();
    // /\s+$/ on 200 000 spaces and a letter is quadratic: minutes when run natively
    await expect(evalExpr("$replace($pad('', 200000) & 'x', /\\s+$/, '')", {})).rejects.toThrow(/longer than|simplify/i);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('time-limits a backtracking-only pattern (case-insensitive) run in a worker', async () => {
    const t0 = Date.now();
    await expect(evalExpr("$contains('" + 'a'.repeat(44) + "!', /(a+)+$/i)", {})).rejects.toThrow(/longer than|simplify/i);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('still evaluates ordinary case-insensitive regexes correctly', async () => {
    expect(await evalExpr("$replace('Admin admin ADMIN', /admin/i, 'x')", {})).toBe('x x x');
    expect(await evalExpr("$contains('password123', /^(?=.*\\d)/)", {})).toBe(true);
  });
});

describe('regular expressions give the same results as native ones', () => {
  it('global $replace, $match and $split across many matches (worker batches)', async () => {
    const subject = Array.from({ length: 3000 }, (_, i) => `a${i}`).join(' ');
    const expected = subject.replace(/\d+/g, '#');
    const t0 = Date.now();
    expect(await evalExpr('$replace($s, /\\d+/, "#")', {}, { s: subject })).toBe(expected);
    expect(Date.now() - t0).toBeLessThan(3000);
    const m = (await evalExpr('$match($s, /a(\\d+)/)', {}, { s: subject })) as { match: string; index: number; groups: string[] }[];
    expect(m).toHaveLength(3000);
    expect(m[1234]).toMatchObject({ match: 'a1234', index: subject.indexOf('a1234'), groups: ['1234'] });
    expect(await evalExpr("$split('a1b22c333d', /\\d+/)", {})).toEqual(['a', 'b', 'c', 'd']);
    expect(await evalExpr('$match($s, /^m./im).match', {}, { s: 'Mo\nDi\nmi' })).toEqual(['Mo', 'mi']);
    expect(await evalExpr("$replace('x-1 y-22', /(\\w)-(\\d+)/, '$2$1')", {})).toBe('1x 22y');
  });

  it('runs the same pattern on alternating subjects correctly', async () => {
    expect(await evalExpr("[$replace('aa1', /a+/, 'x'), $replace('baa', /a+/, 'y'), $replace('aa1', /a+/, 'z')]", {})).toEqual(['x1', 'by', 'z1']);
  });

  it('runs fixed-length patterns natively, all others in the worker', () => {
    for (const re of [/admin/i, /T/g, /^\d\d:\d\d$/, /[*+?{|]/, /(?:ab)(?<x>c)/, /\u{1F600}/u, /\p{L}/u, /a\{/])
      expect(isFixedLengthPattern(re), String(re)).toBe(true);
    for (const re of [
      /a+/,
      /a*/,
      /a?/,
      /a{2}/,
      /a|b/,
      /(a)\1/,
      /(?<x>a)\k<x>/,
      /(?=a)/,
      /(?!a)/,
      /(?<=a)b/,
      /(?<!a)b/,
      /[a]+/,
      new RegExp('[a-z]', 'v'),
      new RegExp('x'.repeat(201)),
      // without the u flag (JSONata never sets it) \\u{…} and \\p{…} are a letter with a quantifier
      new RegExp('\\u{0,99}\\u{0,99}X'),
      new RegExp('\\p{0,99}\\P{0,99}X'),
      new RegExp('\\p{2}'),
    ])
      expect(isFixedLengthPattern(re), String(re)).toBe(false);
  });

  it('stops quantified \\u{…} patterns from JSONata within the time limit (review r4)', async () => {
    // before the fix this ran natively on the main thread for ~35 s; in the worker it is stopped after its budget
    const started = Date.now();
    await expect(
      evalExpr('$contains(s, /\\u{0,99}\\u{0,99}\\u{0,99}\\u{0,99}\\u{0,99}\\u{0,99}X/)', { s: 'u'.repeat(60) }, {}, { timeoutMs: 1000 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// Node 26 crashed (V8 CHECK in Genesis::InitializeGlobal_regexp_linear_flag) when a worker started after
// expr.ts had switched V8's experimental regexp engine on with v8.setFlagsFromString(). Flags stay as started.
describe('V8 flags are not changed at runtime', () => {
  it('a worker started after the server modules are loaded boots without experimental regexp flags', async () => {
    const { startTestServer } = await import('./helpers.js');
    const s = await startTestServer();
    try {
      // the regex worker and an expression run in the server process before the new worker starts
      expect(await evalExpr("$replace('Admin', /a(d)/i, '$1')", {})).toBe('dmin');
      const result = await new Promise<unknown>((resolve, reject) => {
        const w = new Worker(
          `const { parentPort } = require('node:worker_threads');
          let linearFlag = true;
          try { new RegExp('a', 'l'); } catch { linearFlag = false; }
          parentPort.postMessage({ linearFlag, linearGetter: 'linear' in RegExp.prototype });`,
          { eval: true },
        );
        w.once('message', (m) => void w.terminate().then(() => resolve(m)));
        w.once('error', reject);
      });
      expect(result).toEqual({ linearFlag: false, linearGetter: false });
    } finally {
      await s.app.close();
    }
  });

  it('no source file sets V8 flags at runtime', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const hits: string[] = [];
    for (const dir of ['server/src', 'shared/src', 'web/src', 'scripts']) {
      for (const f of fs.readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })) {
        if (!/\.(ts|tsx|mjs|js)$/.test(f)) continue;
        if (fs.readFileSync(path.join(root, dir, f), 'utf8').includes('setFlagsFromString(')) hits.push(`${dir}/${f}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('render threads options through', () => {
  it('applies limits inside a template', async () => {
    await expect(render('x {{ $sum([1..5000000]) }}', {}, {}, { maxSequence: 1000 })).rejects.toThrow(/sequence/i);
  });
});
