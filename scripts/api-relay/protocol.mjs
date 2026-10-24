export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_CONCURRENT = 4;
export const MAX_QUEUE = 32;
// Allow for background browser timer throttling while retaining bounded expiry.
export const LEASE_MS = 120000;

// This validator is shared by the broker and the served executor. Only data,
// never JavaScript, crosses the request protocol.
export function validateRequest(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid API request.");
  const { method = "GET", path, headers = {}, body, timeoutMs = 30000 } = value;
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) throw new Error("Unsupported HTTP method.");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\\s#]/.test(path) || path.length > 8192) throw new Error("Use a DMP-relative API path.");
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 32) throw new Error("Invalid API headers.");
  for (const [key, val] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || /^(cookie|host|origin|referer|authorization|proxy-|sec-)/i.test(key) || typeof val !== "string" || /[\r\n]/.test(val) || val.length > 4096) throw new Error("Unsupported API header.");
  }
  if (body !== undefined && (typeof body !== "string" || ["GET", "HEAD"].includes(method))) throw new Error("Invalid request body.");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_REQUEST_BYTES) throw new Error("API request is too large.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error("Invalid API timeout.");
  return { method, path, headers, ...(body === undefined ? {} : { body }), timeoutMs };
}

export function subjectFromBody(body, subjectPath) {
  let value = JSON.parse(body);
  for (const key of subjectPath.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("DMP identity is missing.");
    value = value[key];
  }
  if (!["string", "number"].includes(typeof value) || String(value).length === 0 || String(value).length > 256) throw new Error("Invalid DMP identity.");
  return String(value);
}
