// Build information shared by the web build (web/vite.config.ts) and the desktop executable
// (scripts/build-exe.mjs): commit and date of the build, and the list of third-party packages
// with their licences for the About page.
//
//   SM_BUILD_COMMIT   commit hash (default: `git rev-parse HEAD`, if git and .git are available)
//   SM_BUILD_DATE     ISO date (default: SOURCE_DATE_EPOCH, else now)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** @returns {{ commit: string | null, date: string }} */
export function buildInfo(root) {
  let commit = process.env.SM_BUILD_COMMIT?.trim() || null;
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      commit = null;
    }
  }
  if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) commit = null;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const fromEnv = process.env.SM_BUILD_DATE?.trim();
  const date = fromEnv && !Number.isNaN(Date.parse(fromEnv)) ? new Date(fromEnv) : Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
  return { commit, date: date.toISOString() };
}

function licenseOf(entry, dir) {
  if (typeof entry.license === 'string' && entry.license) return entry.license;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license?.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  } catch {
    /* not installed */
  }
  return 'UNKNOWN';
}

/**
 * Production dependencies (server runtime and the libraries bundled into the web UI) from
 * package-lock.json: [{ name, version, license }], sorted, without the workspace packages.
 */
export function thirdPartyLicenses(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const seen = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes('node_modules/') || entry.link || entry.dev || entry.devOptional) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@sm/')) continue;
    const id = `${name}@${entry.version}`;
    if (!seen.has(id)) seen.set(id, { name, version: entry.version, license: licenseOf(entry, path.join(root, key)) });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}
