import fs from 'node:fs';
import path from 'node:path';
import { SYNC_LIMITS } from '@sm/shared';
import { config } from '../config.js';
import { logger } from '../log.js';
import { gitBlobSha, objectFormatOf, type GitApi } from './providers.js';

/**
 * Git file contents Steward already knows, by Git object id – so a fetch does not download them again (0.20.0).
 *
 * GitHub allows 60 API calls an hour without a token, and every file is one call. Two sources of known contents:
 *   - the example files shipped with this installation (config.examplesDir): Steward's example library follows the
 *     tag of this version, so its files are, byte for byte, the ones on disk – its fetch then needs a handful of calls
 *     (tag, commit, tree) instead of one per file;
 *   - files downloaded recently (in memory, bounded): a fetch that stopped at a rate limit goes on where it stopped,
 *     and two sources with the same files share them.
 *
 * Nothing is trusted by name: a known content is used only when its Git object id is the id the commit's tree names
 * (checked here and again by the caller), the same check every downloaded file passes. The memory part holds only
 * contents that passed that check; it is not persisted (files that are refused for secrets are never stored).
 */

/** Memory for recent downloads: a few fetches' worth (a fetch reads at most SYNC_LIMITS.maxTotalBytes). */
const MAX_MEMORY_BYTES = 4 * SYNC_LIMITS.maxTotalBytes;
const DEFINITION = /\.(ya?ml|json)$/i;
/** Example files indexed at most (the shipped examples are about 150). */
const MAX_EXAMPLE_FILES = 2000;

const memory = new Map<string, Buffer>();
let memoryBytes = 0;
/** Object id → file below the examples folder, per object format; built on first use. */
let examples: { dir: string; ids: Map<string, string> } | null = null;

function remember(sha: string, content: Buffer): void {
  if (memory.has(sha) || content.length > SYNC_LIMITS.maxFileBytes) return;
  memory.set(sha, content);
  memoryBytes += content.length;
  for (const [key, old] of memory) {
    if (memoryBytes <= MAX_MEMORY_BYTES) break;
    memory.delete(key);
    memoryBytes -= old.length;
  }
}

function recent(sha: string): Buffer | undefined {
  const b = memory.get(sha);
  if (b) {
    // most recently used last
    memory.delete(sha);
    memory.set(sha, b);
  }
  return b;
}

function exampleIndex(): Map<string, string> {
  const dir = config.examplesDir;
  if (examples?.dir === dir) return examples.ids;
  const ids = new Map<string, string>();
  let seen = 0;
  const walk = (folder: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (seen >= MAX_EXAMPLE_FILES) return;
      const file = path.join(folder, d.name);
      if (d.isDirectory() && depth < 8) walk(file, depth + 1);
      else if (d.isFile() && DEFINITION.test(d.name)) {
        seen++;
        try {
          const content = fs.readFileSync(file);
          if (content.length > SYNC_LIMITS.maxFileBytes) continue;
          ids.set(gitBlobSha(content, 'sha1'), file);
          ids.set(gitBlobSha(content, 'sha256'), file);
        } catch {
          /* unreadable: not a known content */
        }
      }
    }
  };
  walk(dir, 0);
  examples = { dir, ids };
  if (ids.size) logger.debug({ files: ids.size / 2 }, 'git sync: shipped example files indexed by Git object id');
  return ids;
}

function shipped(sha: string): Buffer | undefined {
  const file = exampleIndex().get(sha);
  if (!file) return undefined;
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

/** The content of the blob with this object id when Steward knows it (verified against the id), else undefined. */
export function knownBlob(sha: string, maxBytes: number): Buffer | undefined {
  const format = objectFormatOf(sha);
  for (const content of [recent(sha), shipped(sha)]) {
    if (content && content.length <= maxBytes && gitBlobSha(content, format) === sha) return content;
  }
  return undefined;
}

/** Remembers a downloaded blob – only when it is the content its object id names. */
export function rememberBlob(sha: string, content: Buffer): void {
  if (gitBlobSha(content, objectFormatOf(sha)) === sha) remember(sha, content);
}

/** The API with known contents served without a download; every download that matches its id is remembered. */
export function withKnownBlobs(api: GitApi): GitApi {
  return {
    ...api,
    async blob(sha, maxBytes) {
      const known = knownBlob(sha, maxBytes);
      if (known) return known;
      const content = await api.blob(sha, maxBytes);
      rememberBlob(sha, content);
      return content;
    },
  };
}

/** Tests: forget everything (and index the examples folder again on next use). */
export function resetBlobCache(): void {
  memory.clear();
  memoryBytes = 0;
  examples = null;
}
