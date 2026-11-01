import type { Principal } from "@/lib/auth/principal";
import * as workflows from "@/lib/labels/workflows";
import * as devices from "@/lib/labels/devices";
import * as issuance from "@/lib/labels/issuance";
import { z } from "zod";

const noInput = z.object({});
export const labelActions = {
  "labels.workflows": { capability: "labels.manage", description: "Read managed label drafts and published versions", inputSchema: noInput, run: workflows.listLabelWorkflows },
  "labels.published": { capability: "labels.read", description: "Read current published label purposes", inputSchema: noInput, run: workflows.listPublishedLabelWorkflows },
  "labels.workflow": { capability: "labels.manage", description: "Read one label purpose and its history", inputSchema: workflows.labelWorkflowPurposeInput, run: (p: Principal, input: unknown) => workflows.getLabelWorkflow(p, workflows.labelWorkflowPurposeInput.parse(input).purpose) },
  "labels.draft.save": { capability: "labels.manage", description: "Save an operator-facing label draft using its current revision", inputSchema: workflows.labelWorkflowSaveInput, run: workflows.saveLabelWorkflow },
  "labels.publish": { capability: "labels.manage", description: "Publish an immutable reviewed label version", inputSchema: workflows.labelWorkflowPublishInput, run: workflows.publishLabelWorkflow },
  "labels.rollback": { capability: "labels.manage", description: "Select a prior published label version", inputSchema: workflows.labelWorkflowRollbackInput, run: workflows.rollbackLabelWorkflow },
  "labels.enabled": { capability: "labels.manage", description: "Enable or disable a label purpose", inputSchema: workflows.labelWorkflowEnabledInput, run: workflows.setLabelWorkflowEnabled },
  "labels.preview": { capability: "labels.manage", description: "Render synthetic content/ZPL without printing", inputSchema: workflows.labelPreviewInput, run: workflows.previewLabelDraft },
  "labels.evaluate": { capability: "labels.read", capabilitiesAll: ["inventory.read", "workflow.read"], description: "Evaluate authoritative identified-unit content independently of last physical observation; caller preview fields do not set warehouse content", inputSchema: workflows.labelEvaluationInput, run: (p: Principal, input: unknown) => workflows.evaluateLabel(p, input as Parameters<typeof workflows.evaluateLabel>[1]) },
  "labels.devices": { capability: "labels.read", description: "List currently authorized connected printing devices", inputSchema: noInput, run: devices.listPrintingDevices },
  "labels.device.register": { capability: "labels.print", description: "Lease a session-bound device; a server grant does not supply LAN hardware", inputSchema: devices.printingDeviceRegisterInput, run: devices.registerPrintingDevice },
  "labels.device.revoke": { capability: "labels.print", description: "Revoke your connected device", inputSchema: devices.printingDeviceRevokeInput, run: (p: Principal, input: unknown) => devices.revokePrintingDevice(p, devices.printingDeviceRevokeInput.parse(input).deviceId) },
  "labels.prepare": { capability: "labels.print", description: "Prepare an idempotent label intent; operational purposes derive current unit content and require inventory/workflow access, while legacy manual snapshots use approved templates", inputSchema: issuance.labelPrepareInput, run: issuance.prepareLabelIssuance },
  "labels.pending": { capability: "labels.print", description: "List print intents assigned to your actual device credential", inputSchema: devices.printingDeviceAuthorityInput, run: issuance.listPendingLabelDispatches },
  "labels.claim": { capability: "labels.print", description: "Claim exactly one dispatch using the actual device credential; never replay uncertain effects", inputSchema: issuance.labelDispatchClaimInput, run: issuance.claimLabelDispatch },
  "labels.delivery.report": { capability: "labels.print", description: "Report transport delivery uncertainty without claiming physical printing", inputSchema: issuance.labelDeliveryReportInput, run: issuance.reportLabelDelivery },
  "labels.cancel": { capability: "labels.print", description: "Cancel an intent that has not been dispatched", inputSchema: issuance.labelCancelInput, run: issuance.cancelQueuedLabel },
  "labels.reconcile": { capability: "labels.print", description: "Record attributed physical/reconciliation evidence separately from browser delivery", inputSchema: issuance.labelReconcileInput, run: issuance.reconcileLabelIssuance },
  "labels.reprint": { capability: "labels.print", description: "Prepare an explicit new reprint with a reason and separate operation ID", inputSchema: issuance.labelReprintInput, run: issuance.reprintLabelIssuance },
  "labels.issuance": { capabilitiesAny: ["labels.read", "labels.print"], description: "Read an authorized issuance receipt; print-only access is limited to your own", inputSchema: issuance.labelIssuanceInput, run: (p: Principal, input: unknown) => issuance.getLabelIssuance(p, issuance.labelIssuanceInput.parse(input).issuanceId) },
  "labels.issuances": { capability: "labels.read", description: "Read recent label receipts; optionally constrain to an exact unit", inputSchema: issuance.labelIssuanceListInput, run: (p: Principal, input: unknown) => issuance.listLabelIssuances(p, issuance.labelIssuanceListInput.parse(input).unitId) },
} as const;
