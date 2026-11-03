import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";

export const identityGapInput = z.object({ afterId: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export async function listWarehouseIdentityGaps(p: Principal, raw: unknown = {}) {
  const input = identityGapInput.parse(raw);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, p, "inventory.read");
    const rows = await tx.inventoryAuditItem.findMany({ where: { unitId: null, ...(input.afterId ? { id: { gt: input.afterId } } : {}) }, select: { id: true, lpn: true, description: true, status: true, orderNumber: true, sourceChangedAt: true }, orderBy: { id: "asc" }, take: input.limit + 1 });
    return { items: rows.slice(0, input.limit), nextAfterId: rows.length > input.limit ? rows[input.limit - 1].id : null, reason: "This warehouse's report is retained but its physical identity is unconfirmed or conflicts with an existing alias. Use an evidenced identity decision or accepted transfer, then refresh the report. Matching order numbers do not establish identity; another warehouse's private records are not disclosed." };
  });
}
