import { toCsv } from "../csv.js";

export function exportApi(invoices) {
  return toCsv(invoices, ["id", "total"]);
}
