import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Principal } from "@/lib/auth/principal";
import * as picks from "@/lib/pick-waves";
import { decodeRetainedWorkbookBase64 } from "@/lib/retained-workbook";

const id = z.string().min(1).max(200);
const routes = z.array(z.object({ routeNumber: z.string().trim().min(1).max(100), stagingLocation: z.string().max(100).nullable() })).max(1000);
const pickIdInput = z.object({ id });
const previewInput = z.object({ contentBase64: z.string() });
const importInput = z.object({ operationId: z.string().min(16).max(150), name: z.string().trim().min(1).max(120), filename: z.string().min(1).max(255), contentBase64: z.string(), routeMappings: routes }).strict();
const archiveInput = pickIdInput.extend({ archived: z.boolean() });
const routesInput = pickIdInput.extend({ routeMappings: routes });
async function read(principal: Principal) { await prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, "workflow.read")); }
export async function previewPickWorkbook(principal: Principal, input: unknown) {
  await read(principal);
  const data = previewInput.parse(input);
  const parsed = await picks.parsePickWaveWorkbook(decodeRetainedWorkbookBase64(data.contentBase64) as unknown as picks.PickWaveWorkbookBuffer);
  const routeNumbers = [...new Set(parsed.items.map(item => item.routeNumber).filter((route): route is string => Boolean(route)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { itemCount: parsed.items.length, routeNumbers, missingColumns: parsed.missingColumns };
}
export async function importPickWorkbook(principal: Principal, input: unknown) {
  await prisma.$transaction(tx => assertCurrentPrincipal(tx, principal, "workflow.execute"));
  const data = importInput.parse(input);
  return picks.createPickWave({ ...data, userId: principal.userId, principal, fileBuffer: decodeRetainedWorkbookBase64(data.contentBase64) as unknown as picks.PickWaveWorkbookBuffer });
}
export async function listPickWork(principal: Principal) { await read(principal); return picks.listPickWaves(); }
export async function getPickWork(principal: Principal, input: unknown) { await read(principal); return picks.getPickWave(pickIdInput.parse(input).id); }
export async function setPickArchive(principal: Principal, input: unknown) { const data = archiveInput.parse(input); return picks.setPickWaveArchived(data.id, data.archived, principal); }
export async function setPickRoutes(principal: Principal, input: unknown) { const data = routesInput.parse(input); return picks.replacePickWaveRoutes(data.id, data.routeMappings, principal); }
export async function savePickScanList(principal: Principal, input: unknown) { return picks.savePickWaveScansToList(pickIdInput.parse(input).id, principal.userId, principal); }
export const pickActions = {
  "picks.list": { capability: "workflow.read", description: "Read retained Pick Waves and progress", inputSchema: z.object({}), run: listPickWork },
  "picks.get": { capability: "workflow.read", description: "Read an existing wave, scans, route instructions and printable item data", inputSchema: pickIdInput, run: getPickWork },
  "picks.preview": { capability: "workflow.read", description: "Preview a bounded workbook (contentBase64)", inputSchema: previewInput, run: previewPickWorkbook },
  "picks.import": { capability: "workflow.execute", description: "Import a workbook with name, filename, routeMappings, contentBase64 and stable operationId", inputSchema: importInput, run: importPickWorkbook },
  "picks.archive": { capability: "workflow.execute", description: "Archive/restore retained work by id and archived flag", inputSchema: archiveInput, run: setPickArchive },
  "picks.routes.save": { capability: "workflow.execute", description: "Save legacy wave route instructions; dispatch-bound waves require an amendment", inputSchema: routesInput, run: setPickRoutes },
  "picks.scans.save-list": { capability: "workflow.execute", description: "Save a durable idempotent snapshot of existing attributed scans", inputSchema: pickIdInput, run: savePickScanList },
} as const;
