import ExcelJS from "exceljs";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PICK_WAVE_STAGING_LOCATIONS } from "@/lib/pick-wave-constants";
import type { Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { resolveDispatchPickItemInTransaction } from "@/lib/dispatch/service";
import { validateRetainedWorkbook } from "@/lib/retained-workbook";
import { localCommandReceipt } from "@/lib/application/command-receipts";

type WorksheetValue = ExcelJS.CellValue | null | undefined;
export type PickWaveWorkbookBuffer = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

export interface PickWaveImportedItem {
  rowNumber: number;
  routeNumber: string | null;
  contact: string | null;
  orderNumber: string | null;
  lpn: string | null;
  serialNumber: string | null;
  trackingNumber: string | null;
  partNumber: string | null;
  description: string | null;
}

export interface PickWaveRouteInput {
  routeNumber: string;
  stagingLocation: string | null;
}

const COLUMN_ALIASES: Record<string, keyof Omit<PickWaveImportedItem, "rowNumber">> = {
  route: "routeNumber", routenumber: "routeNumber", routeno: "routeNumber",
  contact: "contact", contactname: "contact", customer: "contact", customername: "contact",
  order: "orderNumber", ordernumber: "orderNumber", orderno: "orderNumber",
  lpn: "lpn", lpnumber: "lpn", licenseplatenumber: "lpn",
  serial: "serialNumber", serialnumber: "serialNumber", serialno: "serialNumber",
  tracking: "trackingNumber", trackingnumber: "trackingNumber", trackingno: "trackingNumber",
  part: "partNumber", partnumber: "partNumber", partno: "partNumber", sku: "partNumber",
  description: "description", itemdescription: "description", productdescription: "description",
};

export class PickWaveValidationError extends Error {}

export async function parsePickWaveWorkbook(fileBuffer: PickWaveWorkbookBuffer) {
  await validateRetainedWorkbook(fileBuffer);
  const workbook = await loadWorkbook(fileBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.actualRowCount < 2) {
    throw new PickWaveValidationError("The first worksheet must contain a header row and at least one item.");
  }

  const { headerMap, headerRowNumber } = findHeaderRow(worksheet);

  const foundFields = Object.keys(headerMap);
  if (!foundFields.length) {
    throw new PickWaveValidationError("No recognized pick-wave header row was found in the first 25 rows.");
  }
  if (!headerMap.lpn && !headerMap.serialNumber && !headerMap.trackingNumber && !headerMap.orderNumber && !headerMap.partNumber) {
    throw new PickWaveValidationError("The spreadsheet needs at least one scannable column: LPN, Serial Number, Tracking Number, Order Number, or Part Number.");
  }

  const items: PickWaveImportedItem[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const item: PickWaveImportedItem = {
      rowNumber,
      routeNumber: cellText(row, headerMap.routeNumber),
      contact: cellText(row, headerMap.contact),
      orderNumber: cellText(row, headerMap.orderNumber),
      lpn: cellText(row, headerMap.lpn),
      serialNumber: cellText(row, headerMap.serialNumber),
      trackingNumber: cellText(row, headerMap.trackingNumber),
      partNumber: cellText(row, headerMap.partNumber),
      description: cellText(row, headerMap.description),
    };
    if (Object.entries(item).some(([key, value]) => key !== "rowNumber" && value)) items.push(item);
  }
  if (!items.length) throw new PickWaveValidationError("The spreadsheet does not contain any non-empty item rows.");

  const desired = ["routeNumber", "contact", "orderNumber", "lpn", "serialNumber", "trackingNumber", "partNumber", "description"];
  const missingColumns = desired.filter((field) => !headerMap[field as keyof typeof headerMap]);
  return { items, missingColumns };
}

async function loadWorkbook(fileBuffer: PickWaveWorkbookBuffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(fileBuffer);
    return workbook;
  } catch (initialError) {
    // Some warehouse exports use namespace-prefixed OOXML tags (for example x:workbook).
    // They are valid XLSX and open in Excel, but ExcelJS only recognizes unprefixed tag names.
    try {
      const zip = await JSZip.loadAsync(fileBuffer);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || (!entry.name.endsWith(".xml") && !entry.name.endsWith(".psmdcp"))) continue;
        const xml = await entry.async("string");
        if (/<\/?[A-Za-z_][\w.-]*:/.test(xml)) {
          zip.file(entry.name, xml.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, "$1"));
        }
      }
      const compatibleBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const compatibleWorkbook = new ExcelJS.Workbook();
      await compatibleWorkbook.xlsx.load(compatibleBuffer as unknown as PickWaveWorkbookBuffer);
      return compatibleWorkbook;
    } catch {
      throw initialError;
    }
  }
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  let bestHeaderMap: Partial<Record<keyof Omit<PickWaveImportedItem, "rowNumber">, number>> = {};
  let bestHeaderRowNumber = 1;
  for (let rowNumber = 1; rowNumber <= Math.min(worksheet.actualRowCount, 25); rowNumber += 1) {
    const candidate: Partial<Record<keyof Omit<PickWaveImportedItem, "rowNumber">, number>> = {};
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const field = COLUMN_ALIASES[normalizeHeader(cell.value)];
      if (field && !candidate[field]) candidate[field] = columnNumber;
    });
    if (Object.keys(candidate).length > Object.keys(bestHeaderMap).length) {
      bestHeaderMap = candidate;
      bestHeaderRowNumber = rowNumber;
    }
  }
  return { headerMap: bestHeaderMap, headerRowNumber: bestHeaderRowNumber };
}

