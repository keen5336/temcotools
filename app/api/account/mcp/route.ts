import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { assertActor } from "@/lib/auth/sessions";
import { authFailure, authReply } from "@/lib/auth/context";
import { mcpConfig } from "@/lib/mcp/config";
export async function GET() {
  try {
    const actor = await getSession();
    const connections = await prisma.$transaction(async tx => {
      await assertActor(tx, actor, true);
      return tx.mcpGrant.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, scopes: true, createdAt: true, expiresAt: true, revokedAt: true, client: { select: { id: true, name: true } }, session: { select: { id: true, deviceName: true, lastUsedAt: true, revokedAt: true, expiresAt: true } } } });
    });
    return authReply({ url: mcpConfig().resource, connections });
  } catch (error) { return authFailure(error); }
}
