"use client";
import { useState } from "react";
type View = { requestId: string; username: string; clientName: string; clientId: string; redirectUri: string; resource: string; scopes: string[] };
export default function McpConsentClient({ request }: { request: View }) {
  const [write, setWrite] = useState(request.scopes.includes("temco.write")), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function decide(allow: boolean) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/account/mcp/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: request.requestId, allow, scopes: ["temco.read", ...(write ? ["temco.write"] : []), ...(request.scopes.includes("offline_access") ? ["offline_access"] : [])] }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Authorization could not be confirmed. Start again from the client.");
      window.location.assign(result.redirectTo);
    } catch (error) { setError(error instanceof Error ? error.message : "Authorization could not be confirmed."); setBusy(false); }
  }
  return <div className="space-y-5"><p>Signed in as <strong>{request.username}</strong>. This client will become a separate device on your administrator account.</p>
    <div className="rounded-box bg-base-200 p-4 space-y-2 text-sm"><p><strong>Client-provided name:</strong> {request.clientName}</p><p className="break-all"><strong>Client ID:</strong> {request.clientId}</p><p className="break-all"><strong>Callback:</strong> {request.redirectUri}</p><p className="break-all"><strong>TemcoTools:</strong> {request.resource}</p></div>
    <p>The client can read the same operational information available to your account. Only approve a client you recognize.</p>
    {request.scopes.includes("temco.write") && <label className="flex gap-3 items-start"><input type="checkbox" className="checkbox mt-1" checked={write} onChange={event => setWrite(event.target.checked)} disabled={busy} /><span><strong>Allow changes</strong><span className="block text-sm mt-1">Includes imports, scans, file changes, printing through connected relays, configuration, code publication, users and device sign-out. Clear this for read-only access.</span></span></label>}
    <p className="text-sm text-base-content/65">Authorization lasts up to 30 days. Revoke this client from Configuration or User Management at any time. Passwords and account enrollment remain in the browser.</p>
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    <div className="flex gap-3"><button className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>Allow {request.clientName}</button><button className="btn btn-outline" disabled={busy} onClick={() => void decide(false)}>Deny</button></div>
  </div>;
}
