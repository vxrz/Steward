import path from 'node:path';
import YAML from 'yaml';
import type { RecordFieldDef, RecordImportItem } from '@sm/shared';
import { HttpError } from '../util.js';
import { canCreateRecords, forbid, me } from './access.js';
import { cleanFields, cleanTags, createRecord, getRecord, LIMITS, workflowOf } from './service.js';
import { requireType, toType, typeRow, type TypeRow } from './types.js';

/**
 * Markdown import and export of records.
 *
 * Import understands YAML frontmatter, MADR (frontmatter status/date/deciders/
 * consulted/informed or the "* Status:" bullets of MADR 2, headings such as
 * "Context and Problem Statement") and Nygard ADRs ("# 1. Title", "Date:",
 * "## Status"). It always creates drafts: a status from the file is kept in
 * the import metadata and as a tag, because an imported decision still needs
 * an approval in Steward before it counts.
 *
 * The YAML is parsed with the core schema only (no custom tags, aliases
 * limited) and sizes are limited before parsing.
 */

export const IMPORT_LIMITS = { files: 20, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, frontmatterBytes: 16 * 1024 };
const IMPORT_EXTENSIONS = ['.md', '.markdown', '.txt'];

/** Statuses from other tools that mean "still being written" (imported as draft without a note). */
const DRAFT_LIKE = new Set(['draft', 'wip', 'work in progress', 'in progress', 'new', 'open', 'todo', 'ideation', '']);

export interface ParsedMarkdown {
  format: NonNullable<RecordImportItem['format']>;
  title: string | null;
  typeKey: string | null;
  status: string | null;
  /** Raw values by the key they had in the file */
  values: Record<string, string>;
  tags: string[];
  body: string;
  meta: Record<string, unknown>;
  warnings: string[];
}

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v) && v.every((x) => ['string', 'number'].includes(typeof x))) return v.map(String).join(', ');
  return null;
}

/** YAML frontmatter as a plain object: core schema, no custom tags, few aliases. */
export function parseFrontmatter(src: string): Record<string, unknown> {
  if (Buffer.byteLength(src) > IMPORT_LIMITS.frontmatterBytes)
    throw new HttpError(400, `The frontmatter is too large (at most ${IMPORT_LIMITS.frontmatterBytes / 1024} KiB)`);
  const doc = YAML.parseDocument(src, { schema: 'core', uniqueKeys: true, merge: false, prettyErrors: false, strict: true, customTags: [] });
  if (doc.errors.length) throw new HttpError(400, `Invalid YAML frontmatter: ${doc.errors[0]!.message.split('\n')[0]}`);
  const tagWarning = doc.warnings.find((w) => w.code === 'TAG_RESOLVE_FAILED');
  if (tagWarning) throw new HttpError(400, 'Invalid YAML frontmatter: custom tags (!tag) are not allowed');
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 20 });
  } catch (e) {
    throw new HttpError(400, `Invalid YAML frontmatter: ${(e as Error).message.split('\n')[0]}`);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Invalid YAML frontmatter: expected key: value pairs');
  return data as Record<string, unknown>;
}

const STATUS_HEADING = /^#{2,3}\s+Status\s*$/i;

/**
 * Title of a "# Title #" line: what `/^#\s+(.+?)\s*#*\s*$/` captured, as a
 * loop (the lazy group next to optional spaces backtracks on long lines).
 */
export function h1Title(line: string): string | null {
  const ws = (c: string | undefined) => c !== undefined && /\s/.test(c);
  if (line[0] !== '#' || !ws(line[1])) return null;
  let k = 1;
  while (ws(line[k])) k++;
  // only spaces after "#": the group takes one of them (the caller trims it)
  if (k === line.length) return line.length > 2 && /[^\n\r\u2028\u2029]/.test(line.slice(2)) ? '' : null;
  let end = line.length;
  while (ws(line[end - 1])) end--;
  let h = end;
  while (h > k && line[h - 1] === '#') h--;
  if (h === k)
    end = k + 1; // only #s: the lazy group takes one
  else {
    end = h;
    while (ws(line[end - 1])) end--;
  }
  const title = line.slice(k, end);
  return /[\n\r\u2028\u2029]/.test(title) ? null : title; // `.` does not match line terminators
}

