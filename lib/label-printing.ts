import type { OperatorPrinter } from "@/components/labels/useLabelConfiguration";
import type { LabelDispatchClaim, LabelFields, LabelPurpose, LabelDeliveryStatus } from "@/lib/labels/types";

export interface LabelPrintContext { operationId?: string; unitId?: string; purpose?: LabelPurpose; versionId?: string; fields?: LabelFields; automatic?: boolean; reprintOf?: string; reason?: string; deviceId?: string }
export interface BrowserPrintingDevice { device: { id: string; name: string; mode: string; printerIds: string[] }; deviceToken: string }
const usedDispatches = new Set<string>();
const deviceCredentials = new Map<string, { deviceId: string; deviceToken: string }>();
async function labelRequest(path: string, input: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || "Label action failed. Inspect the original receipt before repeating it.") as Error & { code?: string; status?: number }; error.code = value.code; error.status = response.status; throw error; }
  return value;
}
export async function registerBrowserPrintingDevice(printerIds: string[], mode: "direct" | "relay", name: string): Promise<BrowserPrintingDevice> {
  const key = `temco-print-device.${mode}.${name}`;
  let saved: { deviceId: string; deviceToken: string } | undefined;
  try { saved = deviceCredentials.get(key) ?? JSON.parse(sessionStorage.getItem(key) || "null") ?? undefined; } catch { /* Fresh session-bound device. */ }
  const register = async (previous?: typeof saved) => {
    const value = await labelRequest("/api/labels/devices", { deviceId: previous?.deviceId || crypto.randomUUID(), deviceToken: previous?.deviceToken, name, mode, printerIds });
    const credentials = { deviceId: value.device.id, deviceToken: value.deviceToken };
    deviceCredentials.set(key, credentials);
    try { sessionStorage.setItem(key, JSON.stringify(credentials)); } catch { /* This page keeps its authorized device in memory. */ }
    return value as BrowserPrintingDevice;
  };
  try { return await register(saved); }
  catch (error) { if ((error as Error & { code?: string }).code !== "device_reconnect") throw error; deviceCredentials.delete(key); try { sessionStorage.removeItem(key); } catch { /* In-memory fallback. */ } return register(); }
}
export function claimBrowserPrint(issuanceId: string, device: BrowserPrintingDevice) { return labelRequest("/api/labels/dispatch", { action: "claim", issuanceId, deviceId: device.device.id, deviceToken: device.deviceToken }) as Promise<LabelDispatchClaim | { dispatch: false; issuance: { id: string; state: string } }>; }
export function reportBrowserPrint(claim: LabelDispatchClaim, device: BrowserPrintingDevice, status: LabelDeliveryStatus, note: string) { return labelRequest("/api/labels/dispatch", { action: "report", issuanceId: claim.issuanceId, deviceId: device.device.id, deviceToken: device.deviceToken, reportToken: claim.reportToken, status, note }); }

export function labelRelayUrl() {
  const url = new URL("/api/label-relay/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (process.env.NODE_ENV === "development") url.port = "3002";
  return url.href;
}

export async function sendLabelDirect(printer: OperatorPrinter, zpl: string, claim?: LabelDispatchClaim) {
  if (!claim) { await sendLabel(printer, zpl, false); return; }
  if (!claim.dispatch || claim.printer.id !== printer.id || claim.zpl !== zpl || usedDispatches.has(claim.issuanceId)) throw new Error("This label dispatch was already consumed or does not match the authorized job. Inspect its receipt.");
  usedDispatches.add(claim.issuanceId);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(claim.printer.endpoint, {
      method: "POST", headers: { "Content-Type": claim.printer.contentType }, body: claim.zpl,
      mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal,
    });
  } catch {
    throw new Error("Printer delivery could not be confirmed. Check the printer before printing again; the label may have been sent.");
  } finally { window.clearTimeout(timeout); }
}

