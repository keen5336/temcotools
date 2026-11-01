import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dmpConfig } from "@/lib/api-relay/config";
import { MAX_CONCURRENT, MAX_RESPONSE_BYTES } from "@/scripts/api-relay/protocol.mjs";
import { builtinDmpGrant } from "@/lib/api-relay/payload-policy";
import { MARS_LABEL_HELPER_SCRIPT } from "@/lib/mars-label-bookmarklet";
import { SITE_PROFILE_BINDING_DIRECTIVE } from "@/lib/relay-sites/contract";

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
  return { source: `${SITE_PROFILE_BINDING_DIRECTIVE}\n(()=>{${protocol}\n${executor}\nstartDmpRelay(${JSON.stringify(options)});})();`, targetOrigins: config.origins };
}
export function builtinMarsLabelSource(appOrigin: string) {
  const origin = new URL(appOrigin).origin;
  return { source: `${MARS_LABEL_HELPER_SCRIPT}(${JSON.stringify({ reviewPage: `${origin}/tools/rtv-label` })});`, targetOrigins: ["https://delivery-management.homedepot.com"] };
}
export function builtinRoutePlannerSource(appOrigin: string) {
  const reviewPage = new URL("/tools/dmp-samples", appOrigin).href;
  // Owner-provided origin only; no guessed RP identity, DOM capture, endpoint,
  // fetch or mutation. Publication/mapping still require explicit admin intent.
  return { targetOrigins: ["https://routeplannerui.homedepot.com"], source: `(()=>{if(document.getElementById('temco-rp-review')){alert('Temco Route Planner review is already open.');return;}const host=document.createElement('div');host.id='temco-rp-review';host.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:280px;padding:16px;background:white;color:#17202a;border:1px solid #888;border-radius:8px;font:14px system-ui';const title=document.createElement('strong');title.textContent='Temco Route Planner — review only';const status=document.createElement('p');status.textContent='Live identity and operations are not qualified. No data was read or sent. Use manual XML intake in Temco.';const open=document.createElement('button');open.textContent='Open manual XML intake';open.onclick=()=>window.open(${JSON.stringify(reviewPage)},'_blank','noopener,noreferrer');const close=document.createElement('button');close.textContent='Close';close.onclick=()=>host.remove();host.append(title,status,open,document.createTextNode(' '),close);document.body.append(host);})();` };
}
