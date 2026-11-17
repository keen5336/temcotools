import { getCookieSession, getSession } from "@/lib/auth";
import { authContext, authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { accountSecurity, changeOwnPassword, reauthenticate, revokeOwnDevices } from "@/lib/auth/identity";
import { installSession } from "@/lib/auth/cookie";
import { AuthError } from "@/lib/auth/policy";

export async function GET() {
  try { return authReply(await accountSecurity(await getSession())); } catch (error) { return authFailure(error); }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request); const actor = await getSession(); const body = await readAuthBody(request);
    if (body.action === "reauthenticate") return authReply(await reauthenticate(actor, body.password, authContext(request)));
    if (body.action === "change-password") {
      const session = await changeOwnPassword(actor, body.input, authContext(request));
      await installSession(session); return authReply({ ok: true, changed: true });
    }
    if (body.action === "revoke-session" || body.action === "revoke-others") {
      if (body.action === "revoke-session" && (typeof body.sessionId !== "string" || body.sessionId.length > 200)) throw new AuthError("Select a device session.");
      const result = await revokeOwnDevices(actor, body.action === "revoke-others" ? null : body.sessionId as string);
      if (result.current) (await getCookieSession()).destroy();
      return authReply(result);
    }
    throw new AuthError("Unknown account action.");
  } catch (error) { return authFailure(error); }
}
