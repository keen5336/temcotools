"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeRefreshStatus } from "@/lib/office/refresh";

interface Props { initial?: OfficeRefreshStatus | null; cause: "home" | "office" | "wms_import"; refreshKey?: number; onProgress?: () => void }
type PageInput = { operationId: string; expectedActorUserId: string; runId?: string; expectedCheckpoint?: string; cause: Props["cause"]; limit: number };
export default function OfficeRefreshClient({ initial, cause, refreshKey = 0, onProgress }: Props) {
  const [status, setStatus] = useState(initial ?? null), [busy, setBusy] = useState(false), [paused, setPaused] = useState(false), [error, setError] = useState("");
  const state = useRef({ alive: false, busy: false, paused: false, pending: null as PageInput | null });
  const callback = useRef(onProgress);
  useEffect(() => { callback.current = onProgress; }, [onProgress]);
  const run = useCallback(async () => {
    const control = state.current;
    if (!control.alive || control.busy) return;
    control.busy = true; setBusy(true); setError("");
    try {
      const read = async () => { const response = await fetch("/api/office/refresh", { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Evaluation coverage is unavailable."); return body.result as OfficeRefreshStatus; };
      let current = await read(); if (!control.alive) return; setStatus(current);
      let completedRuns = 0;
      while (control.alive && document.visibilityState === "visible" && !control.paused && current.canRefresh && (current.coverage !== "fresh" || control.pending)) {
        // A finite upper bound is retained server-side. Allow one catch-up pass
        // if facts change mid-run, then pause rather than chasing live scans.
        if (completedRuns >= 2 && !control.pending) { control.paused = true; setPaused(true); setError("Facts kept changing during evaluation. Saved progress is safe; resume when ready to evaluate the remaining changes."); break; }
        const checkpoint = current.checkpoint;
        const input = control.pending ?? { operationId: crypto.randomUUID(), expectedActorUserId: current.actorUserId, ...(checkpoint ? { runId: checkpoint.runId, expectedCheckpoint: checkpoint.checkpoint } : {}), cause, limit: 50 };
        control.pending = input;
        const response = await fetch("/api/office/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const body = await response.json();
        if (!response.ok) {
          // A conflict proves this page did not execute; reload the other saved
          // head. Network/503 uncertainty retains the exact operation for retry.
          if (response.status === 409) control.pending = null;
          throw new Error(body.error || "Evaluation stopped. Resume the saved page.");
        }
        control.pending = null; current = body.result.status;
        if (!control.alive) return;
        setStatus(current); callback.current?.();
        if (body.result.receipt.complete) completedRuns++;
        if (body.result.noWork) break;
      }
    } catch (failure) {
      if (control.alive) { control.paused = true; setPaused(true); setError(failure instanceof Error ? failure.message : "Evaluation stopped. Resume its saved progress."); }
    } finally { control.busy = false; if (control.alive) setBusy(false); }
  }, [cause]);
  useEffect(() => {
    const control = state.current; control.alive = true;
    const initialTimer = window.setTimeout(() => { void run(); }, 0);
    // Read-only checks discover rollover/input changes. A fresh page performs no
    // writes. Background/closed pages do not act as a worker or service identity.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void run(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", visible);
    return () => { control.alive = false; window.clearTimeout(initialTimer); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [run]);
  useEffect(() => { if (!refreshKey) return; const timer = window.setTimeout(() => { state.current.paused = false; setPaused(false); void run(); }, 0); return () => window.clearTimeout(timer); }, [refreshKey, run]);
  const checkpoint = status?.checkpoint;
  return <section className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3 min-w-0" aria-label="Office evaluation coverage">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Office issue evaluation</h2><span className={`badge ${status?.coverage === "fresh" ? "badge-success" : "badge-warning"}`}>{status?.coverage.replaceAll("_", " ") ?? "checking"}</span></div>
    {checkpoint ? <><p className="text-sm">{checkpoint.processed.toLocaleString()} evaluated of {checkpoint.totalAtStart.toLocaleString()} relevant units at run start · {status?.remaining.toLocaleString()} remaining in the saved scope</p><p className="text-xs opacity-75">Warehouse day {checkpoint.day} · {checkpoint.complete ? "Completed" : "Last saved"} {new Date(checkpoint.evaluatedAt).toLocaleString()} · by {checkpoint.lastActorName}</p>{checkpoint.needsCurrentSchedule > 0 && <p className="text-sm">{checkpoint.needsCurrentSchedule.toLocaleString()} evaluated units with warehouse evidence need a current complete schedule before a no-new-date issue can be established.</p>}</> : <p className="text-sm">Warehouse-wide issue evaluation has not completed. Existing case counts may omit newly eligible issues.</p>}
    {status?.staleReasons.map(reason => <p className="text-sm break-words" key={reason}>{reason}</p>)}
    <p className="text-xs opacity-75">{status?.limitation ?? "Checks stored warehouse and Office facts. This does not fetch upstream DMP/WMS data or establish physical presence."}</p>
    {status?.canRefresh && <div className="flex flex-wrap gap-2">{busy ? <button className="btn btn-sm btn-outline min-h-11" disabled={paused} onClick={() => { state.current.paused = true; setPaused(true); }}>Pause after this batch</button> : <button className="btn btn-sm btn-outline min-h-11" onClick={() => { state.current.paused = false; setPaused(false); void run(); }}>{paused ? "Resume saved evaluation" : status.coverage === "fresh" ? "Check coverage" : "Evaluate / resume all relevant units"}</button>}<span role="status" className="self-center text-sm">{busy ? paused ? "Saving this batch…" : "Evaluating bounded batches…" : paused ? "Paused; progress retained" : status.coverage === "fresh" ? "Stored facts evaluated" : "Incomplete / stale"}</span></div>}
    {status && !status.canRefresh && status.coverage !== "fresh" && <p className="text-sm">An authorized warehouse/Office user must complete evaluation. Current case counts are incomplete or stale.</p>}
    {error && <p role="alert" className="text-sm text-error break-words">{error}</p>}
  </section>;
}
