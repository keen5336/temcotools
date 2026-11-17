import { NextRequest } from "next/server";
import { authContext, authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { signInLegacy, signInPassword } from "@/lib/auth/identity";
import { installSession } from "@/lib/auth/cookie";

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const body = await readAuthBody(request);
    // Existing cached v1 login forms can still enter the restricted upgrade
    // flow; an old PIN never establishes an operational session.
    const legacy = body.method === "legacy" || (body.password === undefined && typeof body.pin === "string");
    const row = legacy
      ? await signInLegacy({ username: body.username, pin: body.pin, deviceName: body.deviceName }, authContext(request))
      : await signInPassword({ username: body.username, password: body.password, deviceName: body.deviceName }, authContext(request));
    await installSession(row);
    return authReply({ ok: true, redirectTo: legacy ? "/account/update" : "/", upgradeRequired: legacy });
  } catch (error) { return authFailure(error); }
}
