import { marsApi } from "@/lib/mars/http";
import { getMarsAudit, MarsWorkflowError } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ auditSessionId: string }> }) { return marsApi(async principal => { const result = await getMarsAudit(principal, await context.params); if (!result) throw new MarsWorkflowError("MARS record not found.",404); return { result }; }); }