export async function createPickWave(options: {
  name: string;
  filename: string;
  fileBuffer: PickWaveWorkbookBuffer;
  routeMappings: PickWaveRouteInput[];
  userId: string;
  principal: Principal;
  operationId: string;
}) {
  const name = options.name.trim();
  if (!name) throw new PickWaveValidationError("A pick-wave name is required.");
  if (name.length > 120) throw new PickWaveValidationError("Pick-wave name must be 120 characters or fewer.");
  const parsed = await parsePickWaveWorkbook(options.fileBuffer);
  const routeMappings = normalizeRouteMappings(options.routeMappings);
  const spreadsheetRoutes = [...new Set(parsed.items.map((item) => item.routeNumber).filter((route): route is string => Boolean(route)))];
  const mappedRoutes = new Set(routeMappings.map((mapping) => mapping.routeNumber.toLowerCase()));
  const missingRoutes = spreadsheetRoutes.filter((route) => !mappedRoutes.has(route.toLowerCase()));
  const extraRoutes = routeMappings.filter((mapping) => !spreadsheetRoutes.some((route) => route.toLowerCase() === mapping.routeNumber.toLowerCase()));
  if (missingRoutes.length) throw new PickWaveValidationError(`Choose a staging location or No Location for every route. Missing: ${missingRoutes.join(", ")}.`);
  if (extraRoutes.length) throw new PickWaveValidationError(`These mapped routes are not in the spreadsheet: ${extraRoutes.map((mapping) => mapping.routeNumber).join(", ")}.`);

  const wave = await prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, options.principal, "workflow.execute");
    return localCommandReceipt(tx, options.principal, "pick-waves.import", options.operationId, { name, filename: options.filename, items: parsed.items, routeMappings }, () => tx.pickWave.create({
    data: {
      name,
      sourceFilename: options.filename,
      createdByUserId: options.principal.userId,
      items: { create: parsed.items },
      routeMappings: { create: routeMappings },
    },
    select: { id: true, name: true, createdAt: true, _count: { select: { items: true } } },
  }));
  });
  return { ...wave, missingColumns: parsed.missingColumns };
}

export async function listPickWaves() {
  return prisma.pickWave.findMany({
    orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true, name: true, sourceFilename: true, createdAt: true, updatedAt: true, archivedAt: true,
      createdByUser: { select: { displayName: true } },
      _count: { select: { items: true, scans: true, routeMappings: true } },
      items: { where: { scannedAt: { not: null } }, select: { id: true } },
    },
  });
}

export async function getPickWave(id: string) {
  return prisma.pickWave.findUnique({
    where: { id },
    select: {
      id: true, name: true, sourceFilename: true, createdAt: true, updatedAt: true, archivedAt: true,
      createdByUser: { select: { displayName: true } },
      routeMappings: { orderBy: { routeNumber: "asc" }, select: { routeNumber: true, stagingLocation: true } },
      _count: { select: { scans: true } },
      items: {
        orderBy: { rowNumber: "asc" },
        select: { id: true, rowNumber: true, routeNumber: true, contact: true, orderNumber: true, lpn: true, serialNumber: true, trackingNumber: true, partNumber: true, description: true, scannedAt: true },
      },
      scans: { orderBy: { createdAt: "desc" }, take: 25, select: { id: true, scannedValue: true, matched: true, alreadyScanned: true, createdAt: true } },
    },
  });
}

