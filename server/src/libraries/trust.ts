import { z } from 'zod';
import { BUILT_IN_PUBLISHER_KEYS, LIBRARY_ID_RE, LIBRARY_LIMITS, type LibraryKey, type LibraryKeyState, type LibraryPublisher } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { checkMac, configMac, type IntegrityState } from '../integrity.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { parsePublicKeyLine, publicKeyLine, sshFingerprint, SshSigError } from './sshsig.js';

/**
 * Trusted publishers (Settings → Libraries → Trusted publishers): an administrator pins a publisher's public keys.
 * Keys and the publisher's list of library ids are sealed with the vault's integrity key (checkMac): a key written
 * into the database directly is not trusted. Adding a publisher or key, removing one, widening the library list and
 * lifting an expiry need a step-up (control point library.publishers, routes.ts); retiring and revoking only make
 * trust narrower and need none, so a stolen key can be stopped at once.
 *
 * Built-in keys (BUILT_IN_PUBLISHER_KEYS in shared/src/libraries.ts) come with the build and can be removed; the
 * removal is a settings row (a removed key is never trusted again by this installation until it is restored).
 */

const BUILT_IN_REMOVED_KEY = 'system.libraryBuiltInKeysRemoved';

interface PublisherRow {
  id: string;
  name: string;
  contact: string;
  libraries: string;
  mac: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface KeyRow {
  id: string;
  publisher_id: string;
  key_line: string;
  fingerprint: string;
  comment: string;
  state: LibraryKeyState;
  expires_at: string | null;
  revoked_reason: string | null;
  mac: string | null;
  created_by: string;
  created_at: string;
  changed_by: string | null;
  changed_at: string | null;
}

/** A key as the verification sees it. Only keys whose seal holds (or built-in ones) are returned by trustedKeys(). */
export interface TrustedKey {
  id: string;
  publisherId: string;
  publisherName: string;
  /** Library ids the publisher may publish; empty = any */
  libraries: string[];
  blob: Buffer;
  fingerprint: string;
  state: LibraryKeyState;
  expiresAt: string | null;
  builtIn: boolean;
}

const keyFields = (r: Pick<KeyRow, 'publisher_id' | 'key_line' | 'state' | 'expires_at'>) => ({
  publisherId: r.publisher_id,
  key: r.key_line,
  state: r.state,
  expiresAt: r.expires_at,
});
const publisherFields = (r: Pick<PublisherRow, 'libraries'>) => ({ libraries: parseJson<string[]>(r.libraries, []) });
const keyIntegrity = (r: KeyRow): IntegrityState => checkMac('library_key', r.id, keyFields(r), r.mac);
const publisherIntegrity = (r: PublisherRow): IntegrityState => checkMac('library_publisher', r.id, publisherFields(r), r.mac);
const sealKey = (id: string) => {
  const r = db().get<KeyRow>('SELECT * FROM library_keys WHERE id = ?', id);
  if (r) db().run('UPDATE library_keys SET mac = ? WHERE id = ?', configMac('library_key', id, keyFields(r)), id);
};
const sealPublisher = (id: string) => {
  const r = db().get<PublisherRow>('SELECT * FROM library_publishers WHERE id = ?', id);
  if (r) db().run('UPDATE library_publishers SET mac = ? WHERE id = ?', configMac('library_publisher', id, publisherFields(r)), id);
};

export function requireTrustAdmin(): void {
  if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators manage trusted publishers', 'FORBIDDEN', { context: 'manageLibraryPublishers' });
}

const removedBuiltIns = (): string[] => {
  const r = db().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', BUILT_IN_REMOVED_KEY);
  return r ? parseJson<string[]>(r.value, []) : [];
};

/** The built-in keys of this build (parsed once; a broken entry is a build error, surfaced by the tests). */
function builtInKeys(): (TrustedKey & { name: string; contact: string; comment: string; line: string })[] {
  const removed = new Set(removedBuiltIns());
  return BUILT_IN_PUBLISHER_KEYS.map((b) => {
    const k = parsePublicKeyLine(b.key);
    const fingerprint = sshFingerprint(k.blob);
    return {
      id: `builtin:${fingerprint}`,
      publisherId: b.publisher,
      publisherName: b.name,
      name: b.name,
      contact: b.contact ?? '',
      comment: k.comment,
      line: publicKeyLine(k),
      libraries: [],
      blob: k.blob,
      fingerprint,
      state: 'active' as const,
      expiresAt: null,
      builtIn: true,
    };
  }).filter((k) => !removed.has(k.fingerprint));
}

/** Every key the verification may use: sealed keys of sealed publishers, and the built-in keys not removed. */
export function trustedKeys(): TrustedKey[] {
  const pubs = new Map(
    db()
      .all<PublisherRow>('SELECT * FROM library_publishers')
      .map((p) => [p.id, p]),
  );
  const out: TrustedKey[] = [];
  for (const k of db().all<KeyRow>('SELECT * FROM library_keys ORDER BY created_at')) {
    const p = pubs.get(k.publisher_id);
    if (!p || publisherIntegrity(p) !== 'ok' || keyIntegrity(k) !== 'ok') continue;
    out.push({
      id: k.id,
      publisherId: p.id,
      publisherName: p.name,
      libraries: parseJson<string[]>(p.libraries, []),
      blob: parsePublicKeyLine(k.key_line).blob,
      fingerprint: k.fingerprint,
      state: k.state,
      expiresAt: k.expires_at,
      builtIn: false,
    });
  }
  for (const b of builtInKeys()) if (!out.some((k) => k.fingerprint === b.fingerprint)) out.push(b);
  return out;
}

/** The state of a key by fingerprint, as installed releases show it (unknown: removed or never trusted). */
export function keyStateOf(fingerprint: string): LibraryKeyState | 'unknown' {
  const r = db().get<KeyRow>('SELECT * FROM library_keys WHERE fingerprint = ?', fingerprint);
  if (r) return r.state === 'revoked' ? 'revoked' : keyIntegrity(r) === 'ok' ? r.state : 'unknown';
  return builtInKeys().some((k) => k.fingerprint === fingerprint) ? 'active' : 'unknown';
}

export const publisherName = (id: string): string =>
  db().get<{ name: string }>('SELECT name FROM library_publishers WHERE id = ?', id)?.name ??
  BUILT_IN_PUBLISHER_KEYS.find((b) => b.publisher === id)?.name ??
  id;

function toKey(r: KeyRow): LibraryKey {
  let type: LibraryKey['type'] = 'ssh-ed25519';
  try {
    type = parsePublicKeyLine(r.key_line).type;
  } catch {
    /* a broken line is shown as it is; it is never trusted (trustedKeys parses it again) */
  }
  return {
    id: r.id,
    publisherId: r.publisher_id,
    key: r.key_line,
    type,
    fingerprint: r.fingerprint,
    comment: r.comment,
    state: r.state,
    expiresAt: r.expires_at,
    revokedReason: r.revoked_reason,
    builtIn: false,
    integrity: keyIntegrity(r),
    createdBy: r.created_by,
    createdAt: r.created_at,
    changedBy: r.changed_by,
    changedAt: r.changed_at,
  };
}

const installedOf = (publisherId: string) =>
  db()
    .all<{ library: string }>('SELECT library FROM library_installs WHERE publisher_id = ? ORDER BY library', publisherId)
    .map((r) => r.library);

export function listPublishers(): LibraryPublisher[] {
  requireTrustAdmin();
  const keys = db().all<KeyRow>('SELECT * FROM library_keys ORDER BY created_at');
  const out: LibraryPublisher[] = db()
    .all<PublisherRow>('SELECT * FROM library_publishers ORDER BY name')
    .map((p) => ({
      id: p.id,
      name: p.name,
      contact: p.contact,
      libraries: parseJson<string[]>(p.libraries, []),
      builtIn: false,
      keys: keys.filter((k) => k.publisher_id === p.id).map(toKey),
      integrity: publisherIntegrity(p),
      createdBy: p.created_by,
      createdAt: p.created_at,
      installed: installedOf(p.id),
    }));
  for (const b of builtInKeys()) {
    const key: LibraryKey = {
      id: b.id,
      publisherId: b.publisherId,
      key: b.line,
      type: b.line.startsWith('sk-') ? 'sk-ssh-ed25519@openssh.com' : 'ssh-ed25519',
      fingerprint: b.fingerprint,
      comment: b.comment,
      state: 'active',
      expiresAt: null,
      revokedReason: null,
      builtIn: true,
      integrity: 'ok',
      createdBy: 'system',
      createdAt: '',
      changedBy: null,
      changedAt: null,
    };
    const p = out.find((x) => x.id === b.publisherId);
    if (p) p.keys.push(key);
    else
      out.push({
        id: b.publisherId,
        name: b.name,
        contact: b.contact,
        libraries: [],
        builtIn: true,
        keys: [key],
        integrity: 'ok',
        createdBy: 'system',
        createdAt: '',
        installed: installedOf(b.publisherId),
      });
  }
  return out;
}

const libraryList = z
  .array(z.string().trim().toLowerCase().regex(LIBRARY_ID_RE, 'A library id: lower case letters, digits and hyphens'))
  .max(LIBRARY_LIMITS.maxLibrariesPerPublisher)
  .default([])
  .transform((a) => [...new Set(a)].sort());

export const publisherInput = z.object({
  id: z.string().trim().toLowerCase().regex(LIBRARY_ID_RE, 'A publisher id: lower case letters, digits and hyphens'),
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(300).default(''),
  libraries: libraryList,
});
export const publisherUpdate = publisherInput.omit({ id: true });
const expiry = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date (YYYY-MM-DD)')
  .nullable()
  .optional();
export const keyInput = z.object({ key: z.string().trim().min(20).max(2000), expiresAt: expiry });
export const keyExpiryInput = z.object({ expiresAt: expiry });
export const revokeInput = z.object({ reason: z.string().trim().min(3).max(500) });

function requirePublisher(id: string): PublisherRow {
  const r = LIBRARY_ID_RE.test(id) ? db().get<PublisherRow>('SELECT * FROM library_publishers WHERE id = ?', id) : undefined;
  if (!r) throw new HttpError(404, 'Publisher not found', 'LIBRARY_PUBLISHER_NOT_FOUND');
  return r;
}

function requireKey(id: string): KeyRow {
  const r = /^lky_[A-Za-z0-9_-]{8,40}$/.test(id) ? db().get<KeyRow>('SELECT * FROM library_keys WHERE id = ?', id) : undefined;
  if (!r) throw new HttpError(404, 'Key not found', 'LIBRARY_KEY_NOT_FOUND');
  return r;
}

/** Widening a publisher's library list (or lifting it: empty = any) is a loosening and needs the step-up. */
export function widensLibraries(id: string, next: string[]): boolean {
  const r = LIBRARY_ID_RE.test(id) ? db().get<PublisherRow>('SELECT * FROM library_publishers WHERE id = ?', id) : undefined;
  if (!r) return true;
  const before = parseJson<string[]>(r.libraries, []);
  if (!next.length) return before.length > 0;
  return before.length > 0 && next.some((l) => !before.includes(l));
}

/** Lifting an expiry (later date or none) needs the step-up; an earlier date does not. */
export function liftsExpiry(id: string, next: string | null | undefined): boolean {
  const r = /^lky_[A-Za-z0-9_-]{8,40}$/.test(id) ? db().get<KeyRow>('SELECT * FROM library_keys WHERE id = ?', id) : undefined;
  if (!r) return true;
  if (!r.expires_at) return false;
  return !next || next > r.expires_at;
}

export function addPublisher(raw: z.input<typeof publisherInput>): LibraryPublisher {
  requireTrustAdmin();
  const p = publisherInput.parse(raw);
  if (db().get('SELECT 1 FROM library_publishers WHERE id = ?', p.id) || BUILT_IN_PUBLISHER_KEYS.some((b) => b.publisher === p.id))
    throw new HttpError(409, `A publisher "${p.id}" exists already`, 'LIBRARY_PUBLISHER_EXISTS');
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO library_publishers (id, name, contact, libraries, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.id,
      p.name,
      p.contact,
      JSON.stringify(p.libraries),
      currentActor(),
      ts,
      ts,
    );
    sealPublisher(p.id);
    audit({
      action: 'library.publisher_added',
      entityType: 'library_publisher',
      entityId: p.id,
      summary: `Trusted publisher "${p.name}" (${p.id}) added${p.libraries.length ? ` for ${p.libraries.join(', ')}` : ' for any library'}`,
      details: { name: p.name, contact: p.contact, libraries: p.libraries },
    });
  });
  return listPublishers().find((x) => x.id === p.id)!;
}

