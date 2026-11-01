import { getCurrentPrincipal } from "@/lib/auth";
import { claimLabelDispatch, reportLabelDelivery, listPendingLabelDispatches } from "@/lib/labels/issuance";
import { LabelError } from "@/lib/labels/model";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401);
    const input = await readLabelBody(request);
    if (input.action === "claim") return labelReply(await claimLabelDispatch(principal, input));
    if (input.action === "report") return labelReply(await reportLabelDelivery(principal, input));
    if (input.action === "pending") return labelReply(await listPendingLabelDispatches(principal, input));
    throw new LabelError("Choose a known device dispatch action.");
  } catch (error) { return labelFailure(error); }
}
