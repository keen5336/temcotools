import { buildDriverPaperworkPayload } from "@/lib/driver-paperwork/payload";
import { getPublishedTemplate } from "@/lib/driver-paperwork/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Public program source, with no session, manifest, or customer data. A script
  // loaded by a different site's tab cannot depend on Temco's login cookies.
  try {
    const { template, program, version } = await getPublishedTemplate();
    return new Response(buildDriverPaperworkPayload(template, program), { headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Driver-Paperwork-Version": String(version),
    } });
  } catch {
    // Never silently substitute defaults for an unavailable saved template.
    return new Response("Driver Paperwork templates are unavailable. Try again shortly.", { status: 503, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
}
