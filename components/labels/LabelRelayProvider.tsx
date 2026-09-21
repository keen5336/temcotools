"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { OperatorPrinter } from "./useLabelConfiguration";
import { labelRelayUrl, sendLabelDirect } from "@/lib/label-printing";

const storageKey = "label-relay.laptop";
interface Settings { enabled: boolean; name: string; printerIds: string[] }
interface Receipt { id: string; printer: string; message: string; ok: boolean; time: string }

interface Configuration { userId: string; printers: OperatorPrinter[]; settings: Settings }
interface RelayContext {
  settings: Settings;
  printers: OperatorPrinter[];
  loaded: boolean;
  error: string;
  status: string;
  connected: boolean;
  receipts: Receipt[];
  update: (settings: Settings) => void;
  reload: () => void;
  suspend: () => void;
}
const defaultSettings: Settings = { enabled: false, name: "Label relay laptop", printerIds: [] };
const LabelRelayContext = createContext<RelayContext | null>(null);

export function useLabelRelay() {
  const relay = useContext(LabelRelayContext);
  if (!relay) throw new Error("Label relay controls require LabelRelayProvider.");
  return relay;
}

// The root layout survives client navigation. Page headers only display controls;
// mounting or closing a dropdown must never own the receiver's connection.
export default function LabelRelayProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<{ userId: string; message: string } | null>(null);
  const [status, setStatus] = useState("Off");
  const [connected, setConnected] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const seen = useRef(new Set<string>());
  const inFlight = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loaded = Boolean(userId && configuration?.userId === userId);
  const settings = loaded ? configuration!.settings : defaultSettings;
  const printers = loaded ? configuration!.printers : [];
  const error = loadError?.userId === userId ? loadError.message : "";

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    loadController.current = controller;
    async function load() {
      setLoadError(null);
      setReceipts([]);
      try {
        const response = await fetch("/api/label-relay/session", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to use label relay." : "Unable to load relay printers. Try again.");
        const data = await response.json() as { userId: string; printers: OperatorPrinter[] };
        if (data.userId !== userId) throw new Error("Your session changed. Reload the page to use label relay.");
        let next: Settings = { ...defaultSettings, printerIds: data.printers.map((printer) => printer.id) };
        try {
          const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
          if (saved && typeof saved.enabled === "boolean" && typeof saved.name === "string" && Array.isArray(saved.printerIds)) {
            const printerIds = saved.printerIds.filter((id: string) => data.printers.some((printer) => printer.id === id));
            next = { enabled: saved.enabled && printerIds.length > 0, name: saved.name, printerIds };
          }
        } catch { /* Use defaults if the saved configuration is invalid. */ }
        if (!controller.signal.aborted) setConfiguration({ userId: userId!, printers: data.printers, settings: next });
      } catch (caught) {
        if (!controller.signal.aborted) setLoadError({ userId: userId!, message: caught instanceof Error ? caught.message : "Unable to load relay printers." });
      }
    }
    void load();
    return () => controller.abort();
  }, [userId, loadAttempt]);

  function update(next: Settings) {
    if (!loaded || !configuration) return;
    setConfiguration({ ...configuration, settings: next });
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  function suspend() {
    loadController.current?.abort();
    socketRef.current?.close();
    setConfiguration(null);
    setReceipts([]);
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
      socketRef.current = socket;
      const current = socket;
      current.onmessage = async (event) => {
        if (stopped) return;
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
        if (!stopped) setReceipts((items) => [{ id: message.jobId, printer: message.printer.name, message: result, ok, time: new Date().toLocaleTimeString() }, ...items].slice(0, 20));
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
      if (socketRef.current === socket) socketRef.current = null;
      document.removeEventListener("visibilitychange", keepAwake);
      void wakeLock?.release();
    };
  }, [loaded, settings, userId]);

  return <LabelRelayContext.Provider value={{ settings, printers, loaded, error, status, connected: loaded && settings.enabled && connected, receipts, update, reload: () => setLoadAttempt((attempt) => attempt + 1), suspend }}>
    {children}
  </LabelRelayContext.Provider>;
}
