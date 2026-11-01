import { getCurrentPrincipal } from "@/lib/auth";
import { issueRecovery, listIdentityAudit } from "@/lib/auth/identity";
import { identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";

export async function GET() {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await listIdentityAudit(principal));
  } catch (error) { return identityFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await issueRecovery(principal, await readIdentityJson(request)), 201);
  } catch (error) { return identityFailure(error); }
}
