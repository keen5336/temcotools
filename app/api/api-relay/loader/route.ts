import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dmpConfig } from "@/lib/api-relay/config";
import { MAX_CONCURRENT, MAX_RESPONSE_BYTES } from "@/scripts/api-relay/protocol.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) {
  const config = dmpConfig();
  const base = new URL(process.env.API_RELAY_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin);
  const ws = new URL("/api/api-relay/ws", base);
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (process.env.NODE_ENV !== "production") ws.port = process.env.API_RELAY_PUBLIC_PORT || "3003";
  const options = { temcoOrigin: base.origin, wsUrl: ws.href, allowedOrigins: config.origins, maxConcurrent: MAX_CONCURRENT, maxResponseBytes: MAX_RESPONSE_BYTES };
  // Read original source: bundled function.toString() can contain minifier-
  // renamed module references which do not exist in the DMP page.
  const protocol = readFileSync(join(process.cwd(), "scripts/api-relay/protocol.mjs"), "utf8").replace(/^export /gm, "");
  const executor = readFileSync(join(process.cwd(), "scripts/api-relay/executor.mjs"), "utf8").replace(/^export /gm, "");
  const source = `(()=>{${protocol}\n${executor}\nstartDmpRelay(${JSON.stringify(options)});})();`;
  return new Response(source, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" } });
}
