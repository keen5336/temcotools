import { getCurrentPrincipal } from "@/lib/auth";
import { listSiteProfiles, removeSiteProfile, saveSiteProfile, setSiteProfileEnabled } from "@/lib/relay-sites/service";
import { connectTemcoBookmarklet } from "@/lib/relay-sites/loader";
import { exactSiteOrigin, SiteProfileError } from "@/lib/relay-sites/types";
import { siteBody, siteFailure, siteReply } from "@/lib/relay-sites/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return siteReply({ error: "Sign in required." }, 401);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => !["afterId", "includeRemoved"].includes(key) || url.searchParams.getAll(key).length !== 1) || (url.searchParams.has("includeRemoved") && !["true", "false"].includes(url.searchParams.get("includeRemoved")!))) throw new SiteProfileError("Use the bounded mapping-list cursor/filter.");
    const origin = exactSiteOrigin(process.env.NEXT_PUBLIC_APP_URL || url.origin);
    return siteReply({ ...await listSiteProfiles(principal, { afterId: url.searchParams.get("afterId") ?? undefined, includeRemoved: url.searchParams.get("includeRemoved") === "true" }), loaderUrl: `${origin}/api/connect-temco/loader`, bookmarklet: connectTemcoBookmarklet(origin) });
  } catch (error) { return siteFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return siteReply({ error: "Sign in required." }, 401);
    const { action, ...input } = await siteBody(request);
    if (action === "save") return siteReply(await saveSiteProfile(principal, input));
    if (action === "enabled") return siteReply(await setSiteProfileEnabled(principal, input));
    if (action === "remove") return siteReply(await removeSiteProfile(principal, input));
    throw new SiteProfileError("Choose a known mapping action.");
  } catch (error) { return siteFailure(error); }
}
