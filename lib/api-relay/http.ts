import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RelayError } from "./model";

export const relayReply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function relayAppOrigin(request: NextRequest) {
  return new URL(process.env.API_RELAY_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin).origin;
}

export async function relayUser(request: NextRequest, write = true) {
  if (write && request.headers.get("origin") !== relayAppOrigin(request)) throw new RelayError("Same-origin request required.", 403);
  const session = await getSession();
  const user = session.userId && session.isActive ? await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, isActive: true, role: true } }) : null;
  if (!user?.isActive) throw new RelayError("Sign in to use API relays.", 401);
  return { session, user };
}

export async function relayBody(request: NextRequest) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 250000) throw new RelayError("Request is too large.", 413);
  let value;
  try { value = raw ? JSON.parse(raw) : {}; } catch { throw new RelayError("Invalid JSON request."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("Invalid request.");
  return value;
}

export function relayFailure(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : error instanceof TypeError ? 503 : 400;
  return relayReply({ error: status === 503 ? "API relay service is unavailable." : error instanceof Error ? error.message : "API relay failed." }, status);
}
