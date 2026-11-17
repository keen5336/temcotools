import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRelayDefinitions } from "@/lib/api-relay/definitions";
import { relayAppOrigin } from "@/lib/api-relay/http";
import { resolveRelayDefinition } from "@/lib/api-relay/model";
import { MAX_CONCURRENT, MAX_RESPONSE_BYTES } from "@/scripts/api-relay/protocol.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" };

export async function GET(request: NextRequest) {
  try {
    const definitions = await listRelayDefinitions();
    const origin = request.nextUrl.searchParams.get("origin");
    const pathname = request.nextUrl.searchParams.get("pathname");
    const legacy = origin === null && pathname === null;
    const definition = legacy ? definitions.find(row => row.id === "dmp" && row.enabled) : resolveRelayDefinition(definitions, origin || "", pathname || "");
    if (!definition) throw new Error("This API relay is disabled.");
    const base = new URL(relayAppOrigin(request));
    const ws = new URL("/api/api-relay/ws", base);
    ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    if (process.env.NODE_ENV !== "production") ws.port = process.env.API_RELAY_PUBLIC_PORT || "3003";
    const config = { name: definition.name, relayId: definition.id, relayRevision: definition.revision, pathPrefix: definition.pathPrefix, ...(legacy ? {} : { pathname }), temcoOrigin: base.origin, wsUrl: ws.href, allowedOrigins: legacy ? definition.origins : [origin], maxConcurrent: MAX_CONCURRENT, maxResponseBytes: MAX_RESPONSE_BYTES };
    const protocol = readFileSync(join(process.cwd(), "scripts/api-relay/protocol.mjs"), "utf8").replace(/^export /gm, "");
    const executor = readFileSync(join(process.cwd(), "scripts/api-relay/executor.mjs"), "utf8").replace(/^export /gm, "");
    // Check the actual tab before any admin-authored code runs. The query is a
    // selection hint, never proof that the script is executing on that site.
    const guard = `const config=${JSON.stringify(config)};if(!config.allowedOrigins.includes(location.origin)||!relayPathMatches(location.pathname,config.pathPrefix)||(config.pathname&&location.pathname!==config.pathname)){alert('This relay is not approved for the current page. Run Connect Temco again.');return;}if(window.__temcoApiRelay?.busy?.()){alert('Relay work is still running. Wait for its original result.');return;}`;
    return new Response(`(()=>{${protocol}\n${guard}\n${executor}\n${definition.program}\nstartTemcoSiteRelay(config);})();`, { headers });
  } catch {
    // A classic script must explain a refused selection to its invoking tab.
    // No fallback payload or connection is created for an unsupported site.
    return new Response("alert('No enabled Temco API relay matches this page. Check its site/path with an administrator, then run Connect Temco again.');", { headers });
  }
}
