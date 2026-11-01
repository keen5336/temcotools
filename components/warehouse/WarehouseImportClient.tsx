"use client";

import Link from "next/link";
import OfficeRefreshClient from "@/components/office/OfficeRefreshClient";
import type { OfficeRefreshStatus } from "@/lib/office/refresh";
import { useEffect, useState } from "react";
import { loadLpnSpreadsheetParser, parseLpnWorkbook } from "@/lib/lpn-workbook";
import { prepareLpnReport, type LpnSourceRow } from "@/lib/lpn-report";

export default function WarehouseImportClient() {
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<LpnSourceRow[]>([]);
  const [filename, setFilename] = useState("");
  const [summary, setSummary] = useState("");
  const [coverage, setCoverage] = useState<"partial" | "complete">("partial");
  const [scope, setScope] = useState("warehouse");
  const [sourceAsOf, setSourceAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ rowCount: number; insertedCount: number; changedCount: number; unchangedCount: number; officeRefresh?: OfficeRefreshStatus | null; officeRefreshError?: string | null } | null>(null);
  useEffect(() => { void loadLpnSpreadsheetParser().then(() => setReady(true)).catch(() => setError("Spreadsheet parser could not load. Try again when connected.")); }, []);
  async function readFile(file: File) {
    setError(""); setReceipt(null); setRows([]); setSummary(""); setFilename(file.name);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("Choose a report smaller than 50 MB.");
      const parsed = parseLpnWorkbook(await file.arrayBuffer());
      if (parsed.length > 100_000) throw new Error("Reports may contain up to 100,000 rows.");
      const report = prepareLpnReport(parsed);
      setRows(parsed); setSummary(`${report.items.length.toLocaleString()} LPN rows · ${report.duplicateCount.toLocaleString()} identical duplicate rows collapsed`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not read this report."); }
  }
  async function submit() {
    setBusy(true); setError(""); setReceipt(null);
    try {
      const response = await fetch("/api/warehouse/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, rows, scope, coverage, sourceAsOf: sourceAsOf ? new Date(sourceAsOf).toISOString() : null }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Import failed. No partial report was accepted.");
      setReceipt(payload.batch);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Import failed. Check the shared view before trying again."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5"><header><h1 className="text-2xl font-bold">Refresh shared WMS report</h1><p className="mt-2 text-sm">Import once for Inventory Audit, Put Away and warehouse lookup. Full source rows and changed revisions are retained; an import records reported state, not physical presence.</p></header>
    <div className="rounded-2xl border border-base-300 bg-base-100 p-4 space-y-4"><label className="form-control"><span className="label-text font-semibold">LPN report (.xlsx or .xls)</span><input className="file-input file-input-bordered mt-1 w-full" type="file" accept=".xlsx,.xls" disabled={!ready || busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} /></label>{summary && <p className="text-sm">{summary}</p>}
      <label className="form-control"><span className="label-text font-semibold">Source scope</span><input className="input input-bordered mt-1 w-full" value={scope} maxLength={100} onChange={(event) => setScope(event.target.value)} disabled={busy} /><span className="mt-1 text-xs text-base-content/70">Use the same scope for repeat reports covering the same warehouse/export selection.</span></label>
      <label className="form-control"><span className="label-text font-semibold">Report coverage</span><select className="select select-bordered mt-1 w-full" value={coverage} onChange={(event) => setCoverage(event.target.value as "partial" | "complete")} disabled={busy}><option value="partial">Partial / coverage not established</option><option value="complete">Complete report for this source scope</option></select></label><p className="text-xs text-base-content/70">A missing row in a partial report is not declared absent. Complete report membership still does not prove physical departure.</p>
      <label className="form-control"><span className="label-text font-semibold">Report source-as-of (optional)</span><input className="input input-bordered mt-1 w-full" type="datetime-local" value={sourceAsOf} onChange={(event) => setSourceAsOf(event.target.value)} disabled={busy} /><span className="mt-1 text-xs text-base-content/70">Enter the actual report time using the device timezone. Leave blank if unknown; upload time is recorded separately.</span></label>
      <button className="btn btn-primary min-h-12 w-full" disabled={busy || !rows.length || !scope.trim()} onClick={() => void submit()}>{busy ? "Importing…" : "Accept shared report"}</button>
    </div>{error && <p role="alert" className="alert alert-error text-sm">{error}</p>}{receipt && <div role="status" className="rounded-xl border border-success/40 bg-success/10 p-4 space-y-2"><p className="font-semibold">Shared report accepted</p><p>{receipt.rowCount.toLocaleString()} rows · {receipt.insertedCount.toLocaleString()} new · {receipt.changedCount.toLocaleString()} changed · {receipt.unchangedCount.toLocaleString()} unchanged</p><div className="flex flex-wrap gap-2"><Link className="btn btn-sm" href="/tools/lpn-put-away">Open Put Away</Link><Link className="btn btn-sm" href="/tools/warehouse">Warehouse Lookup</Link><Link className="btn btn-sm" href="/tools/inventory-audit">Inventory Audit</Link></div>{receipt.officeRefreshError && <p className="text-sm">{receipt.officeRefreshError}</p>}</div>}{receipt && <OfficeRefreshClient key={receipt.officeRefresh?.checkpoint?.checkpoint ?? filename} initial={receipt.officeRefresh} cause="wms_import" />}</div>;
}
