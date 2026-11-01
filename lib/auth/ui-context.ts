import { createHmac, timingSafeEqual } from "node:crypto";
import { isLiveSessionClaim, type SessionClaim } from "./principal";

// This is a rejection-only fingerprint, never a credential or permission. It
// excludes mutable relay fields and cookie ciphertext so pairing/resealing the
// same individual session does not change the tab's expected identity.
export function createUiContext(claim: SessionClaim | null | undefined): string | null {
  if (!claim || !isLiveSessionClaim(claim)) return null;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("UI session binding is unavailable.");
  const identity = JSON.stringify([claim.userId, claim.sessionId, claim.authVersion]);
  return "uc1_" + createHmac("sha256", secret).update("temcotools-ui-context-v1\0").update(identity).digest("base64url");
}
export function matchesUiContext(supplied: string | null, expected: string): boolean {
  return Boolean(supplied && /^uc1_[A-Za-z0-9_-]{43}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)));
}
