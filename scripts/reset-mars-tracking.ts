import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: ["error"],
  });

  try {
    const countsBefore = await getCounts(prisma);

    await prisma.$transaction(async (tx) => {
      await tx.marsAuditScan.deleteMany({});
      await tx.marsAuditSession.deleteMany({});
      await tx.marsEvent.deleteMany({});
      await tx.marsUnit.deleteMany({});
      await tx.marsImportBatch.deleteMany({});
    });

    const countsAfter = await getCounts(prisma);

    const deleted = {
      auditScans: countsBefore.auditScans - countsAfter.auditScans,
      auditSessions: countsBefore.auditSessions - countsAfter.auditSessions,
      marsEvents: countsBefore.marsEvents - countsAfter.marsEvents,
      marsUnits: countsBefore.marsUnits - countsAfter.marsUnits,
      importBatches: countsBefore.importBatches - countsAfter.importBatches,
    };

    console.log(JSON.stringify({ countsBefore, deleted, countsAfter }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function getCounts(prisma: PrismaClient) {
  const [auditScans, auditSessions, marsEvents, marsUnits, importBatches] = await Promise.all([
    prisma.marsAuditScan.count(),
    prisma.marsAuditSession.count(),
    prisma.marsEvent.count(),
    prisma.marsUnit.count(),
    prisma.marsImportBatch.count(),
  ]);

  return {
    auditScans,
    auditSessions,
    marsEvents,
    marsUnits,
    importBatches,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
