import { getCurrentPrincipal } from "@/lib/auth";
import { listLabelIssuances, prepareLabelIssuance } from "@/lib/labels/issuance";
import { labelReply, labelFailure, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET(request: Request) { try { const principal = await getCurrentPrincipal(); return principal ? labelReply({ issuances: await listLabelIssuances(principal, new URL(request.url).searchParams.get("unitId") ?? undefined) }) : labelReply({ error: "Sign in required." }, 401); } catch (error) { return labelFailure(error); } }
export async function POST(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); return labelReply(await prepareLabelIssuance(principal, await readLabelBody(request))); } catch (error) { return labelFailure(error); } }
