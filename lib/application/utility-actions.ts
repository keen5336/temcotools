import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import bwipjs from "bwip-js/node";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Capability, Principal } from "@/lib/auth/principal";
import { barcodeOptions, barcodeValues } from "@/lib/barcodes";
import { executePipeline } from "@/lib/pipeline/executePipeline";
import { decodeRetainedWorkbookBase64, validateRetainedWorkbook } from "@/lib/retained-workbook";
import { emptyLabelFields, parseFields, renderTemplate } from "@/app/tools/rtv-label/marsLabelShared";
import { buildPayloadBookmarklet } from "@/lib/payloads/model";

const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const column = z.string().min(1).max(200).refine(value => !["__proto__", "prototype", "constructor"].includes(value), "Reserved field name.");
const row = z.record(column, scalar).refine(value => Object.keys(value).length <= 250, "Use up to 250 columns.");
const rows = z.array(row).max(20_000);
const step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("filter"), column, operator: z.enum(["eq", "neq", "contains", "notcontains", "gt", "lt", "gte", "lte", "isempty", "notempty"]), value: z.string().max(4000) }),
  z.object({ type: z.literal("map"), from: column, to: column.nullable() }),
  z.object({ type: z.literal("sort"), column, direction: z.enum(["asc", "desc"]) }),
  z.object({ type: z.literal("join"), rightData: rows, on: column, prefix: z.string().max(100).refine(value => !value.includes("__proto__"), "Reserved prefix.") }),
]);
const pipelineSchema = z.object({ rows, steps: z.array(step).max(50) });
const importSchema = z.object({ contentBase64: z.string(), format: z.enum(["xlsx", "csv"]) });
const barcodeSchema = z.object({ values: z.string().max(100_000) });
const rtvFieldsSchema = z.object(Object.fromEntries(Object.keys(emptyLabelFields()).map(key => [key, z.string().max(2000).default("")])));
async function authority(principal: Principal, capability: Capability) { return prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, capability)); }
export async function runLegacyPipeline(principal: Principal, input: unknown) {
  await authority(principal, "workflow.read"); const data = pipelineSchema.parse(input);
  return { rows: executePipeline(data.rows, data.steps), limitation: "Retained legacy transform semantics. A join keeps the last right-hand row per key; never use this to merge physical units or establish dispatch demand." };
}
export async function importLegacyReport(principal: Principal, input: unknown) {
  await authority(principal, "workflow.read"); const data = importSchema.parse(input), bytes = decodeRetainedWorkbookBase64(data.contentBase64);
  const workbook = new ExcelJS.Workbook();
  if (data.format === "xlsx") { await validateRetainedWorkbook(bytes); await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  else await workbook.csv.read(Readable.from([bytes]));
  const sheet = workbook.worksheets[0]; if (!sheet) throw Object.assign(new Error("No worksheet found."), { status: 400 });
  if (sheet.rowCount > 20_001 || sheet.columnCount > 250) throw Object.assign(new Error("Report exceeds 20,000 rows or 250 columns."), { status: 413 });
  const cell = (value: ExcelJS.CellValue): z.infer<typeof scalar> => value == null ? null : value instanceof Date ? value.toISOString() : typeof value === "object" ? "result" in value ? cell(value.result ?? null) : "richText" in value ? value.richText.map(part => part.text).join("") : "text" in value ? value.text : String(value) : value;
  const headers: string[] = []; sheet.getRow(1).eachCell({ includeEmpty: true }, (value, index) => { headers[index - 1] = column.parse(String(cell(value.value) ?? `Column ${index}`)); });
  if (new Set(headers).size !== headers.length) throw Object.assign(new Error("Use distinct column headers."), { status: 400 });
  const output: z.infer<typeof rows> = [];
  for (let index = 2; index <= sheet.rowCount; index++) if (sheet.getRow(index).hasValues) output.push(row.parse(Object.fromEntries(headers.map((header, offset) => [header, cell(sheet.getRow(index).getCell(offset + 1).value)]))));
  return { rows: output, sheet: sheet.name, limitation: "Report data only; importing here does not refresh shared warehouse inventory." };
}
export async function exportLegacyReport(principal: Principal, input: unknown) {
  const result = await runLegacyPipeline(principal, input), workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Report");
  const headers = [...new Set(result.rows.flatMap(record => Object.keys(record)))];
  sheet.addRow(headers); result.rows.forEach(record => sheet.addRow(headers.map(header => record[header])));
  return { filename: "report-export.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"), rowCount: result.rows.length, limitation: result.limitation };
}
export async function generateBarcodes(principal: Principal, input: unknown) {
  await authority(principal, "labels.read"); const data = barcodeSchema.parse(input);
  const values = barcodeValues(data.values);
  return { barcodes: values.map(value => ({ value, svg: bwipjs.toSVG(barcodeOptions(value)) })), physicalPrinting: "requires_authorized_browser_or_connected_device; no printing occurred" };
}
export async function parseRtvLabel(principal: Principal, input: unknown) { await authority(principal, "labels.read"); return { fields: parseFields(z.object({ text: z.string().max(100_000) }).parse(input).text), qualification: "Pasted page text requires review; parsing is not unit/submission identity evidence." }; }
export async function renderRtvLabel(principal: Principal, input: unknown) {
  const data = z.object({ templateId: z.string().min(1).max(100), fields: rtvFieldsSchema }).parse(input);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "labels.read");
    const template = await tx.labelTemplate.findFirst({ where: { id: data.templateId, kind: "mars_return", isActive: true } });
    if (!template) throw Object.assign(new Error("Select an active managed MARS label template."), { status: 404 });
    const fields = { ...emptyLabelFields(), ...data.fields };
    return { zpl: renderTemplate(template.zpl, fields), fields, templateId: template.id, physicalOutput: "not_printed", guidance: "Use labels.prepare or an identified unit's managed label action for an authorized device dispatch." };
  });
}
export async function rtvBookmarklet(principal: Principal) { await authority(principal, "labels.read"); const origin = new URL(z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL)).origin, loaderUrl = `${origin}/api/payloads/mars-label-helper/loader`; return { loaderUrl, bookmarklet: buildPayloadBookmarklet(loaderUrl), effect: "Open the existing submission page and explicitly review in Temco; no submission or print occurs." }; }
export const utilityActions = {
  "reports.pipeline.execute": { capability: "workflow.read", description: "Run retained legacy filter/map/sort/join semantics on rows and steps; never warehouse identity", inputSchema: pipelineSchema, run: runLegacyPipeline },
  "reports.pipeline.import": { capability: "workflow.read", description: "Parse a bounded CSV/XLSX contentBase64 file into report rows", inputSchema: importSchema, run: importLegacyReport },
  "reports.pipeline.export": { capability: "workflow.read", description: "Run rows/steps and export the retained report as XLSX base64", inputSchema: pipelineSchema, run: exportLegacyReport },
  "labels.barcodes.generate": { capability: "labels.read", description: "Generate the same Code128 barcodes as the browser, as standalone SVGs", inputSchema: barcodeSchema, run: generateBarcodes },
  "labels.rtv.parse": { capability: "labels.read", description: "Extract existing MARS label fields from supplied page text for human review", run: parseRtvLabel },
  "labels.rtv.render": { capability: "labels.read", description: "Render an active managed template with reviewed fields, without printing", run: renderRtvLabel },
  "labels.rtv.bookmarklet": { capability: "labels.read", description: "Generate the stable MARS field-review loader; no direct external-page print", run: rtvBookmarklet },
  "scanner.diagnostics.open": { capability: "diagnostics.use", description: "Initiate scanner diagnostics on the actual authorized device", run: async (p: Principal) => { await authority(p, "diagnostics.use"); return { status: "requires_connected_device", actionUrl: `${new URL(z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL)).origin}/admin/scanner-diagnostic`, limitation: "Keyboard/wedge/OCR events must come from the actual device. This server cannot claim hardware capture or acceptance." }; } },
} as const;
