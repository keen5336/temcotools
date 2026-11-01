"use client";
import { useEffect, useState } from "react";
type Grant = { id: string; clientName: string; scopes: string[]; expiresAt: string; revokedAt: string | null };
export default function AccessGrantsClient() {
  const [grants, setGrants] = useState<Grant[]>([]), [name, setName] = useState("My MCP client"), [token, setToken] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function refresh() { const res = await fetch("/api/access-grants", { cache: "no-store" }); if (!res.ok) throw new Error("Sign in again to manage clients."); setGrants((await res.json()).grants); }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  async function create() {
    setBusy(true); setError(""); setToken("");
    try {
      const res = await fetch("/api/access-grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientName: name, scopes: ["inventory.read", "workflow.read"], lifetimeMinutes: 30 }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error); setToken(data.token); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create grant."); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true);
    try { const res = await fetch(`/api/access-grants?id=${encodeURIComponent(id)}`, { method: "DELETE" }); if (!res.ok) throw new Error("Could not revoke client."); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke client."); } finally { setBusy(false); }
  }
  return <div className="space-y-4"><p>Development/stdio client grants use your current account permissions and expire after 30 minutes. Remote OAuth setup follows in the identity slice.</p><label className="form-control">Client name<input className="input input-bordered w-full" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>Create read-only MCP grant</button>{token && <div className="alert block"><p>Copy this secret into your client&apos;s private TEMCO_MCP_TOKEN setting. It is shown once. Do not share it or commit it.</p><textarea aria-label="New client token" className="textarea textarea-bordered w-full font-mono mt-2" readOnly value={token} /><button className="btn btn-sm mt-2" onClick={() => setToken("")}>Hide token</button></div>}{error && <p role="alert" className="text-error">{error}</p>}<ul className="space-y-3">{grants.map(g => <li className="card bg-base-100 p-4 break-words" key={g.id}><strong>{g.clientName}</strong><p>{g.scopes.join(", ")}</p><p>Expires {new Date(g.expiresAt).toLocaleString()} {g.revokedAt ? "· Revoked" : ""}</p>{!g.revokedAt && <button className="btn btn-outline mt-2" disabled={busy} onClick={() => void revoke(g.id)}>Revoke</button>}</li>)}</ul></div>;
}
