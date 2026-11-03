import type { Prisma } from "@prisma/client";
import { AuthorizationError } from "./principal";

// Hold the actor's access row through the write. An administrator deactivated
// or demoted while password hashing/body processing was in progress cannot
// finish a privileged write using an earlier page/route guard.
export async function lockCurrentAdmin(tx: Prisma.TransactionClient, userId: string, authVersion: number) {
  const current = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User"
    WHERE id = ${userId} AND "authVersion" = ${authVersion}
      AND "isActive" = true AND "isPlatformAdmin" = true
    FOR SHARE
  `;
  if (!current.length) throw new AuthorizationError("Your access changed. Sign in again before continuing.");
}
