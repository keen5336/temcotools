"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { PICK_WAVE_STAGING_LOCATIONS } from "@/lib/pick-wave-constants";

export interface PickWaveSummary {
  id: string;
  name: string;
  sourceFilename: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: string | null;
  itemCount: number;
  scannedCount: number;
  routeCount: number;
  scanCount: number;
}

interface SpreadsheetPreview { itemCount: number; routeNumbers: string[]; missingColumns: string[] }

export default function PickWavesClient({ initialWaves }: { initialWaves: PickWaveSummary[] }) {
  const router = useRouter();
  const [waves, setWaves] = useState(initialWaves);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const visibleWaves = useMemo(() => waves.filter((wave) => Boolean(wave.archivedAt) === showArchived), [waves, showArchived]);
  const assignedLocations = useMemo(() => new Set(Object.values(assignments).filter(Boolean)), [assignments]);
  const noLocationRoutes = preview?.routeNumbers.filter((route) => !assignments[route]) ?? [];

  async function handleFile(fileValue: File | null) {
    setFile(fileValue); setPreview(null); setAssignments({}); setError(null);
    if (!fileValue) return;
    setPreviewing(true);
    try {
      const form = new FormData(); form.set("file", fileValue);
      const response = await fetch("/api/pick-waves/preview", { method: "POST", body: form });
      const payload = await response.json() as { ok: true; preview: SpreadsheetPreview } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Failed to read spreadsheet.");
      setPreview(payload.preview);
    } catch (error) { setError(error instanceof Error ? error.message : "Failed to read spreadsheet."); }
    finally { setPreviewing(false); }
  }

  function assignLocation(routeNumber: string, stagingLocation: string) {
    setAssignments((current) => ({ ...current, [routeNumber]: stagingLocation }));
  }

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !name.trim()) return;
    startTransition(async () => {
      setError(null);
      const form = new FormData();
      form.set("name", name.trim());
      form.set("file", file);
      form.set("routeMappings", JSON.stringify(preview?.routeNumbers.map((routeNumber) => ({ routeNumber, stagingLocation: assignments[routeNumber] || null })) ?? []));
      const response = await fetch("/api/pick-waves", { method: "POST", body: form });
      const payload = await response.json() as { ok: true; pickWave: { id: string } } | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to create pick wave.");
        return;
      }
      router.push(`/tools/pick-waves/${encodeURIComponent(payload.pickWave.id)}`);
      router.refresh();
    });
  }

  function handleArchive(wave: PickWaveSummary, archived: boolean) {
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/pick-waves/${encodeURIComponent(wave.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
      });
      const payload = await response.json() as { ok: true; pickWave: { archivedAt: string | null } } | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to update pick wave.");
        return;
      }
      setWaves((current) => current.map((entry) => entry.id === wave.id ? { ...entry, archivedAt: payload.pickWave.archivedAt } : entry));
    });
  }

  return (
    <div className="space-y-6">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <form className="card-body gap-5" onSubmit={handleCreate}>
          <div>
            <h2 className="card-title">Create Pick Wave</h2>
            <p className="text-sm text-base-content/65 mt-1">Upload an XLSX workbook first. Its routes will populate the staging map, defaulting to No Location.</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <label className="form-control">
              <span className="label font-semibold">Pick-wave name</span>
              <input className="input input-bordered" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: AM Wave - West" />
            </label>
            <label className="form-control">
              <span className="label font-semibold">Pick spreadsheet (.xlsx)</span>
              <input className="file-input file-input-bordered w-full" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void handleFile(event.target.files?.[0] ?? null)} />
            </label>
          </div>

          {previewing ? <div className="flex items-center gap-3 text-base-content/70"><span className="loading loading-spinner loading-sm" /> Reading spreadsheet and discovering routes…</div> : null}
          {preview ? <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center"><span className="badge badge-success">{preview.itemCount} items found</span><span className="badge badge-primary">{preview.routeNumbers.length} routes found</span>{noLocationRoutes.length ? <span className="badge badge-ghost">{noLocationRoutes.length} with no location</span> : <span className="badge badge-success">All routes have locations</span>}</div>
            <div><h3 className="font-semibold">Route staging map</h3><p className="text-sm text-base-content/60 mt-1">Choose a staging location for each route. Routes default to No Location, and each actual location can be used once.</p></div>
            <div className="overflow-x-auto border border-base-200 rounded-xl">
              <table className="table table-sm"><thead><tr><th>Route Number</th><th>Staging Location</th></tr></thead><tbody>{preview.routeNumbers.map((routeNumber) => {
                const currentLocation = assignments[routeNumber] ?? "";
                return <tr key={routeNumber}><td className="font-semibold">{routeNumber}</td><td><select className="select select-bordered select-sm w-full" value={currentLocation} onChange={(event) => assignLocation(routeNumber, event.target.value)}><option value="">No Location</option>{PICK_WAVE_STAGING_LOCATIONS.map((location) => <option key={location} value={location} disabled={assignedLocations.has(location) && location !== currentLocation}>{location}</option>)}</select></td></tr>;
              })}</tbody></table>
            </div>
          </div> : null}
          {error ? <div className="alert alert-error"><span>{error}</span></div> : null}
          <div className="card-actions justify-end">
            <button className="btn btn-primary" disabled={!name.trim() || !file || !preview || previewing || isPending}>{isPending ? "Creating…" : "Create Pick Wave"}</button>
          </div>
        </form>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="card-title">{showArchived ? "Archived Pick Waves" : "Active Pick Waves"}</h2><p className="text-sm text-base-content/60 mt-1">{visibleWaves.length} waves</p></div>
            <label className="label cursor-pointer gap-3"><span className="label-text">Show archived</span><input type="checkbox" className="toggle toggle-primary" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></label>
          </div>
          <div className="overflow-x-auto border border-base-200 rounded-xl mt-3">
            <table className="table table-zebra">
              <thead><tr><th>Name</th><th>Created</th><th>Progress</th><th>Routes</th><th>Source</th><th></th></tr></thead>
              <tbody>{visibleWaves.length ? visibleWaves.map((wave) => (
                <tr key={wave.id}>
                  <td><Link className="link link-primary font-semibold" href={`/tools/pick-waves/${encodeURIComponent(wave.id)}`}>{wave.name}</Link><div className="text-xs text-base-content/55 mt-1">{wave.createdBy ?? "Unknown user"}</div></td>
                  <td>{formatDate(wave.createdAt)}</td>
                  <td><div className="font-semibold">{wave.scannedCount} / {wave.itemCount}</div><progress className="progress progress-success w-32" value={wave.scannedCount} max={Math.max(wave.itemCount, 1)} /></td>
                  <td>{wave.routeCount}</td><td className="max-w-52 truncate" title={wave.sourceFilename}>{wave.sourceFilename}</td>
                  <td><div className="flex gap-2 justify-end"><Link className="btn btn-sm btn-primary" href={`/tools/pick-waves/${encodeURIComponent(wave.id)}`}>Open</Link><button className="btn btn-sm btn-outline" disabled={isPending} onClick={() => handleArchive(wave, !showArchived)}>{showArchived ? "Restore" : "Archive"}</button></div></td>
                </tr>
              )) : <tr><td colSpan={6} className="text-center py-10 text-base-content/60">No {showArchived ? "archived" : "active"} pick waves.</td></tr>}</tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
