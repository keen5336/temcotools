import { marsApi } from "@/lib/mars/http";
import { getMarsSourceRows } from "@/lib/mars/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  return marsApi(principal => getMarsSourceRows(principal, { ...(input.has("batchId") ? { batchId: input.get("batchId") } : {}), ...(input.has("requestNumber") ? { requestNumber: input.get("requestNumber") } : {}), ...(input.has("afterId") ? { afterId: input.get("afterId") } : {}), limit: Number(input.get("limit") ?? "50") }));
}
