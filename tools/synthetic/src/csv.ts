/**
 * The CSV the sample drops are written in: a comma between cells, a line feed after every line
 * (the last one too), and a cell quoted only when it holds a comma, a quote or a line break, with
 * quotes doubled. The validation library's reader takes exactly this back.
 */
export const csvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** The file text for a header and its rows of cells, every row in header order. */
export function csvText(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}
