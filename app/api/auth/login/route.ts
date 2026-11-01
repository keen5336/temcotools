import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session";
import { revokeApiRelaySession } from "@/lib/api-relay/control";
import { endSession, signInWithPassword } from "@/lib/auth/identity";
import { identityContext, identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";

export async function POST(request: Request) {
  try {
    const result = await signInWithPassword(await readIdentityJson(request), identityContext(request));
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    await revokeApiRelaySession(session);
    await endSession(session);
    Object.assign(session, result.claim, {
      username: result.user.username, displayName: result.user.displayName, role: result.user.role, isActive: true,
    });
    delete session.apiRelaySessionId;
    delete session.capabilities;
    delete session.strongAuthenticatedAt;
    delete session.mfaVerifiedAt;
    await session.save();
    return identityReply({ ok: true });
  } catch (error) { return identityFailure(error); }
}
