import { getCurrentPrincipal } from "@/lib/auth";
import { createIdentityUser, listIdentityUsers } from "@/lib/auth/identity";
import { identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";

export async function GET(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await listIdentityUsers(principal, new URL(request.url).searchParams.get("search") ?? ""));
  } catch (error) { return identityFailure(error); }
}

export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await createIdentityUser(principal, await readIdentityJson(request)), 201);
  } catch (error) { return identityFailure(error); }
}
