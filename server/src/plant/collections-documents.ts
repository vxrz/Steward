import {
  PLANT_SOURCE_GENERATED_HEADING as HEADING,
  PLANT_SOURCE_RECORD_TYPE,
  PLANT_SOURCE_TYPE_ID,
  PLANT_SOURCE_TYPE_KEYS,
  type CollectionFormat,
  type PlantCollectionValues,
  type PlantSourceDocumentResult,
} from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { HttpError, parseJson } from '../util.js';
import { canCreateRecords } from '../records/access.js';
import { ensureBuiltinType } from '../records/types.js';
import { createRecord, readRecordRow, revise, updateRecord, LIMITS } from '../records/service.js';
import { addAttachment, removeAttachment } from '../records/attachments.js';
import { attachmentRows } from '../records/model.js';
import { itemRef } from './network.js';
import type { SourceRow } from './collections-sources.js';

/**
 * The gateway configuration document of a data collection (0.12, docs/PLANT.md "Gateway configurations"): one living
 * document (type GWC) per collection, linked to the asset and the collection, that each import keeps up to date – a
 * summary in its generated part and the kept file (secrets removed) as attachment. People write their own text below
 * the generated part; an import never changes it.
 *
 * It is written with the importer's rights on records, through the records module like any edit: who may not create
 * or change records gets the import without the document (the result says so). By status:
 * draft or revising – updated; published – a new edition is started and updated (the published one stays valid until
 * the next is approved); in review – left as it is; withdrawn or gone – a new document.
 */

export interface DocumentInput {
  assetId: string;
  assetName: string;
  collection: PlantCollectionValues;
  /** Collections the file had (datasets, connections …) */
  fileCollections: number;
  format: CollectionFormat;
  sources: SourceRow[];
  /** A new version was kept (else the files are the same as the last import's) */
  newVersion: boolean;
  documentId: string | null;
}

const FORMAT_NAMES: Record<CollectionFormat, string> = {
  gateway_json: 'Gateway JSON (datasets of data points)',
  table: 'Table (CSV or YAML)',
  ie_opcua: 'Industrial Edge OPC UA connector (preview)',
  node_red: 'Node-RED flow',
};

/** A Markdown table cell: backslashes first, then the pipes that would end the cell; one line. */
export const markdownCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const extOf = (r: SourceRow) =>
  /\.(csv|txt)$/i.test(r.file_name) ? (/\.txt$/i.test(r.file_name) ? 'txt' : 'csv') : /^\s*[[{]/.test(r.content) ? 'json' : 'yaml';
/** The attachment name of a kept file: the original's stem, the version, "redacted". */
export const attachmentName = (r: SourceRow) => `${r.file_name.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.v${r.version}.redacted.${extOf(r)}`;

function collectorLabel(c: PlantCollectionValues): string {
  const k = c.collector;
  if (k.kind === 'job') return k.ref;
  return itemRef(k.kind, k.ref).label || k.ref;
}

/** The generated part: what the import read, in English (it is content, like an audit summary). */
export function generatedPart(x: DocumentInput): string {
  const c = x.collection;
  const mapped = c.items.filter((i) => i.dataPoint).length;
  const v = x.sources[0];
  const removed = x.sources.reduce((n, s) => n + parseJson<string[]>(s.redacted_paths, []).length, 0);
  const rows: [string, string][] = [
    ['Asset', `${x.assetName} (\`${x.assetId}\`)`],
    ['Collector', `${c.collector.kind} ${collectorLabel(c)}`],
    ['Collection', `${c.name} (\`${c.id}\`)`],
    ['Format', FORMAT_NAMES[x.format] ?? x.format],
    ['Items', `${c.items.length} (${mapped} mapped to data points, ${c.items.length - mapped} raw)`],
    ['Collections in the files', String(x.fileCollections)],
    ['Sinks', c.sinks.length ? c.sinks.map((s) => [s.name, s.object].filter(Boolean).join(': ')).join('; ') : '–'],
    ['Version', v ? `${v.version}, imported ${v.imported_at.slice(0, 16).replace('T', ' ')} UTC by ${v.imported_by}` : '–'],
    [
      'Files',
      x.sources
        .map((s) => `${s.file_name} (SHA-256 of the original ${s.sha256.slice(0, 12)}…, ${parseJson<string[]>(s.redacted_paths, []).length} values removed)`)
        .join('; '),
    ],
  ];
  return [
    HEADING,
    '',
    '_Steward rewrites this section with every import of the collector’s configuration. Write your own text under the next heading._',
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, val]) => `| ${k} | ${markdownCell(val)} |`),
    '',
    removed
      ? `Steward removed ${removed} secret values (passwords, tokens, keys, credentials) before keeping the file: the attachment is that copy.`
      : 'The attached file is the configuration as imported (no secret values were found).',
    '',
  ].join('\n');
}

