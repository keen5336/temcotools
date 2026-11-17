import { getCookieSession } from "@/lib/auth";
import { sameOrigin, authFailure, authReply } from "@/lib/auth/context";
import { revokeAuthSession } from "@/lib/auth/identity";
import { revokeApiRelaySession } from "@/lib/api-relay/control";

export async function POST(request: Request) {
  try {
    sameOrigin(request); const cookie = await getCookieSession();
    await revokeAuthSession(cookie.sessionId, cookie.userId);
    await revokeApiRelaySession({ userId: cookie.userId, apiRelaySessionId: cookie.sessionId || cookie.apiRelaySessionId });
    cookie.destroy(); return authReply({ ok: true });
  } catch (error) { return authFailure(error); }
}
