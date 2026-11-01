import { loadPublishedPayload } from "@/lib/payloads/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return loadPublishedPayload(request, "dmp-relay");
}
