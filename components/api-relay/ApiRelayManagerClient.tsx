"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RelayDefinition } from "@/lib/api-relay/model";
import { DEFAULT_RELAY_PROGRAM } from "@/lib/api-relay/default-program";

type History = { relayId: string; revision: number; snapshot: RelayDefinition; createdAt: string; operationId: string };
type Data = { definitions: RelayDefinition[]; history: History[] };
const blank = (): RelayDefinition => ({ id: "", name: "", enabled: false, origins: [], pathPrefix: "/", identityPath: "/identity/me", subjectPath: "subject", operations: { session: { label: "Check signed-in account", path: "/identity/me" } }, program: DEFAULT_RELAY_PROGRAM, revision: 0 });

export default function ApiRelayManagerClient() {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<RelayDefinition>(blank);
  const [origins, setOrigins] = useState(""); const [operations, setOperations] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/api-relays", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load API relays.");
    return result as Data;
  }, []);
  function edit(definition: RelayDefinition, id = definition.id) {
    setDraft(definition); setOrigins(definition.origins.join("\n")); setOperations(JSON.stringify(definition.operations, null, 2)); setSelected(id); setUncertain(false);
  }
  useEffect(() => { let active = true; void load().then(value => { if (active) { setData(value); if (value.definitions[0]) edit(value.definitions[0]); } }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [load]);
  async function reload() {
    setBusy(true);
    try { const next = await load(); setData(next); edit(next.definitions.find(row => row.id === selected) || blank()); setMessage("Current definitions loaded. Review before saving."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Reload failed."); }
    finally { setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    let parsed: unknown;
    try { parsed = JSON.parse(operations); } catch { setMessage("Named operations must be valid JSON."); return; }
    setBusy(true);
    let response: Response | undefined;
    try {
      response = await fetch("/api/admin/api-relays", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, revision: undefined, expectedRevision: draft.revision, operationId: crypto.randomUUID(), origins: origins.split(/[\n,]/).map(value => value.trim()).filter(Boolean), operations: parsed }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save API relay.");
      edit(result.definition); setData(await load()); setMessage(`Saved ${result.definition.name} revision ${result.definition.revision}. Existing connections must reconnect before using this revision.`);
    } catch (error) {
      if (!response || response.ok) { setUncertain(true); setMessage("Save could not be confirmed. Reload the current definition before making another edit."); }
      else setMessage(error instanceof Error ? error.message : "Save failed.");
    } finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-3"><Link className="btn btn-sm btn-outline" href="/configuration">Connections & configuration</Link><button className="btn btn-sm" disabled={busy} onClick={() => void reload()}>Reload current definitions</button><button className="btn btn-sm btn-primary" disabled={busy || !data} onClick={() => { edit(blank(), ""); setMessage(""); }}>New relay</button></div>
    {message && <p role="status" className="alert alert-info">{message}</p>}
    {!data ? <p>Loading relay definitions…</p> : <div className="grid lg:grid-cols-[240px_minmax(0,1fr)] gap-6">
      <aside className="space-y-2">{data.definitions.map(definition => <button key={definition.id} disabled={busy} className={`btn h-auto py-3 w-full justify-start text-left ${selected === definition.id ? "btn-primary" : "btn-outline"}`} onClick={() => { edit(definition); setMessage(""); }}><span>{definition.name}<span className="block text-xs font-normal mt-1">{definition.enabled ? "Enabled" : "Disabled"} · revision {definition.revision}</span></span></button>)}</aside>
      <form onSubmit={save} className="card bg-base-100 border border-base-200 shadow-sm min-w-0"><div className="card-body gap-4">
        <h2 className="card-title">{selected ? `Edit ${draft.name}` : "New API relay"}</h2>
        <div className="grid sm:grid-cols-2 gap-4"><label className="form-control"><span className="label font-semibold">Stable relay ID</span><input className="input input-bordered w-full" value={draft.id} disabled={!!selected || busy} maxLength={64} required pattern="[a-z][a-z0-9-]*" onChange={event => setDraft({ ...draft, id: event.target.value })} placeholder="warehouse-system" /></label><label className="form-control"><span className="label font-semibold">System name</span><input className="input input-bordered w-full" value={draft.name} required maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label></div>
        <label className="flex items-center gap-3"><input type="checkbox" className="toggle toggle-success" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span>Enable this relay when saved</span></label>
        <label className="form-control"><span className="label font-semibold">Allowed site origins — one per line</span><textarea className="textarea textarea-bordered w-full font-mono" rows={3} value={origins} onChange={event => setOrigins(event.target.value)} placeholder="https://system.example.com" required /><span className="text-xs text-base-content/60 mt-1">Exact HTTPS origins. Each origin/path must map to one relay.</span></label>
        <label className="form-control"><span className="label font-semibold">Page path prefix</span><input className="input input-bordered w-full font-mono" value={draft.pathPrefix} onChange={event => setDraft({ ...draft, pathPrefix: event.target.value })} required /><span className="text-xs text-base-content/60 mt-1">/ allows the whole site. /warehouse matches that page and its children.</span></label>
        <div className="grid sm:grid-cols-2 gap-4"><label className="form-control"><span className="label font-semibold">Signed-in account endpoint</span><input className="input input-bordered w-full font-mono" value={draft.identityPath} onChange={event => setDraft({ ...draft, identityPath: event.target.value })} required /></label><label className="form-control"><span className="label font-semibold">Account ID field</span><input className="input input-bordered w-full font-mono" value={draft.subjectPath} onChange={event => setDraft({ ...draft, subjectPath: event.target.value })} required placeholder="user.id" /></label></div>
        <label className="form-control"><span className="label font-semibold">Named API operations (JSON)</span><textarea className="textarea textarea-bordered w-full font-mono text-xs" rows={12} value={operations} onChange={event => setOperations(event.target.value)} required /><span className="text-xs text-base-content/60 mt-1">Each name maps to a label, method, site-relative path, and optional defaults, headers, body and timeoutMs. Use {'{parameter}'} in paths or {'{"$param":"parameter"}'} in JSON bodies. Authentication cookies stay in the source tab.</span></label>
        <details><summary className="font-semibold cursor-pointer">Injection payload (JavaScript)</summary><p className="text-sm text-base-content/65 my-3">This code executes on the allowed external page with that page’s privileges. Store no credentials here. Define startTemcoSiteRelay(config); call startDmpRelay(config) to use the shared connection interface.</p><textarea aria-label="Injection payload JavaScript" className="textarea textarea-bordered w-full font-mono text-xs" rows={14} maxLength={100000} value={draft.program} onChange={event => setDraft({ ...draft, program: event.target.value })} required /></details>
        <button className="btn btn-primary self-start" disabled={busy || uncertain}>{busy ? "Saving…" : "Save relay definition"}</button>
      </div></form>
    </div>}
    {data && selected && <section className="rounded-box border border-base-300 bg-base-100 p-4 space-y-3"><h2 className="font-semibold">Recent revisions</h2><p className="text-sm text-base-content/65">Load a saved version as a draft, review it, then save to create a new revision.</p>{data.history.filter(row => row.relayId === selected).map(row => <div key={row.revision} className="flex flex-wrap items-center justify-between gap-3"><span>Revision {row.revision} · {new Date(row.createdAt).toLocaleString()}</span><button className="btn btn-sm btn-outline" disabled={busy || uncertain} onClick={() => { const current = data.definitions.find(definition => definition.id === selected)!; edit({ ...row.snapshot, revision: current.revision }); setMessage(`Revision ${row.revision} loaded as a draft. Save to apply it as a new revision.`); }}>Load as draft</button></div>)}</section>}
  </div>;
}
