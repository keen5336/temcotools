import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type WorksheetValue = ExcelJS.CellValue | null | undefined;
export type WorkbookInputBuffer = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

const COLUMN_ALIASES: Record<string, keyof MarsImportedFields> = {
  requestnumber: "requestNumber",
  order: "orderNumber",
  ordernumber: "orderNumber",
  vendor: "vendor",
  serial: "serialNumber",
  serialnumber: "serialNumber",
  model: "modelNumber",
  modelnumber: "modelNumber",
  vendorra: "vendorRaNumber",
  vendorranumber: "vendorRaNumber",
  daterequested: "dateRequested",
  requeststatus: "requestStatus",
  returnstatus: "returnStatus",
  replacementneeded: "replacementNeeded",
};

const IMPORTED_FIELD_KEYS = [
  "orderNumber",
  "vendor",
  "serialNumber",
  "modelNumber",
  "vendorRaNumber",
  "dateRequested",
  "requestStatus",
  "returnStatus",
  "replacementNeeded",
] as const;

type ImportedFieldKey = (typeof IMPORTED_FIELD_KEYS)[number];

const MARS_UNIT_IMPORT_SELECT = {
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
  localStatus: true,
} as const satisfies Prisma.MarsUnitSelect;

export interface MarsImportedFields {
  requestNumber: string;
  orderNumber: string | null;
  vendor: string | null;
  serialNumber: string | null;
  modelNumber: string | null;
  vendorRaNumber: string | null;
  dateRequested: Date | null;
  requestStatus: string | null;
  returnStatus: string | null;
  replacementNeeded: string | null;
}

interface ParsedMarsRow extends MarsImportedFields {
  rowNumber: number;
}

type ExistingMarsUnitRecord = Prisma.MarsUnitGetPayload<{
  select: typeof MARS_UNIT_IMPORT_SELECT;
}>;

type MarsImportTransaction = Prisma.TransactionClient;

type MarsUnitImportData = {
  orderNumber: string | null;
  vendor: string | null;
  serialNumber: string | null;
  modelNumber: string | null;
  vendorRaNumber: string | null;
  dateRequested: Date | null;
  requestStatus: string | null;
  returnStatus: string | null;
  replacementNeeded: string | null;
  localStatus: string;
  presentInLatestImport: boolean;
  missingFromLatestImportAt: Date | null;
  lastImportedAt: Date;
  lastKnownImportBatchId: string;
};

export interface MarsImportSummary {
  ok: true;
  batchId: string;
  filename: string;
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  warnings: string[];
}

interface ParsedWorksheet {
  rowCount: number;
  skippedCount: number;
  warnings: string[];
  rows: ParsedMarsRow[];
}

interface ImportWorkbookOptions {
  filename: string;
  fileBuffer: WorkbookInputBuffer;
  uploadedByUserId?: string | null;
}

export class MarsImportValidationError extends Error {}

