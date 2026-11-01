import { getCurrentPrincipal } from "@/lib/auth";
import { getLabelWorkflow, getLabelManagerData, saveLabelWorkflow, publishLabelWorkflow, rollbackLabelWorkflow, setLabelWorkflowEnabled, previewLabelDraft } from "@/lib/labels/workflows";
import { LabelError } from "@/lib/labels/model";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); const purpose = new URL(request.url).searchParams.get("purpose"); return labelReply(purpose ? await getLabelWorkflow(principal, purpose) : await getLabelManagerData(principal)); }
  catch (error) { return labelFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401);
    const input = await readLabelBody(request);
    if (input.action === "save") return labelReply(await saveLabelWorkflow(principal, input));
    if (input.action === "publish") return labelReply(await publishLabelWorkflow(principal, input));
    if (input.action === "rollback") return labelReply(await rollbackLabelWorkflow(principal, input));
    if (input.action === "enabled") return labelReply(await setLabelWorkflowEnabled(principal, input));
    if (input.action === "preview") return labelReply(previewLabelDraft(principal, input));
    throw new LabelError("Choose a known label workflow action.");
  } catch (error) { return labelFailure(error); }
}
