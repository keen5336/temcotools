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
  const assignedRoutes = useMemo(() => new Set(Object.values(assignments).filter(Boolean)), [assignments]);
  const unmappedRoutes = preview?.routeNumbers.filter((route) => !assignedRoutes.has(route)) ?? [];

  async function handleFile(fileValue: File | null) {
    setFile(fileValue); setPreview(null); setAssignments({}); setError(null);
    if (!fileValue) return;
    setPreviewing(true);
    try {
      const form = new FormData(); form.set("file", fileValue);
      const response = await fetch("/api/pick-waves/preview", { method: "POST", body: form });
      const payload = await response.json() as { ok: true; preview: SpreadsheetPreview } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Failed to read spreadsheet.");
      if (payload.preview.routeNumbers.length > PICK_WAVE_STAGING_LOCATIONS.length) throw new Error(`This spreadsheet has ${payload.preview.routeNumbers.length} routes but only ${PICK_WAVE_STAGING_LOCATIONS.length} staging locations are available.`);
      setPreview(payload.preview);
    } catch (error) { setError(error instanceof Error ? error.message : "Failed to read spreadsheet."); }
    finally { setPreviewing(false); }
  }

  function assignRoute(location: string, routeNumber: string) {
    setAssignments((current) => ({ ...current, [location]: routeNumber }));
  }

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !name.trim()) return;
    startTransition(async () => {
      setError(null);
      const form = new FormData();
      form.set("name", name.trim());
      form.set("file", file);
      form.set("routeMappings", JSON.stringify(Object.entries(assignments).filter(([, routeNumber]) => routeNumber).map(([stagingLocation, routeNumber]) => ({ routeNumber, stagingLocation }))));
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
            <p className="text-sm text-base-content/65 mt-1">Upload an XLSX workbook first. Its route values will populate the staging-location grid.</p>
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
            <div className="flex flex-wrap gap-2 items-center"><span className="badge badge-success">{preview.itemCount} items found</span><span className="badge badge-primary">{preview.routeNumbers.length} routes found</span>{unmappedRoutes.length ? <span className="badge badge-warning">{unmappedRoutes.length} routes left to assign</span> : <span className="badge badge-success">All routes assigned</span>}</div>
            <div><h3 className="font-semibold">Staging-location grid</h3><p className="text-sm text-base-content/60 mt-1">Choose one spreadsheet route for each staging slot you need. Each route can be selected once.</p></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
              {Array.from({ length: 6 }, (_, numberIndex) => numberIndex + 9).map((number) => <div key={number} className="rounded-xl border border-base-200 bg-base-200/40 p-3"><div className="text-lg font-bold mb-2">Location {number}</div><div className="space-y-2">{["A", "B", "C", "D"].map((letter) => {
                const location = `${number}-${letter}`; const currentRoute = assignments[location] ?? "";
                return <label key={location} className="grid grid-cols-[2.5rem_1fr] gap-2 items-center"><span className="font-semibold">{letter}</span><select className="select select-bordered select-sm w-full" value={currentRoute} onChange={(event) => assignRoute(location, event.target.value)}><option value="">Unused</option>{preview.routeNumbers.map((route) => <option key={route} value={route} disabled={assignedRoutes.has(route) && route !== currentRoute}>{route}</option>)}</select></label>;
              })}</div></div>)}
            </div>
            {unmappedRoutes.length ? <div className="alert alert-warning"><span>Assign these routes before saving: {unmappedRoutes.join(", ")}</span></div> : null}
          </div> : null}
          {error ? <div className="alert alert-error"><span>{error}</span></div> : null}
          <div className="card-actions justify-end">
            <button className="btn btn-primary" disabled={!name.trim() || !file || !preview || unmappedRoutes.length > 0 || previewing || isPending}>{isPending ? "Creating…" : "Create Pick Wave"}</button>
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
