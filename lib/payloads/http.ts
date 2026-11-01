import { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth/principal";
import { PayloadError } from "./model";
export const payloadReply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function payloadFailure(error: unknown) {
  if (error instanceof PayloadError || error instanceof AuthorizationError) return payloadReply({ error: error.message }, error.status);
  return payloadReply({ error: "Payload management is unavailable. No change was confirmed; reload before trying again." }, 503);
}
export async function readPayloadBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 160 * 1024) throw new PayloadError("Payload request is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > 160 * 1024) throw new PayloadError("Payload request is too large.", 413);
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new PayloadError("Enter a valid payload request."); }
}
export function executablePayloadResponse(source: string, immutable = false) {
  return new Response(source, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" } });
}
export function payloadLoaderSource(versionUrl: string) {
  return `(()=>{var s=document.createElement('script');s.src=${JSON.stringify(versionUrl)};s.onerror=()=>alert('The published Temco payload version could not load.');(document.head||document.documentElement).appendChild(s)})();`;
}
