import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal } from "@/lib/auth/principal";
import { authorizeDmpPayload } from "@/lib/api-relay/payload-policy";
import { dmpConfig } from "@/lib/api-relay/config";
import { assertCurrentPrincipal } from "@/lib/auth/identity";

export const runtime = "nodejs";
const inputSchema = z.object({
  owner: z.object({ userId: z.string(), authSessionId: z.string(), authVersion: z.number().int(), grantId: z.string().optional() }),
  origin: z.string(), payloadGrant: z.unknown(), operation: z.string().max(64),
});
export async function POST(request: Request) {
  const secret = process.env.SESSION_SECRET;
  const expected = secret && secret.length >= 32 ? createHash("sha256").update(`temco-api-relay-control-v1:${secret}`).digest("hex") : "";
  const supplied = request.headers.get("x-api-relay-key") || "";
  const expectedBytes = Buffer.from(expected), suppliedBytes = Buffer.from(supplied);
  if (!expected || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return NextResponse.json({ authorized: false }, { status: 401 });
  try {
    const raw = await request.text(); if (raw.length > 8192) throw new Error();
    const input = inputSchema.parse(JSON.parse(raw));
    const session = await prisma.userSession.findUnique({ where: { id: input.owner.authSessionId } });
    const claim = session && { userId: session.userId, authVersion: session.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() };
    if (!session || !claim || session.userId !== input.owner.userId || session.authVersion !== input.owner.authVersion || !isLivePersistentSession(session, claim)) throw new Error();
    const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }));
    if (!principal) throw new Error();
    const current = await prisma.$transaction(tx => assertCurrentPrincipal(tx, {
      ...principal, sessionId: session.id, grantId: input.owner.grantId,
      strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime(),
    }));
    const policy = await authorizeDmpPayload(input.payloadGrant, input.origin);
    const config = dmpConfig();
    if (!Object.hasOwn(config.operations, input.operation) || !policy.operationNames.includes(input.operation)) throw new Error();
    const operation = config.operations[input.operation];
    const capability = ["GET", "HEAD"].includes(operation.method || "GET") ? "workflow.read" : "workflow.execute";
    if (!current.capabilities.includes(capability)) throw new Error();
    return NextResponse.json({ authorized: true }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ authorized: false }, { headers: { "Cache-Control": "no-store" } }); }
}