/** Text without HTML comments (`<!-- … -->`), as a loop. */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf('<!--', i);
    const b = a < 0 ? -1 : s.indexOf('-->', a + 4);
    if (b < 0) return out + s.slice(i);
    out += s.slice(i, a);
    i = b + 3;
  }
}

/** Reads a Markdown file into title, status, values and body (no database access). */
export function parseRecordMarkdown(text: string): ParsedMarkdown {
  const warnings: string[] = [];
  const meta: Record<string, unknown> = {};
  let src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let fm: Record<string, unknown> = {};
  let hasFm = false;
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (m) {
    fm = parseFrontmatter(m[1]!);
    hasFm = true;
    src = src.slice(m[0].length);
  } else if (/^---[ \t]*\n/.test(src) && !/\n(?:---|\.\.\.)[ \t]*(\n|$)/.test(src.slice(4))) {
    throw new HttpError(400, 'The frontmatter is not closed (a line with --- is missing)');
  }
  const values: Record<string, string> = {};
  let title = scalar(fm.title);
  let status = scalar(fm.status);
  let typeKey = scalar(fm.type) ?? scalar(fm.recordType);
  let tags: string[] = [];
  let format: ParsedMarkdown['format'] = hasFm ? 'frontmatter' : 'markdown';
  const steward = fm.steward && typeof fm.steward === 'object' && !Array.isArray(fm.steward) ? (fm.steward as Record<string, unknown>) : null;
  if (steward) {
    format = 'steward';
    typeKey ??= scalar(steward.type);
    for (const k of ['id', 'number', 'revision', 'version', 'contentHash']) if (steward[k] !== undefined) meta[`steward.${k}`] = scalar(steward[k]);
  }
  for (const [k, v] of Object.entries(fm)) {
    if (['title', 'status', 'type', 'recordType', 'steward'].includes(k)) continue;
    if (k === 'tags' || k === 'keywords') {
      const list = Array.isArray(v)
        ? v.map((x) => scalar(x)).filter((x): x is string => !!x)
        : (scalar(v) ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      tags.push(...list);
      continue;
    }
    if (k === 'number' || k === 'id') {
      meta.originalNumber = scalar(v);
      continue;
    }
    if (k === 'fields' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
        const s = scalar(fv);
        if (s !== null) values[fk] = s;
      }
      continue;
    }
    const s = scalar(v);
    if (s === null) warnings.push(`Frontmatter key "${k}" ignored (not a text value)`);
    else values[k] = s;
  }

  let lines = src.split('\n');
  const dropLeadingBlank = () => {
    while (lines.length && !lines[0]!.trim()) lines.shift();
  };
  dropLeadingBlank();
  // title heading
  const h1 = h1Title(lines[0] ?? '');
  if (h1 !== null) {
    let heading = h1.trim();
    const numbered = /^(\d+)\.\s+(.+)$/.exec(heading);
    const prefixed = /^((?:[A-Z]{2,10})[- ]?\d+)\s*[:.–-]\s+(.+)$/.exec(heading);
    if (numbered) {
      meta.adrNumber = Number(numbered[1]);
      heading = numbered[2]!;
    } else if (prefixed) {
      meta.originalNumber ??= prefixed[1];
      heading = prefixed[2]!;
    }
    if (!title) {
      title = heading;
      lines.shift();
    } else if (title === heading || title === h1.trim()) lines.shift();
    dropLeadingBlank();
  }
  // Nygard "Date: 2024-01-15" and MADR 2 "* Status: accepted" lines before the first section
  const firstSection = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  const head = firstSection < 0 ? lines.length : firstSection;
  const keep: string[] = [];
  let sawNygardDate = false;
  let sawMadrBullets = false;
  lines.slice(0, head).forEach((l) => {
    const date = /^Date:\s*(.+)$/i.exec(l.trim());
    const bullet = /^[*-]\s+(Status|Deciders|Date|Consulted|Informed|Technical Story):\s*(.*)$/i.exec(l.trim());
    if (date && !values.date) {
      values.date = date[1]!.trim();
      sawNygardDate = true;
    } else if (bullet) {
      sawMadrBullets = true;
      const key = bullet[1]!.toLowerCase().replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());
      const v = stripComments(bullet[2]!).trim();
      if (key === 'status') status ??= v;
      else if (v) values[key] ??= v;
    } else keep.push(l);
  });
  lines = [...keep, ...lines.slice(head)];
  // Nygard "## Status" section
  const statusAt = lines.findIndex((l) => STATUS_HEADING.test(l));
  if (statusAt >= 0) {
    let end = statusAt + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!)) end++;
    const content = lines
      .slice(statusAt + 1, end)
      .map((l) => l.trim())
      .filter(Boolean);
    if (content.length) status ??= content[0]!;
    if (content.length > 1) meta.statusNote = content.slice(1).join('\n');
    lines.splice(statusAt, end - statusAt);
    format = format === 'markdown' ? 'nygard' : format;
  } else if (sawNygardDate && format === 'markdown') format = 'nygard';
  const bodyText = lines.join('\n');
  if (
    format !== 'steward' &&
    (sawMadrBullets || /^#{2,3}\s+(Context and Problem Statement|Decision Outcome|Considered Options|Decision Drivers)\s*$/im.test(bodyText))
  )
    format = 'madr';
  if (/^#{2,3}\s+(Context|Decision|Consequences)\s*$/im.test(bodyText) && format === 'markdown') format = 'nygard';
  const body = bodyText.replace(/^\s*\n/, '').trimEnd();
  tags = [...new Set(tags.map((t) => t.toLowerCase().slice(0, LIMITS.tag)))];
  return { format, title, typeKey, status, values, tags, body: body ? body + '\n' : '', meta, warnings };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES: Record<string, string> = { date: 'decisionDate', decisionmakers: 'deciders', technicalstory: 'reason' };

/** Maps raw values onto the type's fields; what does not fit is returned separately. */
export function mapFields(
  defs: RecordFieldDef[],
  values: Record<string, string>,
): { fields: Record<string, string>; rest: Record<string, string>; warnings: string[] } {
  const fields: Record<string, string> = {};
  const rest: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [k, raw] of Object.entries(values)) {
    const n = norm(k);
    const def = defs.find((d) => norm(d.key) === n || norm(d.label) === n) ?? defs.find((d) => d.key === ALIASES[n]);
    if (!def) {
      rest[k] = raw;
      continue;
    }
    let v = raw.trim();
    if (def.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = Date.parse(v);
      if (!Number.isNaN(d)) v = new Date(d).toISOString().slice(0, 10);
    }
    if (def.kind === 'select') v = (def.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase()) ?? v;
    if ((def.kind === 'text' || def.kind === 'select') && v.includes('\n'))
      v = v
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' '); // = v.replace(/\s*\n\s*/g, ' ') for a trimmed v, without the backtracking
    try {
      Object.assign(fields, cleanFields([def], { [def.key]: v }));
    } catch (e) {
      warnings.push(`${def.label}: ${(e as Error).message} – kept in the import notes`);
      rest[k] = raw;
    }
  }
  return { fields, rest, warnings };
}

