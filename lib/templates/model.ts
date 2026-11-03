import { createHash } from "node:crypto";
import { z } from "zod";
import { assertWorkflowJson, copyWorkflowJson, stableWorkflowJson, validateWorkflowDefinition, workflowDefinition, workflowKey } from "@/lib/workflows/definition";
import { labelDraftInput, validateLabelDraft } from "@/lib/labels/model";
import { LABEL_PURPOSES } from "@/lib/labels/types";

export class TemplateError extends Error { constructor(message: string, readonly status = 400) { super(message); this.name = "TemplateError"; } }
export const TEMPLATE_KINDS = ["workflow", "label_workflow", "site_defaults"] as const;
const name = z.string().trim().min(1).max(160);
const timezone = z.string().trim().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }, "Choose an IANA timezone.");
const locations = z.array(z.string().trim().min(1).max(100)).max(200).refine(values => new Set(values).size === values.length, "Use each location once.");
export const connectionRule = z.object({ integrationId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), purpose: z.enum(["read", "write", "print"]), selection: z.literal("explicit_authorized_provider") }).strict();
const workflowPolicy = z.object({ allowedFields: z.array(z.enum(["name", "stepText"])).max(2).default([]), allowDetach: z.boolean().default(false) }).strict();
const labelPolicy = z.object({ allowedFields: z.array(z.enum(["name", "zpl", "widthMm", "heightMm", "dpi"])).max(5).default([]), allowDetach: z.boolean().default(false) }).strict();
const defaultsPolicy = z.object({ allowedFields: z.array(z.enum(["timezone", "locations", "defaultPrinterId", "defaultWorkflowId", "connectionRules"])).max(5).default([]), allowDetach: z.boolean().default(false) }).strict();
export const platformTemplatePayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow"), title: name.optional(), definition: workflowDefinition, policy: workflowPolicy }).strict(),
  z.object({ kind: z.literal("label_workflow"), title: name.optional(), definition: labelDraftInput, policy: labelPolicy }).strict(),
  z.object({ kind: z.literal("site_defaults"), title: name.optional(), defaults: z.object({ timezone: timezone.optional(), locations: locations.default([]), printerName: z.string().trim().min(1).max(120).optional(), defaultWorkflowPurpose: z.enum(LABEL_PURPOSES).exclude(["legacy_manual"]).optional(), connectionRules: z.array(connectionRule).max(20).default([]) }).strict(), policy: defaultsPolicy }).strict(),
]);
export type PlatformTemplatePayload = z.infer<typeof platformTemplatePayload>;
const stepText = z.record(workflowKey, z.object({ title: name.optional(), description: z.string().max(2000).optional(), prompt: z.string().min(1).max(1000).optional() }).strict());
export const workflowOverrides = z.object({ name: name.optional(), stepText: stepText.optional() }).strict();
export const labelOverrides = z.object({ name: name.optional(), zpl: z.string().min(1).max(128 * 1024).optional(), widthMm: z.number().min(20).max(300).optional(), heightMm: z.number().min(20).max(500).optional(), dpi: z.union([z.literal(203), z.literal(300), z.literal(600)]).optional() }).strict();
export const defaultsOverrides = z.object({ timezone: timezone.optional(), locations: locations.optional(), defaultPrinterId: z.string().min(1).max(200).nullable().optional(), defaultWorkflowId: z.enum(LABEL_PURPOSES).exclude(["legacy_manual"]).nullable().optional(), connectionRules: z.array(connectionRule).max(20).optional() }).strict();

/** Platform definitions are reusable defaults, never credentials or operational-object authority. */
function assertNoPrivateSource(value: unknown) {
  assertWorkflowJson(value, 256 * 1024);
  const forbidden = /(?:userId|sessionId|grantId|providerId|printerId|deviceId|connectionId)$|^(?:password|passphrase|secret|token|cookies?|headers|authorization|credentials|endpoint|customerName|customerEmail)$/i;
  const visit = (item: unknown): void => {
    if (typeof item === "string" && (/\bBearer\s+\S+/i.test(item) || /\b(?:tc_at_|tc_rt_|enroll_)[A-Za-z0-9_-]{16,}/.test(item))) throw new TemplateError("Platform templates cannot contain credentials or enrollment material.");
    if (Array.isArray(item)) for (const part of item) visit(part);
    else if (item && typeof item === "object") for (const [key, part] of Object.entries(item)) { if (forbidden.test(key)) throw new TemplateError("Platform templates cannot contain private people, device/provider/printer IDs, endpoints, headers or credentials. Choose local references when adopting."); visit(part); }
  };
  visit(value);
}
export function validatePlatformTemplate(input: unknown): PlatformTemplatePayload {
  assertNoPrivateSource(input);
  const result = platformTemplatePayload.safeParse(input); if (!result.success) throw new TemplateError(`Invalid template: ${result.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const value = result.data;
  if (new Set(value.policy.allowedFields).size !== value.policy.allowedFields.length) throw new TemplateError("Declare each allowed override once.");
  if (value.kind === "workflow") value.definition = validateWorkflowDefinition(value.definition);
  if (value.kind === "label_workflow") value.definition = labelDraftInput.parse(validateLabelDraft(value.definition));
  return value;
}
export function templateContentHash(value: unknown) { assertWorkflowJson(value, 256 * 1024); return createHash("sha256").update(stableWorkflowJson(value)).digest("hex"); }
export function applyTemplateOverrides(payload: PlatformTemplatePayload, input: unknown) {
  assertWorkflowJson(input, 256 * 1024);
  const overrides = (payload.kind === "workflow" ? workflowOverrides : payload.kind === "label_workflow" ? labelOverrides : defaultsOverrides).parse(input);
  for (const key of Object.keys(overrides)) if (!(payload.policy.allowedFields as string[]).includes(key)) throw new TemplateError(`Platform control ${key} is protected. Choose only the overrides allowed by this published version.`, 403);
  const effective = copyWorkflowJson(payload);
  if (effective.kind === "workflow") {
    const parsed = workflowOverrides.parse(overrides);
    if (parsed.name) effective.definition.name = parsed.name;
    for (const [id, text] of Object.entries(parsed.stepText ?? {})) {
      const step = effective.definition.steps.find(candidate => candidate.id === id); if (!step) throw new TemplateError("Choose an existing step for operator-facing text.");
      if (text.prompt !== undefined && step.kind !== "confirm") throw new TemplateError("Only confirmation steps have prompts.");
      Object.assign(step, text);
    }
    effective.definition = validateWorkflowDefinition(effective.definition);
  } else if (effective.kind === "label_workflow") effective.definition = labelDraftInput.parse(validateLabelDraft({ ...effective.definition, ...labelOverrides.parse(overrides) }));
  else {
    const parsed = defaultsOverrides.parse(overrides);
    if (parsed.timezone) effective.defaults.timezone = parsed.timezone;
    if (parsed.locations) effective.defaults.locations = parsed.locations;
    if (parsed.connectionRules) effective.defaults.connectionRules = parsed.connectionRules;
  }
  return { effective, overrides };
}
