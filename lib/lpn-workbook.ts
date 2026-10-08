import type { LpnSourceRow } from "@/lib/lpn-report";

const XLSX_CDN_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
type SheetJs = {
  read: (data: Uint8Array, options: Record<string, unknown>) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json: (sheet: unknown, options: Record<string, unknown>) => LpnSourceRow[] };
};
let loading: Promise<void> | null = null;
export function loadLpnSpreadsheetParser() {
  if (window.XLSX) return Promise.resolve();
  if (!loading) loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_CDN_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { loading = null; script.remove(); reject(new Error("Unable to load the spreadsheet parser. Check your connection and try again.")); };
    document.head.appendChild(script);
  });
  return loading;
}
export function parseLpnWorkbook(buffer: ArrayBuffer) {
  const xlsx = window.XLSX as SheetJs | undefined;
  if (!xlsx) throw new Error("Spreadsheet parser is not loaded yet.");
  const workbook = xlsx.read(new Uint8Array(buffer), { type: "array", cellDates: true });
  const first = workbook.SheetNames[0];
  if (!first) throw new Error("The workbook does not contain a sheet.");
  return xlsx.utils.sheet_to_json(workbook.Sheets[first], { defval: "", raw: true });
}
