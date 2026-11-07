import { LIBRARY_LIMITS, SYNC_VERSION_PLACEHOLDER, compareSemver, isPrerelease, LIBRARY_SEMVER_RE, type SyncFetchResult } from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { gitBlobSha, objectFormatOf, type CommitCheck, type GitApi } from '../sync/providers.js';
import type { SourceRow } from '../sync/service.js';
import { isHiddenPath } from './manifest.js';
import { auditRefused, installedVersion, refusal, stageRelease, verifyRelease, type FileSet, type VerifiedRelease } from './releases.js';

/**
 * A Git sync source in library mode (ADR 0014): it follows the library's version tags. The pattern is the source's
 * tag name with `{version}` standing for the release (`v{version}` → v1.4.0). A fetch lists the tags, takes the
 * newest release (pre-releases only when the source allows them), reads the folder at that tag's commit with Git
 * sync's checks (path confinement, Git object ids, size caps) and verifies the release; the tag must name the version
 * in release.json. A verified release is staged for review – nothing is installed by a fetch.
 */

const FILE_MODES = new Set(['100644', '100755']);

/** "v{version}" → the version a tag name stands for, or null. */
export function versionOfTag(pattern: string, tag: string): string | null {
  const at = pattern.indexOf(SYNC_VERSION_PLACEHOLDER);
  if (at < 0 || pattern.indexOf(SYNC_VERSION_PLACEHOLDER, at + 1) >= 0) return null;
  const prefix = pattern.slice(0, at);
  const suffix = pattern.slice(at + SYNC_VERSION_PLACEHOLDER.length);
  if (!tag.startsWith(prefix) || !tag.endsWith(suffix) || tag.length <= prefix.length + suffix.length) return null;
  const v = tag.slice(prefix.length, tag.length - suffix.length);
  return LIBRARY_SEMVER_RE.test(v) ? v : null;
}

/** The newest version tag (pre-releases only when allowed), and the newest version seen at all. */
export function newestTag(tags: { name: string; sha: string }[], pattern: string, allowPre: boolean): { tag: string; version: string; sha: string } | null {
  let best: { tag: string; version: string; sha: string } | null = null;
  for (const t of tags) {
    const v = versionOfTag(pattern, t.name);
    if (!v || (isPrerelease(v) && !allowPre)) continue;
    if (!best || (compareSemver(v, best.version) ?? 0) > 0) best = { tag: t.name, version: v, sha: t.sha };
  }
  return best;
}

function checkSigned(r: SourceRow, head: CommitCheck, tag: string) {
  if (!r.require_signed) return;
  if (head.verified !== true)
    throw new HttpError(
      409,
      `The commit ${head.sha.slice(0, 10)} of tag ${tag} is not signed with a key the Git host verified – this source requires signed commits`,
      'GIT_COMMIT_UNSIGNED',
      {
        commit: head.sha.slice(0, 10),
        branch: `tag ${tag}`,
      },
    );
  const allowed = parseJson<string[]>(r.allowed_signers, []);
  if (allowed.length && !head.signers.some((s) => allowed.includes(s)))
    throw new HttpError(
      409,
      `Tag ${tag} is signed by ${head.signers.join(', ') || 'unknown'}, who is not on the source's list of allowed signers`,
      'GIT_SIGNER_NOT_ALLOWED',
      {
        commit: head.sha.slice(0, 10),
        branch: `tag ${tag}`,
        signer: head.signers.join(', ') || 'unknown',
      },
    );
}

