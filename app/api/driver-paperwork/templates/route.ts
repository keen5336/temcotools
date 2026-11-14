import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getTemplateEditor, PaperworkError, saveTemplate } from "@/lib/driver-paperwork/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof PaperworkError) return reply({ error: error.message }, error.status);
  return reply({ error: "Templates could not be loaded or saved. Please reload to check the saved version." }, 503);
}
async function actor() {
  const session = await getSession();
  if (!session.userId || !session.isActive) throw new PaperworkError("Sign in to manage templates.", 401);
  return session.userId;
}
export async function GET(req: NextRequest) {
  try {
    const version = req.nextUrl.searchParams.get("version");
    const operationId = req.nextUrl.searchParams.get("operationId") ?? undefined;
    if (version !== null && !/^\d{1,9}$/.test(version)) return reply({ error: "Invalid version." }, 400);
    if (operationId && !/^[\da-f-]{36}$/i.test(operationId)) return reply({ error: "Invalid save identifier." }, 400);
    return reply(await getTemplateEditor(await actor(), { version: version === null ? undefined : Number(version), operationId }));
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).origin;
  if (req.headers.get("origin") !== origin) return reply({ error: "Same-origin request required." }, 403);
  try {
    const userId = await actor();
    if (Number(req.headers.get("content-length")) > 350_000) return reply({ error: "Template update is too large." }, 413);
    // Bound the stream too: Content-Length is optional and cannot be trusted.
    const reader = req.body?.getReader();
    if (!reader) return reply({ error: "Template content is required." }, 400);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 350_000) { await reader.cancel(); return reply({ error: "Template update is too large." }, 413); }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return reply({ error: "Invalid template JSON." }, 400); }
    return reply(await saveTemplate(userId, input));
  } catch (error) { return failure(error); }
}
