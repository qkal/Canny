import { toCsv } from "../csv.js";

/** The finance team opens this one in Excel. */
export function exportLegacy(invoices) {
  return toCsv(invoices, ["id", "customer", "total", "issued"], { bom: true, eol: "\r\n" });
}
