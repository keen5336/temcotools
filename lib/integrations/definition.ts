import { z } from "zod";

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type ValueContract =
  | { type: "string"; optional?: boolean; maxLength?: number; values?: string[] }
  | { type: "number" | "integer"; optional?: boolean; min?: number; max?: number }
  | { type: "boolean"; optional?: boolean }
  | { type: "array"; optional?: boolean; maxItems?: number; items: ValueContract }
  | { type: "object"; optional?: boolean; fields: Record<string, ValueContract> };

export class IntegrationDefinitionError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "IntegrationDefinitionError"; }
}

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const credentialKeys = new Set(["password", "cookie", "setcookie", "authorization", "stkn", "accesstoken", "refreshtoken", "clientsecret", "sessiontoken", "headers", "rawheaders", "requestheaders", "har"]);
export function safeIntegrationKey(key: string) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && !dangerousKeys.has(key.toLowerCase()) && !credentialKeys.has(key.toLowerCase().replace(/[-_]/g, ""));
}
const key = z.string().refine(safeIntegrationKey, "Use a bounded field name without credentials or prototype keys.");
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const actionKey = z.string().max(100).regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/);
const capability = z.string().max(100).regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){1,3}$/);
const contractSchema: z.ZodType<ValueContract> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), optional: z.boolean().optional(), maxLength: z.number().int().min(1).max(4 * 1024 * 1024).optional(), values: z.array(z.string().max(16_384)).min(1).max(100).optional() }).strict(),
  z.object({ type: z.enum(["number", "integer"]), optional: z.boolean().optional(), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal("boolean"), optional: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("array"), optional: z.boolean().optional(), maxItems: z.number().int().min(1).max(1000).optional(), items: contractSchema }).strict(),
  z.object({ type: z.literal("object"), optional: z.boolean().optional(), fields: z.record(key, contractSchema).refine(value => Object.keys(value).length <= 50) }).strict(),
]));

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.string().max(16_384), z.number().finite(), z.boolean(),
  z.array(jsonSchema).max(1000), z.record(key, jsonSchema).refine(value => Object.keys(value).length <= 50),
]));
export const actionBindingSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), path: z.array(key).min(1).max(6), format: z.enum(["value", "csv", "json"]).optional(), omitIfMissing: z.boolean().optional() }).strict(),
  z.object({ from: z.literal("warehouse"), format: z.literal("value").optional() }).strict(),
  z.object({ from: z.literal("constant"), value: jsonSchema, format: z.enum(["value", "csv", "json"]).optional() }).strict(),
]);
export type ActionBinding = z.infer<typeof actionBindingSchema>;
export const integrationActionSchema = z.object({
  integrationId: id, key: actionKey, name: z.string().trim().min(1).max(120),
  adapterId: id, adapterVersion: z.number().int().positive(),
  origin: z.string().max(300), pagePathPrefix: z.string().max(512),
  effect: z.enum(["read", "write", "print"]), requiredCapability: capability,
  inputs: z.record(key, contractSchema).refine(value => Object.keys(value).length <= 32), output: contractSchema,
  request: z.object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().max(1024),
    query: z.record(key, actionBindingSchema).default({}),
    body: z.object({ encoding: z.enum(["json", "form"]), fields: z.record(key, actionBindingSchema).refine(value => Object.keys(value).length <= 50) }).strict().optional(),
  }).strict(),
  limits: z.object({
    timeoutMs: z.number().int().min(100).max(60_000), maxInputBytes: z.number().int().min(1).max(65_536),
    maxResponseBytes: z.number().int().min(1).max(4 * 1024 * 1024),
    maxConcurrent: z.number().int().min(1).max(4), maxQueued: z.number().int().min(0).max(32),
    heartbeatMaxAgeMs: z.number().int().min(1000).max(120_000), identityMaxAgeMs: z.number().int().min(1000).max(3_600_000),
  }).strict(),
}).strict();
export type IntegrationActionDefinition = z.infer<typeof integrationActionSchema>;
export type IntegrationEffect = IntegrationActionDefinition["effect"];

