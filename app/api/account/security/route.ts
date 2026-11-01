import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/auth";
import { changePassword, listSessions, lockSession, reauthenticate, revokeSession, revokeOtherSessions } from "@/lib/auth/identity";
import { identityContext, identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";
import { sessionOptions, type SessionData } from "@/lib/session";
import { revokeApiRelaySession } from "@/lib/api-relay/control";

export async function GET() {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await listSessions(principal));
  } catch (error) { return identityFailure(error); }
}

export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    const data = z.object({ action: z.enum(["reauthenticate", "change-password", "revoke-session", "revoke-other-sessions", "lock"]), input: z.unknown().optional() }).parse(await readIdentityJson(request));
    const result = data.action === "reauthenticate" ? await reauthenticate(principal, data.input, identityContext(request))
      : data.action === "change-password" ? await changePassword(principal, data.input, identityContext(request))
      : data.action === "revoke-session" ? await revokeSession(principal, data.input)
      : data.action === "revoke-other-sessions" ? await revokeOtherSessions(principal)
      : await lockSession(principal);
    if (data.action === "lock" || data.action === "change-password" || ("current" in result && result.current)) {
      const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
      await revokeApiRelaySession(session);
      session.destroy();
    }
    return identityReply(result);
  } catch (error) { return identityFailure(error); }
}
