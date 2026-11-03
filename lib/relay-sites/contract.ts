import { SiteProfileError } from "./types";

// A versioned declaration by the trusted publishing administrator, not semantic
// proof of arbitrary JavaScript. Historical immutable source is never rewritten.
export const SITE_PROFILE_BINDING_DIRECTIVE = "// temco-site-profile-binding:1";
export function supportsSiteProfileBinding(source: string) { return source.split(/\r?\n/, 1)[0] === SITE_PROFILE_BINDING_DIRECTIVE; }
export function assertSiteProfileSourceContract(purpose: string, source: string) {
  if (["dmp_relay", "integration_relay"].includes(purpose) && !supportsSiteProfileBinding(source)) throw new SiteProfileError("Mapped relay adapters require the first-line declaration // temco-site-profile-binding:1 and reviewed profile-metadata forwarding. Load/publish the current matching executor, or review and declare a compatible custom adapter. Legacy DMP bookmarks remain available.", 409, "site_contract_unaware");
}
