"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectTemcoBookmarklet } from "@/lib/relay-sites/model";

type ReadShare = { id: string; oauthGrantId: string; operations: string[]; expiresAt: number };
type Connection = { id: string; origin: string; ready: boolean; dmpUser: string | null; pending: number; connectedAt: string; access: "owner" | "shared_read"; operations?: string[]; shareExpiresAt?: number; shares?: ReadShare[] };
type Status = { configured: boolean; origins: string[]; operations: { id: string; label: string; method: string }[]; connections: Connection[]; shareCandidates: { id: string; clientName: string; deviceLabel: string; expiresAt: string }[] };
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
  const [sharingConnectionId, setSharingConnectionId] = useState("");
  const [shareGrantId, setShareGrantId] = useState("");
  const [shareOperations, setShareOperations] = useState<string[]>(["deliveries"]);
  const [shareMinutes, setShareMinutes] = useState("30");
  const [sharing, setSharing] = useState(false);
  const statusGeneration = useRef({ generation: 0 });
  const refresh = useCallback(async () => {
    const generation = ++statusGeneration.current.generation;
    try { const result = await control("status"); if (generation === statusGeneration.current.generation) { setStatus(result); setError(""); } }
    catch (error) { if (generation === statusGeneration.current.generation) setError(error instanceof Error ? error.message : "Cannot reach API relay."); }
  }, []);
  useEffect(() => {
    setBookmarklet(connectTemcoBookmarklet(location.origin));
    const today = new Date();
    setDeliveryDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
    const statusScope = statusGeneration.current;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { clearInterval(timer); statusScope.generation++; };
  }, [refresh]);

  async function run() {
    const id = crypto.randomUUID();
    const label = `${operation} · ${new Date().toLocaleTimeString()}`;
    setReceipts((items) => [{ id, label, result: "Running…" }, ...items].slice(0, 20));
    setRunning((n) => n + 1);
    try {
      const [year, month, day] = deliveryDate.split("-");
      const parameters = operation === "deliveries" ? { deliveryDate: `${month}/${day}/${year}`, locationNumber } : operation === "session" ? {} : JSON.parse(input);
      const result = await control("request", { operationId: id, connectionId: connectionId || status?.connections.find((c) => c.ready)?.id, operation, input: parameters });
      setReceipts((items) => items.map((item) => item.id === id ? { ...item, result: JSON.stringify(result, null, 2) } : item));
    } catch (error) {
      setReceipts((items) => items.map((item) => item.id === id ? { ...item, result: error instanceof Error ? error.message : "Request failed." } : item));
    } finally { setRunning((n) => n - 1); void refresh(); }
  }

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-semibold">DMP API Relay</h1><p className="mt-2 text-base-content/70">Connect a signed-in DMP tab to this Temco session. You can explicitly share named read operations with one of your own remote OAuth clients.</p></div>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {status && !status.configured && <div className="alert alert-info">DMP connection setup is pending. The DMP site and its account lookup must be configured before pairing is available.</div>}
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <h2 className="text-lg font-semibold">Connect DMP</h2>
      <ol className="list-decimal pl-5 space-y-2"><li>Drag the button below to your browser’s bookmarks bar.</li><li>Open DMP and sign into the account you want to use.</li><li>Click the bookmark, choose Connect, and confirm your Temco account in the pairing window.</li></ol>
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-primary" draggable ref={(element) => { if (element) element.setAttribute("href", bookmarklet); }} onClick={(event) => { event.preventDefault(); setNotice("Drag this button to your bookmarks bar, then use it on a supported site."); }}>Connect TemcoTools</a>
        <button className="btn btn-outline" disabled={!bookmarklet} onClick={async () => { try { await navigator.clipboard.writeText(bookmarklet); setNotice("Bookmarklet copied. Paste it into a bookmark’s URL field."); } catch { setNotice("Select and copy the bookmarklet below."); } }}>Copy bookmarklet</button>
      </div>
      <details><summary className="cursor-pointer">Bookmarklet text</summary><textarea className="textarea textarea-bordered w-full mt-2 font-mono text-xs" aria-label="Bookmarklet URL" readOnly value={bookmarklet} /></details>
      {notice && <p role="status">{notice}</p>}
      <p className="text-sm text-base-content/70">One bookmark selects approved published code using only origin and pathname. An administrator must configure the site mapping first; old DMP bookmarks still work. Keep DMP and a signed-in Temco tab open. Sign-out, account changes, or a lost connection require pairing again.</p>
    </section>
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <div className="flex justify-between items-center"><h2 className="text-lg font-semibold">Your connections</h2><button className="btn btn-sm" onClick={() => { void refresh(); }}>Refresh</button></div>
      {!status?.connections.length && <p>No DMP tabs connected.</p>}
      {status?.connections.map((connection) => <div key={connection.id} className="flex flex-wrap justify-between gap-3 border-t border-base-300 pt-3">
        <div><p className="font-medium">{connection.origin}</p><p>{connection.ready ? `DMP user ${connection.dmpUser}` : "Checking DMP account…"} · {connection.pending} outstanding</p><p className="text-xs text-base-content/60">Connected {new Date(connection.connectedAt).toLocaleString()}</p>{connection.access === "shared_read" && <p className="text-sm">Shared read access until {new Date(connection.shareExpiresAt!).toLocaleTimeString()}. Allowed: {connection.operations?.join(", ")}. The original browser still owns this connection.</p>}{connection.shares?.map(share => <div key={share.id} className="mt-2 rounded border border-base-300 p-2 text-sm break-all"><p>Read approval · {status.shareCandidates.find(g => g.id === share.oauthGrantId)?.clientName || share.oauthGrantId} · {share.operations.join(", ")} · expires {new Date(share.expiresAt).toLocaleString()}</p><button className="btn btn-sm mt-2" disabled={sharing} onClick={async () => { setSharing(true); try { await control("unshare", { connectionId: connection.id, shareId: share.id }); setNotice("Read sharing revoked. Already dispatched requests are not replayed or reassigned."); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Cannot revoke sharing."); } finally { setSharing(false); } }}>Revoke read sharing</button></div>)}</div>
        <button className="btn btn-sm btn-outline" disabled={connection.access !== "owner"} onClick={async () => { try { await control("disconnect", { connectionId: connection.id }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed."); } }}>Disconnect</button>
      </div>)}
    </section>
    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3">
      <h2 className="text-lg font-semibold">Share read access with your remote client</h2>
      <p>This work browser must own the selected paired connection. Choose an existing OAuth permission granted from your other browser or machine. Cookies stay in DMP; the remote client receives only approved GET/HEAD responses under its own grant and session.</p>
      <p className="text-sm">Confirm your password and authenticator in <Link className="link" href="/account/security">Account security</Link> before approval. Keep this Temco tab and the DMP tab open. Closing the original session, grant revocation, payload/configuration changes, expiry or disconnect ends access. Broker restart clears all approvals.</p>
      <fieldset disabled={sharing} className="space-y-3">
        <label className="block">Connection to share<select aria-label="Connection to share" className="select select-bordered w-full mt-1" value={sharingConnectionId} onChange={e => setSharingConnectionId(e.target.value)}><option value="">Choose this browser’s connection</option>{status?.connections.filter(c => c.access === "owner" && c.ready).map(c => <option key={c.id} value={c.id}>{c.origin} · {c.dmpUser} · {c.id.slice(0, 8)}</option>)}</select></label>
        <label className="block">Remote OAuth client<select aria-label="Remote OAuth client" className="select select-bordered w-full mt-1" value={shareGrantId} onChange={e => setShareGrantId(e.target.value)}><option value="">Choose an existing current permission</option>{status?.shareCandidates.map(g => <option key={g.id} value={g.id}>{g.clientName} · {g.deviceLabel} · {g.id.slice(-8)}</option>)}</select></label>
        {!status?.shareCandidates.length && <p className="text-sm">No current OAuth grant with workflow.read is available. Connect and authorize the remote MCP client first, then refresh here.</p>}
        <div className="space-y-2"><p className="font-medium">Allowed named read operations</p>{status?.operations.filter(op => ["GET", "HEAD"].includes(op.method)).map(op => <label key={op.id} className="flex items-center gap-3 min-h-11"><input className="checkbox checkbox-sm" type="checkbox" checked={shareOperations.includes(op.id)} onChange={e => setShareOperations(old => e.target.checked ? [...old, op.id] : old.filter(id => id !== op.id))} />{op.label} ({op.method})</label>)}</div>
        <label className="block">Expires after minutes<input aria-label="Sharing duration in minutes" className="input input-bordered w-full mt-1" type="number" min={5} max={60} value={shareMinutes} onChange={e => setShareMinutes(e.target.value)} /></label>
        <button className="btn btn-primary min-h-11 h-auto py-3 whitespace-normal" disabled={!sharingConnectionId || !shareGrantId || !shareOperations.length || !Number.isInteger(Number(shareMinutes)) || Number(shareMinutes) < 5 || Number(shareMinutes) > 60} onClick={async () => { setSharing(true); try { await control("share", { connectionId: sharingConnectionId, oauthGrantId: shareGrantId, operations: shareOperations, expiresInMinutes: Number(shareMinutes) }); setNotice("Read sharing approved for the selected OAuth client and operations. The original connection and its lease remain in this browser."); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Cannot approve read sharing."); } finally { setSharing(false); } }}>Approve scoped read sharing</button>
      </fieldset>
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
