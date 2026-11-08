import { checkPlatformKinds, outputTypeKinds, platformKind } from '@sm/shared';
import { HttpError } from '../util.js';
import { ownerProblem, platformKindRow } from './platforms.js';

/**
 * The kind rule of monitor checks and outputs (0.11.0): a check or output type tied to platform kinds (the kind
 * descriptors, shared/src/platformKinds.ts – a kind's checkTypes and outputTypes) needs a platform of one of them. Saving
 * refuses another kind (checks.ts validateCheckPlatform, service.ts for outputs); a stored one – from before 0.11.0, or a
 * platform whose kind changed – does not run and sends nothing (storedKindProblem), and the engine names it at start.
 */

export type KindItem = { type: string; source?: unknown; platform?: string };

/** The kinds a check or output may use, one of them; empty: any platform, or none. */
export const itemKinds = (item: { type: string; source?: unknown }, isOutput: boolean): string[] =>
  isOutput ? outputTypeKinds(item.type) : checkPlatformKinds(item);

/** The name of a platform kind for a message (own connector types: their id). */
export const kindName = (k: string): string => platformKind(k)?.label ?? k;

/** "GitHub, GitLab or Forgejo / Gitea" */
export function kindNames(kinds: readonly string[]): string {
  const n = kinds.map(kindName);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} or ${n.at(-1)}` : (n[0] ?? '');
}

/** The kinds the item may use when the platform is of another kind; null: the platform fits (or any platform does). */
export function wrongKind(item: { type: string; source?: unknown }, isOutput: boolean, platform: { kind: string }): string[] | null {
  const kinds = itemKinds(item, isOutput);
  return kinds.length && !kinds.includes(platform.kind) ? kinds : null;
}

/** An output type tied to platform kinds needs a platform of one of them when a monitor is saved (OUTPUT_PLATFORM_KIND). */
export function validateOutputPlatform(o: { id: string; type: string }, platform: { name: string; kind: string }): void {
  const kinds = wrongKind(o, true, platform);
  if (kinds)
    throw new HttpError(
      400,
      `Output "${o.id}": "${platform.name}" is a platform of kind ${kindName(platform.kind)}, but a ${o.type} output writes to ${kindNames(kinds)}`,
      'OUTPUT_PLATFORM_KIND',
      { output: o.id, type: o.type, name: platform.name, kind: platform.kind, kinds, kindNames: kinds.map(kindName) },
    );
}

/** The stored platform of a check or output when it is of a kind the item does not use (no secrets are read). */
export function storedKindMismatch(item: KindItem, isOutput: boolean): { platform: string; name: string; kind: string; kinds: string[] } | null {
  const id = item.platform;
  if (!id || !itemKinds(item, isOutput).length) return null;
  const p = platformKindRow(id);
  const kinds = p && wrongKind(item, isOutput, p);
  return p && kinds ? { platform: id, name: p.name, kind: p.kind, kinds } : null;
}

/**
 * Why a stored check or output does not run: its platform is of another kind – else null. A platform the owner may not
 * use is not described: the owner's problem is the reason then, as when the check or output itself finds it.
 */
export function storedKindProblem(item: KindItem, isOutput: boolean, owner: string): string | null {
  const id = item.platform;
  if (!id || !itemKinds(item, isOutput).length) return null;
  const problem = ownerProblem(owner, id);
  if (problem) return problem;
  const m = storedKindMismatch(item, isOutput);
  if (!m) return null;
  return `"${m.name}" is a platform of kind ${kindName(m.kind)}, but this ${isOutput ? 'output writes to' : 'check reads'} ${kindNames(m.kinds)} – choose a platform of that kind`;
}
