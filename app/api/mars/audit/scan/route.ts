import { marsApi, marsBody, marsOperationId } from "@/lib/mars/http";
import { scanMarsAudit } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return marsApi(async principal => { const body = await marsBody(request); return scanMarsAudit(principal, { ...body, operationId: marsOperationId(body) }); });
}
