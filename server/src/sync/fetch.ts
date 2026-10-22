import path from 'node:path';
import { SYNC_LIMITS, type SyncFetchResult, type SyncKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { newId, nowIso, parseJson } from '../util.js';
import { gitApi, gitBlobSha, resolveRepo, SyncError, type TreeEntry } from './providers.js';
import { requireSource, sourceToken, type SourceRow } from './service.js';
import { findLocal, localById, localHash, parseFile, sameAsLocal, type ParsedItem } from './items.js';

/**
 * One fetch of a source: read the branch head, list the configured folder, download changed
 * definition files, validate each one and stage it as a pending update. Nothing is applied here
 * (except "auto-accept new items" when the source enables it, see accept.ts).
 */

const DEFINITION = /\.(ya?ml|json)$/i;
/** Regular files only: symbolic links (120000) and submodules (160000) are skipped. */
const FILE_MODES = new Set(['100644', '100755']);

interface ItemRow {
  kind: SyncKind;
  entity_id: string;
  source_id: string;
  path: string;
  source_hash: string;
  local_hash: string;
}

interface UpdateRow {
  id: string;
  status: string;
  content_hash: string;
}

/** Paths below the folder only, no traversal, no odd characters (path confinement). */
export function confined(p: string, folder: string): boolean {
  if (!p || p.length > 500 || /\\/.test(p) || [...p].some((c) => c.charCodeAt(0) < 32) || p.startsWith('/')) return false;
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  if (path.posix.normalize(p) !== p) return false;
  return !folder || p.startsWith(`${folder}/`);
}

const running = new Map<string, Promise<SyncFetchResult>>();
const again = new Set<string>();

/** Fetch now; a second call while one runs waits for it (and, for webhooks, runs once more afterwards). */
export function fetchSource(id: string, trigger: 'manual' | 'schedule' | 'webhook', actor?: string): Promise<SyncFetchResult> {
  const busy = running.get(id);
  if (busy) {
    if (trigger === 'webhook') again.add(id);
    return busy;
  }
  const p = doFetch(id, trigger, actor).finally(() => {
    running.delete(id);
    if (again.delete(id)) void fetchSource(id, 'webhook').catch(() => undefined);
  });
  running.set(id, p);
  return p;
}

export const isFetching = (id: string) => running.has(id);

function finish(r: SourceRow, patch: { status: 'ok' | 'error'; error?: string | null; commit?: string | null; verified?: boolean | null }) {
  db().run(
    'UPDATE sync_sources SET last_fetch_at = ?, last_status = ?, last_error = ?, last_commit = COALESCE(?, last_commit), last_verified = ? WHERE id = ?',
    nowIso(),
    patch.status,
    patch.error ?? null,
    patch.commit ?? null,
    patch.verified === undefined || patch.verified === null ? null : patch.verified ? 1 : 0,
    r.id,
  );
}

async function doFetch(id: string, trigger: 'manual' | 'schedule' | 'webhook', actor?: string): Promise<SyncFetchResult> {
  const r = requireSource(id);
  const result: SyncFetchResult = {
    sourceId: id,
    commit: null,
    verified: null,
    upToDate: false,
    files: 0,
    staged: 0,
    unchanged: 0,
    invalid: 0,
    autoAccepted: 0,
  };
  const via = trigger === 'manual' ? '' : ` (${trigger})`;
  try {
    const ref = resolveRepo(r.provider, r.repo_url, r.api_url);
    const api = gitApi(ref, sourceToken(r));
    const head = await api.head(r.branch);
    result.commit = head.sha;
    result.verified = head.verified;
    if (r.require_signed && head.verified !== true) {
      throw new SyncError(
        `The head commit ${head.sha.slice(0, 10)} of ${r.branch} is not signed with a key the Git host verified – this source requires signed commits`,
        409,
      );
    }
    if (head.sha === r.last_commit && trigger !== 'manual') {
      result.upToDate = true;
      finish(r, { status: 'ok', commit: head.sha, verified: head.verified });
      return result;
    }
    const entries = (await api.tree(head.sha, r.folder)).filter((e) => e.type === 'blob' && DEFINITION.test(e.path));
    const files: TreeEntry[] = [];
    for (const e of entries) {
      if (!confined(e.path, r.folder)) {
        logger.warn({ source: id, path: e.path.slice(0, 200) }, 'git sync: path outside the configured folder ignored');
        continue;
      }
      if (e.mode && !FILE_MODES.has(e.mode)) continue;
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.sha)) throw new SyncError(`Tree entry ${e.path}: invalid object id`);
      files.push(e);
    }
    if (files.length > SYNC_LIMITS.maxFiles) {
      throw new SyncError(
        `The folder holds ${files.length} definition files – more than the limit of ${SYNC_LIMITS.maxFiles}. Point the source at a smaller folder.`,
        413,
      );
    }
    result.files = files.length;
    const kinds = parseJson<SyncKind[]>(r.kinds, []);
    let total = 0;
    const staged: { path: string; kind: SyncKind | null; action: string; status: string }[] = [];
    const autoAccept: string[] = [];
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const item = db().get<ItemRow>('SELECT * FROM sync_items WHERE source_id = ? AND path = ?', id, f.path);
      // the same blob as last applied: nothing to download
      if (item && db().get('SELECT 1 FROM sync_items WHERE source_id = ? AND path = ? AND blob_sha = ?', id, f.path, f.sha)) {
        result.unchanged++;
        continue;
      }
      const latest = db().get<UpdateRow & { blob_sha: string }>(
        'SELECT id, status, content_hash, blob_sha FROM sync_updates WHERE source_id = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        id,
        f.path,
      );
      if (latest && latest.blob_sha === f.sha && ['pending', 'rejected', 'invalid'].includes(latest.status)) {
        result.unchanged++;
        continue;
      }
      if (f.size !== undefined && f.size > SYNC_LIMITS.maxFileBytes) {
        stageInvalid(r, f, head, null, null, [`The file is ${f.size} bytes – larger than the limit of ${SYNC_LIMITS.maxFileBytes}`], f.sha);
        result.invalid++;
        staged.push({ path: f.path, kind: null, action: 'invalid', status: 'invalid' });
        continue;
      }
      const content = await api.blob(f.sha, SYNC_LIMITS.maxFileBytes);
      total += content.length;
      if (total > SYNC_LIMITS.maxTotalBytes)
        throw new SyncError(`The definition files are larger than ${SYNC_LIMITS.maxTotalBytes} bytes together – point the source at a smaller folder`, 413);
      if (gitBlobSha(content) !== f.sha && f.sha.length === 40) throw new SyncError(`File ${f.path}: the content does not match its Git object id`);
      const parsed = await parseFile(f.path, content.toString('utf8'), kinds);
      if (!parsed.ok) {
        if (latest?.status === 'invalid' && latest.content_hash === parsed.hash) {
          result.unchanged++;
          continue;
        }
        stageInvalid(r, f, head, parsed.kind, parsed.identity, parsed.errors, parsed.hash);
        result.invalid++;
        staged.push({ path: f.path, kind: parsed.kind, action: 'invalid', status: 'invalid' });
        continue;
      }
      const outcome = stage(r, f, head, parsed.item, item);
      if (outcome === 'unchanged') result.unchanged++;
      else if (outcome === 'error') result.invalid++;
      else {
        result.staged++;
        staged.push({ path: f.path, kind: parsed.item.kind, action: outcome.action, status: 'pending' });
        if (r.auto_accept_new && outcome.action === 'create' && !outcome.conflict) autoAccept.push(outcome.id);
      }
    }
    finish(r, { status: 'ok', commit: head.sha, verified: head.verified });
    audit({
      actor: actor ?? (trigger === 'manual' ? undefined : 'git-sync'),
      action: 'sync.fetched',
      entityType: 'sync_source',
      entityId: id,
      summary:
        `Git sync "${r.name}"${via}: fetched ${r.branch}@${head.sha.slice(0, 10)}${head.verified ? ' (signed)' : ''} – ` +
        `${result.files} file(s), ${result.staged} staged for review, ${result.invalid} invalid, ${result.unchanged} unchanged`,
      details: { trigger, commit: head.sha, verified: head.verified, files: result.files, staged, unchanged: result.unchanged },
    });
    if (autoAccept.length) result.autoAccepted = await autoAcceptNew(r, autoAccept);
    return result;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    result.error = msg;
    finish(r, { status: 'error', error: msg, verified: result.verified });
    audit({
      actor: actor ?? (trigger === 'manual' ? undefined : 'git-sync'),
      action: 'sync.fetch_failed',
      entityType: 'sync_source',
      entityId: id,
      summary: `Git sync "${r.name}"${via} failed: ${msg}`,
      details: { trigger, commit: result.commit, error: msg },
    });
    logger.warn({ source: id, err: msg }, 'git sync fetch failed');
    if (trigger === 'manual') throw e;
    return result;
  }
}