export function updatePublisher(id: string, raw: z.input<typeof publisherUpdate>): LibraryPublisher {
  requireTrustAdmin();
  const before = requirePublisher(id);
  const p = publisherUpdate.parse(raw);
  const was = parseJson<string[]>(before.libraries, []);
  db().tx(() => {
    db().run(
      'UPDATE library_publishers SET name = ?, contact = ?, libraries = ?, updated_at = ? WHERE id = ?',
      p.name,
      p.contact,
      JSON.stringify(p.libraries),
      nowIso(),
      id,
    );
    sealPublisher(id);
    audit({
      action: 'library.publisher_changed',
      entityType: 'library_publisher',
      entityId: id,
      summary: `Trusted publisher "${p.name}" (${id}) changed${JSON.stringify(was) !== JSON.stringify(p.libraries) ? `: libraries ${was.join(', ') || 'any'} → ${p.libraries.join(', ') || 'any'}` : ''}`,
      details: { name: p.name, contact: p.contact, libraries: p.libraries, previous: { name: before.name, contact: before.contact, libraries: was } },
    });
  });
  return listPublishers().find((x) => x.id === id)!;
}

/** Removes a publisher and its keys. Installed libraries stay; their updates are refused (no trusted key). */
export function removePublisher(id: string): void {
  requireTrustAdmin();
  if (!LIBRARY_ID_RE.test(id)) throw new HttpError(404, 'Publisher not found', 'LIBRARY_PUBLISHER_NOT_FOUND');
  const row = db().get<PublisherRow>('SELECT * FROM library_publishers WHERE id = ?', id);
  const builtIn = builtInKeys().filter((k) => k.publisherId === id);
  if (!row && !builtIn.length) throw new HttpError(404, 'Publisher not found', 'LIBRARY_PUBLISHER_NOT_FOUND');
  refuseRevokedInUse(db().all<KeyRow>('SELECT * FROM library_keys WHERE publisher_id = ?', id));
  db().tx(() => {
    const keys = db().all<KeyRow>('SELECT * FROM library_keys WHERE publisher_id = ?', id);
    db().run('DELETE FROM library_keys WHERE publisher_id = ?', id);
    db().run('DELETE FROM library_publishers WHERE id = ?', id);
    if (builtIn.length) writeRemoved([...removedBuiltIns(), ...builtIn.map((k) => k.fingerprint)]);
    audit({
      action: 'library.publisher_removed',
      entityType: 'library_publisher',
      entityId: id,
      summary: `Trusted publisher "${row?.name ?? builtIn[0]!.publisherName}" (${id}) removed with ${keys.length + builtIn.length} key(s)${builtIn.length ? ' (built in)' : ''}`,
      details: { keys: [...keys.map((k) => k.fingerprint), ...builtIn.map((k) => k.fingerprint)], builtIn: builtIn.length > 0, installed: installedOf(id) },
    });
  });
}