export async function importMarsWorkbook({
  filename,
  fileBuffer,
  uploadedByUserId,
}: ImportWorkbookOptions): Promise<MarsImportSummary> {
  const parsed = await parseMarsWorkbook(fileBuffer);
  const importedAt = new Date();

  return prisma.$transaction(async (tx: MarsImportTransaction): Promise<MarsImportSummary> => {
    const batch = await tx.marsImportBatch.create({
      data: {
        filename,
        uploadedByUserId: uploadedByUserId ?? null,
        rowCount: parsed.rowCount,
        skippedCount: parsed.skippedCount,
        notes: parsed.warnings.length ? parsed.warnings.join("\n").slice(0, 4000) : null,
      },
    });

    const existingUnits = parsed.rows.length
      ? await tx.marsUnit.findMany({
          select: MARS_UNIT_IMPORT_SELECT,
          where: {
            requestNumber: {
              in: parsed.rows.map((row) => row.requestNumber),
            },
          },
        })
      : [];

    const existingByRequestNumber = new Map<string, ExistingMarsUnitRecord>(
      existingUnits.map((unit) => [unit.requestNumber, unit] as const)
    );

    let insertedCount = 0;
    let updatedCount = 0;
    const importedRequestNumbers = new Set(parsed.rows.map((row) => row.requestNumber));

    for (const row of parsed.rows) {
      const importData = buildMarsUnitImportData(row, importedAt, batch.id);
      const existing = existingByRequestNumber.get(row.requestNumber);

      if (!existing) {
        const created = await tx.marsUnit.create({
          select: MARS_UNIT_IMPORT_SELECT,
          data: {
            ...importData,
            requestNumber: row.requestNumber,
          },
        });
        insertedCount += 1;

        await tx.marsEvent.create({
          data: {
            marsUnitId: created.id,
            type: "imported",
            userId: uploadedByUserId ?? null,
            payload: buildImportEventPayload(batch.id, "inserted", row),
          },
        });

        existingByRequestNumber.set(created.requestNumber, created);
        continue;
      }

      const meaningfullyChanged = hasMeaningfulImportedChanges(existing, row);
      const restoredFromDeleted = existing.localStatus === "deleted";

      await tx.marsUnit.update({
        where: { id: existing.id },
        data: {
          ...importData,
          ...(restoredFromDeleted
            ? {
                archivedAt: null,
                archivedReason: null,
              }
            : {}),
        },
      });

      if (meaningfullyChanged || restoredFromDeleted) {
        updatedCount += 1;

        await tx.marsEvent.create({
          data: {
            marsUnitId: existing.id,
            type: "imported",
            userId: uploadedByUserId ?? null,
            payload: buildImportEventPayload(
              batch.id,
              restoredFromDeleted ? "restored" : "updated",
              row
            ),
          },
        });
      }

      existingByRequestNumber.set(existing.requestNumber, {
        id: existing.id,
        requestNumber: existing.requestNumber,
        orderNumber: importData.orderNumber,
        vendor: importData.vendor,
        serialNumber: importData.serialNumber,
        modelNumber: importData.modelNumber,
        vendorRaNumber: importData.vendorRaNumber,
        dateRequested: importData.dateRequested,
        requestStatus: importData.requestStatus,
        returnStatus: importData.returnStatus,
        replacementNeeded: importData.replacementNeeded,
        localStatus: importData.localStatus,
      });
    }

    const unitsMissingFromLatestImport = await tx.marsUnit.findMany({
      where: {
        presentInLatestImport: true,
        requestNumber: {
          notIn: Array.from(importedRequestNumbers),
        },
      },
      select: {
        id: true,
        requestNumber: true,
      },
    });

    if (unitsMissingFromLatestImport.length) {
      await tx.marsUnit.updateMany({
        where: {
          id: {
            in: unitsMissingFromLatestImport.map((unit) => unit.id),
          },
        },
        data: {
          presentInLatestImport: false,
          missingFromLatestImportAt: importedAt,
          localStatus: "deleted",
          archivedAt: importedAt,
          archivedReason: "Deleted from MARS.",
        },
      });

      await tx.marsEvent.createMany({
        data: unitsMissingFromLatestImport.map((unit) => ({
          marsUnitId: unit.id,
          type: "deleted_from_mars",
          userId: uploadedByUserId ?? null,
          payload: {
            batchId: batch.id,
            requestNumber: unit.requestNumber,
            deletedAt: importedAt.toISOString(),
            archivedAt: importedAt.toISOString(),
          },
        })),
      });
    }

    await tx.marsImportBatch.update({
      where: { id: batch.id },
      data: {
        insertedCount,
        updatedCount,
      },
    });

    return {
      ok: true,
      batchId: batch.id,
      filename,
      rowCount: parsed.rowCount,
      insertedCount,
      updatedCount,
      skippedCount: parsed.skippedCount,
      warnings: parsed.warnings,
    };
  });
}

export async function parseMarsWorkbook(fileBuffer: WorkbookInputBuffer): Promise<ParsedWorksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new MarsImportValidationError("The uploaded workbook does not contain any worksheets.");
  }

  if (worksheet.actualRowCount < 1) {
    throw new MarsImportValidationError("The first worksheet is empty.");
  }

  const headerMap = buildHeaderMap(worksheet.getRow(1));
  if (!headerMap.requestNumber) {
    throw new MarsImportValidationError(
      "The first worksheet is missing the Request Number column."
    );
  }

  const warnings: string[] = [];
  const dedupedRows = new Map<string, ParsedMarsRow>();
  let rowCount = 0;
  let skippedCount = 0;

  for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    rowCount += 1;

    const normalized = normalizeWorksheetRow(row, rowNumber, headerMap);
    if (!normalized.requestNumber) {
      skippedCount += 1;
      continue;
    }

    if (dedupedRows.has(normalized.requestNumber)) {
      warnings.push(
        `Duplicate Request Number "${normalized.requestNumber}" encountered on row ${rowNumber}; using the last occurrence.`
      );
    }

    dedupedRows.set(normalized.requestNumber, normalized as ParsedMarsRow);
  }

  return {
    rowCount,
    skippedCount,
    warnings,
    rows: Array.from(dedupedRows.values()),
  };
}

