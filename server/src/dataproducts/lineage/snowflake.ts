import { DATA_LINEAGE_LIMITS as LL } from '@sm/shared';
import { db } from '../../db.js';
import { nowIso } from '../../util.js';
import { chunks } from '../store.js';
import { elementsByNames, writeProposal } from './store.js';

/**
 * Snowflake `ACCOUNT_USAGE.OBJECT_DEPENDENCIES` (ADR 0036 part 9, phase 2): a discovery source in _account usage_ mode
 * reads, after a complete run, which objects of its scope reference which (a view its tables, a dynamic table its
 * sources) – metadata, as the catalogue views – and proposes a step per referencing object: the referenced objects →
 * the referencing one. Only table-like objects on both sides (functions, procedures and stages are no data). The
 * proposals wait under the discovery source in the inbox, as those of the lineage sources.
 */

export interface SnowflakeDependency {
  referenced: string;
  referencing: string;
  referencingDomain: string;
}

/** The object kinds (OBJECT_DOMAIN) that hold data: both ends of a proposed step are one of these. */
export const DATA_DOMAINS = new Set(['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'DYNAMIC TABLE', 'EXTERNAL TABLE', 'STREAM', 'EVENT TABLE']);

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Proposals from the dependencies a discovery run read: one per referencing object with an element in the catalogue
 * (the referenced objects matched by qualified name on the same platform; unknown ones named, as a tool's datasets).
 */
export async function proposeDependencies(
  sourceId: string,
  platformId: string,
  deps: readonly SnowflakeDependency[],
): Promise<{ created: number; changed: number; skipped: number }> {
  const out = { created: 0, changed: 0, skipped: 0 };
  if (!deps.length) return out;
  const byReferencing = new Map<string, { inputs: Set<string>; domain: string }>();
  for (const d of deps) {
    const cur = byReferencing.get(d.referencing) ?? { inputs: new Set<string>(), domain: d.referencingDomain };
    if (d.referenced !== d.referencing) cur.inputs.add(d.referenced);
    byReferencing.set(d.referencing, cur);
  }
  const names = [...new Set(deps.flatMap((d) => [d.referenced, d.referencing]))];
  const found = elementsByNames(platformId, names);
  const el = (qn: string) => found.get(qn.toLowerCase())?.[0] ?? null;
  const now = nowIso();
  for (const part of chunks([...byReferencing], LL.batch)) {
    db().tx(() => {
      for (const [referencing, { inputs, domain }] of part) {
        const own = el(referencing);
        if (!own) continue;
        const ins = [...inputs];
        const w = writeProposal(
          {
            origin: 'snowflake',
            sourceId,
            key: referencing,
            name: referencing,
            kind: 'transform',
            tool: domain === 'DYNAMIC TABLE' ? 'Snowflake dynamic table' : domain === 'STREAM' ? 'Snowflake stream' : 'Snowflake view',
            inputs: ins.map(el).filter((x): x is string => !!x),
            outputs: [own],
            unmatchedInputs: ins.filter((i) => !el(i)),
            unmatchedOutputs: [],
            run: null,
          },
          now,
        );
        if (!w) out.skipped++;
        else if (w.created) out.created++;
        else if (w.changed) out.changed++;
      }
    });
    await yieldToLoop();
  }
  return out;
}
