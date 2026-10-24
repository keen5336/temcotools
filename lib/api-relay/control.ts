import { createHash } from "node:crypto";

export type RelayOwner = { userId: string; sessionId: string };
export async function apiRelayControl(action: string, owner: RelayOwner, data: Record<string, unknown> = {}) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("API relay requires a configured session secret.");
  const key = createHash("sha256").update(`temco-api-relay-control-v1:${secret}`).digest("hex");
  const url = new URL("/control", process.env.API_RELAY_INTERNAL_URL || "http://127.0.0.1:3003");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Relay-Key": key }, body: JSON.stringify({ ...data, action, owner }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(action === "request" ? 130000 : 5000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "API relay failed."), { status: response.status });
  return result;
}

export async function revokeApiRelaySession(session: { userId?: string; apiRelaySessionId?: string }) {
  if (!session.userId || !session.apiRelaySessionId) return;
  try { await apiRelayControl("revoke", { userId: session.userId, sessionId: session.apiRelaySessionId }); }
  catch { /* An unreachable broker fails closed when its two-minute lease expires. */ }
}
