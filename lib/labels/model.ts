import { createHash } from "node:crypto";
import { z } from "zod";
import { LABEL_FIELDS, LABEL_PURPOSES, LABEL_RULE_CLASSES, type LabelDraft, type LabelFields, type LabelRule } from "./types";

export class LabelError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "label_error") { super(message); this.name = "LabelError"; }
}
const ruleSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name: z.string().trim().min(1).max(100), class: z.enum(LABEL_RULE_CLASSES), priority: z.number().int().min(0).max(1000), enabled: z.boolean(), automatic: z.boolean(), conditions: z.array(z.object({ field: z.enum(LABEL_FIELDS), operator: z.enum(["equals", "not_equals", "empty", "not_empty"]), value: z.string().max(500).optional() })).max(12) });
const draftSchema = z.object({ purpose: z.enum(LABEL_PURPOSES).exclude(["legacy_manual"]), name: z.string().trim().min(1).max(100), zpl: z.string().min(1).max(128 * 1024), requiredFields: z.array(z.enum(LABEL_FIELDS)).max(LABEL_FIELDS.length), rules: z.array(ruleSchema).max(32), widthMm: z.number().min(20).max(300), heightMm: z.number().min(20).max(500), dpi: z.union([z.literal(203), z.literal(300), z.literal(600)]) });
export function validateLabelDraft(input: unknown): LabelDraft {
  const result = draftSchema.safeParse(input);
  if (!result.success) throw new LabelError("Enter a known purpose, template, fields, rules and supported media dimensions.");
  const draft = result.data;
  if (Buffer.byteLength(draft.zpl) > 128 * 1024 || !draft.zpl.includes("^XA") || !draft.zpl.includes("^XZ")) throw new LabelError("Provide a complete ZPL label of at most 128 KiB.");
  const placeholders = [...draft.zpl.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]);
  if (placeholders.some(field => !LABEL_FIELDS.includes(field as (typeof LABEL_FIELDS)[number]))) throw new LabelError("The template contains an unknown field.");
  if (new Set(draft.rules.map(rule => rule.id)).size !== draft.rules.length) throw new LabelError("Rule IDs must be unique within a published workflow.");
  if (draft.purpose === "rtv_submission" && !draft.requiredFields.includes("submissionNumber")) throw new LabelError("RTV submission labels require a submission number.");
  if (draft.purpose === "rtv_submission" && (!placeholders.includes("submissionNumber") || !/\^B(?!Y)[A-Z0-9][^^]*\^FD[^^]*{{\s*submissionNumber\s*}}/.test(draft.zpl))) throw new LabelError("RTV labels must retain the submission-number barcode.");
  return { ...draft, requiredFields: [...new Set(draft.requiredFields)] };
}
export function normalizeLabelFields(input: unknown): LabelFields {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LabelError("Label fields must be an object.");
  const fields: LabelFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LABEL_FIELDS.includes(key as (typeof LABEL_FIELDS)[number])) continue;
    if (typeof value !== "string" || value.length > 2000) throw new LabelError("Label field values must be text of at most 2,000 characters.");
    fields[key as keyof LabelFields] = value.replace(/[\^~\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  }
  return fields;
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function labelVersionHash(draft: LabelDraft) { return fingerprint({ purpose: draft.purpose, zpl: draft.zpl, requiredFields: draft.requiredFields, rules: draft.rules, widthMm: draft.widthMm, heightMm: draft.heightMm, dpi: draft.dpi }); }
function matches(rule: LabelRule, fields: LabelFields) {
  return rule.conditions.every(condition => {
    const value = fields[condition.field] ?? "";
    if (condition.operator === "empty") return !value;
    if (condition.operator === "not_empty") return Boolean(value);
    if (condition.operator === "equals") return value === (condition.value ?? "");
    return value !== (condition.value ?? "");
  });
}
export function evaluateLabelRules(rules: LabelRule[], fields: LabelFields) {
  if (fields.identityResolved === "false") return { automaticAllowed: false, reason: "Resolve the physical-unit identity before automatic label issuance.", ruleId: null };
  if (fields.hold === "true") return { automaticAllowed: false, reason: "An active handling hold blocks automatic label issuance.", ruleId: null };
  const matched = rules.filter(rule => rule.enabled && matches(rule, fields)).sort((a, b) => LABEL_RULE_CLASSES.indexOf(a.class) - LABEL_RULE_CLASSES.indexOf(b.class) || b.priority - a.priority || a.id.localeCompare(b.id));
  if (!matched.length) return { automaticAllowed: false, reason: "No automatic label rule matches. Manual printing remains an explicit action.", ruleId: null };
  const rule = matched[0];
  return { automaticAllowed: rule.automatic, reason: rule.name, ruleId: rule.id };
}
export function renderLabelVersion(version: { id: string; purpose: string; zpl: string; requiredFields: string[]; rules: unknown }, fieldsInput: unknown) {
  const fields = normalizeLabelFields(fieldsInput);
  const missing = version.requiredFields.filter(field => !fields[field as keyof LabelFields]);
  if (missing.length) throw new LabelError(`Required label fields are missing: ${missing.join(", ")}.`);
  const zpl = version.zpl.replace(/{{\s*(\w+)\s*}}/g, (_match, key: keyof LabelFields) => fields[key] ?? "");
  // Only fields rendered into this label and its immutable version affect its
  // fingerprint. An unrelated source column or repeat observation does not.
  return { fields, zpl: zpl.endsWith("\x04") ? zpl : zpl + "\x04", contentFingerprint: fingerprint({ purpose: version.purpose, versionId: version.id, zpl }), decision: evaluateLabelRules(version.rules as LabelRule[], fields) };
}
export function matchesApprovedLegacyTemplate(zpl: string, templates: { zpl: string }[]) {
  const raw = zpl.replace(/\x04$/, "");
  return templates.some(template => {
    const parts = template.zpl.replace(/\x04$/, "").split(/{{\s*\w+\s*}}/g).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${parts.join("[^\\^~\\x00-\\x1f\\x7f]*")}$`, "u").test(raw);
  });
}
