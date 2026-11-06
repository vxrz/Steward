import { HttpError } from '../util.js';

/**
 * A small CSV reader for FOCUS files (RFC 4180): fields separated by a comma (or a semicolon or a tab, as the header
 * line shows), quoted fields with doubled quotes inside, CRLF, LF or CR line ends, a byte order mark at the start.
 * One pass over the characters – no regular expression on the input, so nothing can backtrack – with limits on the
 * rows, the columns and the characters of a cell. Rows are handed to `onRow` one by one (nothing else is kept).
 */

export interface CsvLimits {
  rows: number;
  columns: number;
  cellChars: number;
}

export class CsvError extends HttpError {
  constructor(message: string, line: number) {
    super(400, `${message} (line ${line})`, 'COST_IMPORT_CSV', { line, message });
  }
}

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
    if (cell.length > limits.cellChars) throw new CsvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
    if (row.length >= limits.columns) throw new CsvError(`A row has more than ${limits.columns} columns`, rowLine);
    row.push(cell);
    cell = '';
    afterQuote = false;
  };
  const pushRow = () => {
    pushCell();
    const empty = row.length === 1 && row[0] === '';
    if (!empty) {
      if (index >= limits.rows) throw new CsvError(`The file has more than ${limits.rows} rows`, rowLine);
      onRow(row, rowLine, index);
      index++;
    }
    row = [];
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
        if (cell.length > limits.cellChars) throw new CsvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
      }
      continue;
    }
    if (c === sep) {
      pushCell();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      line++;
      rowLine = line;
    } else if (c === '"') {
      if (cell.length || afterQuote) throw new CsvError('A quote inside an unquoted cell', rowLine);
      quoted = true;
    } else {
      if (afterQuote) throw new CsvError('Text after the closing quote of a cell', rowLine);
      cell += c;
      if (cell.length > limits.cellChars) throw new CsvError(`A cell has more than ${limits.cellChars} characters`, rowLine);
    }
  }
  if (quoted) throw new CsvError('A quoted cell is not closed', rowLine);
  if (cell.length || row.length || afterQuote) pushRow();
  return Math.max(0, index);
}
