import { DATA_LINEAGE_LIMITS as LL, elementNameNorm, parseObjectStorageUrl } from '@sm/shared';
import { db } from '../../db.js';
import { nowIso, parseJson } from '../../util.js';
import { chunks, marks } from '../store.js';
import { elementsByNames, writeProposal } from './store.js';

/**
 * Lineage from Snowflake stages and pipes (0.25.0, ADR 0037 part 2) – without reading data: an external stage reads the
 * object storage location of its URL (`s3://bucket/prefix/`), a pipe copies from its stage into its table. After a
 * complete run of a Snowflake discovery source (both modes) each external stage with a URL and each pipe whose COPY
 * statement names its stage and table becomes a **proposal** in the inbox (origin `snowflake`, as OBJECT_DEPENDENCIES):
 *
 *   Stage SHOP.RAW.LANDING   s3://invented-landing.example/orders/ (a files.path element) → the stage
 *   Pipe SHOP.RAW.ORDERS_PIPE   the stage → SHOP.RAW.ORDERS_RAW
 *
 * So `S3 prefix → stage → pipe → table` is lineage a person accepts. The stage's location is matched to a `files.path`
 * element by its URL – the element of that prefix, else of the nearest prefix above it (any AWS platform: the files are
 * the account's, the stage only reads them); one Steward does not know is named as the stage gave it.
 */

interface Row {
  id: string;
  kind: string;
  qualified_name: string;
  data: string | null;
}

/** The files.path element of a location: the prefix itself, else the nearest prefix above it (one statement). */
function filesElements(urls: readonly string[]): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const url of urls) {
    const u = parseObjectStorageUrl(url);
    if (!u) continue;
    const parts = u.prefix.split('/').filter(Boolean);
    const names: string[] = [];
    for (let n = parts.length; n >= 0; n--) {
      const p = parts.slice(0, n).join('/');
      names.push(`s3://${u.bucket}/${p}${p ? '/' : ''}`, ...(p ? [`s3://${u.bucket}/${p}`] : []));
    }
    candidates.set(url, names.map(elementNameNorm));
  }
  const all = [...new Set([...candidates.values()].flat())];
  const found = new Map<string, string>();
  for (const part of chunks(all))
    for (const r of db().all<{ id: string; name_norm: string }>(
      `SELECT id, name_norm FROM dp_elements WHERE kind = 'files.path' AND missing_since IS NULL AND name_norm IN (${marks(part.length)}) ORDER BY id`,
      ...part,
    ))
      if (!found.has(r.name_norm)) found.set(r.name_norm, r.id);
  const out = new Map<string, string>();
  for (const [url, names] of candidates) {
    const hit = names.find((n) => found.has(n));
    if (hit) out.set(url, found.get(hit)!);
  }
  return out;
}

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The proposals of a source's stages and pipes (after a complete run; its elements are all there). */
export async function proposeStageLinks(sourceId: string, platformId: string): Promise<{ created: number; changed: number; skipped: number }> {
  const out = { created: 0, changed: 0, skipped: 0 };
  const rows = db().all<Row>(
    `SELECT e.id, e.kind, e.qualified_name, r.data FROM dp_elements e LEFT JOIN dp_element_readouts r ON r.element_id = e.id
     WHERE e.discovery_source_id = ? AND e.kind IN ('snowflake.stage', 'snowflake.pipe') AND e.missing_since IS NULL`,
    sourceId,
  );
  if (!rows.length) return out;
  const readout = (r: Row) => parseJson<Record<string, unknown>>(r.data ?? '{}', {});
  const stages = rows.filter((r) => r.kind === 'snowflake.stage' && typeof readout(r).url === 'string');
  const pipes = rows.filter((r) => r.kind === 'snowflake.pipe' && typeof readout(r).stage === 'string' && typeof readout(r).target === 'string');
  const files = filesElements(stages.map((r) => String(readout(r).url)));
  const names = elementsByNames(platformId, [
    ...pipes.flatMap((p) => [String(readout(p).stage), String(readout(p).target)]),
    ...stages.map((s) => s.qualified_name),
  ]);
  const el = (qn: string) => names.get(qn.toLowerCase())?.[0] ?? null;
  const now = nowIso();
  const drafts = [
    ...stages.map((s) => {
      const url = String(readout(s).url);
      const f = files.get(url);
      return {
        key: `stage:${s.qualified_name}`,
        name: `Stage ${s.qualified_name}`,
        tool: 'Snowflake stage',
        inputs: f ? [f] : [],
        outputs: [s.id],
        unmatchedInputs: f ? [] : [url],
        unmatchedOutputs: [] as string[],
      };
    }),
    ...pipes.map((p) => {
      const stage = String(readout(p).stage);
      const target = String(readout(p).target);
      return {
        key: `pipe:${p.qualified_name}`,
        name: `Pipe ${p.qualified_name}`,
        tool: 'Snowpipe',
        inputs: el(stage) ? [el(stage)!] : [],
        outputs: el(target) ? [el(target)!] : [],
        unmatchedInputs: el(stage) ? [] : [stage],
        unmatchedOutputs: el(target) ? [] : [target],
      };
    }),
  ];
  for (const part of chunks(drafts, LL.batch)) {
    db().tx(() => {
      for (const d of part) {
        const w = writeProposal({ origin: 'snowflake', sourceId, kind: 'ingest', run: null, ...d }, now);
        if (!w) out.skipped++;
        else if (w.created) out.created++;
        else if (w.changed) out.changed++;
      }
    });
    await yieldToLoop();
  }
  return out;
}
