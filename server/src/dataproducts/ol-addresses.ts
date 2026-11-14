import { bootstrapList, openLineageDataset, type DataElementKind, type Platform } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { sqlOpenLineage } from './discovery/dbschema.js';
import { chunks, marks } from './store.js';

/**
 * The OpenLineage address of a platform as discovery gives it (the Snowflake account, the first bootstrap server, a
 * database's host and port), for elements that were entered, imported or converted rather than discovered (0.25.0: the
 * OpenLineage export and _Convert to …_).
 */
export function platformAddresses(platformIds: readonly string[]): Map<string, { address: string; prefix: string } | null> {
  const out = new Map<string, { address: string; prefix: string } | null>();
  for (const part of chunks([...new Set(platformIds.filter(Boolean))]))
    for (const p of db().all<{ id: string; kind: string; config: string }>(
      `SELECT id, kind, config FROM platforms WHERE id IN (${marks(part.length)})`,
      ...part,
    )) {
      const config = parseJson<Platform['config']>(p.config, {} as Platform['config']);
      const vars = (config.variables ?? {}) as Record<string, unknown>;
      if (p.kind === 'snowflake') {
        const account = String(vars.account ?? '').trim();
        out.set(p.id, account ? { address: account, prefix: '' } : null);
      } else if (p.kind === 'kafka') {
        const first = bootstrapList(vars.bootstrap as string | undefined)[0];
        out.set(p.id, first ? { address: `${first.host}:${first.port}`, prefix: '' } : null);
      } else if (p.kind === 'database') out.set(p.id, sqlOpenLineage({ config } as Platform));
      else out.set(p.id, null);
    }
  return out;
}

/** The OpenLineage dataset discovery would give an element of this kind and name on this platform (null: none known). */
export function platformDataset(kind: DataElementKind, platformId: string, qualifiedName: string): { namespace: string; name: string } | null {
  if (kind === 'files.path') return openLineageDataset(kind, null, qualifiedName);
  const a = platformId ? platformAddresses([platformId]).get(platformId) : null;
  return a ? openLineageDataset(kind, a.address, `${a.prefix}${qualifiedName}`) : null;
}
