import { NextRequest } from "next/server";
import { getRelayManager, saveRelayDefinition } from "@/lib/api-relay/definitions";
import { relayBody, relayFailure, relayReply, relayUser } from "@/lib/api-relay/http";
import { RelayError } from "@/lib/api-relay/model";

export async function GET(request: NextRequest) {
  try {
    const { user } = await relayUser(request, false);
    return relayReply(await getRelayManager(user.id));
  } catch (error) { return relayFailure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await relayUser(request);
    if (user.role !== "admin") throw new RelayError("Only administrators can manage API relays.", 403);
    return relayReply({ definition: await saveRelayDefinition(user.id, await relayBody(request)) });
  } catch (error) { return relayFailure(error); }
}
