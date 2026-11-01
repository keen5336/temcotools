import { z } from "zod";
import { AuthorizationError } from "@/lib/auth/principal";
import { RetainedListError } from "@/lib/scan-lists";
import { MAX_RETAINED_WORKBOOK_BYTES, RetainedWorkbookError } from "@/lib/retained-workbook";
import { PickWaveValidationError } from "@/lib/pick-waves";
export function retainedReply(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
export function retainedFailure(error: unknown) {
  if (error instanceof AuthorizationError || error instanceof RetainedListError || error instanceof RetainedWorkbookError) return retainedReply({ ok: false, error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof PickWaveValidationError) return retainedReply({ ok: false, error: error instanceof PickWaveValidationError ? error.message : "Provide a valid bounded saved list or report." }, 400);
  return retainedReply({ ok: false, error: "Saved workflow unavailable. Retry with the same draft or operation ID to check the original result." }, 503);
}
async function readBounded(request: Request, limit: number) {
  if (Number(request.headers.get("Content-Length")) > limit) throw new RetainedListError("The saved workflow request is too large.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new RetainedListError("A saved workflow request is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new RetainedListError("The saved workflow request is too large.", 413); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function readRetainedJson(request: Request, limit = 16 * 1024 * 1024) {
  const bytes = await readBounded(request, limit);
  try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new RetainedListError("Provide a valid saved workflow request."); }
}
export async function readRetainedWorkbookForm(request: Request) {
  const bytes = await readBounded(request, MAX_RETAINED_WORKBOOK_BYTES + 64 * 1024);
  let form: FormData; try { form = await new Request(request.url, { method: "POST", headers: request.headers, body: bytes }).formData(); } catch { throw new RetainedListError("Choose a valid multipart XLSX upload."); }
  const upload = form.get("file"); if (form.getAll("file").length !== 1 || !(upload instanceof File) || !upload.size || upload.size > MAX_RETAINED_WORKBOOK_BYTES) throw new RetainedListError("Choose one XLSX workbook no larger than 16 MiB.", 413);
  return { form, upload };
}
export function retainedCsvResponse(file: { filename: string; contentType: string; content: string }) { return new Response(file.content, { headers: { "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
