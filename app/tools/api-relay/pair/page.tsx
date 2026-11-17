import { getSession } from "@/lib/auth";
import { listRelayDefinitions } from "@/lib/api-relay/definitions";
import { resolveRelayDefinition } from "@/lib/api-relay/model";
import ApiRelayPairClient from "@/components/api-relay/ApiRelayPairClient";

export default async function ApiRelayPairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const origin = typeof query.origin === "string" ? query.origin : "";
  const nonce = typeof query.nonce === "string" ? query.nonce : "";
  const session = await getSession();
  const pathname = typeof query.pathname === "string" ? query.pathname : "/";
  let binding: { relayId: string; relayRevision: number; name: string } | null = null;
  try {
    const definition = resolveRelayDefinition(await listRelayDefinitions(), origin, pathname);
    const legacy = query.relayId === undefined;
    if ((legacy ? definition.id === "dmp" : definition.id === query.relayId && String(definition.revision) === query.relayRevision) && /^[a-f0-9-]{36}$/i.test(nonce)) binding = { relayId: definition.id, relayRevision: definition.revision, name: definition.name };
  } catch { /* Unsupported and stale links cannot pair. */ }
  return <ApiRelayPairClient origin={origin} pathname={pathname} nonce={nonce} binding={binding} displayName={session.userId && session.isActive ? session.displayName : null} />;
}
