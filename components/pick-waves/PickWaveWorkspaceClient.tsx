"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PICK_WAVE_TEMPLATE, renderPickWaveLabel, type PickWaveLabelFields } from "./pickWaveLabel";
import { PICK_WAVE_STAGING_LOCATIONS } from "@/lib/pick-wave-constants";

interface PickWaveItem {
  id: string; rowNumber: number; routeNumber: string | null; contact: string | null; orderNumber: string | null;
  lpn: string | null; serialNumber: string | null; trackingNumber: string | null; partNumber: string | null;
  description: string | null; scannedAt: string | null;
}
interface RouteMapping { routeNumber: string; stagingLocation: string }
interface RecentScan { id: string; scannedValue: string; matched: boolean; alreadyScanned: boolean; createdAt: string }
interface PickWaveDetail {
  id: string; name: string; sourceFilename: string; createdAt: string; updatedAt: string; archivedAt: string | null; createdBy: string | null;
  items: PickWaveItem[]; routeMappings: RouteMapping[]; scans: RecentScan[];
}
interface ScanResult { matched: boolean; alreadyScanned: boolean; item: PickWaveItem | null; stagingLocation: string | null }

const STORAGE = {
  endpoint: "pick-wave.printerEndpoint", contentType: "pick-wave.contentType", autoPrint: "pick-wave.autoPrint", template: "pick-wave.labelTemplate",
};

