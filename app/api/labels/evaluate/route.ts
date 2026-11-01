import { getCurrentPrincipal } from "@/lib/auth";
import { evaluateLabel, labelEvaluationInput } from "@/lib/labels/workflows";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); const input = labelEvaluationInput.parse(await readLabelBody(request)); return labelReply(await evaluateLabel(principal, input)); } catch (error) { return labelFailure(error); } }