/** The body with the generated part replaced (or put first), the rest as people wrote it. */
export function withGenerated(body: string, part: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === HEADING);
  if (start < 0) return `${part}\n${body.trimStart() || '## Notes\n\n'}`;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...part.split('\n'), ...lines.slice(end)].join('\n');
}

const title = (x: DocumentInput) => `Gateway configuration – ${x.assetName} – ${collectorLabel(x.collection)} – ${x.collection.name}`.slice(0, LIMITS.title);

/** The type, created on first use (a built-in like the firewall types). */
const ensureType = () => ensureBuiltinType(PLANT_SOURCE_TYPE_ID, PLANT_SOURCE_RECORD_TYPE, PLANT_SOURCE_TYPE_KEYS);

/** Replaces the files of earlier imports on the document with this version's (only files Steward attached: by their hash). */
function replaceFiles(recordId: string, x: DocumentInput): void {
  const kept = new Set(
    db()
      .all<{ redacted_sha256: string }>('SELECT redacted_sha256 FROM plant_collection_sources WHERE asset_id = ?', x.assetId)
      .map((r) => r.redacted_sha256),
  );
  const now = new Set(x.sources.map((s) => s.redacted_sha256));
  const files = attachmentRows(recordId, 'file');
  for (const a of files) if ((kept.has(a.sha256) || a.filename.includes('.redacted.')) && !now.has(a.sha256)) removeAttachment(recordId, a.id);
  const have = new Set(attachmentRows(recordId, 'file').map((a) => a.sha256));
  for (const s of x.sources) if (!have.has(s.redacted_sha256)) addAttachment(recordId, attachmentName(s), Buffer.from(s.content, 'utf8'));
}

/**
 * Creates or updates the collection's document; never throws for rights or status (the result says what happened).
 * Returns the record id to remember on the collection.
 */
export function writeSourceDocument(x: DocumentInput): PlantSourceDocumentResult {
  const skip = (reason: PlantSourceDocumentResult['reason'], r?: { id: string; number: string }): PlantSourceDocumentResult => ({
    collection: x.collection.id,
    action: 'skipped',
    recordId: r?.id ?? null,
    number: r?.number ?? null,
    reason,
  });
  try {
    let r = x.documentId
      ? db().get<{ id: string; number: string; status: string; body: string; type_id: string }>(
          'SELECT id, number, status, body, type_id FROM records WHERE id = ?',
          x.documentId,
        )
      : undefined;
    if (r && r.status === 'withdrawn') r = undefined;
    const part = generatedPart(x);
    if (!r) {
      if (!canCreateRecords()) return skip('forbidden');
      ensureType();
      const rec = createRecord({
        type: PLANT_SOURCE_TYPE_ID,
        title: title(x),
        body: `${part}\n## Notes\n\n`,
        links: [
          { kind: 'asset', id: x.assetId, note: 'gateway configuration' },
          { kind: 'data-collection', id: `${x.assetId}/${x.collection.id}`, note: 'gateway configuration' },
        ],
      });
      replaceFiles(rec.id, x);
      return { collection: x.collection.id, action: 'created', recordId: rec.id, number: rec.number };
    }
    // the same files as last time and a document that has them: nothing to do
    if (!x.newVersion && r.body.includes(HEADING)) return { collection: x.collection.id, action: 'updated', recordId: r.id, number: r.number };
    if (r.status === 'in_review') return skip('in_review', r);
    let action: PlantSourceDocumentResult['action'] = 'updated';
    if (r.status === 'published') {
      revise(r.id, `New version ${x.sources[0]?.version ?? ''} of the gateway configuration imported`.trim());
      action = 'revised';
    } else if (r.status !== 'draft' && r.status !== 'revising') return skip('in_review', r);
    const cur = readRecordRow(r.id);
    updateRecord(r.id, { body: withGenerated(cur.body, part), comment: 'Gateway configuration imported again' });
    replaceFiles(r.id, x);
    return { collection: x.collection.id, action, recordId: r.id, number: r.number };
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 403) return skip('forbidden');
    logger.warn({ err: e, asset: x.assetId, collection: x.collection.id }, 'gateway configuration document not written');
    return skip('failed');
  }
}
