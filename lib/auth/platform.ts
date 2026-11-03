import { redirect } from "next/navigation";
import { getSession } from "./index";
import { assertCapability, AuthorizationError, type Principal } from "./principal";
import type { Prisma } from "@prisma/client";
import { assertCurrentPrincipal } from "./identity";

export async function requirePlatformAdmin() {
  const session = await getSession();
  if (!session.userId) redirect("/signin");
  if (!session.isPlatformAdmin) redirect("/?error=permission");
  return session;
}
export async function assertCurrentPlatformAdmin(tx: Prisma.TransactionClient, principal: Principal, recent = false) {
  const current = await assertCurrentPrincipal(tx, principal, "platform.manage", recent);
  assertCapability(current, "platform.manage");
  if (!current.isPlatformAdmin) throw new AuthorizationError("Platform administrator access is required.");
  return current;
}
