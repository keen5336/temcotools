import { marsApi, marsBody, marsOperationId } from "@/lib/mars/http";
import { submitMarsAudit } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return marsApi(async principal => { const body = await marsBody(request); return submitMarsAudit(principal, { ...body, operationId: typeof body.operationId === "string" ? body.operationId : typeof body.localAuditId === "string" ? `audit-submit:${body.localAuditId}` : marsOperationId(body) }); });
}
