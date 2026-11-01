import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dmpConfig } from "@/lib/api-relay/config";
import { MAX_CONCURRENT, MAX_RESPONSE_BYTES } from "@/scripts/api-relay/protocol.mjs";
import { builtinDmpGrant } from "@/lib/api-relay/payload-policy";

// Preserve the existing loader's source construction. No credential or named
// upstream operation is embedded into the bookmarklet/executor.
export function builtinDmpSource(appOrigin: string) {
  const config = dmpConfig();
  const base = new URL(process.env.API_RELAY_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || appOrigin);
  const ws = new URL("/api/api-relay/ws", base);
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  if (process.env.NODE_ENV !== "production") ws.port = process.env.API_RELAY_PUBLIC_PORT || "3003";
  const options = { temcoOrigin: base.origin, wsUrl: ws.href, allowedOrigins: config.origins, maxConcurrent: MAX_CONCURRENT, maxResponseBytes: MAX_RESPONSE_BYTES, payload: builtinDmpGrant() };
  const protocol = readFileSync(join(process.cwd(), "scripts/api-relay/protocol.mjs"), "utf8").replace(/^export /gm, "");
  const executor = readFileSync(join(process.cwd(), "scripts/api-relay/executor.mjs"), "utf8").replace(/^export /gm, "");
  return { source: `(()=>{${protocol}\n${executor}\nstartDmpRelay(${JSON.stringify(options)});})();`, targetOrigins: config.origins };
}
