"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderPickWaveLabel, type PickWaveLabelFields } from "./pickWaveLabel";
import { PICK_WAVE_STAGING_LOCATIONS } from "@/lib/pick-wave-constants";
import ScannerCapture, { type ScannerFeedback } from "@/components/scanner/ScannerCapture";
import LabelOutputSelector from "@/components/labels/LabelOutputSelector";
import { useLabelConfiguration } from "@/components/labels/useLabelConfiguration";
import { sendLabel as printLabel } from "@/lib/label-printing";

interface PickWaveItem {
  id: string; rowNumber: number; routeNumber: string | null; contact: string | null; orderNumber: string | null;
  lpn: string | null; serialNumber: string | null; trackingNumber: string | null; partNumber: string | null;
  description: string | null; scannedAt: string | null;
}
interface RouteMapping { routeNumber: string; stagingLocation: string | null }
interface RecentScan { id: string; scannedValue: string; matched: boolean; alreadyScanned: boolean; createdAt: string }
interface PickWaveDetail {
  id: string; name: string; sourceFilename: string; createdAt: string; updatedAt: string; archivedAt: string | null; createdBy: string | null;
  items: PickWaveItem[]; routeMappings: RouteMapping[]; scans: RecentScan[]; scanCount: number;
}
interface ScanResult { matched: boolean; alreadyScanned: boolean; item: PickWaveItem | null; stagingLocation: string | null }

const AUTO_PRINT_STORAGE = "pick-wave.autoPrint";

