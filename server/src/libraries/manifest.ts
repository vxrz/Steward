import path from 'node:path';
import { z } from 'zod';
import {
  LIBRARY_ID_RE,
  LIBRARY_LIMITS,
  LIBRARY_MANIFEST_FILE,
  LIBRARY_MANIFEST_FORMAT,
  LIBRARY_RELEASE_FILE,
  LIBRARY_RELEASE_FORMAT,
  LIBRARY_SEMVER_RE,
  LIBRARY_SIGNATURE_FILE,
} from '@sm/shared';
import { canonicalJson } from '../util.js';

/**
 * The two files of a library that are not items: `steward-library.yaml` (written by the publisher) and
 * `release.json` (written by `steward library build`, signed with `ssh-keygen -Y sign -n steward-library`).
 * The JSON Schema of the manifest (docs/libraries/steward-library-1.schema.json) is generated from the zod
 * schema below (`npm run library -- schema`).
 */

export const SCHEMA_ID = 'https://github.com/vxrz/Steward/blob/main/docs/libraries/steward-library-1.schema.json';

const id = (what: string) =>
  z.string().regex(LIBRARY_ID_RE, `${what}: lower case letters, digits and hyphens (at most 64)`).describe(`${what}: lower case letters, digits and hyphens`);
const semver = z.string().regex(LIBRARY_SEMVER_RE, 'a SemVer version such as 1.4.0 or 1.5.0-rc.1');
const plainVersion = z.string().regex(/^\d+\.\d+\.\d+$/, 'a version such as 0.10.0');

/** A path inside the library folder: relative, forward slashes, no "." or ".." segments, no hidden files. */
export function libraryPathProblem(p: string): string | null {
  if (!p || p.length > 300) return 'empty or longer than 300 characters';
  if (p.startsWith('/') || p.includes('\\')) return 'must be relative, with forward slashes';
  if ([...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return 'contains control characters';
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'contains an empty, "." or ".." segment';
  if (segs.some((s) => s.startsWith('.'))) return 'hidden files and folders are not part of a library';
  if (!segs.every((s) => /^[A-Za-z0-9._@+-]+$/.test(s))) return 'letters, digits and . _ - @ + only';
  if (path.posix.normalize(p) !== p) return 'is not normalised';
  return null;
}
/** Hidden files and folders (.git, .DS_Store, …) are never part of a release – on build, fetch and upload alike. */
export const isHiddenPath = (p: string) => p.split('/').some((s) => s.startsWith('.'));

const libraryPath = z
  .string()
  .superRefine((p, ctx) => {
    const problem = libraryPathProblem(p);
    if (problem) ctx.addIssue({ code: 'custom', message: `${p.slice(0, 100)}: ${problem}` });
  })
  .describe('A path inside the library folder, e.g. processes/guest-review.yaml');

const reference = z
  .object({
    ref: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'letters, digits, . _ -')
      .describe('The name the items use for it'),
    kind: z.string().max(64).optional().describe('Platforms: the platform kind it must be (e.g. entra)'),
    description: z.string().max(500).optional(),
  })
  .strict();

export const libraryManifestSchema = z
  .object({
    format: z.literal(LIBRARY_MANIFEST_FORMAT),
    version: z.literal(1),
    library: id('library').describe('Stable id of the library, unique per publisher'),
    name: z.string().trim().min(1).max(200),
    publisher: id('publisher').describe('The publisher id the signing key belongs to'),
    release: semver.describe('This release (SemVer)'),
    steward_min_version: plainVersion.describe('The oldest Steward version that can install the release'),
    licence: z.string().max(100).optional().describe('SPDX licence identifier, e.g. Apache-2.0'),
    description: z.string().max(4000).default(''),
    items: z
      .array(libraryPath)
      .min(1)
      .max(LIBRARY_LIMITS.maxFiles)
      .describe('Item files: processes, dashboards, monitors, record types, connector types (one per file)'),
    references: z
      .object({
        platforms: z.array(reference).max(100).default([]),
        processes: z.array(reference).max(100).default([]),
      })
      .strict()
      .default({ platforms: [], processes: [] })
      .describe('What the items need from the installation; mapped by the reviewer at install'),
    changelog: z
      .array(z.object({ release: semver, notes: z.string().max(4000) }).strict())
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (new Set(m.items).size !== m.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'an item is listed twice' });
    for (const f of [LIBRARY_MANIFEST_FILE, LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE])
      if (m.items.includes(f)) ctx.addIssue({ code: 'custom', path: ['items'], message: `${f} is not an item` });
    for (const k of ['platforms', 'processes'] as const) {
      const refs = m.references[k].map((r) => r.ref);
      if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', path: ['references', k], message: 'a reference is listed twice' });
    }
  });
export type LibraryManifest = z.infer<typeof libraryManifestSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 in lower-case hex');

export const releaseFileSchema = z
  .object({
    format: z.literal(LIBRARY_RELEASE_FORMAT),
    version: z.literal(1),
    library: id('library'),
    publisher: id('publisher'),
    release: semver,
    steward_min_version: plainVersion,
    files: z
      .array(
        z
          .object({
            path: libraryPath,
            size: z.number().int().min(0).max(LIBRARY_LIMITS.maxFileBytes),
            sha256: sha256Hex,
          })
          .strict(),
      )
      .min(1)
      .max(LIBRARY_LIMITS.maxFiles),
  })
  .strict()
  .superRefine((r, ctx) => {
    const paths = r.files.map((f) => f.path);
    if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', path: ['files'], message: 'a file is listed twice' });
    if (!paths.includes(LIBRARY_MANIFEST_FILE)) ctx.addIssue({ code: 'custom', path: ['files'], message: `${LIBRARY_MANIFEST_FILE} is not listed` });
    for (const f of [LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE])
      if (paths.includes(f)) ctx.addIssue({ code: 'custom', path: ['files'], message: `${f} cannot list itself` });
    if (r.files.reduce((n, f) => n + f.size, 0) > LIBRARY_LIMITS.maxTotalBytes)
      ctx.addIssue({ code: 'custom', path: ['files'], message: `the files are larger than ${LIBRARY_LIMITS.maxTotalBytes} bytes together` });
  });
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

/** release.json as the build writes it: canonical JSON (sorted keys, files sorted by path) and a final newline. */
export function releaseJsonText(r: ReleaseFile): string {
  return `${canonicalJson({ ...r, files: [...r.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) })}\n`;
}

/** Zod issues as short messages with the place in the file. */
export function issueList(issues: z.core.$ZodIssue[]): string[] {
  return issues.slice(0, 30).map((i) => `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}`);
}

export function manifestJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(libraryManifestSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = s;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Steward library manifest (steward-library.yaml), format 1',
    description:
      'A named, versioned set of Steward items (processes, dashboards, monitors, record types, connector types) from one publisher. `steward library build` writes release.json from it; the publisher signs release.json with `ssh-keygen -Y sign -n steward-library`. See docs/LIBRARIES.md.',
    ...rest,
  };
}