function stageInvalid(
  r: SourceRow,
  f: TreeEntry,
  head: { sha: string; verified: boolean | null },
  kind: SyncKind | null,
  identity: string | null,
  errors: string[],
  hash: string,
) {
  db().tx(() => {
    supersede(r.id, f.path);
    insertUpdate(r, f, head, {
      kind,
      identity,
      entityId: null,
      entityName: identity,
      action: 'create',
      status: 'invalid',
      errors: errors.slice(0, 20).map((e) => e.slice(0, 500)),
      content: null,
      hash,
    });
  });
}

function supersede(sourceId: string, filePath: string) {
  db().run("UPDATE sync_updates SET status = 'superseded' WHERE source_id = ? AND path = ? AND status IN ('pending', 'invalid')", sourceId, filePath);
}

function insertUpdate(
  r: SourceRow,
  f: TreeEntry,
  head: { sha: string; verified: boolean | null },
  u: {
    kind: SyncKind | null;
    identity: string | null;
    entityId: string | null;
    entityName: string | null;
    action: 'create' | 'update';
    status: 'pending' | 'invalid';
    conflict?: string | null;
    errors?: string[];
    content: unknown;
    hash: string;
  },
): string {
  const id = newId('gsu_');
  db().run(
    `INSERT INTO sync_updates (id, source_id, kind, path, commit_sha, commit_verified, blob_sha, identity, entity_id, entity_name, action, conflict, conflict_reason, status, errors, content, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    r.id,
    u.kind,
    f.path,
    head.sha,
    head.verified === null ? null : head.verified ? 1 : 0,
    f.sha,
    u.identity,
    u.entityId,
    u.entityName,
    u.action,
    u.conflict ? 1 : 0,
    u.conflict ?? null,
    u.status,
    JSON.stringify(u.errors ?? []),
    u.content === null ? null : JSON.stringify(u.content),
    u.hash,
    nowIso(),
  );
  return id;
}

/** Why accepting would overwrite local work (null: no conflict). */
export function conflictOf(kind: SyncKind, entityId: string, item: ItemRow | undefined): string | null {
  if (!item) return 'The item exists in Steward but did not come from this source';
  const now = localHash(kind, entityId);
  return now !== null && now !== item.local_hash ? 'The item was changed in Steward since it was last synced' : null;
}

function stage(
  r: SourceRow,
  f: TreeEntry,
  head: { sha: string; verified: boolean | null },
  it: ParsedItem,
  mapped: ItemRow | undefined,
): 'unchanged' | 'error' | { id: string; action: 'create' | 'update'; conflict: boolean } {
  // a mapping whose item is gone (deleted, archived) or of another kind is dropped: the file counts as new
  const item = mapped && mapped.kind === it.kind && localById(it.kind, mapped.entity_id) ? mapped : undefined;
  if (mapped && !item) db().run('DELETE FROM sync_items WHERE kind = ? AND entity_id = ?', mapped.kind, mapped.entity_id);
  if (item && item.source_hash === it.hash) {
    db().run('UPDATE sync_items SET blob_sha = ?, commit_sha = ? WHERE kind = ? AND entity_id = ?', f.sha, head.sha, item.kind, item.entity_id);
    return 'unchanged';
  }
  const local = item ? localById(it.kind, item.entity_id) : findLocal(it.kind, it.identity);
  if (local && !item) {
    // the same item is synced from another file or source: refuse instead of letting two files fight over it
    const other = db().get<{ source_id: string; path: string }>('SELECT source_id, path FROM sync_items WHERE kind = ? AND entity_id = ?', it.kind, local.id);
    if (other) {
      stageInvalid(
        r,
        f,
        head,
        it.kind,
        it.identity,
        [`"${local.name}" is already synced from ${other.path}${other.source_id === r.id ? '' : ' of another source'}`],
        it.hash,
      );
      return 'error';
    }
    if (sameAsLocal(it, local.id)) {
      // identical content: just remember the origin
      link(r, f, head, it, local.id, 'git-sync');
      audit({
        actor: 'git-sync',
        action: 'sync.linked',
        entityType: it.kind === 'recordType' ? 'record_type' : it.kind,
        entityId: local.id,
        summary: `"${local.name}" is identical to ${f.path} in Git sync "${r.name}" and is linked to it`,
        details: { sourceId: r.id, path: f.path, commit: head.sha },
      });
      return 'unchanged';
    }
  }
  const conflict = local ? conflictOf(it.kind, local.id, item) : null;
  const action = local ? 'update' : 'create';
  const id = db().tx(() => {
    supersede(r.id, f.path);
    const uid = insertUpdate(r, f, head, {
      kind: it.kind,
      identity: it.identity,
      entityId: local?.id ?? null,
      entityName: local?.name ?? it.name,
      action,
      status: 'pending',
      conflict,
      content: it.content,
      hash: it.hash,
    });
    audit({
      actor: 'git-sync',
      action: 'sync.update_staged',
      entityType: 'sync_update',
      entityId: uid,
      summary: `Git sync "${r.name}": ${f.path} staged for review (${action === 'create' ? `new ${it.kind}` : `change to ${it.kind} "${local!.name}"`}${conflict ? ', conflict with local changes' : ''})`,
      details: { sourceId: r.id, path: f.path, commit: head.sha, kind: it.kind, entityId: local?.id ?? null, action, conflict },
    });
    return uid;
  });
  return { id, action, conflict: !!conflict };
}

export function link(
  r: SourceRow,
  f: { path: string; sha: string },
  head: { sha: string },
  it: Pick<ParsedItem, 'kind' | 'hash'>,
  entityId: string,
  by: string,
) {
  db().run(
    `INSERT INTO sync_items (kind, entity_id, source_id, path, commit_sha, blob_sha, source_hash, local_hash, applied_at, applied_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, entity_id) DO UPDATE SET source_id = excluded.source_id, path = excluded.path, commit_sha = excluded.commit_sha,
       blob_sha = excluded.blob_sha, source_hash = excluded.source_hash, local_hash = excluded.local_hash, applied_at = excluded.applied_at, applied_by = excluded.applied_by`,
    it.kind,
    entityId,
    r.id,
    f.path,
    head.sha,
    f.sha,
    it.hash,
    localHash(it.kind, entityId) ?? '',
    nowIso(),
    by,
  );
}

/** "Auto-accept new items": applied as the administrator who created the source (with their rights). */
async function autoAcceptNew(r: SourceRow, ids: string[]): Promise<number> {
  const owner = findUserByName(r.created_by);
  if (!owner || !owner.active) {
    logger.warn({ source: r.id }, 'git sync: auto-accept skipped, the source creator is missing or deactivated');
    return 0;
  }
  const { acceptUpdate } = await import('./updates.js');
  let n = 0;
  for (const uid of ids) {
    try {
      await runAs(toAuthUser(owner), () => acceptUpdate(uid, { comment: 'auto-accepted (new item)', auto: true }));
      n++;
    } catch (e) {
      logger.warn({ source: r.id, update: uid, err: (e as Error).message }, 'git sync: auto-accept failed – left for review');
    }
  }
  return n;
}
