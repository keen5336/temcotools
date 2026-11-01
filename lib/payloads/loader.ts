import { resolvePublishedPayload } from "./service";
import { DEFAULT_DMP_PAYLOAD_ID, PayloadError } from "./model";
import { builtinDmpSource } from "./builtin";
import { executablePayloadResponse, payloadFailure, payloadLoaderSource } from "./http";
export async function loadPublishedPayload(request: Request, payloadId: string) {
  try {
    const result = await resolvePublishedPayload(payloadId);
    const origin = new URL(process.env.API_RELAY_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || request.url).origin;
    if (result.state === "published") return executablePayloadResponse(payloadLoaderSource(`${origin}/api/payloads/${payloadId}/versions/${result.version.id}/${result.version.contentHash}`));
    if ((result.state === "absent" || result.state === "unpublished") && payloadId === DEFAULT_DMP_PAYLOAD_ID) return executablePayloadResponse(builtinDmpSource(origin).source);
    throw new PayloadError(result.state === "disabled" ? "This payload is disabled." : "No published payload is available.", 404);
  } catch (error) { return payloadFailure(error); }
}
