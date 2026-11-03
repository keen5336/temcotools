import { getSession } from "@/lib/auth";
import ProviderConnectClient from "./ProviderConnectClient";
export default async function ProviderConnectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams, session = await getSession();
  const origin = typeof query.origin === "string" ? query.origin : "", pathname = typeof query.pathname === "string" ? query.pathname : "";
  const nonce = typeof query.nonce === "string" ? query.nonce : "", payload = typeof query.payload === "string" && Buffer.byteLength(query.payload) <= 8192 ? query.payload : "";
  const allowed = /^[a-f0-9-]{36}$/i.test(nonce) && !!payload && origin.length <= 300 && pathname.startsWith("/") && pathname.length <= 2048;
  return <ProviderConnectClient allowed={allowed} origin={origin} pathname={pathname} nonce={nonce} payload={payload} displayName={session.userId && session.isActive ? session.displayName : null} />;
}
