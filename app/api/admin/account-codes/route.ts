import { getSession } from "@/lib/auth";
import { authFailure, authReply, readAuthBody, sameOrigin } from "@/lib/auth/context";
import { issueAccountCode } from "@/lib/auth/identity";

export async function POST(request: Request) {
  try { sameOrigin(request); return authReply(await issueAccountCode(await getSession(), await readAuthBody(request))); } catch (error) { return authFailure(error); }
}
