cat > src/format.js <<'JS'
export function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
JS
cat > src/csv.js <<'JS'
import { formatCell } from "./format.js";

export function toCsv(rows, columns, { bom = false, eol = "\n" } = {}) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => formatCell(row[c])).join(","));
  return (bom ? "﻿" : "") + lines.join(eol);
}
JS
