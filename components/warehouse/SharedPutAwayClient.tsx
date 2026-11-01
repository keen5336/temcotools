"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { getWarehousePutAway } from "@/lib/warehouse/reports";
import LpnPutAwayClient from "@/app/tools/lpn-put-away/LpnPutAwayClient";

type PutAwayResult = Awaited<ReturnType<typeof getWarehousePutAway>>;
function today() { const at = new Date(); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`; }
async function requestView(date: string, previous?: PutAwayResult, signal?: AbortSignal): Promise<PutAwayResult> {
  const params = new URLSearchParams({ date });
  if (previous?.batch) params.set("importId", previous.batch.importId);
  if (previous?.nextAfterLpn) params.set("afterLpn", previous.nextAfterLpn);
  const response = await fetch(`/api/warehouse/put-away?${params}`, { cache: "no-store", signal });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "Put-away view is unavailable.");
  return payload.result;
}

export default function SharedPutAwayClient() {
  const [date, setDate] = useState(today);
  const [view, setView] = useState<PutAwayResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [localFallback, setLocalFallback] = useState(false);
  const requestSequence = useRef(0);
  const load = useCallback(async (selectedDate: string, previous?: PutAwayResult) => {
    const sequence = ++requestSequence.current;
    try {
      const result = await requestView(selectedDate, previous);
      if (sequence !== requestSequence.current) return;
      setView(previous ? { ...result, items: [...previous.items, ...result.items] } : result);
    } catch (failure) { if (sequence === requestSequence.current) setError(failure instanceof Error ? failure.message : "Put-away view is unavailable."); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    void requestView(date, undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted && sequence === requestSequence.current) setView(result);
    }).catch((failure) => {
      if (!controller.signal.aborted && sequence === requestSequence.current) setError(failure instanceof Error ? failure.message : "Put-away view is unavailable.");
    }).finally(() => { if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false); });
    return () => controller.abort();
  }, [date]);
  const exportParams = new URLSearchParams({ date, ...(view?.batch ? { importId: view.batch.importId } : {}) });
  async function copyAll() {
    try {
      const response = await fetch(`/api/warehouse/put-away?${exportParams}&format=lpns`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the complete LPN list.");
      const content = await response.text();
      await navigator.clipboard.writeText(content);
      setNotice(`Copied ${content ? content.split("\n").length : 0} LPNs from this report view.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Clipboard unavailable. Use CSV export instead."); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2"><button className={`btn btn-sm ${localFallback ? "btn-outline" : "btn-primary"}`} onClick={() => setLocalFallback(false)}>Shared warehouse report</button><button className={`btn btn-sm ${localFallback ? "btn-primary" : "btn-outline"}`} onClick={() => setLocalFallback(true)}>Local file fallback</button><Link href="/tools/warehouse/import" className="btn btn-sm btn-outline">Refresh shared WMS report</Link></div>
    {localFallback ? <div className="space-y-3"><p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">This fallback filters a local file only. It does not update shared warehouse inventory.</p><LpnPutAwayClient /></div> : <>
      <div className="rounded-xl border border-base-300 bg-base-100 p-4 space-y-3"><label className="form-control"><span className="label-text font-semibold">Received date</span><input className="input input-bordered mt-1 w-full" type="date" value={date} onChange={(event) => { requestSequence.current++; setView(null); setLoading(true); setError(""); setNotice(""); setDate(event.target.value); }} /></label><div className="flex flex-wrap gap-2"><button className="btn btn-sm" disabled={loading || !date} onClick={() => { setLoading(true); setError(""); setNotice(""); void load(date); }}>Refresh view</button><button className="btn btn-sm btn-outline" disabled={!view?.items.length || loading} onClick={() => void copyAll()}>Copy all LPNs</button><a className={`btn btn-sm btn-outline ${view?.items.length ? "" : "btn-disabled"}`} href={`/api/warehouse/put-away?${exportParams}&format=csv`}>Export all CSV</a></div></div>
      {error && <p className="alert alert-error text-sm" role="alert">{error}</p>}{notice && <p role="status" className="text-sm text-success">{notice}</p>}
      {view && <><div className="rounded-xl border border-info/40 bg-info/10 p-4 text-sm space-y-1"><p className="font-semibold">{view.batch?.filename || "Retained warehouse data"}</p><p>Imported: {view.batch ? new Date(view.batch.importedAt).toLocaleString() : "Not recorded"} · Source-as-of: {view.batch?.sourceAsOf ? new Date(view.batch.sourceAsOf).toLocaleString() : "Unknown"}</p><p>{view.limitation}</p></div><h2 className="text-lg font-semibold">Placing rows · {view.items.length.toLocaleString()} shown{view.hasMore ? "+" : ""}</h2><div className="space-y-3">{view.items.map((row) => <article key={row.lpn} className="rounded-xl border border-base-300 bg-base-100 p-4"><Link href={`/tools/warehouse?lpn=${encodeURIComponent(row.lpn)}`} className="link break-all text-lg font-bold">{row.lpn}</Link><p className="break-words">{row.description}</p><dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2"><div><dt className="inline text-base-content/60">Vendor: </dt><dd className="inline break-words">{row.vendor}</dd></div><div><dt className="inline text-base-content/60">Order: </dt><dd className="inline break-all">{row.orderNumber}</dd></div><div><dt className="inline text-base-content/60">Deliver to: </dt><dd className="inline break-words">{row.customerName}</dd></div></dl></article>)}</div>{!view.items.length && <p>No Placing rows for this received date in the selected report.</p>}{view.nextAfterLpn && <button className="btn btn-outline w-full" disabled={loading} onClick={() => { setLoading(true); setError(""); void load(date, view); }}>Load more rows</button>}</>}
      {loading && <p role="status">Loading shared report…</p>}
    </>}
  </div>;
}
