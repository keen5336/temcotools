import { z } from "zod";
import type { Principal } from "@/lib/auth/principal";
import * as scans from "@/lib/scan-lists";
import * as recon from "@/lib/route-recons";
import { decodeRetainedWorkbookBase64, retainedWorkbookBase64Input } from "@/lib/retained-workbook";
import type { PickWaveWorkbookBuffer } from "@/lib/pick-waves";
export const retainedResourceInput = z.object({ id: z.string().min(1).max(200) });
const resource = retainedResourceInput;
export const scanListCreateInput = scans.scanListSaveInput;
export const routeReconPreviewInput = z.object({ contentBase64: retainedWorkbookBase64Input });
export const routeReconImportInput = recon.routeReconMetadataInput.extend({ contentBase64: retainedWorkbookBase64Input });
export const routeReconPrintableInput = resource.extend(recon.routeReconPrintableOptionsInput.shape);
export function listScanLists(principal: Principal) { return scans.listScanLists(principal); }
export async function getScanList(principal: Principal, input: unknown) { const result = await scans.getScanList(resource.parse(input).id, principal); if (!result) throw new scans.RetainedListError("Scan list not found.", 404); return result; }
export function createScanList(principal: Principal, input: unknown) { return scans.saveScanList(input, principal); }
export function archiveScanList(principal: Principal, input: unknown) { return scans.setScanListArchived(resource.parse(input).id, true, principal); }
export function restoreScanList(principal: Principal, input: unknown) { return scans.setScanListArchived(resource.parse(input).id, false, principal); }
export function deleteScanList(principal: Principal, input: unknown) { return scans.deleteScanList(resource.parse(input).id, principal); }
export function exportScanList(principal: Principal, input: unknown) { return scans.exportScanListCsv(resource.parse(input).id, principal); }
export function listRouteRecons(principal: Principal) { return recon.listRouteRecons(principal); }
export async function getRouteRecon(principal: Principal, input: unknown) { const result = await recon.getRouteRecon(resource.parse(input).id, principal); if (!result) throw new recon.RouteReconValidationError("Route Recon not found.", 404); return result; }
export function previewRouteRecon(principal: Principal, input: unknown) { const data = routeReconPreviewInput.parse(input); return recon.previewRouteRecon(decodeRetainedWorkbookBase64(data.contentBase64) as unknown as PickWaveWorkbookBuffer, principal); }
export function importRouteRecon(principal: Principal, input: unknown) { const data = routeReconImportInput.parse(input); return recon.createRouteRecon({ ...data, fileBuffer: decodeRetainedWorkbookBase64(data.contentBase64) as unknown as PickWaveWorkbookBuffer }, principal); }
export function archiveRouteRecon(principal: Principal, input: unknown) { return recon.setRouteReconArchived(resource.parse(input).id, true, principal); }
export function restoreRouteRecon(principal: Principal, input: unknown) { return recon.setRouteReconArchived(resource.parse(input).id, false, principal); }
export function deleteRouteRecon(principal: Principal, input: unknown) { return recon.deleteRouteRecon(resource.parse(input).id, principal); }
export function getRouteReconPrintableData(principal: Principal, input: unknown) { const data = routeReconPrintableInput.parse(input); return recon.getRouteReconPrintableData(data.id, data, principal); }
export function exportRouteRecon(principal: Principal, input: unknown) { return recon.exportRouteReconCsv(resource.parse(input).id, principal); }
