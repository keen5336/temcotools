import { getCurrentPrincipal } from "@/lib/auth";
import { getPayload, savePayloadDraft, publishPayload, rollbackPayload, setPayloadEnabled } from "@/lib/payloads/service";
import { PayloadError } from "@/lib/payloads/model";
import { payloadReply, payloadFailure, readPayloadBody } from "@/lib/payloads/http";

export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    return payloadReply(await getPayload(principal, (await params).id));
  } catch (error) { return payloadFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    const input = { ...await readPayloadBody(request), id: (await params).id };
    if (input.action === "save") return payloadReply(await savePayloadDraft(principal, input));
    if (input.action === "publish") return payloadReply(await publishPayload(principal, input));
    if (input.action === "rollback") return payloadReply(await rollbackPayload(principal, input));
    if (input.action === "enabled") return payloadReply(await setPayloadEnabled(principal, input));
    throw new PayloadError("Choose a known payload action.");
  } catch (error) { return payloadFailure(error); }
}
