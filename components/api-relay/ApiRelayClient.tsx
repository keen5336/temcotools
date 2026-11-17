"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiRelays } from "./ApiRelayProvider";
import RelayBookmarklet from "./RelayBookmarklet";

type Receipt = { id: string; label: string; result: string };
export default function ApiRelayClient() {
  const api = useApiRelays();
  const [relayId, setRelayId] = useState("dmp"), [selectedConnection, setSelectedConnection] = useState(""), [selectedOperation, setSelectedOperation] = useState("deliveries");
  const [input, setInput] = useState("{}");
  const [deliveryDate, setDeliveryDate] = useState(() => { const today = new Date(); return `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`; });
  const [locationNumber, setLocationNumber] = useState("5288");
  const [receipts, setReceipts] = useState<Receipt[]>([]), [running, setRunning] = useState(0);
  const definition = api.status?.definitions.find(row => row.id === relayId) || api.status?.definitions[0];
  const connections = api.status?.connections.filter(row => row.relayId === definition?.id && row.ready) || [];
  const connectionId = selectedConnection ? connections.find(row => row.id === selectedConnection)?.id : connections.length === 1 ? connections[0].id : undefined;
  const operation = definition?.operations.find(row => row.id === selectedOperation)?.id || definition?.operations[0]?.id;
  const deliveries = definition?.id === "dmp" && operation === "deliveries";
  async function run() {
    if (!connectionId || !operation) return;
    const id = crypto.randomUUID(), label = `${definition?.name} · ${operation} · ${new Date().toLocaleTimeString()}`;
    setReceipts(items => [{ id, label, result: "Running…" }, ...items].slice(0, 20)); setRunning(n => n+1);
    try {
      const [year, month, day] = deliveryDate.split("-");
      const parameters = deliveries ? { deliveryDate: `${month}/${day}/${year}`, locationNumber } : operation === "session" ? {} : JSON.parse(input);
      const result = await api.request(connectionId, operation, parameters);
      setReceipts(items => items.map(item => item.id === id ? { ...item, result: JSON.stringify(result, null, 2) } : item));
    } catch (error) { setReceipts(items => items.map(item => item.id === id ? { ...item, result: error instanceof Error ? error.message : "Request failed." } : item)); }
    finally { setRunning(n => n-1); }
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold">API Relays</h1><p className="mt-2 text-base-content/70">Use the external accounts connected to your TemcoTools account.</p></div><Link className="btn btn-outline btn-sm" href="/configuration">Connections & configuration</Link></div>
    {api.error && <div className="alert alert-warning" role="alert">{api.error}</div>}
    <section className="card bg-base-100 border border-base-200"><div className="card-body"><h2 className="card-title">Connect a system</h2><RelayBookmarklet /></div></section>
    <section className="card bg-base-100 border border-base-200"><div className="card-body gap-4"><h2 className="card-title">Run an operation</h2>
      <label className="form-control"><span className="label font-semibold">System</span><select className="select select-bordered w-full" value={definition?.id || ""} onChange={event => { setRelayId(event.target.value); setSelectedConnection(""); setSelectedOperation(""); }}><option value="" disabled>Select a system</option>{api.status?.definitions.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <label className="form-control"><span className="label font-semibold">Connection</span><select className="select select-bordered w-full" value={connectionId || ""} onChange={event => setSelectedConnection(event.target.value)}><option value="">Select a connected tab</option>{connections.map(row => <option key={row.id} value={row.id}>{row.origin} · {row.dmpUser} · {row.id.slice(0,8)}</option>)}</select></label>
      {!connections.length && <p className="text-sm">This system is not connected. <Link className="link link-primary" href="/configuration">Open Configuration</Link> to activate its relay.</p>}
      <label className="form-control"><span className="label font-semibold">Operation</span><select className="select select-bordered w-full" value={operation || ""} onChange={event => setSelectedOperation(event.target.value)}>{definition?.operations.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
      {deliveries ? <div className="grid sm:grid-cols-2 gap-4"><label className="form-control"><span className="label">Delivery date</span><input className="input input-bordered w-full" type="date" value={deliveryDate} onChange={event => setDeliveryDate(event.target.value)} /></label><label className="form-control"><span className="label">Location number</span><input className="input input-bordered w-full" value={locationNumber} onChange={event => setLocationNumber(event.target.value)} /></label></div> : operation !== "session" && <label className="form-control"><span className="label">Parameters (JSON)</span><textarea className="textarea textarea-bordered w-full font-mono" rows={5} value={input} onChange={event => setInput(event.target.value)} /></label>}
      <button className="btn btn-primary self-start" disabled={!connectionId || !operation || !!api.error || running >= 32 || (deliveries && (!deliveryDate || !locationNumber.trim()))} onClick={() => void run()}>Run operation{running ? ` (${running} running)` : ""}</button>
      <p className="text-sm text-base-content/65">Requests can finish in a different order. Failed or interrupted requests are never replayed automatically.</p>
      {receipts.map(receipt => <details key={receipt.id} className="border-t border-base-300 pt-3" open={receipt.result === "Running…"}><summary className="cursor-pointer">{receipt.label} · {receipt.result === "Running…" ? "Running" : "Finished"}</summary><pre className="mt-2 text-xs whitespace-pre-wrap break-all max-h-96 overflow-auto">{receipt.result}</pre></details>)}
    </div></section>
  </div>;
}
