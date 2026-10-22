import { describe, expect, it } from 'vitest';
import { evalExpr, render, expressionLimits, setExpressionLimits } from '../src/engine/expr.js';

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
  it('neutralises catastrophic backtracking (linear fallback)', async () => {
    const t0 = Date.now();
    const v = await evalExpr("$contains('" + 'a'.repeat(44) + "!', /(a+)+$/)", {});
    expect(v).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
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

describe('render threads options through', () => {
  it('applies limits inside a template', async () => {
    await expect(render('x {{ $sum([1..5000000]) }}', {}, {}, { maxSequence: 1000 })).rejects.toThrow(/sequence/i);
  });
});
