import { redeemRecovery, requestRecovery } from "@/lib/auth/identity";
import { identityContext, identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";
import { z } from "zod";

export async function POST(request: Request) {
  try {
    const data = z.object({ action: z.enum(["request", "redeem"]), input: z.unknown() }).parse(await readIdentityJson(request));
    return identityReply(await (data.action === "request" ? requestRecovery(data.input, identityContext(request)) : redeemRecovery(data.input, identityContext(request))));
  } catch (error) { return identityFailure(error); }
}
