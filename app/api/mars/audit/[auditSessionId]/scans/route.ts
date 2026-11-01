import { marsApi, marsBody, marsOperationId } from "@/lib/mars/http";
import { amendMarsAudit } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ auditSessionId: string }> }) {
  return marsApi(async principal => { const body = await marsBody(request); return amendMarsAudit(principal, { ...body, auditSessionId: (await context.params).auditSessionId, operationId: marsOperationId(body) }); });
}
