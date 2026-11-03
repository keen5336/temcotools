import type { Prisma } from "@prisma/client";
import { IdentityError } from "./passwords";

/** Lock administrator identities before removing a usable recovery factor. */
export async function assertCanRemoveRecoveryFactor(tx: Prisma.TransactionClient, targetUserId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE "isPlatformAdmin"=true AND "isActive"=true ORDER BY id FOR UPDATE`;
  const administrators = await tx.user.findMany({ where: { isPlatformAdmin: true, isActive: true, passwordHash: { not: null } }, select: {
    id: true, mfa: { select: { enabledAt: true } }, roleBundles: { select: { bundle: { select: { capabilities: true } } } },
  } });
  const usable = administrators.filter(user => user.mfa?.enabledAt);
  if (usable.some(user => user.id === targetUserId) && !usable.some(user => user.id !== targetUserId)) {
    throw new IdentityError("Keep another enrolled active system administrator with user-management access and a working authenticator before resetting or disabling this administrator's factor. Owner-assisted offline recovery is a separate maintenance procedure.", 409);
  }
}
