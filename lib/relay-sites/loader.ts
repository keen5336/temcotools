import { renderPayloadVersion } from "@/lib/payloads/model";
import { executablePayloadResponse } from "@/lib/payloads/http";
import { resolveSitePayload } from "./service";
import { SiteProfileError } from "./types";
export { connectTemcoBookmarklet } from "./model";
export async function loadSitePayload(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.getAll("origin").length !== 1 || url.searchParams.getAll("pathname").length !== 1) throw new SiteProfileError("Provide only the current origin and pathname.");
    const resolved = await resolveSitePayload(Object.fromEntries(url.searchParams));
    return executablePayloadResponse(renderPayloadVersion(resolved.version, resolved.profileBinding));
  } catch (error) {
    const known = error instanceof SiteProfileError;
    const response = executablePayloadResponse(`alert(${JSON.stringify(known ? error.message : "Connect Temco is unavailable. No adapter was selected or work retried.")});`);
    response.headers.set("X-Temco-Connect-State", known ? error.code : "site_unavailable");
    return response;
  }
}
