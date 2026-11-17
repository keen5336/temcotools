import { getSession } from "@/lib/auth";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { decideConsent } from "@/lib/mcp/oauth";
import { AuthError } from "@/lib/auth/policy";
export async function POST(request: Request) {
  try {
    sameOrigin(request); const body = await readAuthBody(request);
    if (typeof body.requestId !== "string" || body.requestId.length > 100 || typeof body.allow !== "boolean" || !Array.isArray(body.scopes) || body.scopes.length > 3 || !body.scopes.every(item => typeof item === "string")) throw new AuthError("Invalid authorization decision.");
    return authReply(await decideConsent(await getSession(), body.requestId, body.allow, body.scopes as string[]));
  } catch (error) { return authFailure(error); }
}