export interface ImportFile {
  filename: string;
  content: string;
}

function pickType(parsed: ParsedMarkdown, fallback: TypeRow | undefined): TypeRow {
  if (parsed.typeKey) {
    const t = typeRow(parsed.typeKey);
    if (!t) throw new HttpError(400, `Unknown record type "${parsed.typeKey}" in the frontmatter`);
    if (t.archived) throw new HttpError(400, `The record type ${t.key} is archived`);
    return t;
  }
  if (fallback) return fallback;
  if (parsed.format === 'madr' || parsed.format === 'nygard') {
    const adr = typeRow('ADR');
    if (adr && !adr.archived) return adr;
  }
  throw new HttpError(400, 'Choose a record type (the file does not name one)');
}

/** Preview (dryRun) or import of several Markdown files; each file succeeds or fails on its own. */
export function importMarkdown(files: ImportFile[], o: { type?: string; dryRun?: boolean }): RecordImportItem[] {
  const u = me();
  if (!canCreateRecords(u)) forbid('import records');
  if (!files.length) throw new HttpError(400, 'No files');
  if (files.length > IMPORT_LIMITS.files) throw new HttpError(400, `At most ${IMPORT_LIMITS.files} files at once`);
  const total = files.reduce((s, f) => s + Buffer.byteLength(f.content), 0);
  if (total > IMPORT_LIMITS.totalBytes) throw new HttpError(413, `The files are too large together (at most ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB)`);
  const fallback = o.type ? requireType(o.type) : undefined;
  if (fallback?.archived) throw new HttpError(400, `The record type ${fallback.key} is archived`);
  return files.map((f) => {
    const filename = path.basename(f.filename || 'record.md').slice(0, 200);
    try {
      if (!IMPORT_EXTENSIONS.includes(path.extname(filename).toLowerCase()))
        throw new HttpError(415, `Only Markdown files (${IMPORT_EXTENSIONS.join(', ')}) can be imported`);
      if (Buffer.byteLength(f.content) > IMPORT_LIMITS.fileBytes)
        throw new HttpError(413, `The file is too large (at most ${IMPORT_LIMITS.fileBytes / 1024} KiB)`);
      if (f.content.includes('\u0000')) throw new HttpError(400, 'This is not a text file');
      const parsed = parseRecordMarkdown(f.content);
      const t = pickType(parsed, fallback);
      const type = toType(t, 0);
      const wf = workflowOf(t);
      const { fields, rest, warnings } = mapFields(type.fields, parsed.values);
      const title = (parsed.title || path.basename(filename, path.extname(filename)).replace(/[-_]+/g, ' ')).trim().slice(0, LIMITS.title);
      const rawStatus = parsed.status?.trim() ?? '';
      const normalized = rawStatus
        .toLowerCase()
        .replace(/\s+by\b.*$/, '')
        .replace(/[^a-z ]/g, '')
        .trim();
      const draftLike = DRAFT_LIKE.has(normalized) || normalized === wf.initial;
      const tags = cleanTags([...parsed.tags, ...(draftLike ? [] : [`status:${normalized.replace(/\s+/g, '-') || 'unknown'}`])].slice(0, LIMITS.tags));
      const importMeta: Record<string, unknown> = {
        filename,
        format: parsed.format,
        ...(rawStatus && !draftLike ? { originalStatus: rawStatus } : {}),
        ...parsed.meta,
        ...(Object.keys(rest).length ? { values: rest } : {}),
      };
      const item: RecordImportItem = {
        filename,
        ok: true,
        title,
        typeKey: t.key,
        status: wf.initial,
        originalStatus: rawStatus && !draftLike ? rawStatus : null,
        format: parsed.format,
        fields,
        tags,
        warnings: [...parsed.warnings, ...warnings, ...(Object.keys(rest).length ? [`Kept in the import notes: ${Object.keys(rest).join(', ')}`] : [])],
      };
      if (!o.dryRun) {
        const rec = createRecord({ type: t.id, title, body: parsed.body, fields, tags, importMeta, lenientFields: true });
        item.record = { id: rec.id, number: rec.number };
      }
      return item;
    } catch (e) {
      const status = (e as HttpError).statusCode;
      if (status === 403 || !status) throw e;
      return { filename, ok: false, error: (e as Error).message };
    }
  });
}

/** A record as Markdown with YAML frontmatter (importable again). */
export function exportMarkdown(idOrNumber: string): { filename: string; text: string } {
  const rec = getRecord(idOrNumber);
  const fm: Record<string, unknown> = {
    title: rec.title,
    type: rec.typeKey,
    status: rec.status,
    number: rec.number,
    owner: rec.owner,
    ...(rec.tags.length ? { tags: rec.tags } : {}),
    ...(Object.keys(rec.fields).length ? { fields: rec.fields } : {}),
    steward: {
      id: rec.id,
      number: rec.number,
      type: rec.typeKey,
      revision: rec.revision,
      version: rec.version,
      contentHash: rec.frozenHash ?? rec.contentHash,
      exportedAt: new Date().toISOString(),
    },
  };
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  const body = rec.body.trimEnd();
  const text = `---\n${yaml}\n---\n\n# ${rec.title}\n\n${body ? body + '\n' : ''}`;
  return { filename: `${rec.number}.md`, text };
}
