import { createHash } from "node:crypto";
import { z } from "zod";
import { dmpConfig } from "./config";
import { getPublishedVersion, resolvePublishedPayload } from "@/lib/payloads/service";
import { siteProfileBindingInput, type SiteProfileBinding } from "@/lib/relay-sites/types";
import { verifySiteProfileBinding } from "@/lib/relay-sites/service";
import { assertSiteProfileSourceContract } from "@/lib/relay-sites/contract";

const referenceSchema = z.object({ payloadId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/), versionId: z.string().min(1).max(100), contentHash: z.string().regex(/^[a-f0-9]{64}$/), profileBinding: siteProfileBindingInput.optional() });
export type DmpPayloadGrant = { payloadId: string; versionId: string; contentHash: string; protocolVersion: number; operationNames: string[]; operationConfigHash: string; profileBinding?: SiteProfileBinding };
export const dmpOperationConfigHash = () => createHash("sha256").update(JSON.stringify(dmpConfig().operations)).digest("hex");
export function builtinDmpGrant(): DmpPayloadGrant {
  const config = dmpConfig();
  return { payloadId: "dmp-relay", versionId: "builtin", contentHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"), protocolVersion: 1, operationNames: Object.keys(config.operations), operationConfigHash: dmpOperationConfigHash() };
}
export async function authorizeDmpPayload(reference: unknown, origin: string): Promise<DmpPayloadGrant> {
  const parsed = reference === undefined || reference === null ? builtinDmpGrant() : referenceSchema.parse(reference);
  const state = await resolvePublishedPayload(parsed.payloadId);
  if (state.state === "disabled") throw new Error("This payload was disabled. Reconnect after administrator review.");
  const currentProtocol = state.state === "published" ? state.version.protocolVersion : 1;
  const profileBinding = "profileBinding" in parsed ? parsed.profileBinding : undefined;
  if (profileBinding) {
    if (parsed.versionId === "builtin") throw new Error("Site profiles require an explicitly published adapter version; no builtin authority is inferred.");
    await verifySiteProfileBinding(profileBinding, parsed, origin, "dmp_relay");
  }
  if (parsed.versionId === "builtin") {
    const builtin = builtinDmpGrant();
    if (parsed.payloadId !== "dmp-relay" || parsed.contentHash !== builtin.contentHash || currentProtocol !== 1 || !dmpConfig().origins.includes(origin)) throw new Error("DMP configuration or protocol changed. Load the bookmark again.");
    return builtin;
  }
  const version = await getPublishedVersion(parsed.payloadId, parsed.versionId, parsed.contentHash);
  if (profileBinding) assertSiteProfileSourceContract(version.purpose, version.source);
  if (version.purpose !== "dmp_relay" || version.protocolVersion !== 1 || !version.targetOrigins.includes(origin) || version.protocolVersion !== currentProtocol) throw new Error("This DMP payload version/origin is no longer authorized. Reconnect.");
  return { payloadId: version.payloadId, versionId: version.id, contentHash: version.contentHash, protocolVersion: version.protocolVersion, operationNames: version.operationNames, operationConfigHash: dmpOperationConfigHash(), ...(profileBinding ? { profileBinding } : {}) };
}
export async function verifyQueuedDmpPayload(reference: unknown, origin: string) {
  const captured = z.object({ operationConfigHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(reference);
  if (captured.operationConfigHash !== dmpOperationConfigHash()) throw new Error("Named operation configuration changed. Reconnect before new work; the queued intent was not dispatched.");
  return authorizeDmpPayload(reference, origin);
}
