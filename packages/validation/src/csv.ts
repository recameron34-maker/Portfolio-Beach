/**
 * A small RFC 4180 reader: comma separated, optional double quotes with doubled quotes inside,
 * CRLF or LF line ends, a UTF-8 byte order mark tolerated. Cells are returned as text; nothing is
 * parsed here, so a rule can report exactly what the file said.
 */
export interface CsvTable {
  header: string[];
  /** One entry per data line, in file order; a blank line is skipped. */
  rows: string[][];
}

export function parseCsv(text: string): CsvTable {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const lines: string[][] = [];
  let cell = '';
  let line: string[] = [];
  let quoted = false;
  let i = 0;
  const endLine = (): void => {
    line.push(cell);
    cell = '';
    if (line.length > 1 || (line[0] ?? '') !== '') lines.push(line);
    line = [];
  };
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      line.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // CRLF: the line ends at the LF.
    } else if (ch === '\n') {
      endLine();
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== '' || line.length > 0) endLine();
  const header = (lines[0] ?? []).map((h) => h.trim());
  return { header, rows: lines.slice(1) };
}

/** Writes rows as CSV, quoting a cell only when it needs it. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
