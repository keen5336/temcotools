import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "./policy";

export type AuthContext = { source: string };
export function authContext(request: Request): AuthContext {
  const forwarded = process.env.TRUST_PROXY === "true" ? request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() : null;
  return { source: (forwarded || "direct").slice(0, 200) };
}
export async function authBudget(kind: string, subject: string, context: AuthContext) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new AuthError("Sign-in is unavailable.", 503);
  const digest = (text: string) => createHmac("sha256", secret).update(text).digest("hex");
  const at = new Date(), boundary = new Date(at.getTime() - 15 * 60_000);
  let blocked = false;
  await prisma.$transaction(async tx => {
    // Stop before allocating arbitrary account keys when a source is already
    // blocked. Random usernames cannot grow the table past the source budget.
    for (const [value, limit] of [[`${kind}:source:${context.source}`, 120], [`${kind}:account:${subject.trim().toLowerCase()}`, 12]] as const) {
      const key = digest(value);
      const [row] = await tx.$queryRaw<{ attempts: number }[]>`INSERT INTO "AuthRateLimit" (key,"windowStart",attempts) VALUES (${key},${at},1) ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN "AuthRateLimit"."windowStart"<=${boundary} THEN 1 ELSE "AuthRateLimit".attempts+1 END,"windowStart"=CASE WHEN "AuthRateLimit"."windowStart"<=${boundary} THEN ${at} ELSE "AuthRateLimit"."windowStart" END RETURNING attempts`;
      if (row.attempts > limit) { blocked = true; break; }
    }
  });
  if (blocked) throw new AuthError("Too many attempts. Wait 15 minutes before trying again.", 429, "RATE_LIMITED");
}
export function sameOrigin(request: Request) {
  const expected = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
  if (request.headers.get("origin") !== expected) throw new AuthError("Same-origin request required.", 403);
}
export async function readAuthBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) return {};
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 12000) { await reader.cancel(); throw new AuthError("Request is too large.", 413); }
    chunks.push(part.value);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AuthError("Invalid request."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthError("Invalid request.");
  return body;
}
export function authFailure(error: unknown) {
  if (error instanceof AuthError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store", ...(error.status === 429 ? { "Retry-After": "900" } : {}) } });
  return Response.json({ error: "Account service is unavailable. Check current sign-in state before trying again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
export const authReply = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });
