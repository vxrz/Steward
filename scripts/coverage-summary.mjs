#!/usr/bin/env node
/**
 * The coverage of the server tests as a Markdown summary (#23): the totals and the least covered files.
 * CI appends it to the job summary ($GITHUB_STEP_SUMMARY). Report only – it never fails.
 *
 *   node scripts/coverage-summary.mjs [server/coverage/coverage-summary.json] [--files 15]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? 'server/coverage/coverage-summary.json';
const filesArg = args.indexOf('--files');
const topN = filesArg >= 0 ? Number(args[filesArg + 1]) || 15 : 15;

if (!fs.existsSync(file)) {
  console.log(`_No coverage summary at \`${file}\` (the tests did not finish)._`);
  process.exit(0);
}
const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
const pct = (m) => (m && m.total ? `${m.pct.toFixed(1)} %` : '–');
const kinds = ['statements', 'branches', 'functions', 'lines'];
const root = path.resolve('server') + path.sep;

const out = ['## Server test coverage', '', '| | Statements | Branches | Functions | Lines |', '| --- | --- | --- | --- | --- |'];
out.push(`| **Total** | ${kinds.map((k) => `**${pct(summary.total[k])}**`).join(' | ')} |`);
const files = Object.entries(summary)
  .filter(([k, v]) => k !== 'total' && v.statements.total >= 50)
  .map(([k, v]) => ({ name: k.startsWith(root) ? k.slice(root.length) : k, v }))
  .sort((a, b) => a.v.lines.pct - b.v.lines.pct)
  .slice(0, topN);
out.push('', `Least covered files (at least 50 statements):`, '', '| File | Statements | Branches | Functions | Lines |', '| --- | --- | --- | --- | --- |');
for (const f of files) out.push(`| \`${f.name}\` | ${kinds.map((k) => pct(f.v[k])).join(' | ')} |`);
out.push('', '_The full HTML report is attached to the run as the artifact "server-coverage"._');
console.log(out.join('\n'));
