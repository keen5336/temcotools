import { getSession } from "@/lib/auth";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { setLegacyLoginPolicy } from "@/lib/auth/admin";
import { AuthError } from "@/lib/auth/policy";

export async function POST(request: Request) {
  try {
    sameOrigin(request); const body = await readAuthBody(request);
    if (typeof body.legacyLoginEnabled !== "boolean") throw new AuthError("Choose whether legacy setup is enabled.");
    return authReply(await setLegacyLoginPolicy(await getSession(), body.legacyLoginEnabled));
  } catch (error) { return authFailure(error); }
}
