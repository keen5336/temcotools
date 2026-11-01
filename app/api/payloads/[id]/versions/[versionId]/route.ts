import { getCurrentPrincipal } from "@/lib/auth";
import { getPayloadVersion } from "@/lib/payloads/service";
import { payloadReply, payloadFailure } from "@/lib/payloads/http";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    const input = await params;
    return payloadReply(await getPayloadVersion(principal, input.id, input.versionId));
  } catch (error) { return payloadFailure(error); }
}
