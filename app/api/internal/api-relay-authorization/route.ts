import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CURRENT_USER_SELECT, isLivePersistentSession, resolvePrincipal } from "@/lib/auth/principal";
import { verifyQueuedDmpPayload, dmpOperationConfigHash } from "@/lib/api-relay/payload-policy";
import { dmpConfig } from "@/lib/api-relay/config";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { controlKey } from "@/scripts/api-relay/control-key.mjs";

export const runtime = "nodejs";
const ownerSchema = z.object({ siteId: z.string().min(1).max(200).default("warehouse-initial"), userId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), authSessionId: z.string().min(1).max(100), authVersion: z.number().int(), grantId: z.string().max(220).optional() });
const inputSchema = z.object({
  authorizationProtocol: z.literal(3), owner: ownerSchema, connectionOwner: ownerSchema,
  origin: z.string().max(300), payloadGrant: z.unknown(), operation: z.string().max(64), requestMethod: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  share: z.object({ id: z.string().uuid(), requester: ownerSchema, operations: z.array(z.string().max(64)).min(1).max(32), operationConfigHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int() }).nullish(),
});
async function currentOwner(owner: z.infer<typeof ownerSchema>) {
  const session = await prisma.userSession.findUnique({ where: { id: owner.authSessionId } });
  const claim = session && { userId: session.userId, authVersion: session.authVersion, sessionId: session.id, issuedAt: session.createdAt.getTime(), expiresAt: session.expiresAt.getTime() };
  if (!session || !claim || session.userId !== owner.userId || session.authVersion !== owner.authVersion || !isLivePersistentSession(session, claim)) throw new Error();
  const principal = await resolvePrincipal(claim, id => prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT }), Date.now(), owner.siteId);
  if (!principal) throw new Error();
  return prisma.$transaction(tx => assertCurrentPrincipal(tx, { ...principal, sessionId: session.id, grantId: owner.grantId, strongAuthenticatedAt: session.lastStrongAuthenticatedAt.getTime(), mfaVerifiedAt: session.mfaVerifiedAt?.getTime() }));
}
const sameOwner = (a: z.infer<typeof ownerSchema>, b: z.infer<typeof ownerSchema>) => a.siteId === b.siteId && a.userId === b.userId && a.sessionId === b.sessionId && a.authSessionId === b.authSessionId && a.authVersion === b.authVersion && (a.grantId ?? null) === (b.grantId ?? null);
export async function POST(request: Request) {
  let expected = "";
  try { expected = controlKey(process.env.SESSION_SECRET); } catch { /* Invalid/missing control configuration fails closed. */ }
  const supplied = request.headers.get("x-api-relay-key") || "";
  const expectedBytes = Buffer.from(expected), suppliedBytes = Buffer.from(supplied);
  if (!expected || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return NextResponse.json({ authorized: false }, { status: 401 });
  try {
    const raw = await request.text(); if (Buffer.byteLength(raw) > 16_384) throw new Error();
    const input = inputSchema.parse(JSON.parse(raw));
    const [requester, original] = await Promise.all([currentOwner(input.owner), currentOwner(input.connectionOwner)]);
    const policy = await verifyQueuedDmpPayload(input.payloadGrant, input.origin), config = dmpConfig();
    if (!config.origins.includes(input.origin) || !Object.hasOwn(config.operations, input.operation) || !policy.operationNames.includes(input.operation)) throw new Error();
    const read = ["GET", "HEAD"].includes(config.operations[input.operation].method || "GET") && ["GET", "HEAD"].includes(input.requestMethod);
    const capability = read ? "workflow.read" : "workflow.execute";
    if (requester.siteId !== original.siteId || !requester.capabilities.includes(capability) || !original.capabilities.includes(capability)) throw new Error();
    if (!sameOwner(input.owner, input.connectionOwner)) {
      const share = input.share;
      if (!read || !share || input.connectionOwner.grantId || !input.owner.grantId?.startsWith("oauth:") || requester.userId !== original.userId || !sameOwner(share.requester, input.owner) || share.expiresAt <= Date.now() || !share.operations.includes(input.operation) || share.operationConfigHash !== dmpOperationConfigHash()) throw new Error();
    } else if (input.share) throw new Error();
    return NextResponse.json({ authorized: true, authorizationProtocol: 3 }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ authorized: false }, { headers: { "Cache-Control": "no-store" } }); }
}
