"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiRelays } from "@/components/api-relay/ApiRelayProvider";
import { useLabelRelay } from "@/components/labels/LabelRelayProvider";
import RelayBookmarklet from "@/components/api-relay/RelayBookmarklet";

export default function RelayConfigurationClient({ admin }: { admin: boolean }) {
  const api = useApiRelays(); const label = useLabelRelay();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  async function disconnect(id: string) {
    setBusy(id); setMessage("");
    try { await api.disconnect(id); } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to disconnect."); }
    finally { setBusy(null); }
  }
  return <div className="space-y-6">
    <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
      <div className="flex flex-wrap justify-between gap-3"><div><h2 className="card-title">API relay connections</h2><p className="text-sm mt-1 text-base-content/65">Your connected external systems are available from every TemcoTools page. Keep each source tab and a signed-in TemcoTools tab open.</p></div>{admin && <Link href="/admin/api-relays" className="btn btn-sm btn-outline">Manage API relays</Link>}</div>
      <RelayBookmarklet />
      {(api.error || message) && <p role="alert" className="text-warning">{message || api.error}</p>}
      {!api.status && !api.error && <p role="status">Checking API relays…</p>}
      {api.status?.definitions.map(definition => { const connections = api.status!.connections.filter(connection => connection.relayId === definition.id); return <div key={definition.id} className="rounded-box border border-base-300 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{definition.name}</h3><p className="text-sm text-base-content/65">{api.error ? "Status unavailable" : connections.some(connection => connection.ready) ? "Connected" : "Not connected — open the system and run Connect Temco"}</p></div><a className="btn btn-sm btn-outline" href={definition.origins[0] + definition.pathPrefix} target="_blank" rel="noopener noreferrer">Open {definition.name}</a></div>
        <p className="text-xs break-all text-base-content/60">{definition.origins.join(", ")} · {definition.pathPrefix}</p>
        {connections.map(connection => <div key={connection.id} className="flex flex-wrap justify-between gap-3 border-t border-base-200 pt-3"><div className="min-w-0"><p className="text-sm break-all">{connection.origin}{connection.pathname}</p><p className="text-sm">{connection.ready ? `Signed in as ${connection.dmpUser}` : "Checking external account…"} · {connection.pending} requests pending</p></div><button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void disconnect(connection.id)}>{busy === connection.id ? "Disconnecting…" : "Disconnect"}</button></div>)}
      </div>; })}
      {api.status && !api.status.definitions.length && <p>No API relays are enabled. An administrator can add a system in Manage API Relays.</p>}
      <button className="btn btn-sm btn-ghost self-start" onClick={() => void api.refresh()}>Refresh connections</button>
    </div></section>
    <section id="label-relay" className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4">
      <div className="flex items-center justify-between gap-3"><h2 className="card-title">Label relay on this device</h2><label className="flex items-center gap-3"><span>{label.settings.enabled ? "On" : "Off"}</span><input type="checkbox" aria-label="Label Relay Mode" className="toggle toggle-success" checked={label.settings.enabled} disabled={!label.loaded || !label.settings.printerIds.length} onChange={event => label.update({ ...label.settings, enabled: event.target.checked })} /></label></div>
      <p role="status">{label.error || (label.settings.enabled ? label.status : "Off — this device is not accepting labels")}</p>
      <label className="form-control"><span className="label font-semibold">Device name</span><input className="input input-bordered w-full" maxLength={80} value={label.settings.name} disabled={!label.loaded || label.settings.enabled} onChange={event => label.update({ ...label.settings, name: event.target.value })} /></label>
      <fieldset disabled={!label.loaded || label.settings.enabled} className="space-y-2"><legend className="font-semibold mb-2">Printers this device can reach</legend>{label.printers.map(printer => <label key={printer.id} className="flex items-center gap-3"><input className="checkbox checkbox-sm" type="checkbox" checked={label.settings.printerIds.includes(printer.id)} onChange={event => label.update({ ...label.settings, printerIds: event.target.checked ? [...label.settings.printerIds, printer.id] : label.settings.printerIds.filter(id => id !== printer.id) })} />{printer.name}</label>)}</fieldset>
      {label.loaded && !label.printers.length && <p className="text-warning">A manager must configure an active printer first.</p>}
      <p className="text-sm text-base-content/65">Settings are saved on this device. Turn label relay off to change its name or printers. Keep TemcoTools open and the device awake on the printer network.</p>
      <button className="btn btn-sm btn-ghost self-start" disabled={label.settings.enabled} onClick={label.reload}>{label.error ? "Try again" : "Refresh printers"}</button>
      {!!label.receipts.length && <details><summary className="cursor-pointer font-semibold">Recent labels ({label.receipts.length})</summary><ul className="space-y-2 mt-3">{label.receipts.map(receipt => <li key={receipt.id} className={`rounded-box border p-3 ${receipt.ok ? "border-success" : "border-warning"}`}><strong>{receipt.printer}</strong> · {receipt.time}<p>{receipt.message}</p></li>)}</ul></details>}
    </div></section>
  </div>;
}
