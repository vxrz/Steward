/**
 * Table inputs of processes (`type: table`): CSV text as rows of objects. The server coerces a run's inputs with it and
 * the run dialog counts the rows it reads – the same answer in both places.
 */

/** The delimiter of a CSV text: semicolon, tab or comma – whichever splits its first line most. */
function delimiterOf(firstLine: string): string {
  return [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
}

/** The fields of each line (quoted fields with "" for a quote; a line break inside quotes stays in the field). */
export function csvLines(text: string): string[][] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!lines) return [];
  const delim = delimiterOf(lines.split('\n')[0]!);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i]!;
    if (q) {
      if (c === '"' && lines[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) (row.push(field), (field = ''));
    else if (c === '\n') (row.push(field), rows.push(row), (row = []), (field = ''));
    else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * CSV text (comma, semicolon or tab separated, quoted fields) as rows. The first line is the header – with declared
 * `columns`, a header field that names one of them in another case takes the declared spelling, and a first line that
 * names none of them is data: every line is then read by position into the declared columns (extra fields ignored,
 * missing ones empty). Blank lines are left out; fields are trimmed.
 */
export function readTableCsv(text: string, columns?: string[]): { rows: Record<string, string>[]; headerless: boolean } {
  const lines = csvLines(text);
  if (!lines.length) return { rows: [], headerless: false };
  const declared = (columns ?? []).map((c) => c.trim()).filter(Boolean);
  const byLower = new Map(declared.map((c) => [c.toLowerCase(), c]));
  const first = lines[0]!.map((h) => h.trim());
  const headerless = declared.length > 0 && !first.some((h) => byLower.has(h.toLowerCase()));
  const header = headerless ? declared : first.map((h) => byLower.get(h.toLowerCase()) ?? h);
  const data = headerless ? lines : lines.slice(1);
  const rows = data.filter((r) => r.some((x) => x.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { rows, headerless };
}

/** The rows of {@link readTableCsv}. */
export const parseTableCsv = (text: string, columns?: string[]): Record<string, string>[] => readTableCsv(text, columns).rows;
