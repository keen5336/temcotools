import { getCurrentPrincipal } from "@/lib/auth";
import { getUnitLabelContext } from "@/lib/labels/unit-context";
import { labelFailure, labelReply } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET(request: Request) { try { const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401); const params = new URL(request.url).searchParams; return labelReply(await getUnitLabelContext(principal, { unitId: params.get("unitId") ?? "", dispatchDay: params.get("dispatchDay") || undefined, wmsScope: params.get("wmsScope") || "warehouse" })); } catch (error) { return labelFailure(error); } }
