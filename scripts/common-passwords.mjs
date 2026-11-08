#!/usr/bin/env node
// Builds the bundled list of common passwords (server/assets/passwords/common-passwords.txt.gz) from a published list:
//
//   node scripts/common-passwords.mjs <list.txt> [--out <file>]
//
// <list.txt>: one password per line (UTF-8), such as a "most common passwords" list. Each entry is put in the form
// Steward compares (Unicode NFKC, lower case), entries the length rule refuses anyway are left out (shared/src/api.ts
// PASSWORD_RULES: fewer than 12 or more than 256 characters), duplicates are dropped and the rest is sorted and
// gzip-compressed (no file name or time in the header, so the same list gives the same bytes).
//
// The source and its licence go into NOTICE (and its licence text next to the file); see docs/SECURITY-HARDENING.md.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MIN = 12;
const MAX = 256;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : path.join(root, 'server', 'assets', 'passwords', 'common-passwords.txt.gz');
const input = args[0];
if (!input || args.length !== 1) {
  console.error('Usage: node scripts/common-passwords.mjs <list.txt> [--out <file>]');
  process.exit(2);
}

const entries = new Set();
let read = 0;
for (const line of fs.readFileSync(input, 'utf8').split(/\r?\n/)) {
  const pw = line.normalize('NFKC').toLowerCase().trim();
  if (!pw) continue;
  read++;
  const length = [...pw].length;
  if (length >= MIN && length <= MAX) entries.add(pw);
}
const sorted = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const gz = zlib.gzipSync(Buffer.from(sorted.join('\n') + '\n', 'utf8'), { level: 9 });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, gz);
console.log(`${read} passwords read, ${sorted.length} kept (${MIN}–${MAX} characters) → ${path.relative(process.cwd(), out)} (${gz.length} bytes)`);