/** Page-reported location is context only. The installed adapter must check its real page independently. */
export function exactIntegrationOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new IntegrationDefinitionError("Use an exact HTTPS integration origin."); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || /[*\s]/.test(value)) throw new IntegrationDefinitionError("Use an exact HTTPS integration origin without path, credentials or wildcard.");
  return url.origin;
}
export function boundedIntegrationPath(value: string, template = false): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\?#\s\u0000-\u001f\u007f*]/.test(value)) throw new IntegrationDefinitionError("Use a bounded same-origin path without query, fragment or traversal.");
  const withoutBindings = template ? value.replace(/\{([A-Za-z][A-Za-z0-9_-]{0,63})\}/g, "input") : value;
  if (/[{}]/.test(withoutBindings)) throw new IntegrationDefinitionError("Invalid path binding.");
  for (const part of withoutBindings.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { throw new IntegrationDefinitionError("Invalid path encoding."); }
    if ([".", ".."].includes(decoded) || /[\\/%?#\u0000-\u001f\u007f]/.test(decoded)) throw new IntegrationDefinitionError("Path encoding cannot alter routing.");
  }
  return value;
}
export function integrationPathMatches(path: string, prefix: string): boolean {
  boundedIntegrationPath(path); boundedIntegrationPath(prefix);
  const normalized = prefix === "/" ? prefix : prefix.replace(/\/$/, "");
  return normalized === "/" || path === normalized || path.startsWith(normalized + "/");
}

function boundedJson(value: unknown, maxBytes: number): asserts value is JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 12) throw new IntegrationDefinitionError("JSON exceeds the bounded size or nesting limit.");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) return;
    if (!entry || typeof entry !== "object" || seen.has(entry) || (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))) throw new IntegrationDefinitionError("Use ordinary acyclic JSON values.");
    seen.add(entry);
    if (Array.isArray(entry) && Object.keys(entry).length !== entry.length) throw new IntegrationDefinitionError("Use dense JSON arrays.");
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
      if (Array.isArray(entry) && name === "length") continue;
      if (!("value" in descriptor) || (!Array.isArray(entry) && (dangerousKeys.has(name.toLowerCase()) || credentialKeys.has(name.toLowerCase().replace(/[-_]/g, ""))))) throw new IntegrationDefinitionError("Credentials, accessors and prototype fields are not action data.");
      visit(descriptor.value, depth + 1);
    }
    seen.delete(entry);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) throw new IntegrationDefinitionError("JSON exceeds the configured byte limit.");
}

function inspectContract(value: ValueContract, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 200 || depth > 6) throw new IntegrationDefinitionError("Type contracts exceed the bounded size or nesting limit.");
  if ((value.type === "number" || value.type === "integer") && value.min !== undefined && value.max !== undefined && value.min > value.max) throw new IntegrationDefinitionError("Contract minimum exceeds its maximum.");
  if (value.type === "array") inspectContract(value.items, depth + 1, budget);
  if (value.type === "object") for (const child of Object.values(value.fields)) inspectContract(child, depth + 1, budget);
}
function inputContract(definition: IntegrationActionDefinition, path: string[]): ValueContract {
  let result = definition.inputs[path[0]];
  for (const segment of path.slice(1)) {
    if (!result || result.type !== "object") throw new IntegrationDefinitionError("A mapping references an unknown input field.");
    result = result.fields[segment];
  }
  if (!result) throw new IntegrationDefinitionError("A mapping references an unknown input field.");
  return result;
}
export function validateIntegrationAction(input: unknown): IntegrationActionDefinition {
  boundedJson(input, 131_072);
  const result = integrationActionSchema.safeParse(input);
  if (!result.success) throw new IntegrationDefinitionError("Invalid integration action fields or limits.");
  const definition = result.data;
  exactIntegrationOrigin(definition.origin); boundedIntegrationPath(definition.pagePathPrefix); boundedIntegrationPath(definition.request.path, true);
  for (const field of Object.values(definition.inputs)) inspectContract(field);
  inspectContract(definition.output);
  if (["GET", "HEAD"].includes(definition.request.method) && definition.request.body) throw new IntegrationDefinitionError("GET/HEAD action definitions cannot carry a body.");
  for (const [, name] of definition.request.path.matchAll(/\{([^}]+)\}/g)) {
    const field = inputContract(definition, [name]);
    if (field.optional || ["array", "object"].includes(field.type)) throw new IntegrationDefinitionError("Path bindings require a required scalar input.");
  }
  for (const binding of [...Object.values(definition.request.query), ...Object.values(definition.request.body?.fields ?? {})]) if (binding.from === "input") inputContract(definition, binding.path);
  return definition;
}

