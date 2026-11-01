import { marsApi, marsOperationId } from "@/lib/mars/http";
import { importMarsInventory, MarsWorkflowError } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return marsApi(async principal => {
    if (Number(request.headers.get("content-length")) > 22 * 1024 * 1024) throw new MarsWorkflowError("Use a workbook of at most 20 MiB.", 413);
    const form = await request.formData(); const upload = form.get("file") ?? form.get("files");
    if (!(upload instanceof File) || !upload.size || upload.size > 20 * 1024 * 1024) throw new MarsWorkflowError("Use a nonempty workbook of at most 20 MiB.");
    return importMarsInventory(principal, { filename: upload.name, fileBase64: Buffer.from(await upload.arrayBuffer()).toString("base64"), operationId: typeof form.get("operationId") === "string" ? form.get("operationId") : marsOperationId({}), scope: form.get("scope") || "warehouse", coverage: form.get("coverage") || "partial", ...(form.get("sourceAsOf") ? { sourceAsOf: form.get("sourceAsOf") } : {}), ...(form.get("coverageEvidence") ? { coverageEvidence: form.get("coverageEvidence") } : {}) });
  });
}
