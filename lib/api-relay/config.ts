import { validateRequest } from "../../scripts/api-relay/protocol.mjs";

type Operation = { label: string; method?: string; path: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; defaults?: Record<string, string | number | boolean> };
export function dmpConfig() {
  const origins = (process.env.DMP_ORIGINS ?? "https://dmp.extapps.homedepot.com").split(",").map((s) => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost"))) throw new Error("DMP_ORIGINS must contain exact HTTPS origins.");
  }
  const path = process.env.DMP_IDENTITY_PATH ?? "/identity/me";
  const subjectPath = process.env.DMP_IDENTITY_SUBJECT_PATH ?? "subject";
  const configured = origins.length > 0 && !!path && /^[a-zA-Z0-9_.-]{1,200}$/.test(subjectPath);
  const identity = configured ? validateRequest({ path, timeoutMs: 10000 }) : null;
  const operations: Record<string, Operation> = {
    session: { label: "Check DMP session", path },
    deliveries: { label: "Deliveries by date and location", path: "/api/dashboard/v1/driversDeliveries?DeliveryDate={deliveryDate}&LocationNumber={locationNumber}", defaults: { locationNumber: "5288" } },
  };
  if (process.env.DMP_API_OPERATIONS) {
    const extra: unknown = JSON.parse(process.env.DMP_API_OPERATIONS);
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("DMP_API_OPERATIONS must be an object.");
    for (const [name, value] of Object.entries(extra)) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || name === "session" || !value || typeof value !== "object") throw new Error("Invalid DMP operation.");
      const op = value as Operation;
      if (typeof op.label !== "string" || !op.label || op.label.length > 100) throw new Error("DMP operations need a label.");
      validateRequest({ method: op.method || "GET", path: op.path, headers: op.headers || {}, ...(op.body === undefined ? {} : { body: JSON.stringify(op.body) }), timeoutMs: op.timeoutMs || 30000 });
      operations[name] = op;
    }
  }
  return { origins, identity, subjectPath, configured, operations };
}

// Requesters choose a named operation and scalar parameters. HTTP methods,
// destinations and payload shapes are owned by the server, never the snippet.
export function buildDmpRequest(name: string, input: unknown = {}) {
  const config = dmpConfig();
  if (!config.configured) throw new Error("DMP API relay is not configured.");
  if (!Object.hasOwn(config.operations, name)) throw new Error("Unknown DMP operation.");
  const op = config.operations[name];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 50) throw new Error("Parameters must be an object.");
  const params = { ...op.defaults, ...input as Record<string, unknown> };
  const parameter = (key: string) => {
    const value = params[key];
    if (!Object.hasOwn(params, key) || !["string", "number", "boolean"].includes(typeof value) || String(value).length > 8192) throw new Error(`Missing or invalid parameter: ${key}`);
    return value;
  };
  const path = op.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => encodeURIComponent(String(parameter(key))));
  const bodyValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bodyValue);
    if (value && typeof value === "object") {
      if (Object.keys(value).length === 1 && Object.hasOwn(value, "$param")) return parameter(String((value as Record<string, unknown>).$param));
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bodyValue(entry)]));
    }
    return value;
  };
  return validateRequest({ method: op.method || "GET", path, headers: op.headers || {}, ...(op.body === undefined ? {} : { body: JSON.stringify(bodyValue(op.body)) }), timeoutMs: op.timeoutMs || 30000 });
}
