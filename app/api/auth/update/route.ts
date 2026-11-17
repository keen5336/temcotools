import { authContext, authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { completeAccountUpdate } from "@/lib/auth/identity";
import { installSession } from "@/lib/auth/cookie";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const session = await completeAccountUpdate(await readAuthBody(request), authContext(request));
    await installSession(session);
    return authReply({ ok: true, redirectTo: "/" });
  } catch (error) { return authFailure(error); }
}
