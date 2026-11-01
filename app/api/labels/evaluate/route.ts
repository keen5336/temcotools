import { getCurrentPrincipal } from "@/lib/auth";
import { evaluateLabel } from "@/lib/labels/workflows";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
import { z } from "zod";
import { LABEL_PURPOSES } from "@/lib/labels/types";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); const input = z.object({ purpose: z.enum(LABEL_PURPOSES), unitId: z.string().min(1).max(100), fields: z.record(z.string(), z.string()) }).parse(await readLabelBody(request)); return labelReply(await evaluateLabel(principal, input)); } catch (error) { return labelFailure(error); } }
