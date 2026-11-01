// A bounded 128 MiB administrative upload batch expands to about 171 MiB in
// base64. Individual domain/file/workbook limits still apply after parsing.
export const MAX_APPLICATION_BODY_BYTES = 192 * 1024 * 1024;
export class ApplicationBodyError extends Error { readonly status = 413; }
export async function readApplicationInput(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_APPLICATION_BODY_BYTES) { await request.body?.cancel(); throw new ApplicationBodyError("Application input exceeds the supported upload boundary."); }
  const reader = request.body?.getReader(); if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_APPLICATION_BODY_BYTES) { await reader.cancel(); throw new ApplicationBodyError("Application input exceeds the supported upload boundary."); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
