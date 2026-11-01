"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import ScannerCapture, { type ScannerFeedback } from "@/components/scanner/ScannerCapture";
import type { WarehouseLookupResult, WarehouseObservation } from "@/lib/warehouse-lookup";

function time(value: string | null) { return value ? new Date(value).toLocaleString() : "Not recorded"; }
function fieldValue(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value) ?? ""; }

function Observation({ scan }: { scan: WarehouseObservation }) {
  return <li className="space-y-1 rounded-xl border border-base-300 bg-base-100 p-3">
    <p className="font-semibold">Observed {time(scan.capturedAt)}</p>
    <p className="break-all text-sm">Scanned: {scan.scannedValue}</p>
    <p className="break-words text-sm">{scan.scannedByName || "Operator not recorded"} · {scan.pickWaveName}</p>
    <p className="text-xs text-base-content/70">{scan.identityBasis === "exact_lpn_scan" ? "Exact LPN scan" : "Linked by legacy Pick Wave match; not a verified identifier alias"}{scan.duplicateInWave ? " · repeat scan" : ""}</p>
    <p className="text-xs text-base-content/70">Added to Inventory Audit {time(scan.exportedAt)}</p>
  </li>;
}

export default function WarehouseLookupClient({ initialLpn, initialResult }: { initialLpn?: string; initialResult?: WarehouseLookupResult }) {
  const [kind, setKind] = useState<"lpn" | "order">("lpn");
  const [value, setValue] = useState(initialLpn ?? "");
  const [result, setResult] = useState<WarehouseLookupResult | null>(initialResult ?? null);
  const [feedback, setFeedback] = useState<ScannerFeedback | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latestRequest = useRef(0);

  const lookup = useCallback(async (raw: string, selectedKind: "lpn" | "order" = "lpn") => {
    const query = raw.trim();
    if (!query) return;
    const requestId = ++latestRequest.current;
    setLoading(true); setError(""); setResult(null); setFeedback({ tone: "info", title: "Looking up inventory", value: query });
    try {
      const response = await fetch(`/api/warehouse/lookup?${new URLSearchParams({ kind: selectedKind, value: query })}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Lookup failed.");
      if (requestId !== latestRequest.current) return;
      const next = payload.result as WarehouseLookupResult;
      setResult(next); setValue(next.normalizedValue); setKind(selectedKind);
      setFeedback({ tone: next.kind === "lpn" && next.record ? "success" : "info", title: next.kind === "lpn" ? next.record ? "WMS record found" : "No WMS row found" : "Order candidates", detail: next.kind === "lpn" ? "Reported inventory and scan evidence are separate." : "Choose an LPN. An order does not identify one appliance.", value: next.normalizedValue });
    } catch (failure) {
      if (requestId !== latestRequest.current) return;
      const message = failure instanceof Error ? failure.message : "Lookup failed.";
      setError(message); setFeedback({ tone: "error", title: "Lookup unavailable", detail: message, value: query });
    } finally { if (requestId === latestRequest.current) setLoading(false); }
  }, []);

  const record = result?.kind === "lpn" ? result.record : null;
  const sourceFields = record?.sourceData && typeof record.sourceData === "object" && !Array.isArray(record.sourceData) ? Object.entries(record.sourceData) : [];

  return <div className="space-y-5">
    <header><h1 className="text-2xl font-bold">Warehouse Lookup</h1><p className="mt-1 text-sm text-base-content/75">Find a WMS LPN across saved inventory, including archived and historical rows. Looking up a barcode does not record a physical scan.</p><div className="mt-3 flex flex-wrap gap-2"><Link href="/tools/warehouse/import" className="btn btn-sm btn-outline">Refresh shared WMS report</Link><Link href="/tools/warehouse/units" className="btn btn-sm btn-outline">Find linked unit / review identifiers</Link></div></header>
    <form className="rounded-2xl border border-base-300 bg-base-100 p-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void lookup(value, kind); }}>
      <label className="form-control"><span className="label-text font-semibold">Search by</span><select className="select select-bordered mt-1 w-full" value={kind} onChange={(event) => setKind(event.target.value as "lpn" | "order")}><option value="lpn">Exact LPN</option><option value="order">Exact order number — show candidates</option></select></label>
      <label className="form-control"><span className="label-text font-semibold">{kind === "lpn" ? "LPN" : "Order number"}</span><input className="input input-bordered mt-1 w-full" value={value} onChange={(event) => setValue(event.target.value)} maxLength={500} autoCapitalize="off" autoComplete="off" spellCheck={false} placeholder={kind === "lpn" ? "Scan or enter an LPN" : "Enter an order number"} /></label>
      <button className="btn btn-primary min-h-12 w-full" disabled={loading || !value.trim()}>{loading ? "Looking up…" : "Look up"}</button>
    </form>
    <ScannerCapture title="LPN Lookup Scanner" description="Scan an exact LPN to look it up without recording presence or completing work." onScan={(scanned) => lookup(scanned, "lpn")} feedback={feedback} result={record ? <div className="min-w-0 space-y-2"><p className="break-all text-2xl font-black">{record.lpn}</p><p className="break-words text-xl">{record.description || "No description"}</p><p>WMS reported: {record.reportedStatus || "Blank"}</p><p className="text-sm">{record.archivedAt ? "Archived record" : "Saved report record"} · presence not determined</p><p className="text-sm">Exit scanning to review source fields and observation history.</p></div> : undefined} />
    {error && <p role="alert" className="rounded-xl border border-error bg-error/10 p-3 text-error">{error}</p>}
    {result && <section aria-live="polite" className="space-y-4">
      <div className="rounded-xl border border-info/40 bg-info/10 p-4 text-sm space-y-2"><p className="font-semibold">Reported state and physical evidence</p><p>{result.limitations[1]}</p><p>Latest WMS import: {time(result.latestImport?.importedAt ?? null)}{result.latestImport ? ` · ${result.latestImport.rowCount.toLocaleString()} rows` : ""}</p><p className="text-xs">{result.limitations[0]}</p></div>
      {result.kind === "order" ? <div className="space-y-3"><h2 className="text-lg font-semibold">Order candidates</h2><p className="text-sm">An order can include several appliances or replacements. Select the exact LPN to inspect its own record.</p>{!result.candidates.length && <p>No saved WMS rows match this order number.</p>}{result.candidates.map((item) => <button key={item.inventoryRecordId} className="w-full rounded-xl border border-base-300 bg-base-100 p-4 text-left space-y-1" onClick={() => void lookup(item.lpn, "lpn")}><strong className="block break-all text-xl">{item.lpn}</strong><span className="block break-words">{item.description || "No description"}</span><span className="block text-sm">WMS: {item.reportedStatus || "Blank"}{item.archivedAt ? " · archived" : ""}</span></button>)}{result.hasMore && <p className="text-sm font-semibold">More than 20 candidates. Use an exact LPN to identify the record.</p>}</div> : <>
        {record ? <article className="rounded-2xl border border-base-300 bg-base-100 p-4 space-y-4"><div><h2 className="break-all text-2xl font-bold">{record.lpn}</h2><p className="break-words">{record.description || "No description"}</p>{record.unitId && <Link className="btn btn-primary mt-3 w-full" href={`/tools/warehouse/unit/${encodeURIComponent(record.unitId)}`}>Open linked physical-unit history</Link>}</div><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">{[["WMS reported status", record.reportedStatus || "Blank"], ["Order context", record.orderNumber || "Not recorded"], ["Vendor", record.vendor || "Not recorded"], ["Received date in report", record.receivedDate || "Not recorded"], ["Source row revision", String(record.revision)], ["Row last changed", time(record.sourceChangedAt)], ["Latest report membership", result.latestReportMembership], ["Row source-as-of", time(result.sourceAsOf)], ["Archive state", record.archivedAt ? `Archived ${time(record.archivedAt)}` : "Not archived"]].map(([label, content]) => <div key={label} className="min-w-0"><dt className="text-xs uppercase text-base-content/65">{label}</dt><dd className="break-words font-semibold">{content}</dd></div>)}</dl><details><summary className="cursor-pointer font-semibold">Full saved WMS source row</summary><dl className="mt-3 space-y-3">{sourceFields.map(([key, content]) => <div key={key} className="min-w-0 border-t border-base-200 pt-2"><dt className="break-words text-xs uppercase text-base-content/65">{key}</dt><dd className="whitespace-pre-wrap break-words text-sm">{fieldValue(content) || "—"}</dd></div>)}</dl></details></article> : <p className="rounded-xl border border-base-300 bg-base-100 p-4">No saved WMS row matches {result.normalizedValue}. {result.observationCount ? "Independent scan evidence exists below." : "This lookup does not identify an appliance."}</p>}
        <div className="space-y-3"><h2 className="text-lg font-semibold">Independent scan evidence ({result.observationCount})</h2><p className="text-sm">Original scan times are retained separately from the time they were added to Inventory Audit. A legacy Pick Wave match may have used an order or part number.</p>{result.observations.length ? <ul className="space-y-2">{result.observations.map((scan) => <Observation key={scan.observationId} scan={scan} />)}</ul> : <p className="text-sm">No independent Inventory Audit scans are linked to this LPN.</p>}{result.observationsTruncated && <p className="text-sm">Showing the most recent 20 observations. <Link href="/tools/inventory-audit" className="link">Inventory Audit</Link> retains the complete export.</p>}</div>
      </>}
    </section>}
  </div>;
}
