import * as lists from "./retained-lists";
export const listActions = {
  "scan-lists.list": { capability: "workflow.read", description: "Read retained named scan lists", run: lists.listScanLists },
  "scan-lists.get": { capability: "workflow.read", description: "Read one saved generic list and attributed rows by id", run: lists.getScanList },
  "scan-lists.create": { capability: "workflow.execute", description: "Save localDraftId/name/createdAt/scans with current attribution and conflict-safe retries", run: lists.createScanList },
  "scan-lists.archive": { capability: "workflow.execute", description: "Archive a saved list by id", run: lists.archiveScanList },
  "scan-lists.restore": { capability: "workflow.execute", description: "Restore a saved list by id", run: lists.restoreScanList },
  "scan-lists.delete": { capability: "workflow.execute", description: "Delete a saved generic list by id; it is not the physical observation ledger", run: lists.deleteScanList },
  "scan-lists.export": { capability: "workflow.read", description: "Export a retained list to safe CSV", run: lists.exportScanList },
  "route-recon.list": { capability: "workflow.read", description: "Read retained Route Recon reports", run: lists.listRouteRecons },
  "route-recon.get": { capability: "workflow.read", description: "Read one existing Route Recon by id", run: lists.getRouteRecon },
  "route-recon.preview": { capability: "workflow.read", description: "Preview a bounded XLSX contentBase64 upload", run: lists.previewRouteRecon },
  "route-recon.import": { capability: "workflow.execute", description: "Import name/filename/contentBase64 with a stable operationId", run: lists.importRouteRecon },
  "route-recon.archive": { capability: "workflow.execute", description: "Archive a report by id", run: lists.archiveRouteRecon },
  "route-recon.restore": { capability: "workflow.execute", description: "Restore a report by id", run: lists.restoreRouteRecon },
  "route-recon.delete": { capability: "workflow.execute", description: "Delete a retained report by id", run: lists.deleteRouteRecon },
  "route-recon.printable": { capability: "workflow.read", description: "Get printable route data; physical browser/device printing remains explicit", run: lists.getRouteReconPrintableData },
  "route-recon.export": { capability: "workflow.read", description: "Export a retained report to safe CSV", run: lists.exportRouteRecon },
} as const;
