import { getSession } from "@/lib/auth";
import { dmpConfig } from "@/lib/api-relay/config";
import ApiRelayPairClient from "@/components/api-relay/ApiRelayPairClient";

export default async function ApiRelayPairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const origin = typeof query.origin === "string" ? query.origin : "";
  const nonce = typeof query.nonce === "string" ? query.nonce : "";
  const config = dmpConfig();
  const session = await getSession();
  const payload = typeof query.payload === "string" && query.payload.length > 0 && Buffer.byteLength(query.payload) <= 8192 ? query.payload : undefined;
  // Never silently drop a supplied oversized/malformed binding and pair using
  // the legacy default instead. Actual payload/profile authority is checked by
  // the shared pair command after the human confirms.
  let validPayload = query.payload === undefined;
  if (payload) { try { const value = JSON.parse(payload); validPayload = Boolean(value && typeof value === "object" && !Array.isArray(value)); } catch { /* Invalid pairing metadata fails closed. */ } }
  return <ApiRelayPairClient payload={payload} origin={origin} nonce={nonce} allowed={validPayload && config.configured && config.origins.includes(origin) && /^[a-f0-9-]{36}$/i.test(nonce)} displayName={session.userId && session.isActive ? session.displayName : null} />;
}
