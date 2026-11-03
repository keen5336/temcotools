import path from "node:path";
import { createHash } from "node:crypto";
import type { Principal } from "@/lib/auth/principal";
import { AuthorizationError } from "@/lib/auth/principal";
// Keep retained initial-site files in place. Other sites use a reserved,
// non-navigable namespace within the same persistent managed volume.
export function warehouseFilesRoot(configuredRoot: string, principal: Principal) {
  if (!principal.siteId) throw new AuthorizationError("A verified warehouse is required for managed files.");
  const root = path.resolve(configuredRoot);
  return principal.siteId === "warehouse-initial" ? root : path.join(root, ".temco-sites", createHash("sha256").update(principal.siteId).digest("hex"));
}
