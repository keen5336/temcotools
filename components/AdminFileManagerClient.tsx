"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Entry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "blocked";
  size: number;
  modifiedAt: string;
  fingerprint: string;
  blockedReason?: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function toUploadList(files: File[] | FileList | null | undefined) {
  return Array.from(files ?? []).filter((file) => file.size > 0);
}
async function fetchDirectory(path: string): Promise<{ currentPath: string; parentPath: string; entries: Entry[] }> {
  const res = await fetch(`/api/admin/files?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load files.");
  return data;
}

export default function AdminFileManagerClient() {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [parentPath, setParentPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [minSizeKb, setMinSizeKb] = useState("");
  const [modifiedWithinDays, setModifiedWithinDays] = useState("all");
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [moving, setMoving] = useState<Entry | null>(null);
  const [destination, setDestination] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const showDirectory = useCallback((data: { currentPath: string; parentPath: string; entries: Entry[] }) => {
    setCurrentPath(data.currentPath);
    setParentPath(data.parentPath);
    setEntries(data.entries);
    setLoadedAt(Date.now());
    setLoading(false);
  }, []);
  async function load(path: string) {
    setLoading(true); setError("");
    try { showDirectory(await fetchDirectory(path)); }
    catch (error) { setError(error instanceof Error ? error.message : "Failed to load files."); setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    void fetchDirectory("").then(data => { if (active) showDirectory(data); }).catch(error => { if (active) { setError(error instanceof Error ? error.message : "Failed to load files."); setLoading(false); } });
    return () => { active = false; };
  }, [showDirectory]);

  async function changeFiles(url: string, init: RequestInit, operationId: string, success: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok || !data.ok) { setError(`${data.error || "File action failed."} Operation: ${data.operationId || operationId}`); return false; }
      setStatus(`${success} Operation: ${operationId}`); await load(currentPath); return true;
    } catch {
      setError(`The result is uncertain. Refresh and inspect the folder before a new operation. No automatic retry occurred. Operation: ${operationId}`); return false;
    } finally { setBusy(false); }
  }
  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!folderName.trim()) return;
    const operationId = crypto.randomUUID();
    if (await changeFiles("/api/admin/files", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: currentPath, folderName, operationId }) }, operationId, "Folder created.")) {
      setFolderName("");
    }
  }

  async function uploadSelectedFiles(files: File[]) {
    if (!files.length) return;
    const collisions = files.map(file => entries.find(entry => entry.name === file.name)).filter((entry): entry is Entry => Boolean(entry));
    if (collisions.some(entry => entry.kind !== "file")) { setError("An upload cannot replace a folder or blocked entry."); return; }
    if (collisions.length && !window.confirm(`Replace these current files?\n\n${collisions.map(entry => entry.name).join("\n")}\n\nReplacement is checked against the versions shown. Cancel to keep them.`)) return;
    const operationId = crypto.randomUUID();
    const formData = new FormData();
    formData.set("path", currentPath);
    formData.set("operationId", operationId);
    formData.set("replace", String(collisions.length > 0));
    formData.set("expectedFingerprints", JSON.stringify(Object.fromEntries(collisions.map(entry => [entry.name, entry.fingerprint]))));
    files.forEach((file) => formData.append("files", file));

    if (await changeFiles("/api/admin/files", { method: "POST", body: formData }, operationId, `${files.length} file${files.length === 1 ? "" : "s"} uploaded.`)) if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function uploadFiles(e: React.FormEvent) {
    e.preventDefault();
    await uploadSelectedFiles(toUploadList(fileInputRef.current?.files));
  }

  async function handleDropUpload(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    await uploadSelectedFiles(toUploadList(e.dataTransfer.files));
  }

  async function removeEntry(entry: Entry) {
    const confirmed = window.confirm(
      `Delete this ${entry.kind === "directory" ? "folder and its contents" : "file"}?\n\n${entry.path}`
    );
    if (!confirmed) return;

    const operationId = crypto.randomUUID();
    await changeFiles(`/api/admin/files?${new URLSearchParams({ path: entry.path, expectedFingerprint: entry.fingerprint, operationId })}`, { method: "DELETE" }, operationId, `${entry.kind === "directory" ? "Folder" : "File"} deleted.`);
  }
  async function moveEntry(event: React.FormEvent) {
    event.preventDefault(); if (!moving || !destination.trim()) return;
    const operationId = crypto.randomUUID();
    if (await changeFiles("/api/admin/files", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId, path: moving.path, destinationPath: destination.trim(), expectedFingerprint: moving.fingerprint }) }, operationId, "Entry moved.")) { setMoving(null); setDestination(""); }
  }

  const breadcrumbs = currentPath ? currentPath.split("/") : [];
  const minSizeBytes = minSizeKb.trim() ? Number(minSizeKb) * 1024 : 0;
  const modifiedCutoff =
    modifiedWithinDays === "all"
      ? null
      : loadedAt - Number(modifiedWithinDays) * 24 * 60 * 60 * 1000;
  const filteredEntries = entries.filter((entry) => {
    if (entry.kind === "directory") return true;
    if (minSizeBytes > 0 && entry.size < minSizeBytes) return false;
    if (modifiedCutoff && new Date(entry.modifiedAt).getTime() < modifiedCutoff) return false;
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="card-title text-base">Swap Space</h2>
              <p className="text-sm text-base-content/60 mt-1">
                Upload, create folders, move or rename, download, and delete managed files.
              </p>
            </div>
            <div className="text-sm text-base-content/70">
              Managed storage root
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button className="btn btn-sm" onClick={() => load("")}>
              Root
            </button>
            {breadcrumbs.map((segment, index) => {
              const path = breadcrumbs.slice(0, index + 1).join("/");
              return (
                <button key={path} className="btn btn-sm btn-ghost" onClick={() => load(path)}>
                  {segment}
                </button>
              );
            })}
            {currentPath && (
              <button className="btn btn-sm btn-outline" onClick={() => load(parentPath)}>
                Up One Level
              </button>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <form onSubmit={uploadFiles} className="rounded-xl border border-base-300 p-4 space-y-3">
              <div className="font-semibold">Upload files</div>
              <div
                className={`rounded-xl border-2 border-dashed p-5 text-center transition ${
                  dragActive
                    ? "border-primary bg-primary/10"
                    : "border-base-300 bg-base-200/40"
                }`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={handleDropUpload}
              >
                <div className="font-medium">Drag files here</div>
                <div className="text-sm text-base-content/60 mt-1">
                  or choose files below to upload into {currentPath || "/"}
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="file-input file-input-bordered w-full"
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                Upload to {currentPath || "/"}
              </button>
            </form>

            <form onSubmit={createFolder} className="rounded-xl border border-base-300 p-4 space-y-3">
              <div className="font-semibold">Create folder</div>
              <input
                type="text"
                className="input input-bordered w-full"
                placeholder="Folder name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
              />
              <button type="submit" className="btn btn-sm" disabled={busy}>
                Create in {currentPath || "/"}
              </button>
            </form>
          </div>

          {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
          {status && <div role="status" className="alert alert-success text-sm">{status}</div>}
          {moving && <form onSubmit={moveEntry} className="rounded-lg border border-base-300 p-4 space-y-3"><p className="font-semibold break-all">Move or rename: {moving.path}</p><label className="form-control"><span className="label-text">Destination path from managed root, including the new name</span><input className="input input-bordered w-full" value={destination} onChange={event => setDestination(event.target.value)} placeholder="folder/new-name.csv" required /></label><p className="text-sm text-base-content/60">Choose an existing parent folder and an unused destination name. Existing files are kept.</p><div className="flex gap-2"><button className="btn btn-primary btn-sm" disabled={busy}>Move entry</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMoving(null)}>Cancel</button></div></form>}
        </div>
      </div>

      <div className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <h2 className="card-title text-base">Contents</h2>
            <div className="flex flex-wrap gap-3 items-end">
              <label className="form-control">
                <div className="label py-1">
                  <span className="label-text text-xs uppercase tracking-wide text-base-content/60">
                    Min File Size
                  </span>
                </div>
                <input
                  type="number"
                  min="0"
                  step="1"
                  className="input input-bordered input-sm w-32"
                  placeholder="KB"
                  value={minSizeKb}
                  onChange={(e) => setMinSizeKb(e.target.value)}
                />
              </label>
              <label className="form-control">
                <div className="label py-1">
                  <span className="label-text text-xs uppercase tracking-wide text-base-content/60">
                    Modified Within
                  </span>
                </div>
                <select
                  className="select select-bordered select-sm w-40"
                  value={modifiedWithinDays}
                  onChange={(e) => setModifiedWithinDays(e.target.value)}
                >
                  <option value="all">All Time</option>
                  <option value="1">24 Hours</option>
                  <option value="7">7 Days</option>
                  <option value="30">30 Days</option>
                </select>
              </label>
              <button
                className="btn btn-sm btn-outline"
                onClick={() => load(currentPath)}
                disabled={busy}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th className="w-44">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="text-center text-base-content/60 py-8">
                      Loading…
                    </td>
                  </tr>
                ) : filteredEntries.length ? (
                  filteredEntries.map((entry) => (
                    <tr key={entry.path}>
                      <td className="font-medium">{entry.name}</td>
                      <td title={entry.blockedReason}>{entry.kind}</td>
                      <td>{entry.kind === "file" ? formatBytes(entry.size) : "—"}</td>
                      <td>{new Date(entry.modifiedAt).toLocaleString()}</td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          {entry.kind === "directory" ? (
                            <button className="btn btn-xs" onClick={() => load(entry.path)}>
                              Open
                            </button>
                          ) : entry.kind === "file" ? (
                            <a
                              className="btn btn-xs"
                              href={`/api/admin/files/download?path=${encodeURIComponent(entry.path)}`}
                            >
                              Download
                            </a>
                          ) : <span className="text-xs text-warning">{entry.blockedReason}</span>}
                          {entry.kind !== "blocked" && <button className="btn btn-xs" disabled={busy} onClick={() => { setMoving(entry); setDestination(entry.path); }}>Move / Rename</button>}
                          <button
                            className="btn btn-xs btn-error btn-outline"
                            disabled={busy || entry.kind === "blocked"}
                            onClick={() => removeEntry(entry)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="text-center text-base-content/60 py-8">
                      No entries match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
