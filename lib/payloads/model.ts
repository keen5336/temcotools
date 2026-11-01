import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { z } from "zod";
import { PAYLOAD_PURPOSES, MAX_PAYLOAD_BYTES } from "./types";
export { PAYLOAD_PURPOSES, DEFAULT_DMP_PAYLOAD_ID, MAX_PAYLOAD_BYTES, sourceChanges } from "./types";

export const payloadIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
export class PayloadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "PayloadError"; }
}

export const payloadDraftInput = z.object({
  name: z.string().trim().min(1).max(100),
  purpose: z.enum(PAYLOAD_PURPOSES),
  targetOrigins: z.array(z.string().max(300).describe("Exact approved HTTPS origin without paths, queries, fragments or wildcards; HTTP loopback is development-only.")).min(1).max(8),
  source: z.string().min(1).max(MAX_PAYLOAD_BYTES).describe("Trusted integration source, at most 128 KiB UTF-8; never include credentials, customer data or private notes. Validation compiles without executing."),
  protocolVersion: z.literal(1).default(1),
  operationNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32).default([]),
});
export type PayloadDraft = z.infer<typeof payloadDraftInput>;
export function validatePayloadDraft(input: unknown): PayloadDraft {
  const parsed = payloadDraftInput.safeParse(input);
  if (!parsed.success) throw new PayloadError("Enter a name, known purpose, exact target origins and valid source settings.");
  const data = parsed.data;
  if (Buffer.byteLength(data.source, "utf8") > MAX_PAYLOAD_BYTES) throw new PayloadError("Payload source must be at most 128 KiB.");
  const targetOrigins = [...new Set(data.targetOrigins.map(origin => {
    try {
      const url = new URL(origin);
      const local = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.origin !== origin || url.hostname.includes("*") || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error();
      return origin;
    } catch { throw new PayloadError("Targets must be exact HTTPS origins, without paths or wildcards."); }
  }))];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,}/.test(data.source)) {
    throw new PayloadError("Remove credential-like literals before saving payload source.");
  }
  try { new Script(`(()=>{const TEMCO_PAYLOAD=Object.freeze({});\n${data.source}\n})();`, { filename: "payload-draft.js" }); }
  catch { throw new PayloadError("Source does not compile as a browser script body. Preview uses synthetic data only."); }
  return { ...data, targetOrigins, operationNames: [...new Set(data.operationNames)] };
}
export function payloadContentHash(draft: PayloadDraft) {
  return createHash("sha256").update(JSON.stringify({ purpose: draft.purpose, targetOrigins: draft.targetOrigins, source: draft.source, protocolVersion: draft.protocolVersion, operationNames: draft.operationNames })).digest("hex");
}

export interface PublishedPayloadVersion extends Omit<PayloadDraft, "name"> {
  id: string;
  payloadId: string;
  version: number;
  contentHash: string;
}
export function renderPayloadVersion(version: PublishedPayloadVersion) {
  const metadata = { payloadId: version.payloadId, versionId: version.id, version: version.version, contentHash: version.contentHash, purpose: version.purpose, protocolVersion: version.protocolVersion, operationNames: version.operationNames };
  // TEMCO_PAYLOAD is invocation-local metadata, not a credential or mutable
  // global. The trusted payload may read it; the broker must authorize it.
  return `(()=>{const TEMCO_PAYLOAD=Object.freeze(${JSON.stringify(metadata)});if(!${JSON.stringify(version.targetOrigins)}.includes(location.origin)){alert('Temco '+TEMCO_PAYLOAD.payloadId+' v'+TEMCO_PAYLOAD.version+' is not approved for this page origin.');return;}\n${version.source}\n})();`;
}
export function buildPayloadBookmarklet(loaderUrl: string) {
  const url = new URL(loaderUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new PayloadError("Use an HTTPS loader URL.");
  return `javascript:(()=>{var s=document.createElement('script');s.src=${JSON.stringify(url.href)}+'?t='+Date.now();s.onerror=()=>alert('Temco payload could not load. Check the page policy and connection.');(document.head||document.documentElement).appendChild(s)})();`;
}