export async function setPickWaveArchived(id: string, archived: boolean, principal: Principal) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "workflow.execute");
    return tx.pickWave.update({ where: { id }, data: { archivedAt: archived ? new Date() : null }, select: { id: true, archivedAt: true } });
  });
}

export async function savePickWaveScansToList(id: string, userId: string, principal: Principal) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "workflow.execute");
    if (userId !== principal.userId) throw new PickWaveValidationError("Individual scan-list attribution must match the current person.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pick-wave:${id}`}, 0))`;
    const wave = await tx.pickWave.findUnique({ where: { id }, select: { name: true, scans: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, scannedValue: true, createdAt: true, scannedByUserId: true } } } });
    if (!wave) throw new PickWaveValidationError("Pick wave not found.");
    if (!wave.scans.length) throw new PickWaveValidationError("This pick wave has no scans to save.");
    const snapshot = createHash("sha256").update(JSON.stringify(wave.scans.map(scan => scan.id))).digest("hex");
    const localDraftId = `pick-wave:${id}:${snapshot}`;
    const list = await tx.scanListSession.upsert({ where: { localDraftId }, update: {}, create: {
      localDraftId, name: `Pick wave: ${wave.name}`.slice(0, 120), createdByUserId: principal.userId,
      createdAt: wave.scans[0].createdAt, closedAt: new Date(),
      items: { create: wave.scans.map(scan => ({ scannedValue: scan.scannedValue, createdAt: scan.createdAt, scannedByUserId: scan.scannedByUserId })) },
    }, select: { id: true, name: true, _count: { select: { items: true } } } });
    return { id: list.id, name: list.name, scanCount: list._count.items };
  });
}

export async function replacePickWaveRoutes(id: string, inputs: PickWaveRouteInput[], principal: Principal) {
  const routeMappings = normalizeRouteMappings(inputs);
  const itemRoutes = await prisma.pickWaveItem.findMany({ where: { pickWaveId: id, routeNumber: { not: null } }, distinct: ["routeNumber"], select: { routeNumber: true } });
  const spreadsheetRoutes = itemRoutes.map((item) => item.routeNumber).filter((route): route is string => Boolean(route));
  const mappedRoutes = new Set(routeMappings.map((mapping) => mapping.routeNumber.toLowerCase()));
  const missingRoutes = spreadsheetRoutes.filter((route) => !mappedRoutes.has(route.toLowerCase()));
  const extraRoutes = routeMappings.filter((mapping) => !spreadsheetRoutes.some((route) => route.toLowerCase() === mapping.routeNumber.toLowerCase()));
  if (missingRoutes.length) throw new PickWaveValidationError(`Choose a staging location or No Location for every route. Missing: ${missingRoutes.join(", ")}.`);
  if (extraRoutes.length) throw new PickWaveValidationError(`These mapped routes are not in the spreadsheet: ${extraRoutes.map((mapping) => mapping.routeNumber).join(", ")}.`);
  await prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "workflow.execute");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pick-wave:${id}`}, 0))`;
    if (await tx.dispatchWaveItem.findFirst({where:{pickWaveId:id},select:{id:true}})) throw new PickWaveValidationError("Amend dispatch demand rather than changing a bound wave's lane instructions independently.");
    await tx.pickWaveRouteMapping.deleteMany({ where: { pickWaveId: id } });
    await tx.pickWaveRouteMapping.createMany({ data: routeMappings.map(mapping => ({ pickWaveId: id, ...mapping })) });
  });
  return routeMappings;
}

