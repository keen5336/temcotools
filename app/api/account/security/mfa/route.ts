import { getCurrentPrincipal } from "@/lib/auth";
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, getMfaStatus, regenerateMfaRecoveryCodes, verifyMfa } from "@/lib/auth/mfa";
import { identityContext, identityFailure, identityReply, readIdentityJson } from "@/lib/auth/http";
import { z } from "zod";

export async function GET() {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    return identityReply(await getMfaStatus(principal));
  } catch (error) { return identityFailure(error); }
}

export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal();
    if (!principal) return identityReply({ error: "Sign in again." }, 401);
    const data = z.object({ action: z.enum(["begin", "confirm", "verify", "disable", "recovery-codes"]), input: z.unknown() }).parse(await readIdentityJson(request));
    const command = { begin: beginMfaEnrollment, confirm: confirmMfaEnrollment, verify: verifyMfa, disable: disableMfa, "recovery-codes": regenerateMfaRecoveryCodes }[data.action];
    return identityReply(await command(principal, data.input, identityContext(request)));
  } catch (error) { return identityFailure(error); }
}
