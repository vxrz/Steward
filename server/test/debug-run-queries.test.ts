import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Debug runs (ADR 0010) are a new kind of run every reader of `runs` must know about: an aggregate that forgets them
 * shows debug results as real. Every query on `runs` outside engine/ either leaves them out (`debug IS NULL`), asks for
 * them (`debug IS NOT NULL`) or says why it includes them (a `// debug runs: <reason>` comment just above it).
 */

const SRC = path.resolve(__dirname, '..', 'src');
const QUERY = /\b(FROM|JOIN|UPDATE|INTO)\s+runs\b/;
/** Queries decided elsewhere (file: reason), for files another feature owns. */
const DECIDED_ELSEWHERE: Record<string, string> = {
  'msteams/botcard.ts': 'the run of a task by its id: debug runs never create tasks',
};
const DECIDED = /debug IS (NOT )?NULL|debug runs:/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'engine' || e.name === 'migrations' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('queries on runs outside engine/', () => {
  it('each one decides about debug runs', () => {
    const undecided: string[] = [];
    let queries = 0;
    for (const f of files(SRC)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!QUERY.test(line)) return;
        queries++;
        const window = lines.slice(Math.max(0, i - 4), i + 3).join('\n');
        if (!DECIDED.test(window) && !DECIDED_ELSEWHERE[path.relative(SRC, f)])
          undecided.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(queries).toBeGreaterThan(30);
    expect(undecided).toEqual([]);
  });

  it('the aggregates the record names leave debug runs out', () => {
    // daily summary, evidence packs, compliance controls, reports, the start page, duties, failed checks of reviews
    const must: Record<string, number> = {
      'notifications/summary.ts': 1,
      'compliance/evidence-pack.ts': 1,
      'compliance/controls.ts': 1,
      'reports/sections.ts': 1,
      'reports/summary-report.ts': 1,
      'routes/dashboard-home.ts': 2,
      'duties/evaluate.ts': 1,
      'records/reviews.ts': 1,
      'processes/service.ts': 1,
      'metrics.ts': 1,
    };
    for (const [f, n] of Object.entries(must)) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect((text.match(/debug IS NULL/g) ?? []).length, f).toBeGreaterThanOrEqual(n);
    }
  });
});
