"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeQueuedObservation, queuedObservations, queueObservation, rejectQueuedObservation, type QueuedObservation } from "@/lib/observation-queue";

export interface ObservationReceipt { observation?: unknown; resolution?: string; unitId?: string | null; replayed?: boolean; task?: unknown; office?: unknown; finals?: unknown }
export function useObservationQueue(userId: string, onReceipt?: (receipt: ObservationReceipt, event: QueuedObservation) => void) {
  const [pending, setPending] = useState<QueuedObservation[]>([]), [error, setError] = useState("");
  const draining = useRef(false), owner = useRef(userId), callback = useRef(onReceipt);
  useEffect(() => { callback.current = onReceipt; });
  useEffect(() => { owner.current = userId; }, [userId]);
  const refresh = useCallback(async () => {
    const current = await queuedObservations(userId);
    if (owner.current === userId) setPending(current);
    return current;
  }, [userId]);
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      for (const event of await refresh()) {
        if (owner.current !== userId) return;
        if (event.state !== "pending") continue;
        const response = await fetch("/api/scan-ingestion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
        if (owner.current !== userId) return;
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) { setError("Sign in as the original operator to save this device's pending observations."); return; }
          if (response.status >= 500) throw new Error("Server unavailable; observations remain on this device.");
          await rejectQueuedObservation(event, data.error || "Observation needs review.");
          continue;
        }
        await acknowledgeQueuedObservation(event.eventId);
        callback.current?.(data.result, event);
      }
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Offline; observations remain on this device."); }
    finally { draining.current = false; await refresh().catch(() => undefined); }
  }, [refresh, userId]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void drain(); }, 0);
    const online = () => { void drain(); };
    window.addEventListener("online", online);
    const interval = window.setInterval(online, 15_000);
    return () => { window.clearTimeout(initial); window.removeEventListener("online", online); window.clearInterval(interval); };
  }, [drain]);
  const capture = useCallback(async (input: { rawIdentifier: string; type?: QueuedObservation["type"]; location?: string; captureMethod?: QueuedObservation["captureMethod"]; pickWaveId?: string; finalsSessionId?: string; lane?: string; confirmPlacement?: boolean }) => {
    if (owner.current !== userId) throw new Error("Operator changed. Reopen the scan workspace.");
    const event = await queueObservation({ ...input, eventId: crypto.randomUUID(), capturedByUserId: userId, capturedAt: new Date().toISOString(), identifierType: "auto", type: input.type ?? "presence", captureMethod: input.captureMethod ?? "scanner" });
    await refresh(); void drain();
    return event;
  }, [drain, refresh, userId]);
  return { capture, retry: drain, pending, error, queuedCount: pending.filter(item => item.state === "pending").length, rejectedCount: pending.filter(item => item.state === "rejected").length };
}
