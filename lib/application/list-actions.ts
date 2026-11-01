import { z } from "zod";
import * as lists from "./retained-lists";
const noInput = z.object({});
export const listActions = {
  "scan-lists.list": { capability: "workflow.read", description: "Read retained named scan lists", inputSchema: noInput, run: lists.listScanLists },
  "scan-lists.get": { capability: "workflow.read", description: "Read one saved generic list and attributed rows by id", inputSchema: lists.retainedResourceInput, run: lists.getScanList },
  "scan-lists.create": { capability: "workflow.execute", description: "Save localDraftId/name/createdAt/scans with current attribution and conflict-safe retries", inputSchema: lists.scanListCreateInput, run: lists.createScanList },
  "scan-lists.archive": { capability: "workflow.execute", description: "Archive a saved list by id", inputSchema: lists.retainedResourceInput, run: lists.archiveScanList },
  "scan-lists.restore": { capability: "workflow.execute", description: "Restore a saved list by id", inputSchema: lists.retainedResourceInput, run: lists.restoreScanList },
  "scan-lists.delete": { capability: "workflow.execute", description: "Delete a saved generic list by id; it is not the physical observation ledger", inputSchema: lists.retainedResourceInput, run: lists.deleteScanList },
  "scan-lists.export": { capability: "workflow.read", description: "Export a retained list to safe CSV", inputSchema: lists.retainedResourceInput, run: lists.exportScanList },
  "route-recon.list": { capability: "workflow.read", description: "Read retained Route Recon reports", inputSchema: noInput, run: lists.listRouteRecons },
  "route-recon.get": { capability: "workflow.read", description: "Read one existing Route Recon by id", inputSchema: lists.retainedResourceInput, run: lists.getRouteRecon },
  "route-recon.preview": { capability: "workflow.read", description: "Preview a bounded XLSX contentBase64 upload", inputSchema: lists.routeReconPreviewInput, run: lists.previewRouteRecon },
  "route-recon.import": { capability: "workflow.execute", description: "Import name/filename/contentBase64 with a stable operationId", inputSchema: lists.routeReconImportInput, run: lists.importRouteRecon },
  "route-recon.archive": { capability: "workflow.execute", description: "Archive a report by id", inputSchema: lists.retainedResourceInput, run: lists.archiveRouteRecon },
  "route-recon.restore": { capability: "workflow.execute", description: "Restore a report by id", inputSchema: lists.retainedResourceInput, run: lists.restoreRouteRecon },
  "route-recon.delete": { capability: "workflow.execute", description: "Delete a retained report by id", inputSchema: lists.retainedResourceInput, run: lists.deleteRouteRecon },
  "route-recon.printable": { capability: "workflow.read", description: "Get printable route data; physical browser/device printing remains explicit", inputSchema: lists.routeReconPrintableInput, run: lists.getRouteReconPrintableData },
  "route-recon.export": { capability: "workflow.read", description: "Export a retained report to safe CSV", inputSchema: lists.retainedResourceInput, run: lists.exportRouteRecon },
} as const;
