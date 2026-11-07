import { HttpError } from '../util.js';

/**
 * A small CSV reader for FOCUS files (RFC 4180): fields separated by a comma (or a semicolon or a tab, as the header
 * line shows), quoted fields with doubled quotes inside, CRLF, LF or CR line ends, a byte order mark at the start.
 * One pass over the characters – no regular expression on the input, so nothing can backtrack – with limits on the
 * rows, the columns and the characters of a cell. Rows are handed over one by one (nothing else is kept).
 */

export interface CsvLimits {
  rows: number;
  columns: number;
  cellChars: number;
}

/** 400 COST_IMPORT_CSV with the line where the row starts. */
export const csvError = (message: string, line: number): HttpError => new HttpError(400, `${message} (line ${line})`, 'COST_IMPORT_CSV', { line, message });

/** The separator of a file: the one of comma, semicolon and tab that occurs most often in its first line (outside quotes). */
export function separatorOf(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]!++;
  }
  return counts[';']! > counts[',']! && counts[';']! >= counts['\t']! ? ';' : counts['\t']! > counts[',']! ? '\t' : ',';
}

/**
 * Reads every row; the first is the header. `onRow` gets the cells and the line number where the row starts. Empty
 * lines are skipped. Returns the number of rows after the header.
 */
export function readCsv(raw: string, limits: CsvLimits, onRow: (cells: string[], line: number, index: number) => void): number {
  const rows = csvRows(raw, limits);
  for (;;) {
    const r = rows.next();
    if (r.done) return r.value;
    onRow(r.value.cells, r.value.line, r.value.index);
  }
}

export interface CsvRow {
  cells: string[];
  /** The line where the row starts */
  line: number;
  /** -1 for the header, then 0, 1, … */
  index: number;
}

/** The rows one by one (a caller can pause between them); returns the number of rows after the header. */
export function* csvRows(raw: string, limits: CsvLimits): Generator<CsvRow, number, undefined> {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const sep = separatorOf(text);
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;
  let index = -1;
  const pushCell = () => {
    if (cell.length > limits.cellChars) throw csvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
    if (row.length >= limits.columns) throw csvError(`A row has more than ${limits.columns} columns`, rowLine);
    row.push(cell);
    cell = '';
    afterQuote = false;
  };
  /** The finished row, or null for an empty line */
  const endRow = (): CsvRow | null => {
    pushCell();
    const cells = row;
    row = [];
    if (cells.length === 1 && cells[0] === '') return null;
    if (index >= limits.rows) throw csvError(`The file has more than ${limits.rows} rows`, rowLine);
    return { cells, line: rowLine, index: index++ };
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        cell += c;
        if (cell.length > limits.cellChars) throw csvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
      }
      continue;
    }
    if (c === sep) {
      pushCell();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      const r = endRow();
      if (r) yield r;
      line++;
      rowLine = line;
    } else if (c === '"') {
      if (cell.length || afterQuote) throw csvError('A quote inside an unquoted cell', rowLine);
      quoted = true;
    } else {
      if (afterQuote) throw csvError('Text after the closing quote of a cell', rowLine);
      cell += c;
      if (cell.length > limits.cellChars) throw csvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
    }
  }
  if (quoted) throw csvError('A quoted cell is not closed', rowLine);
  if (cell.length || row.length || afterQuote) {
    const r = endRow();
    if (r) yield r;
  }
  return Math.max(0, index);
}
