export const LPN_REPORT_COLUMNS = ["LPN", "Status", "Order Number", "Vendor", "Received Date", "Description", "Deliver to:"] as const;
export type LpnSourceRow = Record<string, unknown>;
export type LpnReportRow = {
  lpn: string; status: string; orderNumber: string; vendor: string;
  receivedDate: string; description: string; customerName: string;
  sourceData: Record<string, string>;
};
export class InventoryAuditValidationError extends Error {}

export function normalizeLpnHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/:$/, "");
}
export function findLpnColumn(row: LpnSourceRow | undefined, name: string) {
  return row ? Object.keys(row).find((key) => normalizeLpnHeader(key) === normalizeLpnHeader(name)) ?? null : null;
}
export function lpnValueToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}
export function lpnInputDate(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 20_000 && numeric < 80_000) return new Date(Math.round((numeric - 25569) * 86_400_000)).toISOString().slice(0, 10);
  // Warehouse reports use month/day/year; preserve calendar dates across time zones.
  const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(text);
  if (usDate) return `${usDate[3]}-${usDate[1].padStart(2, "0")}-${usDate[2].padStart(2, "0")}`;
  const isoDate = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(text);
  if (isoDate) return isoDate[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}
export function normalizeLpn(value: string) { return value.trim().toUpperCase(); }

export function prepareLpnReport(rows: LpnSourceRow[]) {
  if (!rows.length) throw new InventoryAuditValidationError("The report has no rows.");
  const missing = LPN_REPORT_COLUMNS.filter((name) => !findLpnColumn(rows[0], name));
  if (missing.length) throw new InventoryAuditValidationError(`Missing report columns: ${missing.join(", ")}.`);
  const unique = new Map<string, LpnReportRow>();
  let duplicateCount = 0;
  let blankCount = 0;
  for (const row of rows) {
    const sourceData: Record<string, string> = {};
    for (const key of Object.keys(row).sort((a, b) => normalizeLpnHeader(a).localeCompare(normalizeLpnHeader(b)))) {
      const header = normalizeLpnHeader(key);
      if (Object.hasOwn(sourceData, header)) throw new InventoryAuditValidationError(`Duplicate report column: ${key}.`);
      sourceData[header] = lpnValueToString(row[key]);
    }
    const lpn = normalizeLpn(sourceData.lpn ?? "");
    if (!lpn) { blankCount++; continue; }
    if (lpn.length > 500) throw new InventoryAuditValidationError("An LPN exceeds 500 characters.");
    sourceData.lpn = lpn;
    const rawDate = sourceData["received date"];
    const receivedDate = lpnInputDate(rawDate);
    if (rawDate && !receivedDate) throw new InventoryAuditValidationError(`Invalid Received Date for LPN ${lpn}.`);
    const item: LpnReportRow = {
      lpn, status: sourceData.status ?? "", orderNumber: sourceData["order number"] ?? "",
      vendor: sourceData.vendor ?? "", receivedDate, description: sourceData.description ?? "",
      customerName: sourceData["deliver to"] ?? "", sourceData,
    };
    const previous = unique.get(lpn);
    if (previous) {
      if (JSON.stringify(previous.sourceData) !== JSON.stringify(sourceData)) throw new InventoryAuditValidationError(`LPN ${lpn} has conflicting rows. Each LPN must identify one report row.`);
      duplicateCount++;
    } else unique.set(lpn, item);
  }
  if (!unique.size) throw new InventoryAuditValidationError("The report contains no LPNs.");
  return { items: [...unique.values()], duplicateCount, blankCount };
}
