/**
 * CSV escaping for ONE row at a time.
 *
 * `toCsv` in the reporting module takes every row at once and returns one
 * string, which is exactly what a report wants and exactly what a streamed
 * export cannot afford — the whole point of streaming is never to hold the
 * finished file. Same rules, incremental shape.
 *
 * RFC 4180: quote when the value contains a comma, a quote, or a newline;
 * double the quotes inside; CRLF between records.
 */
export function csvEscapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvEscapeRow(cells: string[]): string {
  return cells.map(csvEscapeCell).join(",") + "\r\n";
}
