import JSZip from "jszip";
import type { Readable } from "node:stream";

export const MAX_RETAINED_WORKBOOK_BYTES = 16 * 1024 * 1024;
export const MAX_RETAINED_WORKBOOK_ROWS = 20_000;
export class RetainedWorkbookError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function decodeRetainedWorkbookBase64(input: unknown): Buffer {
  if (typeof input !== "string" || !input.length || input.length > Math.ceil(MAX_RETAINED_WORKBOOK_BYTES / 3) * 4 || input.length % 4 || /[^A-Za-z0-9+/=]/.test(input)) throw new RetainedWorkbookError("Provide a base64 XLSX workbook within the 16 MiB limit.", 413);
  const bytes = Buffer.from(input, "base64");
  if (!bytes.length || bytes.length > MAX_RETAINED_WORKBOOK_BYTES || bytes.toString("base64") !== input) throw new RetainedWorkbookError("The workbook base64 content is invalid or too large.", 413);
  return bytes;
}
export async function validateRetainedWorkbook(input: unknown): Promise<Buffer> {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : input instanceof ArrayBuffer ? Buffer.from(input) : null;
  if (!bytes?.length || bytes.length > MAX_RETAINED_WORKBOOK_BYTES) throw new RetainedWorkbookError("Choose an XLSX workbook no larger than 16 MiB.", 413);
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new RetainedWorkbookError("The file is not a readable XLSX workbook."); }
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (entries.length > 2000 || !zip.file("[Content_Types].xml") || !zip.file("xl/workbook.xml")) throw new RetainedWorkbookError("The XLSX workbook structure is invalid or too large.", 413);
  let expanded = 0, cells = 0, rows = 0;
  for (const entry of entries) {
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name), chunks: Uint8Array[] = [];
    let entrySize = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream("nodebuffer") as Readable;
      let stopped = false;
      stream.on("data", (chunk: Uint8Array) => {
        if (stopped) return;
        entrySize += chunk.length; expanded += chunk.length;
        if (entrySize > 32 * 1024 * 1024 || expanded > 64 * 1024 * 1024) { stopped = true; stream.pause(); stream.destroy(); reject(new RetainedWorkbookError("The expanded workbook exceeds the safe import limit.", 413)); return; }
        if (worksheet) chunks.push(chunk);
      });
      stream.on("error", () => { if (!stopped) { stopped = true; reject(new RetainedWorkbookError("The XLSX workbook contains an unreadable archive entry.")); } });
      stream.on("end", () => { if (!stopped) resolve(); });
      stream.resume();
    });
    if (!worksheet) continue;
    const xml = Buffer.concat(chunks).toString("utf8");
    for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(row|c)\b([^>]*)>/g)) {
      if (match[1] === "row") rows++; else cells++;
      const reference = /\br\s*=\s*["'](?:[A-Za-z]{1,4})?([0-9]+)["']/.exec(match[2]);
      if (reference && Number(reference[1]) > 50_000) throw new RetainedWorkbookError("The worksheet has row references beyond the bounded import range.", 413);
      if (rows > 30_000 || cells > 250_000) throw new RetainedWorkbookError("The workbook has too many rows or cells for an operational import.", 413);
    }
  }
  return bytes;
}
