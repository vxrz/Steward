#!/usr/bin/env node
/**
 * Install scripts of dependencies, enforced (npm 11 only warns about "allowScripts").
 *
 *   npm ci --ignore-scripts                 # nothing from node_modules runs during the install
 *   node scripts/install-scripts.mjs --check --run
 *
 * --check  fails (exit 1) when package-lock.json contains a package with an install script that is
 *          not reviewed in package.json "allowScripts" ("name@version": true = run it, false = never)
 * --run    runs the install scripts of the allowed packages that are installed (npm rebuild <name>)
 *
 * Exit status: 0 = ok, 1 = unreviewed install script (or a script failed), 2 = usage error.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  process.stdout.write('Usage: node scripts/install-scripts.mjs [--check] [--run]\nSee the comment at the top of the script.\n');
  process.exit(0);
}
const unknown = [...args].filter((a) => !['--check', '--run'].includes(a));
if (unknown.length || !args.size) {
  process.stderr.write(`error: ${unknown.length ? `unknown option '${unknown[0]}'` : 'pass --check and/or --run'}\nRun 'node scripts/install-scripts.mjs --help' for usage.\n`);
  process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const allow = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).allowScripts ?? {};
const withScripts = Object.entries(lock.packages ?? {})
  .filter(([p, v]) => p && v.hasInstallScript)
  .map(([p, v]) => ({ path: p, name: p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length), version: v.version }));

let failed = false;
if (args.has('--check')) {
  const unreviewed = withScripts.filter((x) => typeof allow[`${x.name}@${x.version}`] !== 'boolean');
  for (const x of unreviewed) process.stderr.write(`FAIL ${x.name}@${x.version} (${x.path}) has an install script that is not reviewed in package.json "allowScripts"\n`);
  if (unreviewed.length) failed = true;
  else console.log(`ok: ${withScripts.length} package(s) with install scripts, all reviewed in "allowScripts"`);
}
if (args.has('--run') && !failed) {
  const run = [...new Set(withScripts.filter((x) => allow[`${x.name}@${x.version}`] === true && fs.existsSync(path.join(root, x.path))).map((x) => x.name))];
  for (const name of run) {
    console.log(`running the install script of ${name} (npm rebuild ${name})`);
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['rebuild', name, '--foreground-scripts'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}
process.exit(failed ? 1 : 0);
