"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import ScannerCapture from "@/components/scanner/ScannerCapture";

export interface ScanListSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  itemCount: number;
}

interface LocalScan {
  id: string;
  value: string;
  scannedAt: string;
}

interface LocalDraft {
  id: string;
  name: string;
  createdAt: string;
  closedAt: string | null;
  scans: LocalScan[];
}

const STORAGE_KEY = "temcotools_scan_list_draft_v1";

export default function ScanListsClient({ initialLists }: { initialLists: ScanListSummary[] }) {
  const [lists, setLists] = useState(initialLists);
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDraft(loadDraft());
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (draft) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    else window.localStorage.removeItem(STORAGE_KEY);
  }, [draft, ready]);

  const visibleLists = useMemo(
    () => lists.filter((list) => Boolean(list.archivedAt) === showArchived),
    [lists, showArchived]
  );
  const lastScan = draft?.scans[0] ?? null;

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || draft) return;
    setDraft({
      id: crypto.randomUUID(),
      name: normalizedName,
      createdAt: new Date().toISOString(),
      closedAt: null,
      scans: [],
    });
    setName("");
    setError(null);
  }

  function handleScan(value: string) {
    if (!value) return;
    setDraft((current) => current && !current.closedAt ? {
      ...current,
      scans: [{ id: crypto.randomUUID(), value, scannedAt: new Date().toISOString() }, ...current.scans],
    } : current);
    setError(null);
  }

  function handleCloseDraft() {
    if (!draft) return;
    setDraft({ ...draft, closedAt: new Date().toISOString() });
  }

  function handleReopenDraft() {
    if (!draft) return;
    setDraft({ ...draft, closedAt: null });
    setError(null);
  }

  function handleDiscardDraft() {
    if (!draft || !window.confirm(`Discard the local draft “${draft.name}” and all ${draft.scans.length} scans?`)) return;
    setDraft(null);
    setError(null);
  }

  function handleSaveDraft() {
    if (!draft || !draft.scans.length) return;
    startTransition(async () => {
      setError(null);
      const response = await fetch("/api/scan-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localDraftId: draft.id,
          name: draft.name,
          createdAt: draft.createdAt,
          scans: [...draft.scans].reverse().map((scan) => ({ value: scan.value, scannedAt: scan.scannedAt })),
        }),
      });
      const payload = (await response.json()) as
        | { ok: true; scanList: { id: string; name: string; createdAt: string } }
        | { ok: false; error: string };

      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to save scan list.");
        return;
      }

      const now = new Date().toISOString();
      setLists((current) => [{
        id: payload.scanList.id,
        name: payload.scanList.name,
        createdAt: payload.scanList.createdAt,
        updatedAt: now,
        closedAt: now,
        archivedAt: null,
        createdBy: null,
        itemCount: draft.scans.length,
      }, ...current.filter((list) => list.id !== payload.scanList.id)]);
      setDraft(null);
    });
  }

  function handleArchive(list: ScanListSummary, archived: boolean) {
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/scan-lists/${encodeURIComponent(list.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      const payload = (await response.json()) as
        | { ok: true; scanList: { archivedAt: string | null } }
        | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to update scan list.");
        return;
      }
      setLists((current) => current.map((entry) =>
        entry.id === list.id ? { ...entry, archivedAt: payload.scanList.archivedAt } : entry
      ));
    });
  }

  function handleDelete(list: ScanListSummary) {
    if (!window.confirm(`Delete “${list.name}” and all ${list.itemCount} scans? This cannot be undone.`)) return;
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/scan-lists/${encodeURIComponent(list.id)}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok: true } | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to delete scan list.");
        return;
      }
      setLists((current) => current.filter((entry) => entry.id !== list.id));
    });
  }

  return (
    <div className="space-y-6">
      {draft ? (
        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body gap-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="card-title">{draft.name}</h2>
                  <span className={`badge ${draft.closedAt ? "badge-ghost" : "badge-success"}`}>
                    {draft.closedAt ? "Closed locally" : "Scanning"}
                  </span>
                </div>
                <p className="text-sm text-base-content/70 mt-1">
                  {draft.scans.length} scans · Stored only on this device until you save it to the database.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {draft.closedAt ? (
                  <button className="btn btn-outline" onClick={handleReopenDraft} disabled={isPending}>Reopen Session</button>
                ) : (
                  <button className="btn btn-outline" onClick={handleCloseDraft} disabled={isPending}>Close Session</button>
                )}
                <button className="btn btn-primary" onClick={handleSaveDraft} disabled={!draft.scans.length || isPending}>
                  {isPending ? "Saving…" : "Save to Database"}
                </button>
                <button className="btn btn-error btn-outline" onClick={handleDiscardDraft} disabled={isPending}>Discard</button>
              </div>
            </div>

            {!draft.closedAt ? (
              <ScannerCapture
                title={draft.name}
                description="Scan continuously without focusing a text field. The keyboard stays hidden."
                onScan={handleScan}
                autoActivate
                count={draft.scans.length}
                countLabel="scans"
                feedback={lastScan ? { tone: "success", title: "Captured", value: lastScan.value, detail: `Saved locally ${formatDate(lastScan.scannedAt)}` } : null}
                result={lastScan ? <div><p className="text-xs uppercase tracking-[0.2em] text-slate-400 mb-2">Last Scan</p><p className="text-5xl sm:text-7xl font-black break-all">{lastScan.value}</p><div className="mt-5 max-h-48 overflow-auto"><table className="table table-sm text-slate-100"><tbody>{draft.scans.slice(0, 8).map((scan, index) => <tr key={scan.id}><td>{draft.scans.length - index}</td><td className="font-semibold break-all">{scan.value}</td></tr>)}</tbody></table></div></div> : undefined}
              />
            ) : null}

            {lastScan ? (
              <div className="rounded-2xl border-2 border-success/50 bg-success/10 p-6">
                <p className="text-xs uppercase tracking-[0.2em] text-base-content/60 mb-2">Last Scan</p>
                <p className="text-4xl sm:text-5xl font-bold tracking-wide break-all">{lastScan.value}</p>
                <p className="text-sm text-base-content/70 mt-2">Captured {formatDate(lastScan.scannedAt)}</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-base-300 p-6 text-base-content/60">
                Your most recent scan will appear here in large type.
              </div>
            )}

            <div className="max-h-[420px] overflow-auto border border-base-200 rounded-xl">
              <table className="table table-zebra">
                <thead className="sticky top-0 bg-base-100"><tr><th>#</th><th>Scanned Value</th><th>Time</th></tr></thead>
                <tbody>
                  {draft.scans.length ? draft.scans.map((scan, index) => (
                    <tr key={scan.id} className={index === 0 ? "bg-success/10" : ""}>
                      <td>{draft.scans.length - index}</td>
                      <td className={`font-semibold break-all ${index === 0 ? "text-xl" : ""}`}>{scan.value}</td>
                      <td>{formatDate(scan.scannedAt)}</td>
                    </tr>
                  )) : <tr><td colSpan={3} className="text-center py-8 text-base-content/60">No scans yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : (
        <section className="card bg-base-100 border border-base-200 shadow-sm">
          <div className="card-body">
            <h2 className="card-title">Start a Scan Session</h2>
            <p className="text-sm text-base-content/70">Name the session. Its draft will remain on this device if you leave and come back.</p>
            <form className="flex flex-col sm:flex-row gap-3 mt-2" onSubmit={handleCreate}>
              <input className="input input-bordered input-lg flex-1" value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Receiving - July 11" maxLength={120} autoFocus disabled={!ready} />
              <button className="btn btn-primary btn-lg" disabled={!name.trim() || !ready}>Start Scanning</button>
            </form>
          </div>
        </section>
      )}

      {error ? <div className="alert alert-error"><span>{error}</span></div> : null}

      <section className="card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-base-200 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-semibold">Saved Scan Lists</h2><p className="text-sm text-base-content/70 mt-1">Lists saved to the database can be viewed, exported, archived, or deleted.</p></div>
          <div className="join">
            <button className={`btn btn-sm join-item ${!showArchived ? "btn-active" : ""}`} onClick={() => setShowArchived(false)}>Current</button>
            <button className={`btn btn-sm join-item ${showArchived ? "btn-active" : ""}`} onClick={() => setShowArchived(true)}>Archived</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead><tr><th>Name</th><th>Scans</th><th>Created</th><th>Saved By</th><th className="text-right">Actions</th></tr></thead>
            <tbody>
              {visibleLists.length ? visibleLists.map((list) => (
                <tr key={list.id}>
                  <td className="font-semibold max-w-xs whitespace-normal">{list.name}</td><td>{list.itemCount}</td><td>{formatDate(list.createdAt)}</td><td>{list.createdBy ?? "—"}</td>
                  <td><div className="flex flex-wrap justify-end gap-2 min-w-max">
                    <Link href={`/tools/scan-lists/${encodeURIComponent(list.id)}`} className="btn btn-xs btn-primary">View</Link>
                    <a href={`/api/scan-lists/${encodeURIComponent(list.id)}/export`} className="btn btn-xs btn-outline">CSV</a>
                    <button className="btn btn-xs btn-outline" onClick={() => handleArchive(list, !showArchived)} disabled={isPending}>{showArchived ? "Restore" : "Archive"}</button>
                    <button className="btn btn-xs btn-error btn-outline" onClick={() => handleDelete(list)} disabled={isPending}>Delete</button>
                  </div></td>
                </tr>
              )) : <tr><td colSpan={5} className="text-center text-base-content/60 py-10">{showArchived ? "No archived scan lists." : "No saved scan lists yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function loadDraft(): LocalDraft | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as LocalDraft;
    if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.createdAt !== "string" || !Array.isArray(value.scans)) return null;
    return value;
  } catch {
    return null;
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
