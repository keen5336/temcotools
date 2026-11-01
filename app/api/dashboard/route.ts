import { getCurrentPrincipal } from "@/lib/auth";
import { executeApplicationAction } from "@/lib/application/actions";
import { warehouseBody, warehouseReply } from "@/lib/warehouse/http";
export const runtime = "nodejs";
async function handle(request?: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return warehouseReply({ error: "Sign in required." }, 401);
  try { return warehouseReply({ result: await executeApplicationAction(principal, request ? "dashboard.save" : "dashboard.get", request ? await warehouseBody(request, 4096) : {}) }); }
  catch (error) { const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 503; return warehouseReply({ error: status < 500 && error instanceof Error ? error.message : "Dashboard unavailable. Refresh to try again." }, status); }
}
export function GET() { return handle(); }
export function PATCH(request: Request) { return handle(request); }