export async function scanPickWave(options: { id: string; scannedValue: string; userId: string; eventId?: string; principal: Principal }) {
  const scannedValue = options.scannedValue.trim();
  if (!scannedValue) throw new PickWaveValidationError("Scan a barcode value first.");
  if (scannedValue.length > 500) throw new PickWaveValidationError("The scanned value is too long.");

  return prisma.$transaction(async (tx) => {
    await assertCurrentPrincipal(tx, options.principal, "workflow.execute");
    if (options.userId !== options.principal.userId) throw new PickWaveValidationError("Scan attribution must match the current person.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pick-wave:${options.id}`}, 0))`;
    const captureEventId = options.eventId ? `${options.userId}:${options.eventId}` : null;
    if (captureEventId) {
      const previous = await tx.pickWaveScan.findUnique({ where: { captureEventId } });
      if (previous) {
        if (previous.pickWaveId !== options.id || previous.scannedValue !== scannedValue) throw new PickWaveValidationError("This scan event was already used for different work.");
        if (previous.captureResult) return { ...(previous.captureResult as object), replayed: true } as PickWaveScanResult;
      }
    }
    const wave = await tx.pickWave.findUnique({ where: { id: options.id }, select: { id: true, archivedAt: true } });
    if (!wave) throw new PickWaveValidationError("Pick wave not found.");
    if (wave.archivedAt) throw new PickWaveValidationError("Archived pick waves cannot be scanned.");

    const identifierWhere: Prisma.PickWaveItemWhereInput = {
      pickWaveId: options.id,
      OR: ["lpn", "serialNumber", "trackingNumber", "orderNumber", "partNumber"].map((field) => ({
        [field]: { equals: scannedValue, mode: "insensitive" },
      })),
    };
    const binding = await resolveDispatchPickItemInTransaction(tx, { pickWaveId: options.id, rawIdentifier: scannedValue });
    const candidates = binding.boundWave
      ? binding.itemId ? await tx.pickWaveItem.findMany({ where: { id: binding.itemId, pickWaveId: options.id } }) : []
      : await tx.pickWaveItem.findMany({ where: identifierWhere, orderBy: { rowNumber: "asc" } });
    // An order or part shared by several rows is context, not a unique unit.
    // Preserve the scan and ask for the unit barcode instead of choosing first.
    const ambiguous = binding.ambiguous || candidates.length > 1;
    const item = ambiguous ? null : candidates[0] ?? null;
    const alreadyScanned = Boolean(item?.scannedAt);
    if (item && !alreadyScanned) {
      await tx.pickWaveItem.update({ where: { id: item.id }, data: { scannedAt: new Date() } });
    }
    const mapping = item?.routeNumber ? await tx.pickWaveRouteMapping.findFirst({ where: { pickWaveId: options.id, routeNumber: { equals: item.routeNumber, mode: "insensitive" } }, select: { stagingLocation: true } }) : null;
    const result = { matched: Boolean(item), alreadyScanned, item: item ? { ...item, scannedAt: item.scannedAt ?? new Date() } : null, unitId: binding.unitId, stagingLocation: mapping?.stagingLocation ?? null, ambiguous, replayed: false, ...(binding.boundWave && !item ? { error: binding.reason } : {}) };
    await tx.pickWaveScan.create({
      data: { pickWaveId: options.id, itemId: item?.id, scannedValue, matched: Boolean(item), alreadyScanned, scannedByUserId: options.userId, captureEventId, captureResult: captureEventId ? JSON.parse(JSON.stringify(result)) : undefined },
    });
    return result;
  });
}

type PickWaveScanResult = {
  matched: boolean; alreadyScanned: boolean;
  item: (Prisma.PickWaveItemGetPayload<object> & { scannedAt: Date | string | null }) | null;
  stagingLocation: string | null; ambiguous: boolean; replayed: boolean;
};

function normalizeRouteMappings(inputs: PickWaveRouteInput[]) {
  const unique = new Map<string, PickWaveRouteInput>();
  const usedLocations = new Set<string>();
  for (const input of inputs) {
    const routeNumber = input.routeNumber.trim();
    const stagingLocation = input.stagingLocation?.trim() || null;
    if (!routeNumber) throw new PickWaveValidationError("Each route mapping needs a route number.");
    if (stagingLocation && !PICK_WAVE_STAGING_LOCATIONS.includes(stagingLocation)) throw new PickWaveValidationError(`“${stagingLocation}” is not a valid staging location.`);
    const routeKey = routeNumber.toLowerCase();
    if (unique.has(routeKey)) throw new PickWaveValidationError(`Route “${routeNumber}” was assigned more than once.`);
    const locationKey = stagingLocation?.toLowerCase();
    if (locationKey && usedLocations.has(locationKey)) throw new PickWaveValidationError(`Staging location “${stagingLocation}” was assigned more than once.`);
    unique.set(routeKey, { routeNumber, stagingLocation });
    if (locationKey) usedLocations.add(locationKey);
  }
  return [...unique.values()];
}

function normalizeHeader(value: WorksheetValue) {
  return extractText(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
}

function cellText(row: ExcelJS.Row, columnNumber?: number) {
  if (!columnNumber) return null;
  const raw = extractText(row.getCell(columnNumber).value)?.trim().replace(/\s+/g, " ") ?? "";
  return raw && !["n/a", "na", "null"].includes(raw.toLowerCase()) ? raw : null;
}

function extractText(value: WorksheetValue): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return extractText(value.result);
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part: { text: string }) => part.text).join("");
  }
  return null;
}
