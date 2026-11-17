import { Script } from "node:vm";
import { z } from "zod";
import { validateRequest, relayPathMatches } from "@/scripts/api-relay/protocol.mjs";
import type { Operation } from "./config";

export class RelayError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export { DEFAULT_RELAY_PROGRAM } from "./default-program";

export const relayFields = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  origins: z.array(z.string().max(300)).min(1).max(20),
  pathPrefix: z.string().max(512),
  identityPath: z.string().min(1).max(8192),
  subjectPath: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/),
  operations: z.record(z.string(), z.unknown()),
  program: z.string().min(1).max(100000),
}).strict();
export const relaySaveInput = relayFields.extend({ expectedRevision: z.number().int().nonnegative(), operationId: z.uuid() }).strict();
export type RelayFields = Omit<z.infer<typeof relayFields>, "operations"> & { operations: Record<string, Operation> };
export type RelayDefinition = RelayFields & { revision: number };

export function exactRelayOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new RelayError("Use an exact HTTPS origin, for example https://system.example.com."); }
  const local = (process.env.NODE_ENV !== "production" || process.env.API_RELAY_ALLOW_LOCALHOST === "1") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.hostname.includes("*") || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new RelayError("Use exact HTTPS origins without paths, wildcards, credentials or trailing slashes.");
  return value;
}

export function exactRelayPath(value: string, prefix = false) {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s?#]|%(?:2e|2f|5c)/i.test(value) || value.length > 2048) throw new RelayError("Use a plain URL pathname without query strings, fragments or encoded path separators.");
  if (new URL(value, "https://relay.invalid").pathname !== value) throw new RelayError("Use a canonical URL pathname.");
  return prefix && value !== "/" ? value.replace(/\/+$/, "") : value;
}

export function validateRelayFields(input: unknown): RelayFields {
  const result = relayFields.safeParse(input);
  if (!result.success) throw new RelayError(result.error.issues[0]?.message || "Invalid relay definition.");
  const fields = result.data;
  const origins = [...new Set(fields.origins.map(exactRelayOrigin))];
  const pathPrefix = exactRelayPath(fields.pathPrefix || "/", true);
  validateRequest({ path: fields.identityPath, method: "GET", timeoutMs: 10000 });
  const entries = Object.entries(fields.operations);
  if (!entries.length || entries.length > 64 || JSON.stringify(fields.operations).length > 100000) throw new RelayError("Define 1–64 named operations, up to 100 KB total.");
  for (const [id, value] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("Each operation needs a stable name and request definition.");
    const op = value as Operation;
    if (typeof op.label !== "string" || !op.label.trim() || op.label.length > 100) throw new RelayError("Each operation needs a label of up to 100 characters.");
    validateRequest({ method: op.method || "GET", path: op.path, headers: op.headers || {}, ...(op.body === undefined ? {} : { body: JSON.stringify(op.body) }), timeoutMs: op.timeoutMs ?? 30000 });
    if (op.defaults && (typeof op.defaults !== "object" || Array.isArray(op.defaults) || Object.values(op.defaults).some(value => !["string", "number", "boolean"].includes(typeof value)))) throw new RelayError("Operation defaults must contain scalar parameters.");
  }
  try {
    // Compile only. Admin code is never executed in the application process.
    new Script(`(()=>{${fields.program}\nif(typeof startTemcoSiteRelay!=="function")throw new Error();})()`);
    if (!/\bfunction\s+startTemcoSiteRelay\s*\(/.test(fields.program)) throw new Error();
  } catch { throw new RelayError("The injection must compile and define function startTemcoSiteRelay(config)."); }
  return { ...fields, origins, pathPrefix, operations: fields.operations as Record<string, Operation> };
}

export function relayDefinitionsOverlap(a: Pick<RelayFields, "origins" | "pathPrefix">, b: Pick<RelayFields, "origins" | "pathPrefix">) {
  return a.origins.some(origin => b.origins.includes(origin)) && (relayPathMatches(a.pathPrefix, b.pathPrefix) || relayPathMatches(b.pathPrefix, a.pathPrefix));
}

export function resolveRelayDefinition(definitions: RelayDefinition[], origin: string, pathname: string) {
  exactRelayOrigin(origin); exactRelayPath(pathname);
  const matches = definitions.filter(definition => definition.origins.includes(origin) && relayPathMatches(pathname, definition.pathPrefix));
  if (matches.length !== 1 || !matches[0].enabled) throw new RelayError("No enabled API relay is configured for this page. Ask an administrator to configure its exact site and path.", 404);
  return matches[0];
}