export default function PickWaveWorkspaceClient({ initialWave }: { initialWave: PickWaveDetail }) {
  const [wave, setWave] = useState(initialWave);
  const labels = useLabelConfiguration("pick_wave");
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [routeMappings, setRouteMappings] = useState(() => buildRouteMappings(initialWave));
  const [search, setSearch] = useState("");
  const [showAllItems, setShowAllItems] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const printingRef = useRef<Promise<void> | null>(null);
  const [savingScanList, setSavingScanList] = useState(false);
  const savingScanListRef = useRef(false);
  const [savedScanList, setSavedScanList] = useState<{ id: string; name: string; scanCount: number } | null>(null);
  const [scanListError, setScanListError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warning" | "error" | "info" } | null>(null);

  useEffect(() => {
    setAutoPrint(localStorage.getItem(AUTO_PRINT_STORAGE) === "true");
  }, []);

  const scannedCount = wave.items.filter((item) => item.scannedAt).length;
  const noLocationRoutes = useMemo(() => routeMappings.filter((mapping) => !mapping.stagingLocation).length, [routeMappings]);
  const assignedLocations = useMemo(() => new Set(routeMappings.map((mapping) => mapping.stagingLocation).filter((location): location is string => Boolean(location))), [routeMappings]);
  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return wave.items.filter((item) => {
      if (!showAllItems && item.scannedAt) return false;
      return !needle || [item.routeNumber, item.contact, item.orderNumber, item.lpn, item.serialNumber, item.trackingNumber, item.partNumber, item.description].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [wave.items, search, showAllItems]);
  const selectedItem = visibleItems.find((item) => item.id === selectedItemId) ?? null;
  const selectedLocation = selectedItem?.routeNumber
    ? wave.routeMappings.find((mapping) => mapping.routeNumber.toLowerCase() === selectedItem.routeNumber?.toLowerCase())?.stagingLocation ?? null
    : null;

  async function handleScan(value: string) {
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
      setWave((current) => ({
        ...current,
        items: result.item && !result.alreadyScanned ? current.items.map((item) => item.id === result.item?.id ? { ...item, scannedAt: result.item.scannedAt } : item) : current.items,
        scanCount: current.scanCount + 1,
        scans: [{ id: crypto.randomUUID(), scannedValue: value, matched: result.matched, alreadyScanned: result.alreadyScanned, createdAt: new Date().toISOString() }, ...current.scans].slice(0, 25),
      }));
      if (!result.matched) setMessage({ text: "Not in pick wave", tone: "info" });
      else if (result.alreadyScanned) setMessage({ text: "This matching item was already scanned.", tone: "warning" });
      else {
        setMessage({ text: result.stagingLocation ? `Matched — stage at ${result.stagingLocation}.` : "Item has no location.", tone: result.stagingLocation ? "success" : "info" });
        if (autoPrint && result.stagingLocation) await sendLabel(result.item, result.stagingLocation, true);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Scan failed.";
      setMessage({ text, tone: "error" });
      throw new Error(text);
    } finally {
      setBusy(false);
    }
  }

  async function sendLabel(item: PickWaveItem | null, stagingLocation: string | null, automatic = false) {
    if (!item) return;
    if (!stagingLocation) { setMessage({ text: "Item has no location. No label was printed.", tone: "info" }); return; }
    if (!labels.printer || !labels.template) { setMessage({ text: "A manager must activate a printer destination and Pick Wave template before printing.", tone: "warning" }); return; }
    if (printingRef.current) {
      if (!automatic) return;
      // A new scan must still print if an earlier manual label is in flight.
      await printingRef.current;
    }
    setPrinting(true);
    const fields = labelFields(item, stagingLocation);
    const pending = printLabel(labels.printer, renderPickWaveLabel(labels.template.zpl, fields) + "\x04", labels.relayEnabled)
      .then((result) => { setMessage({ text: `${result} Item: ${itemIdentifier(item)}.`, tone: "success" }); })
      .catch((error: unknown) => { setMessage({ text: error instanceof Error ? error.message : "Unable to send label.", tone: "warning" }); });
    printingRef.current = pending;
    await pending;
    if (printingRef.current === pending) {
      printingRef.current = null;
      setPrinting(false);
    }
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
      setWave((current) => ({ ...current, routeMappings: payload.routeMappings }));
      setMessage({ text: "Route staging locations saved.", tone: "success" });
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Failed to save routes.", tone: "error" }); }
    finally { setBusy(false); }
  }

  async function saveToScanList() {
    if (savingScanListRef.current) return;
    savingScanListRef.current = true;
    setSavingScanList(true);
    setScanListError(null);
    setSavedScanList(null);
    try {
      const response = await fetch(`/api/pick-waves/${encodeURIComponent(wave.id)}/scan-list`, { method: "POST" });
      const payload = await response.json() as { ok: true; scanList: { id: string; name: string; scanCount: number } } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Failed to save scan list.");
      setSavedScanList(payload.scanList);
    } catch (error) {
      setScanListError(error instanceof Error ? error.message : "Failed to save scan list.");
    } finally {
      savingScanListRef.current = false;
      setSavingScanList(false);
    }
  }

  function updateLocation(routeNumber: string, stagingLocation: string) {
    setRouteMappings((current) => current.map((mapping) => mapping.routeNumber === routeNumber ? { ...mapping, stagingLocation: stagingLocation || null } : mapping));
  }

  const lastItem = lastResult?.item ?? null;
  const previewFields = lastItem && lastResult?.stagingLocation ? labelFields(lastItem, lastResult.stagingLocation) : null;
  const scanFeedback: ScannerFeedback | null = message ? {
    tone: message.tone,
    title: message.text,
    value: wave.scans[0]?.scannedValue,
  } : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><Link href="/tools/pick-waves" className="link link-primary text-sm">← All pick waves</Link><div className="flex flex-wrap items-center gap-2 mt-2"><h1 className="text-2xl font-semibold">{wave.name}</h1><span className={`badge ${wave.archivedAt ? "badge-neutral" : "badge-success"}`}>{wave.archivedAt ? "Archived" : "Active"}</span></div><p className="text-sm text-base-content/60 mt-1">Created {formatDate(wave.createdAt)} by {wave.createdBy ?? "unknown"} · {wave.sourceFilename}</p></div>
        <div className="stats bg-base-100 border border-base-200 shadow-sm"><div className="stat py-3"><div className="stat-title">Picked</div><div className="stat-value text-2xl">{scannedCount}/{wave.items.length}</div></div><div className="stat py-3"><div className="stat-title">Routes with no location</div><div className="stat-value text-2xl">{noLocationRoutes}</div></div></div>
      </div>

      {message ? <div className={`alert ${message.tone === "success" ? "alert-success" : message.tone === "warning" ? "alert-warning" : message.tone === "info" ? "alert-info" : "alert-error"}`}><span>{message.text}</span></div> : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6 items-start">
        <div className="space-y-6">
          <section className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body gap-5">
              <div className="flex flex-wrap justify-between gap-3"><div><h2 className="card-title">Scan Item</h2><p className="text-sm text-base-content/60 mt-1">Matches LPN, serial, tracking, order, or part number.</p></div><label className="label cursor-pointer gap-3"><span className="label-text font-semibold">Automatically print label</span><input type="checkbox" className="toggle toggle-success" checked={autoPrint} onChange={(event) => { setAutoPrint(event.target.checked); localStorage.setItem(AUTO_PRINT_STORAGE, String(event.target.checked)); }} /></label></div>
              <ScannerCapture title="Pick Wave Scanning" description="Scanner events are captured anywhere on the one-screen view without opening the keyboard." onScan={handleScan} enabled={!wave.archivedAt} disabledReason="Restore this wave before scanning." count={scannedCount} countLabel="picked" feedback={scanFeedback} result={lastItem && !lastResult?.stagingLocation ? <div className="grid h-full min-w-0 place-items-center text-center text-3xl sm:text-4xl font-black">Item has no location</div> : lastItem ? <div className="min-w-0 max-w-full overflow-hidden"><div className="text-xs uppercase tracking-[0.2em] text-slate-400">Staging Location</div><div className="max-w-full text-5xl sm:text-8xl font-black leading-none my-3 break-all">{lastResult?.stagingLocation}</div><div className="grid min-w-0 grid-cols-2 gap-3 text-sm">{itemFields(lastItem).map(({ label, value }) => <div key={label} className="min-w-0"><div className="text-xs uppercase text-slate-400">{label}</div><div className="font-semibold break-all">{value || "—"}</div></div>)}</div><button type="button" className="btn btn-success mt-4 w-full" disabled={printing || !labels.printer || !labels.template} onClick={() => void sendLabel(lastItem, lastResult?.stagingLocation ?? null)}>{lastResult?.alreadyScanned ? "Print Label Anyway" : "Print Label"}</button>{!labels.printer || !labels.template ? <p className="mt-2 text-xs text-amber-300">A printer and template must be configured before printing.</p> : null}</div> : lastResult && !lastResult.matched ? <div className="grid h-full min-w-0 place-items-center text-center text-3xl sm:text-4xl font-black">Not in pick wave</div> : undefined} />

              {lastItem && !lastResult?.stagingLocation ? <div className="rounded-2xl border-2 border-info bg-info/10 p-6"><div className="text-4xl font-bold">Item has no location</div><p className="mt-2">No label will be printed.</p></div> : lastItem ? <div className={`rounded-2xl border-2 p-5 ${lastResult?.alreadyScanned ? "border-warning bg-warning/10" : "border-success bg-success/10"}`}>
                <div className="text-xs uppercase tracking-[0.2em] text-base-content/60">Staging Location</div><div className="text-5xl sm:text-7xl font-black leading-none my-3 break-words">{lastResult?.stagingLocation || "UNASSIGNED"}</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">{itemFields(lastItem).map(({ label, value }) => <div key={label}><div className="text-xs uppercase text-base-content/50">{label}</div><div className="font-semibold break-words">{value || "—"}</div></div>)}</div>
                <button className="btn btn-success mt-5" disabled={printing || !labels.printer || !labels.template} onClick={() => sendLabel(lastItem, lastResult?.stagingLocation ?? null)}>Print Label</button>
              </div> : lastResult && !lastResult.matched ? <div className="rounded-2xl border-2 border-info bg-info/10 p-6"><div className="text-4xl font-bold">Not in pick wave</div></div> : <div className="rounded-2xl border border-dashed border-base-300 p-6 text-base-content/60">The matching item and staging location will appear here.</div>}
            </div>
          </section>

          <section className="card bg-base-100 border border-base-200 shadow-sm">
            <div className="card-body">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><h2 className="card-title">Pick Items</h2><p className="text-sm text-base-content/60">{visibleItems.length} shown</p></div>
                <div className="flex flex-wrap gap-3 items-center">
                  <input aria-label="Search items" className="input input-bordered input-sm" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedItemId(null); }} placeholder="Search items" />
                  <label className="label cursor-pointer gap-2"><span className="label-text">Show scanned</span><input type="checkbox" className="checkbox checkbox-sm" checked={showAllItems} onChange={(event) => { setShowAllItems(event.target.checked); setSelectedItemId(null); }} /></label>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
                <p className="text-sm text-base-content/70" aria-live="polite">
                  {selectedItem ? `Selected: ${itemIdentifier(selectedItem)} · ${selectedLocation ? `Stage at ${selectedLocation}` : "No saved staging location — save a route mapping before printing."}` : "Select an item to print its pick label."}
                </p>
                <button type="button" className="btn btn-success btn-sm" disabled={!selectedItem || !selectedLocation || busy || printing || !labels.printer || !labels.template} onClick={() => void sendLabel(selectedItem, selectedLocation)}>
                  {printing ? "Printing…" : "Print pick label"}
                </button>
              </div>
              <div className="overflow-auto max-h-[520px] border border-base-200 rounded-xl mt-3">
                <table className="table table-sm">
                  <thead className="sticky top-0 bg-base-100 z-[1]"><tr><th><span className="sr-only">Select item</span></th><th>Status</th><th>Route</th><th>Contact</th><th>Order</th><th>LPN</th><th>Serial</th><th>Tracking</th><th>Part</th><th>Description</th></tr></thead>
                  <tbody>
                    {visibleItems.map((item) => (
                      <tr key={item.id} className={`cursor-pointer ${selectedItem?.id === item.id ? "bg-primary/10" : "hover:bg-base-200"}`} onClick={() => setSelectedItemId(item.id)}>
                        <td><input type="radio" name="pick-item" aria-label={`Select ${itemIdentifier(item)}, row ${item.rowNumber}`} className="radio radio-sm radio-primary" checked={selectedItem?.id === item.id} onChange={() => setSelectedItemId(item.id)} /></td>
                        <td><span className={`badge badge-sm ${item.scannedAt ? "badge-success" : "badge-ghost"}`}>{item.scannedAt ? "Picked" : "Open"}</span></td><td>{item.routeNumber}</td><td>{item.contact}</td><td>{item.orderNumber}</td><td className="font-semibold">{item.lpn}</td><td>{item.serialNumber}</td><td>{item.trackingNumber}</td><td>{item.partNumber}</td><td className="min-w-64">{item.description}</td>
                      </tr>
                    ))}
                    {!visibleItems.length ? <tr><td colSpan={10} className="text-base-content/60">No items match the current filters.</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4"><div><h2 className="card-title">Route Staging Map</h2><p className="text-sm text-base-content/60 mt-1">Routes are taken from the uploaded workbook. Routes may have No Location, and each actual staging location can be used once.</p></div><div className="overflow-x-auto border border-base-200 rounded-xl"><table className="table table-sm"><thead><tr><th>Route Number</th><th>Staging Location</th></tr></thead><tbody>{routeMappings.map((mapping) => <tr key={mapping.routeNumber}><td className="font-semibold">{mapping.routeNumber}</td><td><select className="select select-bordered select-sm w-full" value={mapping.stagingLocation ?? ""} onChange={(event) => updateLocation(mapping.routeNumber, event.target.value)}><option value="">No Location</option>{PICK_WAVE_STAGING_LOCATIONS.map((location) => <option key={location} value={location} disabled={assignedLocations.has(location) && location !== mapping.stagingLocation}>{location}</option>)}</select></td></tr>)}</tbody></table></div><button className="btn btn-primary" disabled={busy} onClick={saveRoutes}>Save Route Mappings</button></div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body gap-4"><div><h2 className="card-title">Label Output</h2><p className="text-sm text-base-content/60 mt-1">Choose an approved template and where to print. Managers control the endpoint and ZPL.</p></div><LabelOutputSelector printers={labels.printers} templates={labels.templates} printerId={labels.printerId} templateId={labels.templateId} onPrinterChange={labels.setPrinterId} onTemplateChange={labels.setTemplateId} loading={labels.loading} error={labels.error} />
            {previewFields ? <div className="rounded-xl bg-white text-black border p-4" style={{ aspectRatio: "4 / 3" }}><div className="text-xs font-bold uppercase">Staging Location</div><div className="text-5xl font-black text-center border-4 border-black p-3 mt-1 mb-3 break-words">{previewFields.stagingLocation}</div><div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">{[{ k: "Contact", v: previewFields.contact }, { k: "Order", v: previewFields.orderNumber }, { k: "LPN", v: previewFields.lpn }, { k: "Serial", v: previewFields.serialNumber }, { k: "Date", v: previewFields.today }, { k: "Part", v: previewFields.partNumber }].map(({ k, v }) => <div key={k}><div className="text-[10px] font-bold uppercase text-gray-500">{k}</div><div className="font-bold break-words">{v || "UNKNOWN"}</div></div>)}</div></div> : null}
          </div></section>

          <section className="card bg-base-100 border border-base-200 shadow-sm"><div className="card-body">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="card-title">Recent Scans</h2>
              <button type="button" className="btn btn-primary btn-sm" disabled={!wave.scanCount || busy || savingScanList} onClick={() => void saveToScanList()}>{savingScanList ? "Saving…" : "Save to scan list"}</button>
            </div>
            <p className="text-sm text-base-content/60">Showing the latest {wave.scans.length} of {wave.scanCount} scans. Saving includes all scans in this wave, including duplicates and unmatched values.</p>
            {savedScanList ? <div role="status" className="alert alert-success text-sm"><span>Saved {savedScanList.scanCount} scans to <Link className="link font-semibold" href={`/tools/scan-lists/${savedScanList.id}`}>{savedScanList.name}</Link>.</span></div> : null}
            {scanListError ? <div role="alert" className="alert alert-error text-sm">{scanListError}</div> : null}
            <div className="overflow-auto max-h-72">
              <table className="table table-sm">
                <thead><tr><th>Value</th><th>Result</th><th>Time</th></tr></thead>
                <tbody>{wave.scans.map((scan) => (
                  <tr key={scan.id}>
                    <td className="font-semibold break-all">{scan.scannedValue}</td>
                    <td><span className={`badge badge-sm whitespace-nowrap ${!scan.matched ? "badge-info" : scan.alreadyScanned ? "badge-warning" : "badge-success"}`}>{!scan.matched ? "Not in pick wave" : scan.alreadyScanned ? "Duplicate" : "Matched"}</span></td>
                    <td>{formatDate(scan.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div></section>
        </div>
      </div>
    </div>
  );
}

function buildRouteMappings(wave: Pick<PickWaveDetail, "items" | "routeMappings">) {
  const saved = new Map(wave.routeMappings.map((mapping) => [mapping.routeNumber.toLowerCase(), mapping.stagingLocation]));
  return [...new Set(wave.items.map((item) => item.routeNumber).filter((route): route is string => Boolean(route)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((routeNumber) => ({ routeNumber, stagingLocation: saved.get(routeNumber.toLowerCase()) ?? null }));
}
function itemIdentifier(item: PickWaveItem) { return item.lpn || item.serialNumber || item.trackingNumber || item.orderNumber || item.partNumber || `Row ${item.rowNumber}`; }
function labelFields(item: PickWaveItem, stagingLocation: string): PickWaveLabelFields { return { stagingLocation, contact: item.contact || "", orderNumber: item.orderNumber || "", lpn: item.lpn || "", serialNumber: item.serialNumber || "", today: new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), partNumber: item.partNumber || "", routeNumber: item.routeNumber || "" }; }
function itemFields(item: PickWaveItem) { return [{ label: "Route", value: item.routeNumber }, { label: "Contact", value: item.contact }, { label: "Order", value: item.orderNumber }, { label: "LPN", value: item.lpn }, { label: "Serial", value: item.serialNumber }, { label: "Tracking", value: item.trackingNumber }, { label: "Part", value: item.partNumber }, { label: "Description", value: item.description }]; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