export default function PickWaveWorkspaceClient({ initialWave }: { initialWave: PickWaveDetail }) {
  const [wave, setWave] = useState(initialWave);
  const [scanValue, setScanValue] = useState("");
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [routeMappings, setRouteMappings] = useState(() => buildRouteMappings(initialWave));
  const [search, setSearch] = useState("");
  const [showAllItems, setShowAllItems] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [printerEndpoint, setPrinterEndpoint] = useState("http://localhost:3000");
  const [contentType, setContentType] = useState("text/plain");
  const [template, setTemplate] = useState(DEFAULT_PICK_WAVE_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warning" | "error" | "info" } | null>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPrinterEndpoint(localStorage.getItem(STORAGE.endpoint) || localStorage.getItem("mars-label-tool.printerEndpoint") || "http://localhost:3000");
    setContentType(localStorage.getItem(STORAGE.contentType) || localStorage.getItem("mars-label-tool.contentType") || "text/plain");
    setAutoPrint(localStorage.getItem(STORAGE.autoPrint) === "true");
    setTemplate(localStorage.getItem(STORAGE.template) || DEFAULT_PICK_WAVE_TEMPLATE);
  }, []);

  const scannedCount = wave.items.filter((item) => item.scannedAt).length;
  const unassignedRoutes = useMemo(() => routeMappings.filter((mapping) => !mapping.stagingLocation.trim()).length, [routeMappings]);
  const assignedLocations = useMemo(() => new Set(routeMappings.map((mapping) => mapping.stagingLocation).filter(Boolean)), [routeMappings]);
  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return wave.items.filter((item) => {
      if (!showAllItems && item.scannedAt) return false;
      return !needle || [item.routeNumber, item.contact, item.orderNumber, item.lpn, item.serialNumber, item.trackingNumber, item.partNumber, item.description].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [wave.items, search, showAllItems]);

  async function handleScan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = scanValue.trim();
    if (!value || busy || wave.archivedAt) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/pick-waves/${encodeURIComponent(wave.id)}/scan`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scannedValue: value }),
      });
      const payload = await response.json() as { ok: true; result: ScanResult } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Scan failed.");
      const result = payload.result;
      setLastResult(result);
      setScanValue("");
      setWave((current) => ({
        ...current,
        items: result.item && !result.alreadyScanned ? current.items.map((item) => item.id === result.item?.id ? { ...item, scannedAt: result.item.scannedAt } : item) : current.items,
        scans: [{ id: crypto.randomUUID(), scannedValue: value, matched: result.matched, alreadyScanned: result.alreadyScanned, createdAt: new Date().toISOString() }, ...current.scans].slice(0, 25),
      }));
      if (!result.matched) setMessage({ text: "Not in pick wave", tone: "info" });
      else if (result.alreadyScanned) setMessage({ text: "This matching item was already scanned.", tone: "warning" });
      else {
        setMessage({ text: result.stagingLocation ? `Matched — stage at ${result.stagingLocation}.` : "Matched, but this route has no staging location.", tone: result.stagingLocation ? "success" : "warning" });
        if (autoPrint) await sendLabel(result.item, result.stagingLocation);
      }
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Scan failed.", tone: "error" });
    } finally {
      setBusy(false);
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    }
  }

  async function sendLabel(item: PickWaveItem | null, stagingLocation: string | null) {
    if (!item) return;
    const endpoint = printerEndpoint.trim();
    if (!endpoint) { setMessage({ text: "Set the label printer endpoint before printing.", tone: "warning" }); return; }
    const fields = labelFields(item, stagingLocation);
    localStorage.setItem(STORAGE.endpoint, endpoint); localStorage.setItem(STORAGE.contentType, contentType);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 2000);
    try {
      await fetch(endpoint, { method: "POST", headers: { "Content-Type": contentType }, body: renderPickWaveLabel(template, fields) + "\x04", mode: "no-cors", cache: "no-store", signal: controller.signal });
      setMessage({ text: `Label sent for ${item.lpn || item.serialNumber || item.orderNumber || "item"}.`, tone: "success" });
    } catch {
      setMessage({ text: `Label sent for ${item.lpn || item.serialNumber || item.orderNumber || "item"}.`, tone: "success" });
    } finally { window.clearTimeout(timeoutId); }
  }

  async function saveRoutes() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/pick-waves/${encodeURIComponent(wave.id)}/routes`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ routeMappings }),
      });
      const payload = await response.json() as { ok: true; routeMappings: RouteMapping[] } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Failed to save route mappings.");
      setRouteMappings(buildRouteMappings({ ...wave, routeMappings: payload.routeMappings }));
      setMessage({ text: "Route staging locations saved.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Failed to save routes.", tone: "error" }); }
    finally { setBusy(false); }
  }

  function savePrinterSettings() {
    localStorage.setItem(STORAGE.endpoint, printerEndpoint.trim()); localStorage.setItem(STORAGE.contentType, contentType);
    localStorage.setItem(STORAGE.autoPrint, String(autoPrint)); localStorage.setItem(STORAGE.template, template);
    setMessage({ text: "Printer and label template settings saved on this device.", tone: "success" });
  }

  function updateLocation(routeNumber: string, stagingLocation: string) {
    setRouteMappings((current) => current.map((mapping) => mapping.routeNumber === routeNumber ? { ...mapping, stagingLocation } : mapping));
  }

  const lastItem = lastResult?.item ?? null;
  const previewFields = lastItem ? labelFields(lastItem, lastResult?.stagingLocation ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><Link href="/tools/pick-waves" className="link link-primary text-sm">← All pick waves</Link><div className="flex flex-wrap items-center gap-2 mt-2"><h1 className="text-2xl font-semibold">{wave.name}</h1><span className={`badge ${wave.archivedAt ? "badge-neutral" : "badge-success"}`}>{wave.archivedAt ? "Archived" : "Active"}</span></div><p className="text-sm text-base-content/60 mt-1">Created {formatDate(wave.createdAt)} by {wave.createdBy ?? "unknown"} · {wave.sourceFilename}</p></div>
        <div className="stats bg-base-100 border border-base-200 shadow-sm"><div className="stat py-3"><div className="stat-title">Picked</div><div className="stat-value text-2xl">{scannedCount}/{wave.items.length}</div></div><div className="stat py-3"><div className="stat-title">Unmapped routes</div><div className={`stat-value text-2xl ${unassignedRoutes ? "text-warning" : "text-success"}`}>{unassignedRoutes}</div></div></div>
      </div>

      {message ? <div className={`alert ${message.tone === "success" ? "alert-success" : message.tone === "warning" ? "alert-warning" : message.tone === "info" ? "alert-info" : "alert-error"}`}><span>{message.text}</span></div> : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6 items-start">
        <div className="space-y-6">
          <section className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-5">
              <div className="flex flex-wrap justify-between gap-3"><div><h2 className="card-title">Scan Item</h2><p className="text-sm text-base-content/60 mt-1">Matches LPN, serial, tracking, order, or part number.</p></div><label className="label cursor-pointer gap-3"><span className="label-text font-semibold">Automatically print label</span><input type="checkbox" className="toggle toggle-success" checked={autoPrint} onChange={(event) => { setAutoPrint(event.target.checked); localStorage.setItem(STORAGE.autoPrint, String(event.target.checked)); }} /></label></div>
              {wave.archivedAt ? <div className="alert alert-warning"><span>Restore this wave from the list before scanning.</span></div> : <form onSubmit={handleScan} className="flex flex-col sm:flex-row gap-3"><input ref={scanInputRef} autoFocus className="input input-bordered input-lg flex-1 text-2xl font-semibold" value={scanValue} onChange={(event) => setScanValue(event.target.value)} placeholder="Scan barcode" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><button className="btn btn-primary btn-lg" disabled={!scanValue.trim() || busy}>{busy ? "Looking up…" : "Lookup"}</button></form>}

              {lastItem ? <div className={`rounded-2xl border-2 p-5 ${lastResult?.alreadyScanned ? "border-warning bg-warning/10" : "border-success bg-success/10"}`}>
                <div className="text-xs uppercase tracking-[0.2em] text-base-content/60">Staging Location</div><div className="text-5xl sm:text-7xl font-black leading-none my-3 break-words">{lastResult?.stagingLocation || "UNASSIGNED"}</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">{itemFields(lastItem).map(({ label, value }) => <div key={label}><div className="text-xs uppercase text-base-content/50">{label}</div><div className="font-semibold break-words">{value || "—"}</div></div>)}</div>
                <button className="btn btn-success mt-5" onClick={() => sendLabel(lastItem, lastResult?.stagingLocation ?? null)}>Print Label</button>
              </div> : lastResult && !lastResult.matched ? <div className="rounded-2xl border-2 border-info bg-info/10 p-6"><div className="text-4xl font-bold">Not in pick wave</div></div> : <div className="rounded-2xl border border-dashed border-base-300 p-6 text-base-content/60">The matching item and staging location will appear here.</div>}
            </div>
          </section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="card-title">Pick Items</h2><p className="text-sm text-base-content/60">{visibleItems.length} shown</p></div><div className="flex gap-3 items-center"><input className="input input-bordered input-sm" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search items" /><label className="label cursor-pointer gap-2"><span className="label-text">Show scanned</span><input type="checkbox" className="checkbox checkbox-sm" checked={showAllItems} onChange={(event) => setShowAllItems(event.target.checked)} /></label></div></div>
            <div className="overflow-auto max-h-[520px] border border-base-200 rounded-xl mt-3"><table className="table table-sm table-zebra"><thead className="sticky top-0 bg-base-100 z-[1]"><tr><th>Status</th><th>Route</th><th>Contact</th><th>Order</th><th>LPN</th><th>Serial</th><th>Tracking</th><th>Part</th><th>Description</th></tr></thead><tbody>{visibleItems.map((item) => <tr key={item.id}><td><span className={`badge badge-sm ${item.scannedAt ? "badge-success" : "badge-ghost"}`}>{item.scannedAt ? "Picked" : "Open"}</span></td><td>{item.routeNumber}</td><td>{item.contact}</td><td>{item.orderNumber}</td><td className="font-semibold">{item.lpn}</td><td>{item.serialNumber}</td><td>{item.trackingNumber}</td><td>{item.partNumber}</td><td className="min-w-64">{item.description}</td></tr>)}</tbody></table></div>
          </div></section>
        </div>

        <div className="space-y-6">
          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4"><div><h2 className="card-title">Route Staging Map</h2><p className="text-sm text-base-content/60 mt-1">Routes are taken from the uploaded workbook. Each staging location can be used once.</p></div><div className="overflow-x-auto border border-base-200 rounded-xl"><table className="table table-sm"><thead><tr><th>Route Number</th><th>Staging Location</th></tr></thead><tbody>{routeMappings.map((mapping) => <tr key={mapping.routeNumber}><td className="font-semibold">{mapping.routeNumber}</td><td><select className={`select select-bordered select-sm w-full ${mapping.stagingLocation ? "" : "select-warning"}`} value={mapping.stagingLocation} onChange={(event) => updateLocation(mapping.routeNumber, event.target.value)}><option value="">Select location</option>{PICK_WAVE_STAGING_LOCATIONS.map((location) => <option key={location} value={location} disabled={assignedLocations.has(location) && location !== mapping.stagingLocation}>{location}</option>)}</select></td></tr>)}</tbody></table></div><button className="btn btn-primary" disabled={busy || unassignedRoutes > 0} onClick={saveRoutes}>Save Route Mappings</button></div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4"><div><h2 className="card-title">Label Printer & Template</h2><p className="text-sm text-base-content/60 mt-1">Settings are stored on this device and inherit the MARS printer endpoint when available.</p></div><label className="form-control"><span className="label font-semibold">Printer / bridge endpoint</span><input className="input input-bordered input-sm" type="url" value={printerEndpoint} onChange={(event) => setPrinterEndpoint(event.target.value)} /></label><label className="form-control"><span className="label font-semibold">Content-Type</span><select className="select select-bordered select-sm" value={contentType} onChange={(event) => setContentType(event.target.value)}><option value="text/plain">text/plain</option><option value="application/octet-stream">application/octet-stream</option></select></label>
            {previewFields ? <div className="rounded-xl bg-white text-black border p-4" style={{ aspectRatio: "4 / 3" }}><div className="text-xs font-bold uppercase">Staging Location</div><div className="text-5xl font-black text-center border-4 border-black p-3 mt-1 mb-3 break-words">{previewFields.stagingLocation}</div><div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{[{ k: "Contact", v: previewFields.contact }, { k: "Order", v: previewFields.orderNumber }, { k: "LPN", v: previewFields.lpn }, { k: "Serial", v: previewFields.serialNumber }, { k: "Date", v: previewFields.today }, { k: "Part", v: previewFields.partNumber }].map(({ k, v }) => <div key={k}><div className="text-[10px] font-bold uppercase text-gray-500">{k}</div><div className="font-bold break-words">{v || "UNKNOWN"}</div></div>)}</div></div> : null}
            <details><summary className="cursor-pointer font-semibold">Edit ZPL template</summary><p className="text-xs text-base-content/60 my-2">Placeholders: {"{{stagingLocation}}, {{contact}}, {{orderNumber}}, {{lpn}}, {{serialNumber}}, {{today}}, {{partNumber}}, {{routeNumber}}"}</p><textarea className="textarea textarea-bordered font-mono text-xs w-full min-h-72" value={template} onChange={(event) => setTemplate(event.target.value)} spellCheck={false} /><button className="btn btn-sm btn-ghost mt-2" onClick={() => setTemplate(DEFAULT_PICK_WAVE_TEMPLATE)}>Restore Default</button></details>
            <button className="btn btn-outline" onClick={savePrinterSettings}>Save Printer & Template Settings</button>
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body"><h2 className="card-title">Recent Scans</h2><div className="overflow-auto max-h-72"><table className="table table-sm"><thead><tr><th>Value</th><th>Result</th><th>Time</th></tr></thead><tbody>{wave.scans.map((scan) => <tr key={scan.id}><td className="font-semibold break-all">{scan.scannedValue}</td><td><span className={`badge badge-sm ${!scan.matched ? "badge-info" : scan.alreadyScanned ? "badge-warning" : "badge-success"}`}>{!scan.matched ? "Not in pick wave" : scan.alreadyScanned ? "Duplicate" : "Matched"}</span></td><td>{formatDate(scan.createdAt)}</td></tr>)}</tbody></table></div></div></section>
        </div>
      </div>
    </div>
  );
}

