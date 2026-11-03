import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createScopedClient } from "./scoped-client";

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const base = globalForPrisma.prisma ?? createPrismaClient();
// Metadata authentication queries are global. Operational delegates and all raw
// SQL use short, context-bound transactions; effects are never wrapped across IO.
export const prisma = createScopedClient(base, async () => {
  const { requestSiteContext } = await import("@/lib/sites/request-context");
  return requestSiteContext(base);
});

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = base;
