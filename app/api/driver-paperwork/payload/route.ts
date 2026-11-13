import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  // Public program source, with no session, manifest, or customer data. A script
  // loaded by a different site's tab cannot depend on Temco's login cookies.
  const source = readFileSync(join(process.cwd(), "scripts/driver-paperwork/payload.js"), "utf8");
  return new Response(source, { headers: {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  } });
}
