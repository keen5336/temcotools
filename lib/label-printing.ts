import type { OperatorPrinter } from "@/components/labels/useLabelConfiguration";

export function labelRelayUrl() {
  const url = new URL("/api/label-relay/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (process.env.NODE_ENV === "development") url.port = "3002";
  return url.href;
}

export async function sendLabelDirect(printer: OperatorPrinter, zpl: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(printer.endpoint, {
      method: "POST", headers: { "Content-Type": printer.contentType }, body: zpl,
      mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal,
    });
  } catch {
    throw new Error("Printer delivery could not be confirmed. Check the printer before printing again; the label may have been sent.");
  } finally { window.clearTimeout(timeout); }
}

export function sendLabel(printer: OperatorPrinter, zpl: string, relay: boolean): Promise<string> {
  if (!relay) return sendLabelDirect(printer, zpl).then(() => "Label sent to printer.");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(labelRelayUrl());
    const requestId = crypto.randomUUID();
    let submitted = false;
    const finish = (error?: string, relayName?: string) => {
      window.clearTimeout(timeout);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      if (error) reject(new Error(error));
      else resolve(`Label sent by ${relayName || "relay laptop"}.`);
    };
    const connectionError = () => finish(submitted
      ? "Relay delivery could not be confirmed. Check the printer before printing again; the label may have been sent."
      : "Could not connect to label relay. Check your connection and sign in again if needed.");
    const timeout = window.setTimeout(connectionError, 65000);
    socket.onerror = connectionError;
    socket.onclose = connectionError;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "heartbeat") socket.send(JSON.stringify({ type: "heartbeat" }));
      if (message.type === "hello" && !submitted) {
        submitted = true;
        socket.send(JSON.stringify({ type: "print", requestId, printerId: printer.id, zpl }));
      }
      if (message.type === "result" && message.requestId === requestId) finish(message.ok ? undefined : message.error, message.relayName);
      if (message.type === "error") finish(message.error);
    };
  });
}
