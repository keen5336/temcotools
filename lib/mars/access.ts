import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { assertCapability, AuthorizationError, type Principal } from "@/lib/auth/principal";

export type MarsDatabase = Prisma.TransactionClient | typeof prisma;
export class MarsWorkflowError extends Error { constructor(message: string, readonly status = 400) { super(message); this.name = "MarsWorkflowError"; } }
export type MarsWriter = { principal: Principal; transaction?: Prisma.TransactionClient };
export async function writeMars<T>(options: MarsWriter, handler: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!options.principal) throw new AuthorizationError("A current individual session is required.");
  assertCapability(options.principal, "workflow.execute");
  const execute = async (tx: Prisma.TransactionClient) => { await assertCurrentPrincipal(tx, options.principal, "workflow.execute"); return handler(tx); };
  return options.transaction ? execute(options.transaction) : prisma.$transaction(execute, { timeout: 60_000 });
}
