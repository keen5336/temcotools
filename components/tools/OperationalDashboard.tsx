"use client";
import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import OfficeRefreshClient from "@/components/office/OfficeRefreshClient";
import { useRef, useState } from "react";
import type { OperationalDashboard as DashboardData, WidgetId } from "@/lib/dashboard";

export default function OperationalDashboard({ initial }: { initial: DashboardData | null }) {
  const readSequence = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState(initial), [editing, setEditing] = useState(false), [selection, setSelection] = useState<WidgetId[]>(initial?.selectedWidgetIds as WidgetId[] || []), [busy, setBusy] = useState(false), [error, setError] = useState(initial ? "" : "Operational dashboard unavailable. Refresh to load current work.");
  async function refresh() {
    const sequence = ++readSequence.current; setBusy(true); setError("");
    try { const response = await fetch("/api/dashboard", { cache: "no-store" }); const body = await response.json(); if (sequence !== readSequence.current) return; if (!response.ok) throw new Error(body.error); setData(body.result); setSelection(body.result.selectedWidgetIds); }
    catch (error) { if (sequence === readSequence.current) setError(error instanceof Error ? error.message : "Dashboard unavailable."); }
    finally { if (sequence === readSequence.current) setBusy(false); }
  }
  async function save(useDefaults = false) {
    if (!data) return;
    setBusy(true); setError("");
    try { const response = await fetch("/api/dashboard", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ widgetIds: selection, expectedRevision: data.revision, useDefaults }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setEditing(false); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Dashboard could not be saved."); }
    finally { setBusy(false); }
  }
  function move(index: number, direction: -1 | 1) { const next = [...selection], destination = index + direction; if (destination < 0 || destination >= next.length) return; [next[index], next[destination]] = [next[destination], next[index]]; setSelection(next); }
  return <section className="space-y-4" aria-labelledby="work-heading"><div className="flex flex-wrap items-center justify-between gap-3"><div><h1 id="work-heading" className="text-2xl font-bold">Warehouse today</h1><p className="text-sm opacity-70">{data ? `${data.day} · ${data.timeZone}` : "Current operational work"}</p></div><div className="flex flex-wrap gap-2"><button className="btn btn-outline btn-sm min-h-11" disabled={busy} onClick={() => { setRefreshKey(value => value + 1); void refresh(); }}>Refresh work</button>{data && <button className="btn btn-ghost btn-sm min-h-11" disabled={busy} onClick={() => { setSelection(data.selectedWidgetIds as WidgetId[]); setEditing(value => !value); }}>{editing ? "Cancel customization" : "Customize home"}</button>}</div></div>
    {data?.officeRefresh && <OfficeRefreshClient initial={data.officeRefresh} cause="home" refreshKey={refreshKey} onProgress={() => { void refresh(); }} />}
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    {editing && data && <div className="rounded-xl border bg-base-100 p-4 space-y-3"><h2 className="font-semibold">Your authorized widgets</h2>{data.availableWidgets.map(widget => <label key={widget.id} className="flex items-center gap-3 min-h-11"><input type="checkbox" className="checkbox" checked={selection.includes(widget.id)} onChange={event => setSelection(previous => event.target.checked ? [...previous, widget.id] : previous.filter(id => id !== widget.id))} />{widget.name}</label>)}<ol className="space-y-2">{selection.map((id, index) => <li key={id} className="flex items-center justify-between gap-2"><span>{data.availableWidgets.find(widget => widget.id === id)?.name}</span><span className="flex gap-1"><button className="btn btn-sm min-h-11" aria-label={`Move ${id} earlier`} disabled={index === 0 || busy} onClick={() => move(index, -1)}>↑</button><button className="btn btn-sm min-h-11" aria-label={`Move ${id} later`} disabled={index === selection.length - 1 || busy} onClick={() => move(index, 1)}>↓</button></span></li>)}</ol><div className="flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save home</button><button className="btn btn-outline" disabled={busy} onClick={() => void save(true)}>Restore useful defaults</button></div></div>}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{data?.widgets.map(widget => <article key={widget.id} className="rounded-xl bg-base-100 border border-base-300 p-4 min-w-0"><h2 className="font-semibold text-lg">{widget.title}</h2><p className="text-xl font-bold mt-2 break-words">{widget.summary}</p><ul className="space-y-2 mt-3">{widget.items?.map(item => <li key={item.id}><Link className="link inline-block py-2 break-words" href={item.href}>{item.text}</Link></li>)}</ul>{widget.lines.map((line, index) => <p key={index} className="text-sm opacity-75 mt-2 break-words">{line}</p>)}<Link className="btn btn-outline btn-sm min-h-11 mt-4" href={widget.href}>Open {widget.title.toLowerCase()}</Link></article>)}</div>
    {data && data.widgets.length === 0 && <p className="rounded-xl bg-base-100 p-4">No widgets selected. Customize home or use your tools below.</p>}
    {data && <p className="text-xs opacity-60">Snapshot: <LocalTime value={data.asOf} timeZone={data.timeZone} />. Refresh after imports or operational changes.</p>}
  </section>;
}
