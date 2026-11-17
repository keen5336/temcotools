"use client";

import { useState } from "react";

export default function PickWaveLocationsEditor({ locations, onChange }: { locations: string[]; onChange: (locations: string[]) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function update(method: "POST" | "DELETE" | "GET", location?: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/pick-waves/locations", {
        method,
        ...(method === "GET" ? { cache: "no-store" as const } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: location }) }),
      });
      const payload = await response.json() as { ok: true; locations: string[] } | { ok: false; error: string };
      if (!response.ok || !payload.ok) throw new Error("error" in payload ? payload.error : "Unable to update locations.");
      onChange(payload.locations);
      if (method === "POST") setName("");
      setMessage(method === "GET" ? "Location list refreshed." : method === "POST" ? "Location added." : "Location removed. Existing wave assignments are preserved.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to update locations. Refresh the list before trying again.");
    } finally { setBusy(false); }
  }

  return (
    <section id="staging-locations" className="card bg-base-100 border border-base-200 shadow-sm scroll-mt-6">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="card-title">Staging Locations</h2><p className="text-sm text-base-content/65 mt-1">Add or remove locations for all pick waves. Removing a location keeps assignments already saved on existing waves.</p></div>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void update("GET")}>Refresh locations</button>
        </div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void update("POST", name); }}>
          <label className="form-control"><span className="label font-semibold">New location</span><input className="input input-bordered uppercase" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} placeholder="Example: 8-E" disabled={busy} /></label>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>Add location</button>
        </form>
        {error ? <div role="alert" className="alert alert-error"><span>{error}</span></div> : null}
        {message ? <p role="status" className="text-sm text-success">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          {locations.map((location) => <div key={location} className="flex items-center gap-2 rounded-lg border border-base-300 py-1 pl-3 pr-1"><span className="font-semibold">{location}</span><button type="button" className="btn btn-xs btn-ghost text-error" aria-label={`Remove location ${location}`} disabled={busy} onClick={() => void update("DELETE", location)}>Remove</button></div>)}
          {!locations.length ? <p className="text-sm text-base-content/60">No staging locations. Add a location above to make it available in route maps.</p> : null}
        </div>
      </div>
    </section>
  );
}
