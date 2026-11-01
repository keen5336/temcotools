import { marsApi, marsBody, marsOperationId } from "@/lib/mars/http";
import { archiveMarsSubmission, MarsWorkflowError } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ requestNumber: string }> }) {
  return marsApi(async principal => { const body = await marsBody(request); const result = await archiveMarsSubmission(principal, { ...body, requestNumber: (await context.params).requestNumber, operationId: marsOperationId(body) }); if (!result.unit) throw new MarsWorkflowError("MARS submission not found.", 404); return result; });
}
