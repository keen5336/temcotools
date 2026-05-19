import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import {
  classifyMarsUnit,
  getMarsBucketWhere,
  MARS_BUCKET_LABELS,
  MARS_OPERATIONAL_BUCKETS,
  parseMarsOperationalBucket,
  type MarsOperationalBucket,
} from "../lib/mars/classification";

const MARS_UNIT_MCP_SELECT = {
  id: true,
  requestNumber: true,
  orderNumber: true,
  vendor: true,
  serialNumber: true,
  modelNumber: true,
  vendorRaNumber: true,
  dateRequested: true,
  requestStatus: true,
  returnStatus: true,
  replacementNeeded: true,
  staged: true,
  localStatus: true,
  archivedAt: true,
  archivedReason: true,
  presentInLatestImport: true,
  missingFromLatestImportAt: true,
  lastImportedAt: true,
  lastAuditSeenAt: true,
  lastScannedAt: true,
  updatedAt: true,
} as const satisfies Prisma.MarsUnitSelect;

type MarsUnitMcpRecord = Prisma.MarsUnitGetPayload<{
  select: typeof MARS_UNIT_MCP_SELECT;
}>;

const BucketSchema = z.enum(MARS_OPERATIONAL_BUCKETS);

const prisma = createPrismaClient();

const server = new McpServer({
  name: "temcotools-mars",
  version: "0.1.0",
});

server.registerTool(
  "mars_workflow_summary",
  {
    title: "MARS workflow summary",
    description: "Return counts for the MARS operational workflow buckets.",
    inputSchema: {},
  },
  async () => {
    const summary = await getWorkflowSummary();
    return jsonResult(summary);
  }
);

server.registerTool(
  "mars_search_units",
  {
    title: "Search MARS units",
    description:
      "Search MARS units by request, order, serial, vendor, model, or vendor RA. Optional bucket filtering uses Temco workflow buckets.",
    inputSchema: {
      query: z.string().optional().describe("Free-text search value."),
      bucket: BucketSchema.optional().describe("Optional workflow bucket."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum rows to return."),
    },
  },
  async ({ query, bucket, limit }) => {
    const units = await searchMarsUnits({
      query,
      bucket,
      limit: limit ?? 25,
    });
    return jsonResult(units);
  }
);

server.registerTool(
  "mars_get_unit",
  {
    title: "Get MARS unit",
    description: "Return one MARS unit by request number with operational classification.",
    inputSchema: {
      requestNumber: z.string().min(1).describe("MARS request number."),
    },
  },
  async ({ requestNumber }) => {
    const unit = await prisma.marsUnit.findUnique({
      where: { requestNumber: requestNumber.trim() },
      select: MARS_UNIT_MCP_SELECT,
    });

    if (!unit) {
      return jsonResult({ found: false, requestNumber });
    }

    return jsonResult({
      found: true,
      unit: toMcpUnit(unit),
    });
  }
);

server.registerTool(
  "mars_problem_units",
  {
    title: "List MARS problem units",
    description:
      "Return units currently classified in the Problems bucket, including problem reasons.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Maximum rows to return."),
    },
  },
  async ({ limit }) => {
    const units = await searchMarsUnits({
      bucket: "problem",
      limit: limit ?? 50,
    });
    return jsonResult(units);
  }
);

server.registerTool(
  "mars_status_rules",
  {
    title: "Explain MARS status rules",
    description: "Explain how raw MARS statuses map into Temco workflow buckets.",
    inputSchema: {},
  },
  async () =>
    jsonResult({
      buckets: MARS_BUCKET_LABELS,
      rules: [
        "RECEIVED -> Received / Archived, not expected in warehouse.",
        "SHIPPED -> Shipped, not expected in warehouse.",
        "Vendor RA containing DENIED -> Denied; this is a vendor workaround for Home Depot removing denied status.",
        "NOT RECEIVED -> Problems; verify pickup proof, BOL, or physical location.",
        "NOT SHIPPED and AWAITING PICKUP -> Awaiting Pickup, expected in warehouse.",
        "ADDED TO PICKUP, RESCHEDULED, MISSED -> Pickup Cycle, expected in warehouse.",
        "REMOVED FROM PICKUP, deleted from latest import, or unmapped statuses -> Problems.",
      ],
      note: "Manual override/resolution tools are not enabled yet; this server is read-only.",
    })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run the TemcoTools MCP server.");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: ["error"],
  });
}

async function getWorkflowSummary() {
  const counts = await Promise.all(
    MARS_OPERATIONAL_BUCKETS.map(async (bucket) => ({
      bucket,
      label: MARS_BUCKET_LABELS[bucket],
      count: await prisma.marsUnit.count({
        where: getMarsBucketWhere(bucket),
      }),
    }))
  );

  const latestImport = await prisma.marsImportBatch.findFirst({
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      uploadedAt: true,
      rowCount: true,
      insertedCount: true,
      updatedCount: true,
      skippedCount: true,
    },
  });

  return {
    latestImport,
    buckets: counts,
  };
}

async function searchMarsUnits(options: {
  query?: string | null;
  bucket?: MarsOperationalBucket | null;
  limit: number;
}) {
  const where: Prisma.MarsUnitWhereInput[] = [];
  const query = options.query?.trim();
  const bucket = options.bucket ? parseMarsOperationalBucket(options.bucket) : null;

  if (bucket) {
    where.push(getMarsBucketWhere(bucket));
  }

  if (query) {
    where.push({
      OR: [
        { requestNumber: { contains: query, mode: "insensitive" } },
        { orderNumber: { contains: query, mode: "insensitive" } },
        { vendor: { contains: query, mode: "insensitive" } },
        { serialNumber: { contains: query, mode: "insensitive" } },
        { modelNumber: { contains: query, mode: "insensitive" } },
        { vendorRaNumber: { contains: query, mode: "insensitive" } },
      ],
    });
  }

  const units = await prisma.marsUnit.findMany({
    where: where.length ? { AND: where } : undefined,
    select: MARS_UNIT_MCP_SELECT,
    orderBy: [{ updatedAt: "desc" }, { requestNumber: "asc" }],
    take: options.limit,
  });

  return {
    count: units.length,
    units: units.map(toMcpUnit),
  };
}

function toMcpUnit(unit: MarsUnitMcpRecord) {
  const classification = classifyMarsUnit(unit);

  return {
    requestNumber: unit.requestNumber,
    orderNumber: unit.orderNumber,
    vendor: unit.vendor,
    serialNumber: unit.serialNumber,
    modelNumber: unit.modelNumber,
    vendorRaNumber: unit.vendorRaNumber,
    dateRequested: unit.dateRequested,
    requestStatus: unit.requestStatus,
    returnStatus: unit.returnStatus,
    replacementNeeded: unit.replacementNeeded,
    staged: unit.staged,
    localStatus: unit.localStatus,
    archivedAt: unit.archivedAt,
    archivedReason: unit.archivedReason,
    presentInLatestImport: unit.presentInLatestImport,
    missingFromLatestImportAt: unit.missingFromLatestImportAt,
    lastImportedAt: unit.lastImportedAt,
    lastAuditSeenAt: unit.lastAuditSeenAt,
    lastScannedAt: unit.lastScannedAt,
    updatedAt: unit.updatedAt,
    operational: classification,
  };
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
