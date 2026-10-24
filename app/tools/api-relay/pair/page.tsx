import { getSession } from "@/lib/auth";
import { dmpConfig } from "@/lib/api-relay/config";
import ApiRelayPairClient from "@/components/api-relay/ApiRelayPairClient";

export default async function ApiRelayPairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const origin = typeof query.origin === "string" ? query.origin : "";
  const nonce = typeof query.nonce === "string" ? query.nonce : "";
  const config = dmpConfig();
  const session = await getSession();
  return <ApiRelayPairClient origin={origin} nonce={nonce} allowed={config.configured && config.origins.includes(origin) && /^[a-f0-9-]{36}$/i.test(nonce)} displayName={session.userId && session.isActive ? session.displayName : null} />;
}
