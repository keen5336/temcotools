import { loadPublishedPayload } from "@/lib/payloads/loader";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return loadPublishedPayload(request, (await params).id);
}
