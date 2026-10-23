import { SYNC_UPDATE_STATUSES, type SyncKind, type SyncOrigin, type SyncUpdate, type SyncUpdateDetail, type SyncUpdateStatus } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import * as processes from '../processes/service.js';
import { monitorRow, permissionsOfRow } from '../monitors/model.js';
import { fileWebUrl } from './providers.js';
import { requireSource, type SourceRow } from './service.js';
import { applyItem, canDecide, canView, incomingText, localById, localText } from './items.js';
import { CONFLICT_TEXT, conflictOf, link } from './fetch.js';

/**
 * The "Updates from Git" inbox: pending updates are reviewed (diff) and accepted or rejected.
 * Reviewing needs the designer capability; each decision needs the same right as making the
 * change by hand (create processes, edit this process, manage record types, …).
 */

interface UpdateRow {
  id: string;
  source_id: string;
  kind: SyncKind | null;
  path: string;
  commit_sha: string;
  commit_verified: number | null;
  blob_sha: string;
  identity: string | null;
  entity_id: string | null;
  entity_name: string | null;
  action: 'create' | 'update';
  conflict: number;
  conflict_reason: SyncUpdate['conflictReason'];
  status: SyncUpdateStatus;
  errors: string;
  content: string | null;
  content_hash: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  result_version: number | null;
  source_name?: string;
  provider?: SourceRow['provider'];
  repo_url?: string;
}

const SELECT = `SELECT u.*, s.name AS source_name, s.provider, s.repo_url FROM sync_updates u JOIN sync_sources s ON s.id = u.source_id`;

export function requireReviewer(): void {
  if (!capabilities(currentUser()).createProcesses)
    throw new HttpError(403, 'Only designers and administrators can review updates from Git', 'FORBIDDEN', { context: 'reviewGitUpdates' });
}

/** Updates of items the reviewer cannot see are hidden like the items themselves (name, current definition). */
const visible = (r: UpdateRow) => !r.kind || !r.entity_id || canView(r.kind, r.entity_id);

function toUpdate(r: UpdateRow): SyncUpdate {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name ?? '',
    kind: r.kind,
    path: r.path,
    commit: r.commit_sha,
    commitVerified: r.commit_verified === null ? null : !!r.commit_verified,
    webUrl: r.provider && r.repo_url ? fileWebUrl(r.provider, r.repo_url, r.commit_sha, r.path) : '',
    entityId: r.entity_id,
    entityName: r.entity_name,
    action: r.action,
    conflict: !!r.conflict,
    conflictReason: r.conflict_reason,
    status: r.status,
    errors: parseJson(r.errors, []),
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    comment: r.comment,
    resultVersion: r.result_version,
    canDecide: r.status === 'pending' && !!r.kind && canDecide(r.kind, r.entity_id),
    // rejected invalid files never had content; a rejected valid file lost it to the retention
    contentRemoved: r.status === 'rejected' && r.content === null && !parseJson<string[]>(r.errors, []).length,
  };
}

export function listUpdates(q: { status?: SyncUpdateStatus[]; sourceId?: string; limit?: number }): SyncUpdate[] {
  requireReviewer();
  const statuses = (q.status?.length ? q.status : (['pending', 'invalid'] as SyncUpdateStatus[])).filter((s) =>
    (SYNC_UPDATE_STATUSES as readonly string[]).includes(s),
  );
  const where = [`u.status IN (${statuses.map(() => '?').join(', ')})`];
  const params: unknown[] = [...statuses];
  if (q.sourceId) {
    where.push('u.source_id = ?');
    params.push(q.sourceId);
  }
  return db()
    .all<UpdateRow>(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
      ...params,
      Math.min(Math.max(q.limit ?? 200, 1), 500),
    )
    .filter(visible)
    .map(toUpdate);
}

function updateRow(id: string, checkVisible = true): UpdateRow {
  const r = /^gsu_[A-Za-z0-9_-]{8,40}$/.test(id) ? db().get<UpdateRow>(`${SELECT} WHERE u.id = ?`, id) : undefined;
  if (!r || (checkVisible && !visible(r))) throw new HttpError(404, 'Update not found', 'SYNC_UPDATE_NOT_FOUND');
  return r;
}

export function getUpdate(id: string): SyncUpdateDetail {
  requireReviewer();
  const r = updateRow(id);
  const u = toUpdate(r);
  const content = r.content ? JSON.parse(r.content) : null;
  const local = r.kind && r.entity_id ? localText(r.kind, r.entity_id) : null;
  return {
    ...u,
    incomingText: r.kind && content !== null ? incomingText(r.kind, content) : '',
    currentText: local?.text ?? null,
    ...(r.kind === 'process' ? { incomingDefinition: content ?? undefined, currentDefinition: local?.definition } : {}),
  };
}

const entityTypeOf = (k: SyncKind) => (k === 'recordType' ? 'record_type' : k);

