import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Principal } from "@/lib/auth/principal";

// Local database-only commands commit their result and ordinary audit receipt
// together. External effects have separate ledgers and must never use this.
export async function localCommandReceipt<T>(tx: Prisma.TransactionClient, principal: Principal, action: string, operationId: string, input: unknown, run: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9:_-]{16,150}$/.test(operationId)) throw Object.assign(new Error("A stable operation ID is required."), { status: 400 });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const key = `command.receipt:${hash([principal.userId, principal.siteId ?? null, operationId])}`, fingerprint = hash({ action, input });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  const previous = await tx.identityAudit.findFirst({ where: { actorUserId: principal.userId, siteId: principal.siteId ?? null, action: { in: principal.siteId === "warehouse-initial" ? [key, `command.receipt:${hash([principal.userId, operationId])}`] : [key] } }, select: { reason: true } });
  if (previous) {
    const receipt = JSON.parse(previous.reason || "{}");
    if (receipt.action !== action || receipt.fingerprint !== fingerprint) throw Object.assign(new Error("This operation ID was already used for different work."), { status: 409 });
    return receipt.result as T;
  }
  const result = JSON.parse(JSON.stringify(await run())) as T;
  await tx.identityAudit.create({ data: { action: key, siteId: principal.siteId ?? null, actorUserId: principal.userId, sessionId: principal.sessionId, reason: JSON.stringify({ action, fingerprint, result, grantId: principal.grantId ?? null }) } });
  return result;
}
