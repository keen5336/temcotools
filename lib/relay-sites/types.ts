import { z } from "zod";
import { PAYLOAD_PURPOSES } from "@/lib/payloads/types";

export class SiteProfileError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "site_profile_invalid") { super(message); this.name = "SiteProfileError"; }
}
export const siteProfileId = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
export const sitePurpose = z.enum(PAYLOAD_PURPOSES);
export function exactSiteOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const local = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== origin || url.hostname.includes("*") || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error();
    return origin;
  } catch { throw new SiteProfileError("Use an exact approved HTTPS origin without path, credentials, query, fragment or wildcard."); }
}
export function exactSitePath(pathname: string, prefix = false) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//") || pathname.length > (prefix ? 512 : 2048) || /[\\\s?#\x00-\x1f\x7f]/.test(pathname) || /%2f|%5c/i.test(pathname)) throw new SiteProfileError("Use a bounded literal pathname without query, fragment, encoded separators or wildcards.");
  if (pathname.includes("*") || new URL(pathname, "https://site.invalid").pathname !== pathname || (prefix && pathname !== "/" && pathname.endsWith("/"))) throw new SiteProfileError("Use a canonical path prefix without a trailing slash (or / for the whole origin).");
  return pathname;
}
export function sitePathMatches(pathname: string, pathPrefix: string) { return pathPrefix === "/" || pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`); }
export function siteProfilesOverlap(a: { origin: string; pathPrefix: string }, b: { origin: string; pathPrefix: string }) { return a.origin === b.origin && (sitePathMatches(a.pathPrefix, b.pathPrefix) || sitePathMatches(b.pathPrefix, a.pathPrefix)); }
export const siteLocationInput = z.object({ origin: z.string().max(300), pathname: z.string().min(1).max(2048) }).strict();
export function validateSiteLocation(input: unknown) {
  const parsed = siteLocationInput.safeParse(input);
  if (!parsed.success) throw new SiteProfileError("Connect Temco accepts only the current origin and pathname; no query, fragment, arbitrary URL or source.");
  return { origin: exactSiteOrigin(parsed.data.origin), pathname: exactSitePath(parsed.data.pathname) };
}
export const siteProfileBindingInput = z.object({
  profileId: siteProfileId, revision: z.number().int().positive(), origin: z.string().max(300), pathname: z.string().min(1).max(2048), pathPrefix: z.string().min(1).max(512),
  payloadId: siteProfileId, versionId: z.string().min(1).max(100), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SiteProfileBinding = z.infer<typeof siteProfileBindingInput>;
export type SiteProfileMatch = { id: string; origin: string; pathPrefix: string; purpose: string; payloadId: string; enabled: boolean; revision: number; removedAt: Date | null };
export function chooseSiteProfile(profiles: readonly SiteProfileMatch[], location: { origin: string; pathname: string }) {
  // Count disabled/removed mappings too: never fall through to broader code.
  for (const profile of profiles) { exactSiteOrigin(profile.origin); exactSitePath(profile.pathPrefix, true); }
  const matches = profiles.filter(profile => profile.origin === location.origin && sitePathMatches(location.pathname, profile.pathPrefix));
  if (profiles.length > 64 || matches.length > 1) throw new SiteProfileError("Ambiguous site configuration. Ask an administrator to review the exact origin/path mappings.", 409, "site_ambiguous");
  if (!matches.length) throw new SiteProfileError("This site or path is not configured for Connect Temco.", 404, "site_unsupported");
  if (!matches[0].enabled || matches[0].removedAt) throw new SiteProfileError("Connect Temco is disabled for this site/path. No other adapter was selected.", 403, "site_disabled");
  return matches[0];
}
