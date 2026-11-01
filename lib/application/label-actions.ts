import type { Principal } from "@/lib/auth/principal";
import * as workflows from "@/lib/labels/workflows";
import * as devices from "@/lib/labels/devices";
import * as issuance from "@/lib/labels/issuance";
import { z } from "zod";

const id = (input: unknown, key: string) => z.string().min(1).max(100).parse(z.record(z.string(), z.unknown()).parse(input)[key]);
export const labelActions = {
  "labels.workflows": { capability: "labels.manage", description: "Read managed label drafts and published versions", run: workflows.listLabelWorkflows },
  "labels.published": { capability: "labels.read", description: "Read current published label purposes", run: workflows.listPublishedLabelWorkflows },
  "labels.workflow": { capability: "labels.manage", description: "Read one label purpose and its history", run: (p: Principal, input: unknown) => workflows.getLabelWorkflow(p, id(input, "purpose")) },
  "labels.draft.save": { capability: "labels.manage", description: "Save an operator-facing label draft using its current revision", run: workflows.saveLabelWorkflow },
  "labels.publish": { capability: "labels.manage", description: "Publish an immutable reviewed label version", run: workflows.publishLabelWorkflow },
  "labels.rollback": { capability: "labels.manage", description: "Select a prior published label version", run: workflows.rollbackLabelWorkflow },
  "labels.enabled": { capability: "labels.manage", description: "Enable or disable a label purpose", run: workflows.setLabelWorkflowEnabled },
  "labels.preview": { capability: "labels.manage", description: "Render synthetic content/ZPL without printing", run: workflows.previewLabelDraft },
  "labels.evaluate": { capability: "labels.read", capabilitiesAll: ["inventory.read"], description: "Evaluate relevant content changes independently of last physical observation", run: (p: Principal, input: unknown) => workflows.evaluateLabel(p, input as Parameters<typeof workflows.evaluateLabel>[1]) },
  "labels.devices": { capability: "labels.read", description: "List currently authorized connected printing devices", run: devices.listPrintingDevices },
  "labels.device.register": { capability: "labels.print", description: "Lease a session-bound device; a server grant does not supply LAN hardware", run: devices.registerPrintingDevice },
  "labels.device.revoke": { capability: "labels.print", description: "Revoke your connected device", run: (p: Principal, input: unknown) => devices.revokePrintingDevice(p, id(input, "deviceId")) },
  "labels.prepare": { capability: "labels.print", description: "Prepare an idempotent label intent for an authorized connected device", run: issuance.prepareLabelIssuance },
  "labels.pending": { capability: "labels.print", description: "List print intents assigned to your actual device credential", run: issuance.listPendingLabelDispatches },
  "labels.claim": { capability: "labels.print", description: "Claim exactly one dispatch using the actual device credential; never replay uncertain effects", run: issuance.claimLabelDispatch },
  "labels.delivery.report": { capability: "labels.print", description: "Report transport delivery uncertainty without claiming physical printing", run: issuance.reportLabelDelivery },
  "labels.cancel": { capability: "labels.print", description: "Cancel an intent that has not been dispatched", run: issuance.cancelQueuedLabel },
  "labels.reconcile": { capability: "labels.print", description: "Record attributed physical/reconciliation evidence separately from browser delivery", run: issuance.reconcileLabelIssuance },
  "labels.reprint": { capability: "labels.print", description: "Prepare an explicit new reprint with a reason and separate operation ID", run: issuance.reprintLabelIssuance },
  "labels.issuance": { capabilitiesAny: ["labels.read", "labels.print"], description: "Read an authorized issuance receipt; print-only access is limited to your own", run: (p: Principal, input: unknown) => issuance.getLabelIssuance(p, id(input, "issuanceId")) },
  "labels.issuances": { capability: "labels.read", description: "Read recent label receipts; optionally constrain to an exact unit", run: (p: Principal, input: unknown) => issuance.listLabelIssuances(p, z.object({ unitId: z.string().min(1).max(100).optional() }).parse(input).unitId) },
} as const;
