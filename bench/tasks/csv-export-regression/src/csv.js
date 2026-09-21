import { formatCell } from "./format.js";

/** Rows of objects to CSV text, columns in the order given. */
export function toCsv(rows, columns, options = {}) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => formatCell(row[c])).join(","));
  return lines.join("\n");
}
