import type { AuthSession } from "@prisma/client";
import { getCookieSession } from "@/lib/auth";
import { revokeApiRelaySession } from "@/lib/api-relay/control";
import { revokeAuthSession } from "./identity";

export async function installSession(row: AuthSession) {
  const cookie = await getCookieSession();
  const previous = { userId: cookie.userId, sessionId: cookie.sessionId, apiRelaySessionId: cookie.sessionId || cookie.apiRelaySessionId };
  await revokeAuthSession(previous.sessionId, previous.userId);
  await revokeApiRelaySession(previous);
  for (const key of Object.keys(cookie)) delete (cookie as unknown as Record<string, unknown>)[key];
  Object.assign(cookie, { userId: row.userId, sessionId: row.id, authVersion: row.authVersion });
  await cookie.save();
}