function writeRemoved(list: string[]) {
  db().run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    BUILT_IN_REMOVED_KEY,
    JSON.stringify([...new Set(list)].sort()),
  );
}

export function addKey(publisherId: string, raw: z.input<typeof keyInput>): LibraryKey {
  requireTrustAdmin();
  const p = requirePublisher(publisherId);
  const input = keyInput.parse(raw);
  let parsed;
  try {
    parsed = parsePublicKeyLine(input.key);
  } catch (e) {
    throw new HttpError(400, `Not a usable public key: ${(e as SshSigError).message}`, 'LIBRARY_KEY_INVALID');
  }
  const fingerprint = sshFingerprint(parsed.blob);
  const other = db().get<{ publisher_id: string }>('SELECT publisher_id FROM library_keys WHERE fingerprint = ?', fingerprint);
  if (other || builtInKeys().some((k) => k.fingerprint === fingerprint))
    throw new HttpError(
      409,
      `The key ${fingerprint} is trusted already${other && other.publisher_id !== p.id ? ' for another publisher' : ''}`,
      'LIBRARY_KEY_EXISTS',
    );
  if ((db().get<{ n: number }>('SELECT COUNT(*) AS n FROM library_keys WHERE publisher_id = ?', p.id)?.n ?? 0) >= LIBRARY_LIMITS.maxKeysPerPublisher)
    throw new HttpError(400, `A publisher has at most ${LIBRARY_LIMITS.maxKeysPerPublisher} keys – remove retired ones first`, 'LIBRARY_TOO_MANY_KEYS');
  const id = newId('lky_');
  db().tx(() => {
    db().run(
      `INSERT INTO library_keys (id, publisher_id, key_line, fingerprint, comment, state, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id,
      p.id,
      publicKeyLine(parsed),
      fingerprint,
      parsed.comment,
      input.expiresAt ?? null,
      currentActor(),
      nowIso(),
    );
    sealKey(id);
    audit({
      action: 'library.key_added',
      entityType: 'library_publisher',
      entityId: p.id,
      summary: `Key ${fingerprint} (${parsed.type}) added to trusted publisher "${p.name}"${input.expiresAt ? `, valid until ${input.expiresAt}` : ''}`,
      details: { keyId: id, fingerprint, type: parsed.type, comment: parsed.comment, expiresAt: input.expiresAt ?? null },
    });
  });
  return toKey(requireKey(id));
}

function changeKey(id: string, patch: { state?: LibraryKeyState; expiresAt?: string | null; reason?: string }, action: string, summary: (r: KeyRow) => string) {
  const r = requireKey(id);
  db().tx(() => {
    db().run(
      'UPDATE library_keys SET state = ?, expires_at = ?, revoked_reason = ?, changed_by = ?, changed_at = ? WHERE id = ?',
      patch.state ?? r.state,
      patch.expiresAt === undefined ? r.expires_at : patch.expiresAt,
      patch.reason ?? r.revoked_reason,
      currentActor(),
      nowIso(),
      id,
    );
    // a revoked key keeps its "revoked" mark even when its seal is broken (keyStateOf); sealing it again is harmless
    sealKey(id);
    audit({
      action,
      entityType: 'library_publisher',
      entityId: r.publisher_id,
      summary: summary(r),
      details: { keyId: id, fingerprint: r.fingerprint, ...patch, previous: { state: r.state, expiresAt: r.expires_at } },
    });
  });
  return toKey(requireKey(id));
}

/** Rotated out: releases staged or installed before stay valid; new releases signed with it are refused. */
export function retireKey(id: string): LibraryKey {
  requireTrustAdmin();
  const r = requireKey(id);
  if (r.state !== 'active') throw new HttpError(409, `The key is ${r.state} already`, 'LIBRARY_KEY_STATE');
  return changeKey(id, { state: 'retired' }, 'library.key_retired', (k) => `Key ${k.fingerprint} of publisher ${k.publisher_id} retired`);
}

/** Compromised: new releases are refused and every installed release signed with it is flagged (Hold offered). */
export function revokeKey(id: string, reason: string): LibraryKey {
  requireTrustAdmin();
  const r = requireKey(id);
  if (r.state === 'revoked') throw new HttpError(409, 'The key is revoked already', 'LIBRARY_KEY_STATE');
  const flagged = db().all<{ library: string }>(
    'SELECT i.library FROM library_installs i JOIN library_releases r ON r.id = i.release_id WHERE r.key_fingerprint = ?',
    r.fingerprint,
  );
  return changeKey(
    id,
    { state: 'revoked', reason },
    'library.key_revoked',
    (k) =>
      `Key ${k.fingerprint} of publisher ${k.publisher_id} revoked: ${reason.slice(0, 200)}${flagged.length ? ` – installed and flagged: ${flagged.map((f) => f.library).join(', ')}` : ''}`,
  );
}

export function setKeyExpiry(id: string, raw: z.input<typeof keyExpiryInput>): LibraryKey {
  requireTrustAdmin();
  const { expiresAt } = keyExpiryInput.parse(raw);
  return changeKey(
    id,
    { expiresAt: expiresAt ?? null },
    'library.key_changed',
    (k) => `Expiry of key ${k.fingerprint} (publisher ${k.publisher_id}): ${k.expires_at ?? 'none'} → ${expiresAt ?? 'none'}`,
  );
}

/** A revoked key stays while a release it signed is installed: removing it would drop the "revoked" flag. */
function refuseRevokedInUse(keys: Pick<KeyRow, 'state' | 'fingerprint'>[]) {
  for (const k of keys) {
    if (k.state !== 'revoked') continue;
    const used = db().all<{ library: string }>(
      'SELECT i.library FROM library_installs i JOIN library_releases r ON r.id = i.release_id WHERE r.key_fingerprint = ?',
      k.fingerprint,
    );
    if (used.length)
      throw new HttpError(
        409,
        `The revoked key ${k.fingerprint} signed the installed release of ${used.map((u) => u.library).join(', ')} – it stays until a release with a good key replaces it or the library is uninstalled`,
        'LIBRARY_KEY_IN_USE',
      );
  }
}

export function removeKey(id: string): void {
  requireTrustAdmin();
  if (id.startsWith('builtin:')) {
    const b = builtInKeys().find((k) => k.id === id);
    if (!b) throw new HttpError(404, 'Key not found', 'LIBRARY_KEY_NOT_FOUND');
    db().tx(() => {
      writeRemoved([...removedBuiltIns(), b.fingerprint]);
      audit({
        action: 'library.key_removed',
        entityType: 'library_publisher',
        entityId: b.publisherId,
        summary: `Built-in key ${b.fingerprint} of publisher "${b.publisherName}" removed`,
        details: { fingerprint: b.fingerprint, builtIn: true },
      });
    });
    return;
  }
  const r = requireKey(id);
  refuseRevokedInUse([r]);
  db().tx(() => {
    db().run('DELETE FROM library_keys WHERE id = ?', id);
    audit({
      action: 'library.key_removed',
      entityType: 'library_publisher',
      entityId: r.publisher_id,
      summary: `Key ${r.fingerprint} removed from trusted publisher ${r.publisher_id}`,
      details: { keyId: id, fingerprint: r.fingerprint, state: r.state },
    });
  });
}
