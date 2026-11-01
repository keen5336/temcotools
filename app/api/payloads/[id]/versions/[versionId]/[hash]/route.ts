import { getPublishedVersion } from "@/lib/payloads/service";
import { renderPayloadVersion } from "@/lib/payloads/model";
import { executablePayloadResponse, payloadFailure } from "@/lib/payloads/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; versionId: string; hash: string }> }) {
  try {
    const input = await params;
    const version = await getPublishedVersion(input.id, input.versionId, input.hash);
    return executablePayloadResponse(renderPayloadVersion(version), true);
  } catch (error) { return payloadFailure(error); }
}
