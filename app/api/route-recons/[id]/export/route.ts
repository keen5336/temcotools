import { getCurrentPrincipal } from "@/lib/auth";
import { exportRouteRecon } from "@/lib/application/retained-lists";
import { retainedCsvResponse, retainedFailure, retainedReply } from "@/lib/application/retained-http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const principal = await getCurrentPrincipal(); return principal ? retainedCsvResponse(await exportRouteRecon(principal, await context.params)) : retainedReply({ ok: false, error: "Sign in required." }, 401); } catch (error) { return retainedFailure(error); } }
