import { getCurrentPrincipal } from "@/lib/auth";
import { listPayloadVersions } from "@/lib/payloads/service";
import { payloadReply, payloadFailure } from "@/lib/payloads/http";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return payloadReply({ error: "Sign in required." }, 401);
    const raw = new URL(request.url).searchParams.get("before");
    return payloadReply(await listPayloadVersions(principal, (await params).id, raw === null ? undefined : Number(raw)));
  } catch (error) { return payloadFailure(error); }
}