function buildHeaderMap(row: ExcelJS.Row): Partial<Record<keyof MarsImportedFields, number>> {
  const headerMap: Partial<Record<keyof MarsImportedFields, number>> = {};

  row.eachCell({ includeEmpty: true }, (cell: ExcelJS.Cell, columnNumber: number) => {
    const normalized = normalizeHeaderKey(cell.value);
    const mappedField = COLUMN_ALIASES[normalized];
    if (mappedField && !headerMap[mappedField]) {
      headerMap[mappedField] = columnNumber;
    }
  });

  return headerMap;
}

function normalizeWorksheetRow(
  row: ExcelJS.Row,
  rowNumber: number,
  headerMap: Partial<Record<keyof MarsImportedFields, number>>
): ParsedMarsRow | { requestNumber: null } {
  return {
    rowNumber,
    requestNumber:
      normalizeRequiredString(getCellValue(row, headerMap.requestNumber)) ?? null,
    orderNumber: normalizeOptionalString(getCellValue(row, headerMap.orderNumber)),
    vendor: normalizeOptionalString(getCellValue(row, headerMap.vendor)),
    serialNumber: normalizeOptionalString(getCellValue(row, headerMap.serialNumber)),
    modelNumber: normalizeOptionalString(getCellValue(row, headerMap.modelNumber)),
    vendorRaNumber: normalizeOptionalString(getCellValue(row, headerMap.vendorRaNumber)),
    dateRequested: coerceDateValue(getCellValue(row, headerMap.dateRequested)),
    requestStatus: normalizeOptionalString(getCellValue(row, headerMap.requestStatus)),
    returnStatus: normalizeOptionalString(getCellValue(row, headerMap.returnStatus)),
    replacementNeeded: normalizeOptionalString(getCellValue(row, headerMap.replacementNeeded)),
  };
}

function getCellValue(row: ExcelJS.Row, columnNumber?: number): WorksheetValue {
  if (!columnNumber) return null;
  return row.getCell(columnNumber).value;
}

function normalizeHeaderKey(value: WorksheetValue): string {
  return normalizeOptionalString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
}

function normalizeRequiredString(value: WorksheetValue): string | null {
  return normalizeOptionalString(value);
}

function normalizeOptionalString(value: WorksheetValue): string | null {
  const extracted = extractCellString(value);
  if (!extracted) return null;

  const trimmed = extracted.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  if (lowered === "n/a" || lowered === "na" || lowered === "null") {
    return null;
  }

  return trimmed;
}

function extractCellString(value: WorksheetValue): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return typeof value.text === "string" ? value.text : value.hyperlink;
    }
    if ("result" in value) return extractCellString(value.result);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part: { text: string }) => part.text).join("");
    }
  }

  return null;
}

function coerceDateValue(value: WorksheetValue): Date | null {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number") {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const date = new Date(excelEpoch + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildMarsUnitImportData(
  row: MarsImportedFields,
  importedAt: Date,
  batchId: string
): MarsUnitImportData {
  return {
    orderNumber: row.orderNumber,
    vendor: row.vendor,
    serialNumber: row.serialNumber,
    modelNumber: row.modelNumber,
    vendorRaNumber: row.vendorRaNumber,
    dateRequested: row.dateRequested,
    requestStatus: row.requestStatus,
    returnStatus: row.returnStatus,
    replacementNeeded: row.replacementNeeded,
    localStatus: "active",
    presentInLatestImport: true,
    missingFromLatestImportAt: null,
    lastImportedAt: importedAt,
    lastKnownImportBatchId: batchId,
  };
}

function hasMeaningfulImportedChanges(
  existing: ExistingMarsUnitRecord,
  incoming: MarsImportedFields
): boolean {
  return IMPORTED_FIELD_KEYS.some((key) => !areImportedValuesEqual(existing[key], incoming[key]));
}

function areImportedValuesEqual(
  left: ExistingMarsUnitRecord[ImportedFieldKey],
  right: MarsImportedFields[ImportedFieldKey]
): boolean {
  if (left instanceof Date || right instanceof Date) {
    const leftTime = left instanceof Date ? left.getTime() : null;
    const rightTime = right instanceof Date ? right.getTime() : null;
    return leftTime === rightTime;
  }

  return left === right;
}

function buildImportEventPayload(
  batchId: string,
  action: "inserted" | "updated" | "restored",
  row: ParsedMarsRow
) {
  return {
    batchId,
    action,
    rowNumber: row.rowNumber,
    imported: {
      requestNumber: row.requestNumber,
      orderNumber: row.orderNumber,
      vendor: row.vendor,
      serialNumber: row.serialNumber,
      modelNumber: row.modelNumber,
      vendorRaNumber: row.vendorRaNumber,
      dateRequested: row.dateRequested?.toISOString() ?? null,
      requestStatus: row.requestStatus,
      returnStatus: row.returnStatus,
      replacementNeeded: row.replacementNeeded,
    },
  };
}
