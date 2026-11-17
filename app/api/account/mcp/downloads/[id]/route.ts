import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { liveAccountSession } from "@/lib/auth/sessions";
import { authFailure } from "@/lib/auth/context";
import { AuthError } from "@/lib/auth/policy";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getSession(); if (!actor.userId || actor.role !== "admin") throw new AuthError("Administrator sign-in required.", 401);
    const artifact = await prisma.mcpArtifact.findFirst({ where: { id: (await params).id, expiresAt: { gt: new Date() }, grant: { userId: actor.userId, revokedAt: null } }, include: { grant: true } });
    if (!artifact || !await liveAccountSession(artifact.grant.sessionId, actor.userId)) throw new AuthError("Download expired or unavailable.", 404);
    return new Response(new Uint8Array(artifact.bytes), { headers: { "Content-Type": artifact.contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) { return authFailure(error); }
}