/** Accept: create or update the item through its normal service (a new process version), and remember its origin. */
export async function acceptUpdate(id: string, opts: { comment?: string; force?: boolean; auto?: boolean } = {}): Promise<SyncUpdate> {
  requireReviewer();
  const r = updateRow(id);
  if (r.status !== 'pending' || !r.kind || r.content === null)
    throw new HttpError(409, `This update is ${r.status} – only pending updates can be accepted`, 'SYNC_UPDATE_DECIDED');
  const kind = r.kind;
  if (!canDecide(kind, r.entity_id))
    throw new HttpError(403, `You are not allowed to ${r.action === 'create' ? 'create' : 'change'} this ${kind}`, 'FORBIDDEN', { context: 'decideGitUpdate' });
  const src = requireSource(r.source_id);
  // check again: the local item may have changed (or appeared) since the fetch
  const target = r.entity_id ? localById(kind, r.entity_id) : null;
  if (r.entity_id && !target) throw new HttpError(409, 'The local item no longer exists – fetch again to stage it as a new item', 'SYNC_ITEM_GONE');
  const item = target
    ? db().get<Parameters<typeof conflictOf>[2] & object>(
        'SELECT * FROM sync_items WHERE kind = ? AND entity_id = ? AND source_id = ?',
        kind,
        target.id,
        src.id,
      )
    : undefined;
  const conflict = target ? conflictOf(kind, target.id, item) : null;
  if (conflict && !opts.force)
    throw new HttpError(409, `${CONFLICT_TEXT[conflict]}. Review the difference and accept anyway to overwrite it.`, 'SYNC_CONFLICT', { context: conflict });
  const content = JSON.parse(r.content) as unknown;
  const sha = r.commit_sha.slice(0, 10);
  const note = `From Git: ${src.name} ${r.path} @ ${sha}${opts.comment?.trim() ? ` – ${opts.comment.trim()}` : ''}`.slice(0, 2000);
  const res = await applyItem(kind, content, target?.id ?? null, {
    identity:
      r.identity ??
      r.path
        .split('/')
        .pop()!
        .replace(/\.(ya?ml|json)$/i, ''),
    comment: note,
    disabled: opts.auto,
  });
  db().tx(() => {
    link(src, { path: r.path, sha: r.blob_sha }, { sha: r.commit_sha }, { kind, hash: r.content_hash }, res.entityId, currentActor());
    db().run(
      "UPDATE sync_updates SET status = 'accepted', decided_by = ?, decided_at = ?, comment = ?, result_version = ?, entity_id = ? WHERE id = ?",
      currentActor(),
      nowIso(),
      opts.comment?.trim() || null,
      res.version,
      res.entityId,
      r.id,
    );
    audit({
      action: 'sync.update_accepted',
      entityType: entityTypeOf(kind),
      entityId: res.entityId,
      summary:
        `Update from Git accepted${opts.auto ? ' automatically (new item)' : ''}: ${r.path} @ ${sha} (${src.name}) → ${kind} ${res.entityId}` +
        `${res.version ? ` v${res.version}` : ''}${conflict ? ' – local changes overwritten' : ''}`,
      details: {
        updateId: r.id,
        sourceId: src.id,
        path: r.path,
        commit: r.commit_sha,
        action: r.action,
        version: res.version,
        overwroteLocalChanges: !!conflict,
        comment: opts.comment ?? null,
      },
    });
  });
  return toUpdate(updateRow(r.id, false));
}

export function rejectUpdate(id: string, comment?: string): SyncUpdate {
  requireReviewer();
  const r = updateRow(id);
  if (r.status !== 'pending' && r.status !== 'invalid') throw new HttpError(409, `This update is ${r.status}`, 'SYNC_UPDATE_DECIDED');
  if (r.status === 'pending' && r.kind && !canDecide(r.kind, r.entity_id))
    throw new HttpError(403, 'You are not allowed to decide this update', 'FORBIDDEN', { context: 'decideGitUpdate' });
  db().tx(() => {
    db().run(
      "UPDATE sync_updates SET status = 'rejected', decided_by = ?, decided_at = ?, comment = ? WHERE id = ?",
      currentActor(),
      nowIso(),
      comment?.trim() || null,
      r.id,
    );
    audit({
      action: 'sync.update_rejected',
      entityType: 'sync_update',
      entityId: r.id,
      summary: `Update from Git rejected: ${r.path} @ ${r.commit_sha.slice(0, 10)} (${r.source_name})${comment?.trim() ? ` – ${comment.trim().slice(0, 200)}` : ''}`,
      details: { sourceId: r.source_id, path: r.path, commit: r.commit_sha, kind: r.kind, entityId: r.entity_id, comment: comment ?? null },
    });
  });
  return toUpdate(updateRow(r.id, false));
}

/** Where synced items came from – only items the current user can see. */
export function listOrigins(kind?: SyncKind): SyncOrigin[] {
  const rows = db().all<{
    kind: SyncKind;
    entity_id: string;
    source_id: string;
    path: string;
    commit_sha: string;
    applied_at: string;
    applied_by: string;
    name: string;
    provider: SourceRow['provider'];
    repo_url: string;
  }>(
    `SELECT i.*, s.name, s.provider, s.repo_url FROM sync_items i JOIN sync_sources s ON s.id = i.source_id${kind ? ' WHERE i.kind = ?' : ''} ORDER BY i.kind, i.entity_id`,
    ...(kind ? [kind] : []),
  );
  return rows
    .filter((r) => {
      if (r.kind === 'process') return processes.permissionsFor(r.entity_id).includes('view');
      if (r.kind === 'monitor') {
        const m = monitorRow(r.entity_id);
        return !!m && permissionsOfRow(m).includes('view');
      }
      return true;
    })
    .map((r) => ({
      kind: r.kind,
      entityId: r.entity_id,
      sourceId: r.source_id,
      sourceName: r.name,
      repoUrl: r.repo_url,
      path: r.path,
      commit: r.commit_sha,
      webUrl: fileWebUrl(r.provider, r.repo_url, r.commit_sha, r.path),
      appliedAt: r.applied_at,
      appliedBy: r.applied_by,
    }));
}
