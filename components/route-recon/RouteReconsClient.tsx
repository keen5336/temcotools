"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

export interface RouteReconSummary {
  id: string;
  name: string;
  sourceFilename: string;
  routeCount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: string | null;
}

interface SpreadsheetPreview {
  itemCount: number;
  routes: Array<{ routeNumber: string | null; itemCount: number }>;
  missingColumns: string[];
}

const COLUMN_LABELS: Record<string, string> = {
  routeNumber: "Route",
  contact: "Contact",
  orderNumber: "Order",
  lpn: "LPN",
  serialNumber: "Serial",
  trackingNumber: "Tracking",
  partNumber: "Part",
  description: "Description",
};

export default function RouteReconsClient({ initialReports }: { initialReports: RouteReconSummary[] }) {
  const router = useRouter();
  const [reports, setReports] = useState(initialReports);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visibleReports = useMemo(
    () => reports.filter((report) => Boolean(report.archivedAt) === showArchived),
    [reports, showArchived],
  );

  async function handleFile(fileValue: File | null) {
    setFile(fileValue);
    setPreview(null);
    setError(null);
    if (!fileValue) return;

    setPreviewing(true);
    try {
      const form = new FormData();
      form.set("file", fileValue);
      const response = await fetch("/api/route-recons/preview", { method: "POST", body: form });
      const payload = await response.json() as
        | { ok: true; preview: SpreadsheetPreview }
        | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        throw new Error("error" in payload ? payload.error : "Failed to read spreadsheet.");
      }
      setPreview(payload.preview);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to read spreadsheet.");
    } finally {
      setPreviewing(false);
    }
  }

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !name.trim() || !preview) return;

    startTransition(async () => {
      setError(null);
      const form = new FormData();
      form.set("name", name.trim());
      form.set("file", file);
      const response = await fetch("/api/route-recons", { method: "POST", body: form });
      const payload = await response.json() as
        | { ok: true; routeRecon: { id: string } }
        | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to create Route Recon.");
        return;
      }
      router.push(`/tools/route-recon/${encodeURIComponent(payload.routeRecon.id)}`);
      router.refresh();
    });
  }

  function handleArchive(report: RouteReconSummary, archived: boolean) {
    startTransition(async () => {
      setError(null);
      const response = await fetch(`/api/route-recons/${encodeURIComponent(report.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      const payload = await response.json() as
        | { ok: true; routeRecon: { archivedAt: string | null } }
        | { ok: false; error: string };
      if (!response.ok || !payload.ok) {
        setError("error" in payload ? payload.error : "Failed to update Route Recon.");
        return;
      }
      setReports((current) => current.map((entry) => (
        entry.id === report.id ? { ...entry, archivedAt: payload.routeRecon.archivedAt } : entry
      )));
    });
  }

  return (
    <div className="space-y-6">
      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <form className="card-body gap-5" onSubmit={handleCreate}>
          <div>
            <h2 className="card-title">Create Route Recon</h2>
            <p className="text-sm text-base-content/65 mt-1">
              Upload the same XLSX format used for Pick Waves. Routes are discovered automatically; no staging locations are needed.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <label className="form-control">
              <span className="label font-semibold">Route Recon name</span>
              <input
                className="input input-bordered"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Example: AM Route Recon"
              />
            </label>
            <label className="form-control">
              <span className="label font-semibold">Pick spreadsheet (.xlsx)</span>
              <input
                className="file-input file-input-bordered w-full"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {previewing ? (
            <div className="flex items-center gap-3 text-base-content/70">
              <span className="loading loading-spinner loading-sm" />
              Reading spreadsheet and organizing routes…
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-success">{preview.itemCount} items found</span>
                <span className="badge badge-primary">{preview.routes.length} routes found</span>
              </div>
              {preview.missingColumns.length ? (
                <div className="alert alert-warning">
                  <span>
                    Missing spreadsheet columns: {preview.missingColumns.map((column) => COLUMN_LABELS[column] ?? column).join(", ")}.
                    Missing values will be shown as em dashes in the report.
                  </span>
                </div>
              ) : null}
              <div>
                <h3 className="font-semibold">Routes discovered</h3>
                <div className="flex flex-wrap gap-2 mt-2">
                  {preview.routes.map((route) => (
                    <span key={route.routeNumber ?? "__no_route__"} className="badge badge-lg badge-outline">
                      {route.routeNumber ?? "No Route"}: {route.itemCount}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {error ? <div className="alert alert-error"><span>{error}</span></div> : null}

          <div className="card-actions justify-end">
            <button
              className="btn btn-primary"
              disabled={!name.trim() || !file || !preview || previewing || isPending}
            >
              {isPending ? "Creating…" : "Create Route Recon"}
            </button>
          </div>
        </form>
      </section>

      <section className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="card-title">{showArchived ? "Archived Route Recons" : "Active Route Recons"}</h2>
              <p className="text-sm text-base-content/60 mt-1">{visibleReports.length} reports</p>
            </div>
            <label className="label cursor-pointer gap-3">
              <span className="label-text">Show archived</span>
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
            </label>
          </div>

          <div className="overflow-x-auto border border-base-200 rounded-xl mt-3">
            <table className="table table-zebra">
              <thead><tr><th>Name</th><th>Created</th><th>Items</th><th>Routes</th><th>Source</th><th /></tr></thead>
              <tbody>
                {visibleReports.length ? visibleReports.map((report) => (
                  <tr key={report.id}>
                    <td>
                      <Link className="link link-primary font-semibold" href={`/tools/route-recon/${encodeURIComponent(report.id)}`}>
                        {report.name}
                      </Link>
                      <div className="text-xs text-base-content/55 mt-1">{report.createdBy ?? "Unknown user"}</div>
                    </td>
                    <td>{formatDate(report.createdAt)}</td>
                    <td className="font-semibold">{report.itemCount}</td>
                    <td className="font-semibold">{report.routeCount}</td>
                    <td className="max-w-52 truncate" title={report.sourceFilename}>{report.sourceFilename}</td>
                    <td>
                      <div className="flex gap-2 justify-end">
                        <Link className="btn btn-sm btn-primary" href={`/tools/route-recon/${encodeURIComponent(report.id)}`}>Open</Link>
                        <button className="btn btn-sm btn-outline" disabled={isPending} onClick={() => handleArchive(report, !showArchived)}>
                          {showArchived ? "Restore" : "Archive"}
                        </button>
                      </div>
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-base-content/60">
                      No {showArchived ? "archived" : "active"} Route Recons.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
