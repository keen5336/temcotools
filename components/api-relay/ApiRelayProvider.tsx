"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RelayStatus } from "@/lib/api-relay/types";

export async function relayControl(action: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/api-relay/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API relay failed.");
  return data;
}

type RelayContext = { status: RelayStatus | null; error: string; refresh: () => Promise<void>; disconnect: (connectionId: string) => Promise<void>; request: (connectionId: string, operation: string, input?: unknown) => Promise<unknown>; suspend: () => void };
const Context = createContext<RelayContext | null>(null);
export function useApiRelays() {
  const context = useContext(Context);
  if (!context) throw new Error("ApiRelayProvider is required.");
  return context;
}

// Mounted once across navigation. Menu/page visibility never owns the lease.
export default function ApiRelayProvider({ userId, children }: { userId: string | null; children: React.ReactNode }) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(false), busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!userId || !alive.current || busy.current) return;
    busy.current = true;
    try {
      const data: RelayStatus = await relayControl("status", {}, AbortSignal.any([controller.current!.signal, AbortSignal.timeout(8000)]));
      if (data.userId !== userId) throw new Error("Your session changed. Reload to view your relays.");
      if (alive.current) { setStatus(data); setError(data.serviceError || ""); }
    } catch (error) {
      if (alive.current && !controller.current?.signal.aborted) { setStatus(null); setError(error instanceof Error ? error.message : "Connection status is unavailable."); }
    } finally { busy.current = false; }
  }, [userId]);
  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10000);
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { alive.current = false; controller.current?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  function suspend() { alive.current = false; controller.current?.abort(); setStatus(null); setError(""); }
  async function disconnect(connectionId: string) { await relayControl("disconnect", { connectionId }); await refresh(); }
  async function request(connectionId: string, operation: string, input?: unknown) {
    try { return await relayControl("request", { connectionId, operation, input }); }
    finally { void refresh(); }
  }
  return <Context.Provider value={{ status, error, refresh, disconnect, request, suspend }}>{children}</Context.Provider>;
}
