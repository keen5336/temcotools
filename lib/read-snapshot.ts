import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type SnapshotOptions = { isolationLevel: "RepeatableRead"; timeout?: number; maxWait?: number };
function isReadSerializationConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2010") return false;
  if (error.meta?.code === "40001") return true;
  const adapter = error.meta?.driverAdapterError;
  if (!adapter || typeof adapter !== "object" || !("cause" in adapter)) return false;
  const cause = adapter.cause;
  return Boolean(cause && typeof cause === "object" && "originalCode" in cause && cause.originalCode === "40001");
}

// Only for inspected pure read callbacks: no mutations, audits, external effects
// or command receipts. Authority FOR SHARE locks can meet a session activity
// update after the snapshot was established. Retry the entire read transaction
// at most three times, with fresh current-authority checks each time. Preserve
// original inputs/asOf outside the callback. Never use this for a writer/command.
export async function readSnapshot<T>(read: (tx: Prisma.TransactionClient) => Promise<T>, options: SnapshotOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(read, options); }
    catch (error) {
      if (attempt >= 2 || !isReadSerializationConflict(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
