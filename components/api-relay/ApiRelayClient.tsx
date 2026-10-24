"use client";

import { useCallback, useEffect, useState } from "react";

type Connection = { id: string; origin: string; ready: boolean; dmpUser: string | null; pending: number; connectedAt: string };
type Status = { configured: boolean; origins: string[]; operations: { id: string; label: string }[]; connections: Connection[] };
type Receipt = { id: string; label: string; result: string };

async function control(action: string, body?: unknown) {
  const response = await fetch(`/api/api-relay/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "API relay failed.");
  return result;
}

export default function ApiRelayClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [bookmarklet, setBookmarklet] = useState("");
  const [notice, setNotice] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [operation, setOperation] = useState("deliveries");
  const [input, setInput] = useState("{}");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [locationNumber, setLocationNumber] = useState("5288");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [running, setRunning] = useState(0);
  const refresh = useCallback(async () => {
    try { setStatus(await control("status")); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Cannot reach API relay."); }
  }, []);
  useEffect(() => {
    const source = `${location.origin}/api/api-relay/loader`;
    setBookmarklet(`javascript:(()=>{var s=document.createElement('script');s.src=${JSON.stringify(source)}+'?t='+Date.now();s.onerror=()=>alert('DMP could not load Temco API Relay.');(document.head||document.documentElement).appendChild(s)})();`);
    const today = new Date();
    setDeliveryDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function run() {
    const id = crypto.randomUUID();
    const label = `${operation} · ${new Date().toLocaleTimeString()}`;
    setReceipts((items) => [{ id, label, result: "Running…" }, ...items].slice(0, 20));
    setRunning((n) => n + 1);
    try {
      const [year, month, day] = deliveryDate.split("-");
      const parameters = operation === "deliveries" ? { deliveryDate: `${month}/${day}/${year}`, locationNumber } : operation === "session" ? {} : JSON.parse(input);
      const result = await control("request", { connectionId: connectionId || status?.connections.find((c) => c.ready)?.id, operation, input: parameters });
      setReceipts((items) => items.map((item) => item.id === id ? { ...item, result: JSON.stringify(result, null, 2) } : item));
    } catch (error) {
      setReceipts((items) => items.map((item) => item.id === id ? { ...item, result: error instanceof Error ? error.message : "Request failed." } : item));
    } finally { setRunning((n) => n - 1); void refresh(); }
  }

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-semibold">DMP API Relay</h1><p className="mt-2 text-base-content/70">Connect a signed-in DMP tab to your Temco account. Only your account can use your connections.</p></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {status && !status.configured && <div className="alert alert-info">DMP connection setup is pending. The DMP site and its account lookup must be configured before pairing is available.</div>}
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <h2 className="text-lg font-semibold">Connect DMP</h2>
      <ol className="list-decimal pl-5 space-y-2"><li>Drag the button below to your browser’s bookmarks bar.</li><li>Open DMP and sign into the account you want to use.</li><li>Click the bookmark, choose Connect, and confirm your Temco account in the pairing window.</li></ol>
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-primary" draggable ref={(element) => { if (element) element.setAttribute("href", bookmarklet); }} onClick={(event) => { event.preventDefault(); setNotice("Drag this button to your bookmarks bar, then use it on DMP."); }}>Connect DMP to Temco</a>
        <button className="btn btn-outline" disabled={!bookmarklet} onClick={async () => { try { await navigator.clipboard.writeText(bookmarklet); setNotice("Bookmarklet copied. Paste it into a bookmark’s URL field."); } catch { setNotice("Select and copy the bookmarklet below."); } }}>Copy bookmarklet</button>
      </div>
      <details><summary className="cursor-pointer">Bookmarklet text</summary><textarea className="textarea textarea-bordered w-full mt-2 font-mono text-xs" aria-label="Bookmarklet URL" readOnly value={bookmarklet} /></details>
      {notice && <p role="status">{notice}</p>}
      <p className="text-sm text-base-content/70">The bookmark loads the latest relay code each time you use it. Keep DMP and a signed-in Temco tab open. Sign-out, account changes, or a lost connection require pairing again.</p>
    </section>
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <div className="flex justify-between items-center"><h2 className="text-lg font-semibold">Your connections</h2><button className="btn btn-sm" onClick={() => { void refresh(); }}>Refresh</button></div>
      {!status?.connections.length && <p>No DMP tabs connected.</p>}
      {status?.connections.map((connection) => <div key={connection.id} className="flex flex-wrap justify-between gap-3 border-t border-base-300 pt-3">
        <div><p className="font-medium">{connection.origin}</p><p>{connection.ready ? `DMP user ${connection.dmpUser}` : "Checking DMP account…"} · {connection.pending} outstanding</p><p className="text-xs text-base-content/60">Connected {new Date(connection.connectedAt).toLocaleString()}</p></div>
        <button className="btn btn-sm btn-outline" onClick={async () => { try { await control("disconnect", { connectionId: connection.id }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed."); } }}>Disconnect</button>
      </div>)}
    </section>
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <h2 className="text-lg font-semibold">Run a DMP operation</h2>
      <label className="block">Connection<select className="select select-bordered w-full mt-1" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}><option value="">First ready connection</option>{status?.connections.filter((c) => c.ready).map((c) => <option key={c.id} value={c.id}>{c.origin} · {c.dmpUser} · {c.id.slice(0, 8)}</option>)}</select></label>
      <label className="block">Operation<select className="select select-bordered w-full mt-1" value={operation} onChange={(e) => setOperation(e.target.value)}>{status?.operations.map((op) => <option key={op.id} value={op.id}>{op.label}</option>)}</select></label>
      {operation === "deliveries" ? <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">Delivery date<input className="input input-bordered w-full mt-1" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></label>
        <label className="block">Location number<input className="input input-bordered w-full mt-1" inputMode="numeric" value={locationNumber} onChange={(e) => setLocationNumber(e.target.value)} /></label>
      </div> : operation !== "session" && <label className="block">Parameters (JSON)<textarea className="textarea textarea-bordered w-full font-mono mt-1" rows={5} value={input} onChange={(e) => setInput(e.target.value)} /></label>}
      <button className="btn btn-primary" disabled={!status?.configured || !status.connections.some((c) => c.ready) || running >= 32 || (operation === "deliveries" && (!deliveryDate || !locationNumber.trim()))} onClick={() => { void run(); }}>Run operation{running ? ` (${running} running)` : ""}</button>
      <p className="text-sm text-base-content/70">You can submit multiple requests. Results may finish in a different order. Failed requests are not retried automatically.</p>
      {receipts.map((receipt) => <details key={receipt.id} className="border-t border-base-300 pt-3" open={receipt.result === "Running…"}><summary className="cursor-pointer">{receipt.label} · {receipt.result === "Running…" ? "Running" : "Finished"}</summary><pre className="mt-2 text-xs whitespace-pre-wrap break-all max-h-96 overflow-auto">{receipt.result}</pre></details>)}
    </section>
  </div>;
}
