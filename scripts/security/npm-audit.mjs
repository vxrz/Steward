#!/usr/bin/env node
// npm audit for the production dependencies, with the accepted risks from osv-scanner.toml.
//
//   node scripts/security/npm-audit.mjs [--audit-level=low|moderate|high|critical]
//
// npm audit can't ignore a single advisory. This runs `npm audit --omit=dev --json` and fails on every
// finding at or above the level, except advisories listed under [[IgnoredVulns]] in osv-scanner.toml
// whose ignoreUntil date has not passed. One list of accepted risks, with a reason and an expiry, for
// both scanners (see docs/SECURITY-PIPELINE.md).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

const arg = process.argv.slice(2).find((a) => a.startsWith('--audit-level='));
const level = arg ? arg.split('=')[1] : 'high';
if (!LEVELS.includes(level)) {
  console.error(`npm-audit: unknown --audit-level "${level}" (one of ${LEVELS.join(', ')})`);
  process.exit(2);
}

/** Accepted advisories from osv-scanner.toml: id → { until, reason }, only those not yet expired. */
function acceptedRisks(today) {
  const text = fs.readFileSync(path.join(ROOT, 'osv-scanner.toml'), 'utf8');
  const out = new Map();
  for (const block of text.split(/^\[\[IgnoredVulns\]\]\s*$/m).slice(1)) {
    const id = /^id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const until = /^ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m.exec(block)?.[1];
    const reason = /^reason\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? '';
    if (!id || !until) continue; // an entry without an expiry is not accepted here
    if (until < today) {
      console.log(`npm-audit: the accepted risk ${id} expired on ${until} – it fails again`);
      continue;
    }
    out.set(id, { until, reason });
  }
  return out;
}

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
  } catch (e) {
    // npm audit exits non-zero when it finds something; the report is still on stdout
    if (e && typeof e === 'object' && 'stdout' in e && e.stdout) return String(e.stdout);
    throw e;
  }
}

const report = JSON.parse(runAudit());
if (report.error) {
  console.error(`npm-audit: npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}
const accepted = acceptedRisks(new Date().toISOString().slice(0, 10));
const vulns = report.vulnerabilities ?? {};
const advisoryId = (via) => /\/advisories\/(GHSA-[\w-]+)/.exec(via.url ?? '')?.[1];

// A package is covered when each of its own advisories is accepted and every package it is
// vulnerable through (via by name) is covered as well.
const covered = new Map();
function isCovered(name, seen = new Set()) {
  if (covered.has(name)) return covered.get(name);
  if (seen.has(name)) return true; // a cycle adds nothing new
  seen.add(name);
  const v = vulns[name];
  const ok = !!v && v.via.every((via) => (typeof via === 'string' ? isCovered(via, seen) : accepted.has(advisoryId(via))));
  covered.set(name, ok);
  return ok;
}

const min = LEVELS.indexOf(level);
const failing = [];
for (const [name, v] of Object.entries(vulns)) {
  if (LEVELS.indexOf(v.severity) < min) continue;
  if (isCovered(name)) {
    for (const via of v.via.filter((x) => typeof x !== 'string')) {
      const a = accepted.get(advisoryId(via));
      console.log(`accepted until ${a.until}: ${name} ${via.severity} ${advisoryId(via)} – ${via.title}\n  ${a.reason}`);
    }
    continue;
  }
  failing.push(v);
}

if (failing.length) {
  console.error(`\nnpm-audit: ${failing.length} package(s) with ${level} or higher findings that are not accepted:`);
  for (const v of failing) {
    const own = v.via.filter((x) => typeof x !== 'string').map((x) => `${advisoryId(x) ?? x.url} ${x.title}`);
    const through = v.via.filter((x) => typeof x === 'string');
    console.error(`- ${v.name} (${v.severity})${own.length ? `: ${own.join('; ')}` : ''}${through.length ? ` via ${through.join(', ')}` : ''}`);
  }
  console.error('Fix them, or accept a risk with a reason and an expiry in osv-scanner.toml (docs/SECURITY-PIPELINE.md).');
  process.exit(1);
}
console.log(`npm-audit: no ${level} or higher findings in the production dependencies that are not accepted.`);
