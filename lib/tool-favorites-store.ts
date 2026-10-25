import { prisma } from "@/lib/db";
import { changeFavorites, FavoriteError, type FavoriteChange } from "./tool-favorites";
import { visibleFavoriteIds, type ToolRole } from "./tools";

type FavoriteUser = { id: string; role: ToolRole; isActive: boolean; favoriteToolIds: string[] };
function result(user: FavoriteUser | null) {
  if (!user?.isActive) throw new FavoriteError("Sign in with an active account to manage favorites.", 401);
  return { favoriteIds: visibleFavoriteIds(user.favoriteToolIds, user.role), role: user.role };
}

export async function getToolFavorites(userId: string) {
  return result(await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true, favoriteToolIds: true } }));
}

export async function saveToolFavorites(userId: string, change: FavoriteChange) {
  return prisma.$transaction(async (tx) => {
    // Lock only this authenticated user's row so updates from different tabs
    // merge against the latest state without touching another user's settings.
    const [user] = await tx.$queryRaw<FavoriteUser[]>`
      SELECT "id", "role", "isActive", "favoriteToolIds" FROM "User" WHERE "id" = ${userId} FOR UPDATE
    `;
    result(user);
    const ids = changeFavorites(user.favoriteToolIds, user.role, change);
    await tx.user.update({ where: { id: userId }, data: { favoriteToolIds: ids } });
    return result({ ...user, favoriteToolIds: ids });
  });
}
