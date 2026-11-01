import { getCurrentPrincipal } from "@/lib/auth";
import { identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";
import { decideOAuthConsent, getOAuthConsent, listOAuthGrants, revokeOAuthGrant } from "@/lib/oauth/service";
import { z } from "zod";

export async function GET(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again to review this client." }, 401);
    const id = new URL(request.url).searchParams.get("request");
    return identityReply(id ? await getOAuthConsent(principal, id) : { grants: await listOAuthGrants(principal) });
  } catch (error) { return identityFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again to decide this request." }, 401);
    return identityReply(await decideOAuthConsent(principal, await readIdentityJson(request)));
  } catch (error) { return identityFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(await readIdentityJson(request));
    return identityReply(await revokeOAuthGrant(principal, id));
  } catch (error) { return identityFailure(error); }
}
