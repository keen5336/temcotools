import { z } from "zod";
import { assertCapability, AuthorizationError, type Principal } from "@/lib/auth/principal";
import { recordWarehouseObservation } from "@/lib/warehouse/units";
import { scanPickWave, PickWaveValidationError } from "@/lib/pick-waves";
import { reviewOfficeObservation } from "@/lib/office/service";
import { reviewDispatchObservation } from "@/lib/dispatch/service";

export const scanIngestionSchema = z.object({
  eventId: z.string().min(1).max(150), capturedByUserId: z.string().min(1).max(200),
  rawIdentifier: z.string().trim().min(1).max(500), identifierType: z.enum(["auto", "lpn", "msn", "serial", "submission"]).default("auto"),
  namespace: z.string().trim().max(100).optional(), type: z.enum(["presence", "check_in", "placement", "departure"]),
  location: z.string().trim().max(200).optional(), capturedAt: z.string().max(100),
  captureMethod: z.enum(["scanner", "manual", "ocr"]).default("manual"), deviceId: z.string().max(200).optional(),
  pickWaveId: z.string().min(1).max(200).optional(),
});
export async function ingestWarehouseScan(principal: Principal, raw: unknown) {
  assertCapability(principal, "inventory.write");
  const input = scanIngestionSchema.parse(raw);
  const receipt = await recordWarehouseObservation(principal, input);
  let dispatchReview;
  try { dispatchReview = await reviewDispatchObservation(principal, { observationId: receipt.observation.observationId }); }
  catch { dispatchReview = { pendingReview: true }; }
  // Rule evaluation only creates/returns durable local instructions. It never
  // sends a print or a MARS submission, including on same-event replay.
  let office;
  try { office = await reviewOfficeObservation(principal, { observationId: receipt.observation.observationId }); }
  catch { office = { pendingReview: true, message: "Observation saved. Office instructions require a fresh review." }; }
  const result = { ...receipt, office, dispatchReview };
  if (!input.pickWaveId) return result;
  if ("pendingReview" in office) return { ...result, task: { matched: false, error: "Current handling instructions are unavailable. Refresh office review before staging." } };
  if ("instructions" in office && office.instructions.some(instruction => ["hold", "customer_property", "route_to_authorized_rtv_workflow"].includes(instruction.action))) {
    return { ...result, task: { matched: false, error: "Current office handling instructions require review before delivery staging." } };
  }
  if (receipt.resolution === "ambiguous") return { ...result, task: { matched: false, ambiguous: true, error: "Identifier matches multiple warehouse units. Scan a unique identifier." } };
  // Both are local, idempotent writes. A task error never erases the physical
  // observation. Retrying after a lost response returns each original receipt.
  try {
    const task = await scanPickWave({ id: input.pickWaveId, scannedValue: input.rawIdentifier, userId: principal.userId, eventId: input.eventId, principal });
    return { ...result, task };
  } catch (error) {
    if (error instanceof AuthorizationError) return { ...result, task: { matched: false, error: "Your current permissions allow the observation but not pick execution." } };
    if (error instanceof PickWaveValidationError) return { ...result, task: { matched: false, error: error.message } };
    throw error;
  }
}