export async function sendLabel(printer: OperatorPrinter, zpl: string, relay: boolean, context: LabelPrintContext = {}): Promise<string> {
  const mode = relay ? "relay" : "direct";
  const device = relay ? null : await registerBrowserPrintingDevice([printer.id], "direct", "Direct browser printer");
  const purpose = context.purpose ?? "legacy_manual";
  const prepared = await labelRequest("/api/labels/issuances", { ...context, operationId: context.operationId ?? crypto.randomUUID(), purpose, printerId: printer.id, mode, deviceId: context.deviceId ?? device?.device.id, fields: context.fields ?? {}, ...(purpose === "legacy_manual" ? { legacyZpl: zpl, automatic: false } : {}) });
  const issuance = prepared.issuance as { id: string; state: string; deviceId: string };
  if (issuance.state !== "queued") {
    if (["dispatching", "unknown"].includes(issuance.state)) throw new Error("The original label result is uncertain. Inspect its receipt and physical printer; no label was replayed.");
    if (!context.automatic && !context.reprintOf) {
      const reason = window.prompt("This label content was already issued. Inspect the physical printer first. Enter a reason to authorize a new reprint, or cancel.");
      if (reason && reason.trim().length >= 3) return reprintLabelSnapshot(printer, issuance.id, relay, reason.trim());
    }
    return "This label content was already issued. Physical output remains separate; use an explicit reprint reason if another copy is needed.";
  }
  return deliverLabelIssuance(printer, issuance, relay, device);
}
export async function reprintLabelSnapshot(printer: OperatorPrinter, issuanceId: string, relay: boolean, reason: string) {
  const device = relay ? null : await registerBrowserPrintingDevice([printer.id], "direct", "Direct browser printer");
  const prepared = await labelRequest(`/api/labels/issuances/${encodeURIComponent(issuanceId)}`, { action: "reprint", operationId: crypto.randomUUID(), reason, printerId: printer.id, mode: relay ? "relay" : "direct", deviceId: device?.device.id });
  return deliverLabelIssuance(printer, prepared.issuance, relay, device);
}
async function deliverLabelIssuance(printer: OperatorPrinter, issuance: { id: string; state: string; deviceId: string }, relay: boolean, device: BrowserPrintingDevice | null): Promise<string> {
  if (issuance.state !== "queued") return `Label ${issuance.state}; no device dispatch was replayed.`;
  if (!relay) {
    if (!device || device.device.id !== issuance.deviceId) return "Label queued for the selected connected device; physical output remains unconfirmed.";
    const claim = await claimBrowserPrint(issuance.id, device!);
    if (!claim.dispatch) return `Label ${claim.issuance.state}; this device did not replay it.`;
    try {
      await sendLabelDirect(claim.printer, claim.zpl, claim);
    } catch (error) {
      await reportBrowserPrint(claim, device!, "unknown", "Browser delivery failed or timed out; physical output is unknown.").catch(() => undefined);
      throw error;
    }
    await reportBrowserPrint(claim, device!, "sent_unconfirmed", "Browser/network send completed; physical output remains unconfirmed.");
    return "Label sent; physical output is unconfirmed.";
  }
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
      else resolve(`Label sent by ${relayName || "relay laptop"}; physical output is unconfirmed.`);
      if (error) void labelRequest(`/api/labels/issuances/${encodeURIComponent(issuance.id)}`, { action: "cancel", reason: "Client transport ended before a confirmed result. Cancel only if not yet dispatched." }).catch(() => undefined);
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
        socket.send(JSON.stringify({ type: "print", requestId, printerId: printer.id, zpl: "^XA^FDManaged issuance^FS^XZ", issuanceId: issuance.id, deviceId: issuance.deviceId }));
      }
      if (message.type === "result" && message.requestId === requestId) finish(message.ok ? undefined : message.error, message.relayName);
      if (message.type === "error") finish(message.error);
    };
  });
}

export async function startBrowserPrintingDevice(printerIds: string[], onStatus: (status: string) => void) {
  let stopped = false, busy = false, lastRenewed = Date.now();
  let device = await registerBrowserPrintingDevice(printerIds, "direct", "Connected browser printer");
  async function poll() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (Date.now() - lastRenewed > 20_000) { device = await registerBrowserPrintingDevice(printerIds, "direct", "Connected browser printer"); lastRenewed = Date.now(); }
      const pending = await labelRequest("/api/labels/dispatch", { action: "pending", deviceId: device.device.id, deviceToken: device.deviceToken });
      for (const item of pending.issuances as { id: string }[]) {
        if (stopped) break;
        const claim = await claimBrowserPrint(item.id, device);
        if (!claim.dispatch) continue;
        onStatus(`Sending to ${claim.printer.name}…`);
        try { await sendLabelDirect(claim.printer, claim.zpl, claim); await reportBrowserPrint(claim, device, "sent_unconfirmed", "Connected browser send completed; physical output remains unconfirmed."); onStatus("Connected — last send is physically unconfirmed."); }
        catch { await reportBrowserPrint(claim, device, "unknown", "Connected browser delivery result is unknown.").catch(() => undefined); onStatus("A print result is unknown. Inspect the receipt/printer before any reprint."); }
      }
    } catch (error) { onStatus(error instanceof Error ? error.message : "Printing device unavailable."); if ([401, 403].includes((error as Error & { status?: number }).status ?? 0)) { stopped = true; window.clearInterval(timer); } }
    finally { busy = false; }
  }
  const timer = window.setInterval(() => void poll(), 1500);
  onStatus("Connected — waiting for authorized labels."); void poll();
  return { deviceId: device.device.id, stop() { stopped = true; window.clearInterval(timer); void fetch(`/api/labels/devices?id=${encodeURIComponent(device.device.id)}`, { method: "DELETE" }).catch(() => undefined); } };
}
