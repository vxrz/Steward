import type { LibraryOrigin } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { keyStateOf } from './trust.js';

/**
 * Small lookups other modules need (the engine, run details, reports): their own module, so those do not import
 * the install code.
 */

/** The library a process belongs to while that library is on hold (ADR 0014): the engine refuses new runs of it. */
export function heldLibraryOf(processId: string): string | null {
  return (
    db().get<{ library: string }>(
      "SELECT i.library FROM sync_items s JOIN library_installs i ON s.source_id = 'lib:' || i.library WHERE s.kind = 'process' AND s.entity_id = ? AND i.held = 1",
      processId,
    )?.library ?? null
  );
}

export type VersionOrigin = LibraryOrigin & { keyRevoked: boolean };

/** The library release a process version came from (process_versions.origin), with the state of its key now. */
export function versionOrigin(processId: string, version: number): VersionOrigin | null {
  const r = db().get<{ origin: string | null }>('SELECT origin FROM process_versions WHERE process_id = ? AND version = ?', processId, version);
  const o = r?.origin ? parseJson<LibraryOrigin | null>(r.origin, null) : null;
  return o ? { ...o, keyRevoked: keyStateOf(o.keyFingerprint) === 'revoked' } : null;
}
