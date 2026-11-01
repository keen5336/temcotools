import { getCurrentPrincipal } from "@/lib/auth";
import { issueAssistedFactorReset } from "@/lib/auth/mfa";
import { identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await issueAssistedFactorReset(principal, await readIdentityJson(request)), 201);
  } catch (error) { return identityFailure(error); }
}
