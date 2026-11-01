import { getCurrentPrincipal } from "@/lib/auth";
import { recordActivity } from "@/lib/auth/identity";
import { identityFailure, identityReply } from "@/lib/auth/http";

export async function POST() {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await recordActivity(principal));
  } catch (error) { return identityFailure(error); }
}
