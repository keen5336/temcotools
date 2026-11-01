import { AuthorizationError } from "@/lib/auth/principal";
import { SiteProfileError } from "./types";
export const siteReply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function siteFailure(error: unknown) { return siteReply({ error: error instanceof SiteProfileError || error instanceof AuthorizationError ? error.message : "Site mappings are unavailable. Reload before trying again." }, error instanceof SiteProfileError || error instanceof AuthorizationError ? error.status : 503); }
export async function siteBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 8192) throw new SiteProfileError("Mapping request exceeds 8 KiB.", 413);
  const text = await request.text(); if (Buffer.byteLength(text) > 8192) throw new SiteProfileError("Mapping request exceeds 8 KiB.", 413);
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new SiteProfileError("Provide a valid mapping request."); }
}
