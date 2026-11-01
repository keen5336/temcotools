import { getCurrentPrincipal } from "@/lib/auth";
import { identityFailure, identityReply } from "@/lib/auth/http";
import { getConnectedClientSetup } from "@/lib/application/client-setup";
export const runtime = "nodejs";
export async function GET() {
  try { const principal = await getCurrentPrincipal(); return principal ? identityReply(await getConnectedClientSetup(principal)) : identityReply({ error: "Sign in required." }, 401); }
  catch (error) { return identityFailure(error); }
}
