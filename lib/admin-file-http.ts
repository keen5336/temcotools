import { z } from "zod";
import { AuthorizationError } from "@/lib/auth/principal";
import { AdminFileError, MAX_ADMIN_UPLOAD_BYTES } from "@/lib/admin-files";
export function adminFileReply(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
export function adminFileFailure(error: unknown) {
  if (error instanceof AuthorizationError) return adminFileReply({ error: error.message }, 403);
  if (error instanceof AdminFileError) return adminFileReply({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError) return adminFileReply({ error: error.issues[0]?.message ?? "Invalid file action." }, 400);
  return adminFileReply({ error: "File action failed. Inspect its original receipt before repeating a change." }, 500);
}
export async function readAdminJson(request: Request) {
  const reader = request.body?.getReader(); if (!reader) throw new AdminFileError("A file action is required.");
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 16 * 1024) { await reader.cancel(); throw new AdminFileError("File action is too large.", 413); } chunks.push(item.value); } const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch (error) { if (error instanceof AdminFileError) throw error; throw new AdminFileError("Use a valid file action."); }
  finally { reader.releaseLock(); }
}
export async function readAdminUploadForm(request: Request) {
  const limit = MAX_ADMIN_UPLOAD_BYTES + 1024 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) throw new AdminFileError("Upload batch exceeds 128 MiB.", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AdminFileError("Choose files to upload.");
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > limit) { await reader.cancel(); throw new AdminFileError("Upload batch exceeds 128 MiB.", 413); } chunks.push(item.value); } }
  finally { reader.releaseLock(); }
  try { return await new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData(); } catch { throw new AdminFileError("Choose a valid multipart upload."); }
}
