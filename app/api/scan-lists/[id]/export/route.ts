import { getCurrentPrincipal } from "@/lib/auth";
import { exportScanList } from "@/lib/application/retained-lists";
import { retainedCsvResponse, retainedFailure, retainedReply } from "@/lib/application/retained-http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const principal = await getCurrentPrincipal(); return principal ? retainedCsvResponse(await exportScanList(principal, await context.params)) : retainedReply({ ok: false, error: "Sign in required." }, 401); } catch (error) { return retainedFailure(error); } }
