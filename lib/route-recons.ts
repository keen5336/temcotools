import { prisma } from "@/lib/db";
import {
  parsePickWaveWorkbook,
  type PickWaveWorkbookBuffer,
} from "@/lib/pick-waves";

export class RouteReconValidationError extends Error {}

export async function previewRouteRecon(fileBuffer: PickWaveWorkbookBuffer) {
  const parsed = await parsePickWaveWorkbook(fileBuffer);
  const routeCounts = countRoutes(parsed.items);

  return {
    itemCount: parsed.items.length,
    routes: [...routeCounts.values()]
      .sort((a, b) => compareRoutes(a.routeNumber, b.routeNumber)),
    missingColumns: parsed.missingColumns,
  };
}

export async function createRouteRecon(options: {
  name: string;
  filename: string;
  fileBuffer: PickWaveWorkbookBuffer;
  userId: string;
}) {
  const name = options.name.trim();
  if (!name) throw new RouteReconValidationError("A Route Recon name is required.");
  if (name.length > 120) throw new RouteReconValidationError("Route Recon name must be 120 characters or fewer.");

  const parsed = await parsePickWaveWorkbook(options.fileBuffer);
  const routeCount = countRoutes(parsed.items).size;

  return prisma.routeRecon.create({
    data: {
      name,
      sourceFilename: options.filename,
      routeCount,
      createdByUserId: options.userId,
      items: { create: parsed.items },
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      routeCount: true,
      _count: { select: { items: true } },
    },
  });
}

export async function listRouteRecons() {
  return prisma.routeRecon.findMany({
    orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      sourceFilename: true,
      routeCount: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
      createdByUser: { select: { displayName: true } },
      _count: { select: { items: true } },
    },
  });
}

export async function getRouteRecon(id: string) {
  return prisma.routeRecon.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      sourceFilename: true,
      routeCount: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
      createdByUser: { select: { displayName: true } },
      items: {
        orderBy: { rowNumber: "asc" },
        select: {
          id: true,
          rowNumber: true,
          routeNumber: true,
          contact: true,
          orderNumber: true,
          lpn: true,
          serialNumber: true,
          trackingNumber: true,
          partNumber: true,
          description: true,
        },
      },
    },
  });
}

export async function setRouteReconArchived(id: string, archived: boolean) {
  return prisma.routeRecon.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
    select: { id: true, archivedAt: true },
  });
}

function countRoutes(items: Array<{ routeNumber: string | null }>) {
  const routeCounts = new Map<string, { routeNumber: string | null; itemCount: number }>();
  for (const item of items) {
    const routeNumber = item.routeNumber?.trim() || null;
    const key = routeNumber?.toLocaleLowerCase() ?? "__no_route__";
    const current = routeCounts.get(key);
    routeCounts.set(key, {
      routeNumber: current?.routeNumber ?? routeNumber,
      itemCount: (current?.itemCount ?? 0) + 1,
    });
  }
  return routeCounts;
}

function compareRoutes(a: string | null, b: string | null) {
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
}
