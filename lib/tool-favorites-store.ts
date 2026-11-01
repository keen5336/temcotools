import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import { changeFavorites, FavoriteError, type FavoriteChange } from "./tool-favorites";
import { toolsForRole, visibleFavoriteIds } from "./tools";

export async function getToolFavorites(principal: Principal) {
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal, "account.self");
    const user = await tx.user.findUniqueOrThrow({ where: { id: principal.userId }, select: { favoriteToolIds: true } });
    return { favoriteIds: visibleFavoriteIds(user.favoriteToolIds, current.role, current.capabilities), tools: toolsForRole(current.role, current.capabilities), role: current.role, capabilities: current.capabilities };
  });
}
export async function saveToolFavorites(principal: Principal, change: FavoriteChange) {
  return prisma.$transaction(async tx => {
    // Acquire the writer lock before the general authority check to serialize
    // merges and avoid upgrading shared locks against another favorite writer.
    const rows = await tx.$queryRaw<{ favoriteToolIds: string[] }[]>`SELECT "favoriteToolIds" FROM "User" WHERE id = ${principal.userId} FOR UPDATE`;
    if (!rows.length) throw new FavoriteError("Sign in again.", 401);
    const current = await assertCurrentPrincipal(tx, principal, "account.self");
    const ids = changeFavorites(rows[0].favoriteToolIds, current.role, change, current.capabilities);
    await tx.user.update({ where: { id: principal.userId }, data: { favoriteToolIds: ids } });
    return { favoriteIds: visibleFavoriteIds(ids, current.role, current.capabilities), role: current.role, capabilities: current.capabilities };
  });
}
