import { apiRelayControl, type RelayOwner } from "./control";
import { listRelayDefinitions, validateRelayBinding } from "./definitions";
import { buildRelayRequest } from "./config";
import { RelayError, resolveRelayDefinition } from "./model";
import type { RelayConnection, RelayStatus } from "./types";
import { livePasswordSession } from "@/lib/auth/sessions";

export async function relayConnections(owner: RelayOwner): Promise<RelayConnection[]> {
  return (await apiRelayControl("connections", owner)).connections;
}

export async function getRelayStatus(owner: RelayOwner): Promise<RelayStatus> {
  const definitions = await listRelayDefinitions();
  const summaries = definitions.filter(row => row.enabled).map(row => ({ id: row.id, name: row.name, origins: row.origins, pathPrefix: row.pathPrefix, operations: Object.entries(row.operations).map(([id, op]) => ({ id, label: op.label })) }));
  try {
    const connections = await relayConnections(owner);
    const current: RelayConnection[] = [];
    for (const connection of connections) {
      try {
        const rule = resolveRelayDefinition(definitions, connection.origin, connection.pathname);
        if (rule.id !== connection.relayId || rule.revision !== connection.relayRevision) throw new Error();
        if (!connection.creatingSessionId || !await livePasswordSession(connection.creatingSessionId, owner.userId)) throw new Error();
        current.push(connection);
      } catch { await apiRelayControl("disconnect", owner, { connectionId: connection.id }); }
    }
    return { userId: owner.userId, definitions: summaries, connections: current, serviceError: null };
  } catch { return { userId: owner.userId, definitions: summaries, connections: [], serviceError: "API relay service is unavailable. Connection status could not be confirmed." }; }
}

// Shared entry point for any authenticated Temco server page/route. Clients
// select a connection and named operation; they never supply an arbitrary URL.
export async function requestViaRelay(owner: RelayOwner, connectionId: string, operation: string, input: unknown = {}) {
  const connection = (await relayConnections(owner)).find(row => row.id === connectionId);
  if (!connection) throw new RelayError("Select one of your connected API relays.", 404);
  const definition = await validateRelayBinding({ ...connection, owner: { userId: owner.userId, sessionId: connection.creatingSessionId } });
  const request = buildRelayRequest(definition.operations, operation, input);
  return apiRelayControl("request", owner, { connectionId, request });
}
