import { prisma } from "@/lib/db";

export function normalizeScannedValue(value: string) {
  return value.trim();
}

export async function listScanLists() {
  return prisma.scanListSession.findMany({
    orderBy: [{ archivedAt: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      archivedAt: true,
      createdByUser: { select: { displayName: true } },
      _count: { select: { items: true } },
    },
  });
}

export async function getScanList(id: string) {
  return prisma.scanListSession.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      archivedAt: true,
      createdByUser: { select: { displayName: true } },
      items: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, scannedValue: true, createdAt: true },
      },
    },
  });
}

export async function saveScanList(options: {
  localDraftId: string;
  name: string;
  createdAt: string;
  scans: Array<{ value: string; scannedAt: string }>;
  userId: string;
}) {
  const normalizedName = options.name.trim();
  if (!normalizedName) throw new Error("A list name is required.");
  if (normalizedName.length > 120) throw new Error("List name must be 120 characters or fewer.");
  if (!options.localDraftId.trim()) throw new Error("A local draft ID is required.");
  if (!options.scans.length) throw new Error("At least one scan is required.");

  const existing = await prisma.scanListSession.findUnique({
    where: { localDraftId: options.localDraftId },
    select: { id: true, name: true, createdAt: true },
  });
  if (existing) return existing;

  const createdAt = parseDate(options.createdAt, "Invalid session start time.");
  const scans = options.scans.map((scan) => {
    const scannedValue = normalizeScannedValue(scan.value);
    if (!scannedValue) throw new Error("Scanned values cannot be empty.");
    if (scannedValue.length > 500) throw new Error("Scanned value must be 500 characters or fewer.");
    return {
      scannedValue,
      createdAt: parseDate(scan.scannedAt, "Invalid scan time."),
      scannedByUserId: options.userId,
    };
  });

  return prisma.scanListSession.create({
    data: {
      localDraftId: options.localDraftId,
      name: normalizedName,
      createdByUserId: options.userId,
      createdAt,
      closedAt: new Date(),
      items: { create: scans },
    },
    select: { id: true, name: true, createdAt: true },
  });
}

export async function setScanListArchived(id: string, archived: boolean) {
  return prisma.scanListSession.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
    select: { id: true, archivedAt: true },
  });
}

export async function deleteScanList(id: string) {
  return prisma.scanListSession.delete({ where: { id }, select: { id: true } });
}

export function scanListToCsv(
  session: NonNullable<Awaited<ReturnType<typeof getScanList>>>
) {
  const rows = [
    ["List Name", "Scanned Value", "Scanned At"],
    ...[...session.items].reverse().map((item) => [
      session.name,
      item.scannedValue,
      item.createdAt.toISOString(),
    ]),
  ];

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n") + "\r\n";
}

function escapeCsvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseDate(value: string, message: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(message);
  return date;
}
