import { TOOLS, toolsForRole, visibleFavoriteIds, type ToolRole } from "./tools";

export type FavoriteChange = { action: "set"; toolId: string; favorite: boolean } | { action: "reorder"; order: string[] };
export class FavoriteError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseFavoriteChange(value: unknown): FavoriteChange {
  if (!value || typeof value !== "object") throw new FavoriteError("Invalid favorites update.");
  const data = value as Record<string, unknown>;
  if (data.action === "set" && typeof data.toolId === "string" && data.toolId.length <= 80 && typeof data.favorite === "boolean") return { action: "set", toolId: data.toolId, favorite: data.favorite };
  if (data.action === "reorder" && Array.isArray(data.order) && data.order.length <= TOOLS.length && data.order.every((id) => typeof id === "string" && id.length <= 80) && new Set(data.order).size === data.order.length) return { action: "reorder", order: data.order };
  throw new FavoriteError("Invalid favorites update.");
}

export function changeFavorites(stored: readonly string[], role: ToolRole, change: FavoriteChange) {
  const known = new Set(TOOLS.map((tool) => tool.id));
  const current = [...new Set(stored)].filter((id) => known.has(id));
  const allowed = new Set(toolsForRole(role).map((tool) => tool.id));
  if (change.action === "set") {
    if (!allowed.has(change.toolId)) throw new FavoriteError("This tool is unavailable to your account.", 403);
    return change.favorite ? [...new Set([...current, change.toolId])] : current.filter((id) => id !== change.toolId);
  }
  if (change.order.some((id) => !allowed.has(id))) throw new FavoriteError("This tool is unavailable to your account.", 403);
  const visible = visibleFavoriteIds(current, role);
  if (change.order.some((id) => !visible.includes(id))) throw new FavoriteError("Favorites changed in another tab. Refresh and try again.", 409);
  // Keep favorites added concurrently in another tab, and preserve hidden
  // favorites in case an administrator later restores this user's role.
  const ordered = [...change.order, ...visible.filter((id) => !change.order.includes(id))];
  let index = 0;
  return current.map((id) => allowed.has(id) ? ordered[index++] : id);
}