function validateValue(value: unknown, contract: ValueContract, path: string): JsonValue | undefined {
  if (value === undefined) { if (contract.optional) return undefined; throw new IntegrationDefinitionError(`Missing required field ${path}.`); }
  if (contract.type === "string") {
    if (typeof value !== "string" || value.length > (contract.maxLength ?? 16_384) || (contract.values && !contract.values.includes(value))) throw new IntegrationDefinitionError(`Invalid string field ${path}.`);
    return value;
  }
  if (contract.type === "boolean") { if (typeof value !== "boolean") throw new IntegrationDefinitionError(`Invalid boolean field ${path}.`); return value; }
  if (contract.type === "number" || contract.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (contract.type === "integer" && !Number.isSafeInteger(value)) || (contract.min !== undefined && value < contract.min) || (contract.max !== undefined && value > contract.max)) throw new IntegrationDefinitionError(`Invalid numeric field ${path}.`);
    return value;
  }
  if (contract.type === "array") {
    if (!Array.isArray(value) || value.length > (contract.maxItems ?? 1000)) throw new IntegrationDefinitionError(`Invalid array field ${path}.`);
    return value.map((entry, index) => { const parsed = validateValue(entry, contract.items, `${path}[${index}]`); if (parsed === undefined) throw new IntegrationDefinitionError("Array entries cannot be missing."); return parsed; });
  }
  if (contract.type !== "object" || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(name => !Object.hasOwn(contract.fields, name))) throw new IntegrationDefinitionError(`Unknown or invalid object fields at ${path}.`);
  return Object.fromEntries(Object.entries(contract.fields).flatMap(([name, field]) => { const parsed = validateValue((value as Record<string, unknown>)[name], field, `${path}.${name}`); return parsed === undefined ? [] : [[name, parsed]]; }));
}
export function validateActionInputs(definition: IntegrationActionDefinition, input: unknown): Record<string, JsonValue> {
  boundedJson(input, definition.limits.maxInputBytes);
  return validateValue(input, { type: "object", fields: definition.inputs }, "input") as Record<string, JsonValue>;
}
/** The adapter parses its evidenced response format first; this never fetches or evaluates an XML/JSON expression. */
export function validateActionOutput(definition: IntegrationActionDefinition, output: unknown): JsonValue {
  boundedJson(output, definition.limits.maxResponseBytes);
  const parsed = validateValue(output, definition.output, "output");
  if (parsed === undefined) throw new IntegrationDefinitionError("An action output cannot be missing.");
  return parsed;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entry]) => `${JSON.stringify(name)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function integrationContentHash(value: unknown): Promise<string> {
  boundedJson(value, 4 * 1024 * 1024);
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}
export async function integrationActionHash(input: unknown): Promise<string> { return integrationContentHash(validateIntegrationAction(input)); }

export type MappedActionRequest = { origin: string; path: string; method: IntegrationActionDefinition["request"]["method"]; body?: string; contentType?: "application/json" | "application/x-www-form-urlencoded"; timeoutMs: number; maxResponseBytes: number };
export function mapActionRequest(definition: IntegrationActionDefinition, input: unknown, verifiedWarehouseValue: string): MappedActionRequest {
  const values = validateActionInputs(definition, input);
  const read = (binding: ActionBinding): JsonValue | undefined => {
    let value: JsonValue | undefined;
    if (binding.from === "constant") value = binding.value;
    else if (binding.from === "warehouse") value = verifiedWarehouseValue;
    else {
      value = values[binding.path[0]];
      for (const segment of binding.path.slice(1)) value = value && typeof value === "object" && !Array.isArray(value) ? value[segment] : undefined;
      if (value === undefined) { if (binding.omitIfMissing) return undefined; throw new IntegrationDefinitionError("A mapped input is missing."); }
    }
    if (binding.format === "json") return JSON.stringify(value);
    if (binding.format === "csv") {
      if (!Array.isArray(value) || value.some(entry => entry === null || typeof entry === "object" || String(entry).includes(","))) throw new IntegrationDefinitionError("CSV bindings require scalar values without embedded commas.");
      return value.join(",");
    }
    return value;
  };
  const path = definition.request.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || typeof value === "object" || /[\\/%?#\u0000-\u001f\u007f]/.test(String(value)) || [".", ".."].includes(String(value))) throw new IntegrationDefinitionError("A path input cannot alter routing.");
    return encodeURIComponent(String(value));
  });
  boundedIntegrationPath(path);
  const query = new URLSearchParams();
  for (const [name, binding] of Object.entries(definition.request.query)) {
    const value = read(binding); if (value === undefined) continue;
    if (value !== null && typeof value === "object") throw new IntegrationDefinitionError("Query object/array values need an explicit JSON or CSV format.");
    query.set(name, value === null ? "" : String(value));
  }
  let body: string | undefined, contentType: MappedActionRequest["contentType"];
  if (definition.request.body) {
    const fields = Object.fromEntries(Object.entries(definition.request.body.fields).flatMap(([name, binding]) => { const value = read(binding); return value === undefined ? [] : [[name, value]]; }));
    if (definition.request.body.encoding === "json") { body = JSON.stringify(fields); contentType = "application/json"; }
    else {
      if (Object.values(fields).some(value => value !== null && typeof value === "object")) throw new IntegrationDefinitionError("Form object/array values need an explicit JSON or CSV format.");
      body = new URLSearchParams(Object.entries(fields).map(([name, value]) => [name, value === null ? "" : String(value)])).toString(); contentType = "application/x-www-form-urlencoded";
    }
    if (new TextEncoder().encode(body).length > definition.limits.maxInputBytes) throw new IntegrationDefinitionError("Mapped request body exceeds its byte limit.");
  }
  const mappedPath = path + (query.size ? `?${query}` : "");
  if (new TextEncoder().encode(mappedPath).length > definition.limits.maxInputBytes) throw new IntegrationDefinitionError("Mapped request path exceeds its byte limit.");
  return { origin: exactIntegrationOrigin(definition.origin), path: mappedPath, method: definition.request.method, ...(body === undefined ? {} : { body, contentType }), timeoutMs: definition.limits.timeoutMs, maxResponseBytes: definition.limits.maxResponseBytes };
}
