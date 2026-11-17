import * as XLSX from "xlsx";
import { OAuthError } from "./config";

export function uploadBytes(file: { dataBase64: string }) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) throw new OAuthError("invalid_request", "Invalid base64 upload.");
  const bytes = Buffer.from(file.dataBase64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new OAuthError("invalid_request", "Supply a nonempty upload of at most 20 MB.");
  return bytes;
}
export function parseSpreadsheet(file: { filename: string; dataBase64: string }, sheet?: string) {
  if (!/\.(xlsx|xls|csv)$/i.test(file.filename)) throw new OAuthError("invalid_request", "Supply an XLSX, XLS or CSV file.");
  try {
    const book = XLSX.read(uploadBytes(file), { type: "buffer", cellDates: true, sheetRows: 100002, bookVBA: false, cellHTML: false, cellFormula: false });
    const name = sheet || book.SheetNames[0], worksheet = book.Sheets[name];
    if (!worksheet) throw new OAuthError("invalid_request", "The requested worksheet was not found.");
    const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
    if (range.e.c > 255 || range.e.r > 100000) throw new OAuthError("invalid_request", "Parse at most 100,000 rows and 256 columns per action.");
    return { sheet: name, sheets: book.SheetNames, rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "", raw: true }) };
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_request", "The spreadsheet could not be parsed.");
  }
}
export function reportWorkbook(rows: Record<string, unknown>[]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "Report");
  return Buffer.from(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}
