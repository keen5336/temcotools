import { z } from "zod";

export class WorkflowError extends Error {
  constructor(message: string, readonly code = "workflow_invalid", readonly status = 400) { super(message); this.name = "WorkflowError"; }
}
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
export const workflowKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(key => !unsafe.has(key));
export const workflowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).refine(key => !unsafe.has(key));
/** Derived operation/receipt IDs contain several bounded identity components. */
export const workflowCorrelationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/).refine(key => !unsafe.has(key));
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string().max(16_384), z.number(), z.boolean(), z.null(), z.array(json).max(1000), z.record(workflowKey, json)]));

/** Reject non-JSON/prototype-bearing input before it enters persisted definitions or mappings. */
export function assertWorkflowJson(value: unknown, maxBytes = 131_072): asserts value is JsonValue {
  let count = 0;
  function visit(item: unknown, depth: number): void {
    if (depth > 12 || ++count > 20_000) throw new WorkflowError("Workflow JSON exceeds its nesting or value limit.");
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const part of item) visit(part, depth + 1); return; }
    if (typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new WorkflowError("Use plain JSON values only.");
    for (const [key, part] of Object.entries(item)) {
      if (unsafe.has(key)) throw new WorkflowError("Prototype and constructor paths are not allowed.");
      visit(part, depth + 1);
    }
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) throw new WorkflowError("Workflow JSON exceeds its size limit.");
}
export function stableWorkflowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableWorkflowJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, part]) => `${JSON.stringify(key)}:${stableWorkflowJson(part)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new WorkflowError("Only defined JSON values can be compared or retained.");
  return encoded;
}
export function copyWorkflowJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export const workflowValue = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: json }).strict(),
  z.object({ source: z.literal("data"), path: z.array(workflowKey).min(1).max(8) }).strict(),
  z.object({ source: z.literal("step"), stepId: workflowKey, path: z.array(workflowKey).max(8).default([]) }).strict(),
]);
export type WorkflowValue = z.infer<typeof workflowValue>;
export const workflowCondition = z.object({ all: z.array(z.object({
  operator: z.enum(["equals", "not_equals", "exists", "empty", "greater_than", "at_least", "less_than"]),
  left: workflowValue, right: workflowValue.optional(),
}).strict().superRefine((value, ctx) => {
  if (!["exists", "empty"].includes(value.operator) && !value.right) ctx.addIssue({ code: "custom", message: "This comparison requires a right value." });
})).min(1).max(16) }).strict();
export type WorkflowCondition = z.infer<typeof workflowCondition>;
export type ValueContext = { data: Record<string, JsonValue>; steps: Record<string, { output?: JsonValue }> };
export function readWorkflowValue(expression: WorkflowValue, context: ValueContext): JsonValue | undefined {
  if (expression.source === "literal") return copyWorkflowJson(expression.value);
  let value: unknown = expression.source === "data" ? context.data : context.steps[expression.stepId]?.output;
  for (const key of expression.path) {
    if (unsafe.has(key) || !value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value as JsonValue | undefined;
}
export function evaluateWorkflowCondition(condition: WorkflowCondition, context: ValueContext): boolean {
  return condition.all.every(test => {
    const left = readWorkflowValue(test.left, context), right = test.right ? readWorkflowValue(test.right, context) : undefined;
    if (test.operator === "exists") return left !== undefined && left !== null;
    if (test.operator === "empty") return left === undefined || left === null || left === "" || (Array.isArray(left) && left.length === 0);
    if (left === undefined || right === undefined) return false;
    if (test.operator === "equals") return stableWorkflowJson(left) === stableWorkflowJson(right);
    if (test.operator === "not_equals") return stableWorkflowJson(left) !== stableWorkflowJson(right);
    if (typeof left !== "number" || typeof right !== "number") return false;
    return test.operator === "greater_than" ? left > right : test.operator === "at_least" ? left >= right : left < right;
  });
}
export function mapWorkflowParameters(mapping: Record<string, WorkflowValue>, context: ValueContext): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!workflowKey.safeParse(key).success) throw new WorkflowError("Use safe parameter keys.");
    const resolved = readWorkflowValue(value, context);
    if (resolved === undefined) throw new WorkflowError(`Required mapping ${key} is unavailable.`, "workflow_mapping_missing");
    output[key] = copyWorkflowJson(resolved);
  }
  return output;
}

const requirementBase = { id: workflowKey, label: z.string().min(1).max(160), fix: z.string().min(1).max(500), level: z.enum(["required", "advisory"]).default("required") };
export const workflowRequirement = z.discriminatedUnion("kind", [
  z.object({ ...requirementBase, kind: z.literal("capability"), capability: workflowId }).strict(),
  z.object({ ...requirementBase, kind: z.literal("provider"), binding: workflowKey, providerType: workflowKey.optional() }).strict(),
  z.object({ ...requirementBase, kind: z.literal("action"), actionId: workflowId, versionId: workflowId, configurationVersion: workflowId }).strict(),
]);
export type WorkflowRequirement = z.infer<typeof workflowRequirement>;
export const workflowField = z.object({
  key: workflowKey, label: z.string().min(1).max(160), type: z.enum(["text", "identifier", "integer", "boolean", "choice"]),
  required: z.boolean().default(true), maxLength: z.number().int().min(1).max(2000).default(500),
  minimum: z.number().optional(), maximum: z.number().optional(), choices: z.array(z.string().min(1).max(500)).max(100).default([]),
}).strict().superRefine((field, ctx) => {
  if (field.type === "choice" && !field.choices.length) ctx.addIssue({ code: "custom", message: "A choice field needs options." });
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) ctx.addIssue({ code: "custom", message: "Field limits are reversed." });
  if (new Set(field.choices).size !== field.choices.length) ctx.addIssue({ code: "custom", message: "Choice values must be unique." });
});
export type WorkflowField = z.infer<typeof workflowField>;
const baseStep = { id: workflowKey, title: z.string().min(1).max(160), description: z.string().max(2000).default(""), requirements: z.array(workflowRequirement).max(16).default([]), next: workflowKey.optional() };
export const workflowStep = z.discriminatedUnion("kind", [
  z.object({ ...baseStep, kind: z.literal("form"), fields: z.array(workflowField).min(1).max(32), saveAs: workflowKey }).strict(),
  z.object({ ...baseStep, kind: z.literal("scan"), expected: workflowValue, keyField: workflowKey, valueField: workflowKey, quantityField: workflowKey.default("quantity"), identityMode: z.enum(["unit", "quantity"]).default("unit"), maxCaptures: z.number().int().min(1).max(1000).default(500), bufferWhenProviderBlocked: z.boolean().default(false), discrepancyCapability: workflowId.default("workflows.manage") }).strict(),
  z.object({ ...baseStep, kind: z.literal("confirm"), prompt: z.string().min(1).max(1000), saveAs: workflowKey, handoff: z.enum(["human", "camera", "device", "approval"]).default("human"), manualFallback: z.boolean().optional() }).strict(),
  z.object({ ...baseStep, kind: z.literal("condition"), condition: workflowCondition, then: workflowKey, otherwise: workflowKey }).strict(),
  z.object({ ...baseStep, kind: z.literal("action"), action: z.object({ id: workflowId, versionId: workflowId, configurationVersion: workflowId, capability: workflowId, effect: z.enum(["read", "write", "print", "local"]), providerBinding: workflowKey.optional() }).strict(), parameters: z.record(workflowKey, workflowValue).default({}), retryKnownFailure: z.boolean().default(false) }).strict(),
]);
export type WorkflowStep = z.infer<typeof workflowStep>;
export const workflowDefinition = z.object({
  id: workflowId, versionId: workflowId, version: z.number().int().min(1).max(1_000_000), configurationVersion: workflowId,
  name: z.string().min(1).max(160), description: z.string().max(3000).default(""), mode: z.enum(["synthetic", "application", "live"]),
  startRequirements: z.array(workflowRequirement).max(16).default([]), steps: z.array(workflowStep).min(1).max(40), completion: workflowCondition.optional(),
}).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  assertWorkflowJson(input);
  const parsed = workflowDefinition.safeParse(input);
  if (!parsed.success) throw new WorkflowError("Provide a bounded typed workflow definition, known steps and safe mappings.");
  const value = parsed.data, ids = value.steps.map(step => step.id);
  if (new Set(ids).size !== ids.length) throw new WorkflowError("Step IDs must be unique.");
  if (new Set(value.startRequirements.map(req => req.id)).size !== value.startRequirements.length) throw new WorkflowError("Start requirement IDs must be unique.");
  function checkExpressions(expressions: WorkflowValue[], beforeIndex: number) {
    for (const expression of expressions) if (expression.source === "step" && (!ids.includes(expression.stepId) || ids.indexOf(expression.stepId) >= beforeIndex)) throw new WorkflowError("Step mappings must reference an earlier existing step.");
  }
  for (const [index, step] of value.steps.entries()) {
    if (step.kind === "condition" && step.next) throw new WorkflowError("A condition uses its explicit then/otherwise branches, not an additional next transition.");
    for (const target of step.kind === "condition" ? [step.then, step.otherwise] : step.next ? [step.next] : []) {
      if (!ids.includes(target) || ids.indexOf(target) <= index) throw new WorkflowError("Transitions must point to a later existing step; loops are not supported.");
    }
    if (step.kind === "form" && new Set(step.fields.map(field => field.key)).size !== step.fields.length) throw new WorkflowError("Form field keys must be unique.");
    const reqs = step.requirements;
    if (new Set(reqs.map(req => req.id)).size !== reqs.length) throw new WorkflowError("Requirement IDs must be unique per step.");
    checkExpressions(step.kind === "scan" ? [step.expected] : step.kind === "action" ? Object.values(step.parameters) : step.kind === "condition" ? step.condition.all.flatMap(test => [test.left, ...(test.right ? [test.right] : [])]) : [], index);
  }
  if (value.completion) checkExpressions(value.completion.all.flatMap(test => [test.left, ...(test.right ? [test.right] : [])]), ids.length);
  return value;
}

export function validateWorkflowFields(fields: WorkflowField[], input: Record<string, unknown>): Record<string, JsonValue> {
  if (Object.keys(input).some(key => !fields.some(field => field.key === key))) throw new WorkflowError("Unknown form field.");
  const result: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = input[field.key];
    if (value === undefined || value === null || value === "") { if (field.required) throw new WorkflowError(`${field.label} is required.`); continue; }
    if (field.type === "boolean") { if (typeof value !== "boolean") throw new WorkflowError(`${field.label} must be true or false.`); }
    else if (field.type === "integer") { if (typeof value !== "number" || !Number.isSafeInteger(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) throw new WorkflowError(`${field.label} is outside its integer limits.`); }
    else {
      if (typeof value !== "string" || value.length > field.maxLength || (field.type === "identifier" && !value.trim()) || (field.type === "choice" && !field.choices.includes(value))) throw new WorkflowError(`${field.label} is invalid.`);
    }
    result[field.key] = value as JsonValue;
  }
  return result;
}
