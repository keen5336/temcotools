import WebSocket from "ws";
import { mcpConfig, OAuthError } from "./config";
export function printThroughRelay(token: string, printerId: string, zpl: string, requestId: string) {
  const address = new URL("/api/label-relay/ws", process.env.LABEL_RELAY_INTERNAL_URL || "http://127.0.0.1:3002");
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return new Promise<{ ok: boolean; relayName?: string; error?: string; outcome?: string }>((resolve, reject) => {
    let sent = false, settled = false;
    const ws = new WebSocket(address, { origin: mcpConfig().issuer, headers: { Authorization: `Bearer ${token}` }, maxPayload: 256 * 1024 });
    const finish = (result?: { ok: boolean; relayName?: string; error?: string; outcome?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); ws.close();
      if (result) resolve(result);
      else if (sent) resolve({ ok: false, outcome: "unknown", error: "Printer delivery could not be confirmed. Check the printer before another print operation; nothing was retried." });
      else reject(new OAuthError("temporarily_unavailable", "No connection to the label relay. No label was submitted.", 503));
    };
    const timer = setTimeout(() => finish(), 65000);
    ws.on("error", () => finish()); ws.on("close", () => finish());
    ws.on("message", raw => {
      let value; try { value = JSON.parse(raw.toString()); } catch { finish(); return; }
      if (value.type === "heartbeat") ws.send(JSON.stringify({ type: "heartbeat" }));
      if (value.type === "hello" && !sent) { sent = true; ws.send(JSON.stringify({ type: "print", requestId, printerId, zpl })); }
      if (value.type === "result" && value.requestId === requestId) finish({ ok: value.ok === true, relayName: value.relayName, error: value.error, ...(value.ok === false ? { outcome: "unconfirmed" } : {}) });
      if (value.type === "error") finish({ ok: false, error: value.error, outcome: sent ? "unknown" : "not_submitted" });
    });
  });
}
