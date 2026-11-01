import { getCurrentPrincipal } from "@/lib/auth";
import { updateIdentityUser } from "@/lib/auth/identity";
import { identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";
import { z } from "zod";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    const body = z.record(z.string(), z.unknown()).parse(await readIdentityJson(request));
    return identityReply(await updateIdentityUser(principal, { ...body, id: (await params).id }));
  } catch (error) { return identityFailure(error); }
}
