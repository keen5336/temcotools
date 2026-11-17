import { NextRequest } from "next/server";
import { apiRelayControl } from "@/lib/api-relay/control";
import { listRelayDefinitions } from "@/lib/api-relay/definitions";
import { relayBody, relayFailure, relayReply, relayUser } from "@/lib/api-relay/http";
import { RelayError, resolveRelayDefinition } from "@/lib/api-relay/model";
import { getRelayStatus, requestViaRelay } from "@/lib/api-relay/service";

export const runtime = "nodejs";
export const maxDuration = 150;

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { session, user } = await relayUser(request);
    const { action } = await params;
    if (!["status", "pair", "lease", "request", "disconnect"].includes(action)) return relayReply({ error: "Unknown action." }, 404);
    if (action === "lease" && !session.apiRelaySessionId) return relayReply({ ok: true });
    const body = await relayBody(request);
    if (!session.apiRelaySessionId) {
      throw new RelayError("Sign in with your updated account before using relays.", 401);
    }
    const owner = { userId: user.id, sessionId: session.apiRelaySessionId };
    if (action === "status") return relayReply(await getRelayStatus(owner));
    if (action === "lease") return relayReply(await apiRelayControl("lease", owner));
    if (action === "pair") {
      // Old DMP bookmarks omit the binding. They can use only the current DMP
      // rule at /; the universal bookmark always supplies the exact revision.
      const origin = typeof body.origin === "string" ? body.origin : "";
      const pathname = typeof body.pathname === "string" ? body.pathname : "/";
      const definition = resolveRelayDefinition(await listRelayDefinitions(), origin, pathname);
      if (body.relayId === undefined ? definition.id !== "dmp" : body.relayId !== definition.id || body.relayRevision !== definition.revision) throw new RelayError("The relay rule changed. Run Connect Temco again.", 409);
      return relayReply(await apiRelayControl("pair", owner, { origin, pathname, relayId: definition.id, relayRevision: definition.revision, identity: { path: definition.identityPath, method: "GET", timeoutMs: 10000 }, subjectPath: definition.subjectPath }));
    }
    if (typeof body.connectionId !== "string" || body.connectionId.length > 100) throw new RelayError("Select an API relay connection.");
    if (action === "disconnect") return relayReply(await apiRelayControl("disconnect", owner, { connectionId: body.connectionId }));
    if (typeof body.operation !== "string") throw new RelayError("Select a named API operation.");
    return relayReply(await requestViaRelay(owner, body.connectionId, body.operation, body.input));
  } catch (error) { return relayFailure(error); }
}
