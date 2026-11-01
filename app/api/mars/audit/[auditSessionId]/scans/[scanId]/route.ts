import { marsApi, marsOperationId } from "@/lib/mars/http";
import { voidMarsAuditScan } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ auditSessionId: string; scanId: string }> }) {
  return marsApi(async principal => { const params = await context.params; const input = new URL(request.url).searchParams; return voidMarsAuditScan(principal, { ...params, operationId: input.get("operationId") || marsOperationId({}), ...(input.has("reason") ? { reason: input.get("reason") } : {}) }); });
}