/** The library folder at a commit, every file checked against its Git object id. */
async function readTree(api: GitApi, sha: string, folder: string): Promise<FileSet> {
  const prefix = folder ? `${folder}/` : '';
  const entries = (await api.tree(sha, folder)).filter((e) => e.type === 'blob' && (!prefix || e.path.startsWith(prefix)));
  const out: FileSet = new Map();
  let total = 0;
  for (const e of entries) {
    const rel = e.path.slice(prefix.length);
    if (!rel || isHiddenPath(rel)) continue;
    if (e.mode && !FILE_MODES.has(e.mode)) throw refusal('LIBRARY_INVALID', `${rel} is a symbolic link or submodule – a library holds plain files only`);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.sha)) throw new HttpError(502, `Tree entry ${rel.slice(0, 200)}: invalid object id`, 'GIT_BAD_RESPONSE');
    if (out.size >= LIBRARY_LIMITS.maxFiles) throw refusal('LIBRARY_INVALID', `The library folder has more than ${LIBRARY_LIMITS.maxFiles} files`);
    if (e.size !== undefined && e.size > LIBRARY_LIMITS.maxReleaseJsonBytes)
      throw refusal('LIBRARY_INVALID', `${rel} is ${e.size} bytes – too large for a library`);
    const content = await api.blob(e.sha, LIBRARY_LIMITS.maxReleaseJsonBytes);
    total += content.length;
    if (total > LIBRARY_LIMITS.maxTotalBytes + LIBRARY_LIMITS.maxReleaseJsonBytes)
      throw refusal('LIBRARY_INVALID', `The files are larger than ${LIBRARY_LIMITS.maxTotalBytes} bytes together`);
    if (gitBlobSha(content, objectFormatOf(e.sha)) !== e.sha)
      throw new HttpError(502, `File ${rel.slice(0, 200)}: the content does not match its Git object id`, 'GIT_BAD_RESPONSE');
    out.set(rel, content);
  }
  return out;
}

/** One fetch of a library source; the caller (sync/fetch.ts) records the outcome on the source and in the audit log. */
export async function fetchLibrary(r: SourceRow, api: GitApi, result: SyncFetchResult, actor: string): Promise<void> {
  const tags = await api.tags(LIBRARY_LIMITS.maxTags);
  const newest = newestTag(tags, r.branch, !!r.allow_prereleases);
  if (!newest)
    throw new HttpError(404, `No tag matches ${r.branch} – tag releases as ${r.branch.replace(SYNC_VERSION_PLACEHOLDER, '1.0.0')}`, 'LIBRARY_NO_TAG', {
      pattern: r.branch,
    });
  db().run('UPDATE sync_sources SET newest_seen = ? WHERE id = ?', newest.version, r.id);
  result.ref = newest.tag;
  const head = await api.tag(newest.tag);
  result.commit = head.sha;
  result.verified = head.verified;
  checkSigned(r, head, newest.tag);
  // the newest release was staged from this commit before, or is installed: nothing to do
  const known = db().get<{ id: string; library: string; release_version: string; state: string }>(
    'SELECT id, library, release_version, state FROM library_releases WHERE source LIKE ? AND release_version = ? ORDER BY staged_at DESC LIMIT 1',
    `%"commit":"${head.sha}"%`,
    newest.version,
  );
  if (known) {
    result.upToDate = true;
    result.library = { library: known.library, release: known.release_version, releaseId: known.id, staged: false };
    return;
  }
  let v: VerifiedRelease | undefined;
  try {
    const files = await readTree(api, head.sha, r.folder);
    result.files = files.size;
    v = await verifyRelease(files);
    if (v.release.release !== newest.version)
      throw refusal('LIBRARY_TAG_MISMATCH', `Tag ${newest.tag} names release ${newest.version}, release.json ${v.release.release}`, {
        tag: newest.tag,
        release: v.release.release,
      });
    const installed = installedVersion(v.release.library);
    if (installed && (compareSemver(v.release.release, installed) ?? 0) <= 0) {
      result.upToDate = true;
      result.library = { library: v.release.library, release: v.release.release, releaseId: '', staged: false };
      return;
    }
    const { row, staged } = stageRelease(v, { type: 'git', sourceId: r.id, sourceName: r.name, repoUrl: r.repo_url, tag: newest.tag, commit: head.sha }, actor);
    if (staged) result.staged = 1;
    else result.upToDate = true;
    result.library = { library: row.library, release: row.release_version, releaseId: row.id, staged };
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 422)
      auditRefused(e, {
        via: `Git sync "${r.name}", tag ${newest.tag}`,
        library: v?.release.library,
        release: v?.release.release ?? newest.version,
        sourceId: r.id,
        actor,
      });
    throw e;
  }
}
