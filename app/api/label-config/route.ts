import { getCurrentPrincipal } from "@/lib/auth";
import { getOperatorLabelConfiguration } from "@/lib/label-configuration-service";
import { labelFailure, labelReply } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const principal = await getCurrentPrincipal(); return principal ? labelReply(await getOperatorLabelConfiguration(principal, { kind: new URL(request.url).searchParams.get("kind") })) : labelReply({ error: "Sign in required." }, 401); } catch (error) { return labelFailure(error); }
}
