"use client";

import { useEffect, useRef, useState } from "react";
import type { OperatorPrinter } from "./useLabelConfiguration";
import { labelRelayUrl, sendLabelDirect } from "@/lib/label-printing";

const storageKey = "label-relay.laptop";
interface Settings { enabled: boolean; name: string; printerIds: string[] }
interface Receipt { id: string; printer: string; message: string; ok: boolean; time: string }

export default function LabelRelayClient({ printers }: { printers: OperatorPrinter[] }) {
  const [settings, setSettings] = useState<Settings>({ enabled: false, name: "Label relay laptop", printerIds: printers.map((printer) => printer.id) });
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("Off");
  const [connected, setConnected] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const seen = useRef(new Set<string>());
  const inFlight = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved.enabled === "boolean" && typeof saved.name === "string" && Array.isArray(saved.printerIds)) {
        const printerIds = saved.printerIds.filter((id: string) => printers.some((printer) => printer.id === id));
        setSettings({ enabled: saved.enabled && printerIds.length > 0, name: saved.name, printerIds });
      }
    } catch { /* Use defaults if the saved configuration is invalid. */ }
    setLoaded(true);
  }, [printers]);

  function update(next: Settings) {
    setSettings(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  useEffect(() => {
    if (!loaded || !settings.enabled) return;
    let stopped = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let wakeLock: WakeLockSentinel | undefined;
    const keepAwake = async () => {
      if (document.visibilityState !== "visible" || !navigator.wakeLock || wakeLock) return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (stopped) { void lock.release(); return; }
        wakeLock = lock;
        lock.addEventListener("release", () => { wakeLock = undefined; });
      } catch { /* The user can still keep the laptop awake manually. */ }
    };
    const connect = () => {
      setConnected(false);
      setStatus("Connecting…");
      socket = new WebSocket(labelRelayUrl());
      const current = socket;
      current.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const reply = (body: object) => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify(body)); };
        if (message.type === "heartbeat") reply({ type: "heartbeat" });
        if (message.type === "hello") reply({ type: "register", name: settings.name, printerIds: settings.printerIds });
        if (message.type === "registered") { setConnected(true); setStatus("Ready — waiting for labels"); }
        if (message.type === "error") { setConnected(false); setStatus(message.error); }
        if (message.type !== "job") return;
        // No job is replayed after a connection loss, including across reconnects.
        if (seen.current.has(message.jobId)) return;
        seen.current.add(message.jobId);
        if (seen.current.size > 1000) seen.current.delete(seen.current.values().next().value!);
        if (inFlight.current) {
          reply({ type: "result", jobId: message.jobId, ok: false, error: "This laptop is still sending a previous label. Try again after it finishes." });
          return;
        }
        inFlight.current = true;
        setStatus(`Sending to ${message.printer.name}…`);
        let ok = false;
        let result = "Sent to printer";
        try {
          await sendLabelDirect(message.printer, message.zpl);
          ok = true;
        } catch (error) { result = error instanceof Error ? error.message : "Printer delivery could not be confirmed."; }
        finally { inFlight.current = false; }
        reply({ type: "result", jobId: message.jobId, ok, error: ok ? undefined : result });
        setReceipts((items) => [{ id: message.jobId, printer: message.printer.name, message: result, ok, time: new Date().toLocaleTimeString() }, ...items].slice(0, 20));
        if (!stopped && current.readyState === WebSocket.OPEN) setStatus(ok ? "Ready — waiting for labels" : result);
      };
      current.onclose = (event) => {
        if (stopped) return;
        setConnected(false);
        if (event.code === 1008) { setStatus("Session ended. Sign in again, then turn relay mode off and on."); return; }
        setStatus("Connection lost — reconnecting…");
        timer = setTimeout(connect, 3000);
      };
    };
    connect();
    void keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.close();
      document.removeEventListener("visibilitychange", keepAwake);
      void wakeLock?.release();
    };
  }, [loaded, settings]);

  return <div className="space-y-5">
    <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span className="text-xl font-semibold">Label Relay Mode</span>
        <input type="checkbox" className="toggle toggle-lg toggle-success" checked={settings.enabled} disabled={!loaded || !settings.printerIds.length} onChange={(event) => update({ ...settings, enabled: event.target.checked })} />
      </label>
      <div role="status" className={`alert ${settings.enabled && connected ? "alert-success" : "alert-info"}`}>
        {settings.enabled ? status : "Off — this laptop is not accepting labels"}
      </div>
      <p>Keep this page open and this laptop awake on the printer network. On each scanner, choose the printer and turn on <strong>Use label relay</strong>. Any signed-in user can send labels through this laptop.</p>
      <p className="text-sm text-base-content/70">The laptop needs the same browser permission to reach the printer that direct printing uses. Turning relay mode off stops new jobs; a label already being sent may still print.</p>
      <label className="form-control"><span className="label-text mb-1 font-semibold">Laptop name</span><input className="input input-bordered w-full" maxLength={80} value={settings.name} disabled={settings.enabled} onChange={(event) => update({ ...settings, name: event.target.value })} /></label>
      <fieldset className="space-y-2" disabled={settings.enabled}><legend className="font-semibold mb-2">Printers this laptop can reach</legend>
        {printers.map((printer) => <label key={printer.id} className="flex gap-3 items-center rounded-lg border border-base-200 p-3 cursor-pointer"><input type="checkbox" className="checkbox checkbox-primary" checked={settings.printerIds.includes(printer.id)} onChange={(event) => update({ ...settings, printerIds: event.target.checked ? [...settings.printerIds, printer.id] : settings.printerIds.filter((id) => id !== printer.id) })} /><span>{printer.name}</span></label>)}
        {!printers.length && <p className="text-warning">A manager must activate a printer in Label Configuration first.</p>}
      </fieldset>
      <p className="text-xs text-base-content/60">Settings are saved on this device. Reopening this page restores relay mode. Turn it off to change the laptop name or printers.</p>
    </div></section>
    <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body"><h2 className="card-title">Recent labels</h2>
      <p className="text-sm text-base-content/70">Sent means the browser completed its request. Check the printer for physical output. Unconfirmed jobs are never retried automatically.</p>
      {!receipts.length && <p className="text-base-content/60">Labels received in this tab will appear here.</p>}
      <ul className="space-y-2">{receipts.map((item) => <li key={item.id} className={`rounded-lg border p-3 ${item.ok ? "border-success" : "border-warning"}`}><div className="font-semibold">{item.printer} <span className="text-xs font-normal">{item.time}</span></div><p className="text-sm">{item.message}</p></li>)}</ul>
    </div></section>
  </div>;
}