function buildRouteMappings(wave: Pick<PickWaveDetail, "items" | "routeMappings">) {
  const saved = new Map(wave.routeMappings.map((mapping) => [mapping.routeNumber.toLowerCase(), mapping.stagingLocation]));
  return [...new Set(wave.items.map((item) => item.routeNumber).filter((route): route is string => Boolean(route)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((routeNumber) => ({ routeNumber, stagingLocation: saved.get(routeNumber.toLowerCase()) ?? "" }));
}
function labelFields(item: PickWaveItem, stagingLocation: string | null): PickWaveLabelFields { return { stagingLocation: stagingLocation || "UNASSIGNED", contact: item.contact || "", orderNumber: item.orderNumber || "", lpn: item.lpn || "", serialNumber: item.serialNumber || "", today: new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), partNumber: item.partNumber || "", routeNumber: item.routeNumber || "" }; }
function itemFields(item: PickWaveItem) { return [{ label: "Route", value: item.routeNumber }, { label: "Contact", value: item.contact }, { label: "Order", value: item.orderNumber }, { label: "LPN", value: item.lpn }, { label: "Serial", value: item.serialNumber }, { label: "Tracking", value: item.trackingNumber }, { label: "Part", value: item.partNumber }, { label: "Description", value: item.description }]; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
