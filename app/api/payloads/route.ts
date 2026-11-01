import { getCurrentPrincipal } from "@/lib/auth";
import { createPayload, getBuiltinPayloadSources, listPayloads, previewPayloadDraft } from "@/lib/payloads/service";
import { buildPayloadBookmarklet } from "@/lib/payloads/model";
import { payloadReply, payloadFailure, readPayloadBody } from "@/lib/payloads/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    const payloads = await listPayloads(principal);
    const url = new URL(request.url);
    const origin = new URL(process.env.NEXT_PUBLIC_APP_URL || url.origin).origin;
    return payloadReply({ payloads: payloads.map(payload => ({ ...payload, loaderUrl: `${origin}/api/payloads/${payload.id}/loader`, bookmarklet: buildPayloadBookmarklet(`${origin}/api/payloads/${payload.id}/loader`) })), ...await getBuiltinPayloadSources(principal, origin) });
  } catch (error) { return payloadFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    const input = await readPayloadBody(request);
    if (input.action === "preview") return payloadReply(previewPayloadDraft(principal, input));
    return payloadReply(await createPayload(principal, input), 201);
  } catch (error) { return payloadFailure(error); }
}
