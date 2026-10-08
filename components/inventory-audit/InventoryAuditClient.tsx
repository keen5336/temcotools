"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadLpnSpreadsheetParser, parseLpnWorkbook } from "@/lib/lpn-workbook";
import { prepareLpnReport } from "@/lib/lpn-report";

type InventoryRow = {
  id: string; lpn: string; status: string; vendor: string; orderNumber: string; receivedDate: string;
  description: string; customerName: string; sourceData: Record<string, string>; revision: number;
  firstSeenAt: string; sourceChangedAt: string; lastScannedAt: string | null; lastScanWaveName: string | null;
  verifiedAt: string | null; archivedAt: string | null;
};
type ImportBatch = { filename: string; createdAt: string; insertedCount: number; changedCount: number; unchangedCount: number; duplicateCount: number; blankCount: number; uploadedByName: string };
type Board = {
  items: InventoryRow[];
  scans: { id: string; lpn: string | null; scannedValue: string; pickWaveName: string; scannedByName: string | null; scannedAt: string; duplicateInWave: boolean }[];
  total: number; page: number; pageCount: number; summary: { active: number; archived: number; pending: number; scanned: number };
  latestImport: ImportBatch | null;
};
const PAGE_SIZE = 100;

export default function InventoryAuditClient() {
  const [board, setBoard] = useState<Board | null>(null);
  const [archive, setArchive] = useState("active");
  const [verification, setVerification] = useState("all");
  const [view, setView] = useState("inventory");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const mutation = useRef(false);
  const queryParams = useCallback(() => new URLSearchParams({ archive, verification, search: query, page: String(page), view }), [archive, verification, query, page, view]);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setSelected([]);
    void fetch(`/api/inventory-audit?${queryParams()}`, { signal: abort.signal, cache: "no-store" }).then(async (response) => {
      const data = await response.json() as { ok: boolean; board: Board; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Unable to load the inventory.");
      if (!abort.signal.aborted) { setBoard(data.board); setError(""); }
    }).catch((error: unknown) => { if (!abort.signal.aborted) { setBoard(null); setError(error instanceof Error ? error.message : "Unable to load the inventory."); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [queryParams, refresh]);

  async function upload(file: File) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("The spreadsheet must be smaller than 50 MB.");
      await loadLpnSpreadsheetParser();
      const rows = parseLpnWorkbook(await file.arrayBuffer());
      prepareLpnReport(rows); // Check columns/conflicting LPNs before sending the report.
      const response = await fetch("/api/inventory-audit/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, rows }) });
      const data = await response.json() as { ok: boolean; batch: ImportBatch; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Unable to import the report.");
      const batch = data.batch;
      setMessage(`Imported ${file.name}: ${batch.insertedCount.toLocaleString()} new, ${batch.changedCount.toLocaleString()} changed, ${batch.unchangedCount.toLocaleString()} unchanged. ${batch.duplicateCount} repeated rows and ${batch.blankCount} blank LPN rows skipped.`);
      setPage(1); setRefresh((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to import the report."); }
    finally { mutation.current = false; setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function changeArchive(ids: string[], archived: boolean) {
    if (mutation.current || !ids.length) return;
    mutation.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/inventory-audit", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, archived }) });
      const data = await response.json() as { ok: boolean; count: number; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Unable to update the selected rows.");
      setMessage(`${data.count} rows ${archived ? "archived" : "restored"}.`);
      setSelected([]); setRefresh((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to update the selected rows."); }
    finally { mutation.current = false; setBusy(false); }
  }
  function toggle(id: string) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  const disabled = busy || loading;
  const allSelected = Boolean(board?.items.length && board.items.every((row) => selected.includes(row.id)));
  return <div className="space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-4">
      <div><Link href="/" className="link link-primary text-sm">← Operations Tools</Link><h1 className="text-2xl font-semibold mt-2">Inventory Audit</h1><p className="text-sm text-base-content/70 mt-1">A running warehouse inventory keyed by LPN, compared with exported Pick Wave scans.</p></div>
      <Link href="/tools/pick-waves" className="btn btn-outline">Pick Waves</Link>
    </div>
    <section className="card bg-base-100 border border-base-200"><div className="card-body gap-3">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="card-title">Import LPN report</h2><p className="text-sm text-base-content/70 mt-1">Use the same spreadsheet as LPN Put Away. All statuses and received dates are included.</p></div><div><input ref={input} type="file" accept=".xlsx,.xls" className="hidden" aria-label="LPN report spreadsheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /><button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Saving…" : "Upload LPN report"}</button></div></div>
      <p className="text-sm text-base-content/60">Unchanged rows keep their scan and archive state. Any report change restores the row to Active and Needs scan. Missing LPNs stay in the tracker. Archived rows remain searchable.</p>
      {board?.latestImport ? <p className="text-xs text-base-content/60">Latest report: {board.latestImport.filename} · {date(board.latestImport.createdAt)} · {board.latestImport.uploadedByName}</p> : null}
    </div></section>
    {error ? <div role="alert" className="alert alert-error"><span>{error}</span></div> : null}
    {message ? <div role="status" className="alert alert-success"><span>{message}</span></div> : null}
    {board ? <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[["Active LPNs", board.summary.active], ["Needs scan", board.summary.pending], ["Scanned", board.summary.scanned], ["Archived", board.summary.archived]].map(([label, count]) => <div key={label} className="stat bg-base-100 border border-base-200 rounded-lg py-3"><div className="stat-title">{label}</div><div className="stat-value text-2xl">{Number(count).toLocaleString()}</div></div>)}</div> : null}
    <section className="card bg-base-100 border border-base-200"><div className="card-body gap-4">
      <div role="group" aria-label="Audit views" className="flex flex-wrap gap-2"><button className={`btn btn-sm ${view === "inventory" ? "btn-primary" : "btn-outline"}`} onClick={() => { setView("inventory"); setPage(1); }}>Inventory</button><button className={`btn btn-sm ${view === "unmatched" ? "btn-primary" : "btn-outline"}`} onClick={() => { setView("unmatched"); setPage(1); }}>Unmatched scans</button></div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="form-control flex-1 min-w-48"><span className="label text-sm">Search {view === "inventory" ? "inventory" : "scans"}</span><input className="input input-bordered w-full" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={view === "inventory" ? "LPN, order, vendor, customer, description…" : "Scan value, LPN, pick wave…"} /></label>
        {view === "inventory" ? <><label className="form-control"><span className="label text-sm">Archive</span><select aria-label="Archive" className="select select-bordered" value={archive} onChange={(event) => { setArchive(event.target.value); setPage(1); }}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All LPNs</option></select></label><label className="form-control"><span className="label text-sm">Audit status</span><select aria-label="Audit status" className="select select-bordered" value={verification} onChange={(event) => { setVerification(event.target.value); setPage(1); }}><option value="all">All</option><option value="pending">Needs scan</option><option value="scanned">Scanned</option></select></label><a className="btn btn-outline" href={`/api/inventory-audit/export?${queryParams()}`}>Export CSV</a></> : null}
        <button type="button" className="btn btn-outline" disabled={disabled} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </div>
      {view === "inventory" ? <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-base-content/60">{selected.length} selected</span><button type="button" className="btn btn-sm btn-outline" disabled={disabled || !selected.length} onClick={() => void changeArchive(selected, true)}>Archive selected</button><button type="button" className="btn btn-sm btn-outline" disabled={disabled || !selected.length} onClick={() => void changeArchive(selected, false)}>Restore selected</button></div> : <p className="text-sm text-base-content/60">Every unmatched scan is kept, including duplicates. Exact LPNs match automatically when that LPN first appears in a later report. Picked items without an LPN need review.</p>}
      {loading ? <div role="status" className="flex items-center gap-2 py-8"><span className="loading loading-spinner loading-sm" />Loading…</div> : board ? <>
        <div className="overflow-auto max-h-[65vh]">
          {view === "inventory" ? <table className="table table-sm"><thead className="sticky top-0 bg-base-100 z-[1]"><tr><th><input type="checkbox" className="checkbox checkbox-sm" aria-label="Select this page" checked={allSelected} disabled={disabled || !board.items.length} onChange={() => setSelected(allSelected ? [] : board.items.map((row) => row.id))} /></th><th>LPN / audit</th><th>Report status</th><th>Vendor / order</th><th>Received</th><th>Customer / description</th><th>Scan evidence</th><th>Report / archive</th><th>Action</th></tr></thead><tbody>{board.items.map((row) => <tr key={row.id}>
            <td><input type="checkbox" className="checkbox checkbox-sm" aria-label={`Select ${row.lpn}`} checked={selected.includes(row.id)} disabled={disabled} onChange={() => toggle(row.id)} /></td>
            <td><div className="font-mono font-semibold whitespace-nowrap">{row.lpn}</div><span className={`badge badge-sm mt-1 ${row.verifiedAt ? "badge-success" : "badge-warning"}`}>{row.verifiedAt ? "Scanned" : "Needs scan"}</span></td>
            <td>{row.status || "—"}</td><td><div>{row.vendor || "—"}</div><div className="font-mono text-xs">{row.orderNumber}</div></td><td className="whitespace-nowrap">{row.receivedDate || "—"}</td>
            <td className="min-w-60 max-w-96"><div className="font-medium">{row.customerName}</div><div className="text-sm">{row.description}</div><details className="mt-1"><summary className="cursor-pointer text-xs text-primary">Full report row</summary><dl className="text-xs space-y-1 mt-2">{Object.entries(row.sourceData).map(([key, value]) => <div key={key}><dt className="font-semibold">{key}</dt><dd className="break-all">{value || "—"}</dd></div>)}</dl></details></td>
            <td className="min-w-44"><div>{row.lastScannedAt ? date(row.lastScannedAt) : "Never scanned"}</div><div className="text-xs text-base-content/60">{row.lastScanWaveName}</div>{row.lastScannedAt && !row.verifiedAt ? <div className="text-xs text-warning">Report changed; scan again</div> : null}</td>
            <td className="min-w-40 text-xs"><div>{row.revision > 1 ? "Changed" : "First seen"}: {date(row.sourceChangedAt)}</div><div>Revision {row.revision}</div>{row.archivedAt ? <span className="badge badge-neutral badge-sm mt-1">Archived</span> : null}</td>
            <td><button type="button" className="btn btn-xs btn-outline" disabled={disabled} onClick={() => void changeArchive([row.id], !row.archivedAt)}>{row.archivedAt ? "Restore" : "Archive"}</button></td>
          </tr>)}</tbody></table> : <table className="table table-sm"><thead className="sticky top-0 bg-base-100 z-[1]"><tr><th>Scanned value</th><th>Candidate LPN</th><th>Pick Wave</th><th>Scanned by</th><th>Time</th><th>Result</th></tr></thead><tbody>{board.scans.map((scan) => <tr key={scan.id}><td className="font-mono break-all">{scan.scannedValue}</td><td className="font-mono">{scan.lpn ?? "No item LPN"}</td><td>{scan.pickWaveName}</td><td>{scan.scannedByName ?? "Unknown"}</td><td>{date(scan.scannedAt)}</td><td>{scan.lpn ? "LPN not in imported reports" : "Picked item has no LPN"}{scan.duplicateInWave ? " · Duplicate scan" : ""}</td></tr>)}</tbody></table>}
          {!board.total ? <p className="text-center py-10 text-base-content/60">{view === "unmatched" ? "No unmatched scans." : "No inventory rows match these filters. Upload an LPN report to start."}</p> : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>{board.total ? `${((board.page - 1) * PAGE_SIZE + 1).toLocaleString()}–${Math.min(board.page * PAGE_SIZE, board.total).toLocaleString()} of ${board.total.toLocaleString()}` : "0 rows"}</span><div className="flex items-center gap-3"><button className="btn btn-sm btn-outline" disabled={disabled || board.page <= 1} onClick={() => setPage(board.page - 1)}>Previous</button><span>Page {board.page} of {board.pageCount}</span><button className="btn btn-sm btn-outline" disabled={disabled || board.page >= board.pageCount} onClick={() => setPage(board.page + 1)}>Next</button></div></div>
      </> : null}
    </div></section>
  </div>;
}
function date(value: string) { return new Date(value).toLocaleString(); }
